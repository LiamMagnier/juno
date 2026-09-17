"use client";

import * as React from "react";
import { toast } from "sonner";
import { needsYou } from "@/components/work/inbox/triage";
import { newestPerConversation, workRunNeedsYou } from "@/lib/conversation-status";
import { describeNeedsYouRise } from "@/lib/work/notifications";
import {
  WORK_POLL_MS,
  WORK_SYNC_EVENT,
  fetchWorkSessions,
  type WorkInboxSession,
} from "@/components/work/work-transport";

/*
 * WHICH CHATS ARE CARRYING A RUN, for the sidebar — and the count that used to
 * be the only thing anybody asked this file.
 *
 * The count was drawn as a dot on a Work row. Work is not a row any more
 * (docs/design/TWO_PRODUCTS.md §2), and a number on its own has nowhere to go:
 * the thing a person does with "3 need you" is open those three. So the sidebar
 * lists them instead, in a "Needs you" fold above Today whose header filters
 * the panel in place, and every other row in the panel wants to know whether
 * its conversation is carrying a run at all. Both answers come from one list
 * keyed by `WorkSession.conversationId` — the pointer this whole merge is built
 * on, which has existed and been serialised to every client since Work shipped.
 *
 * ONE POLL PER QUESTION, AND NEVER ONE PER ROW. That was the rule when this
 * file held a badge and it is the rule now: the sidebar mounts once and lives
 * for the whole session, so it gets a single small GET on a visibility-gated
 * interval and joins to rows in memory (`newestPerConversation`).
 *
 * The file keeps its old name on purpose: `ComposerModeSwitch` imports it by
 * path and that file is deleted by the composer's half of this merge, so
 * renaming it here would be a rename and a deletion of the same line racing
 * each other. It goes when its last old caller does.
 *
 * WHAT THE WINDOW COSTS, stated plainly: the list route answers pinned-first
 * then most recently active, capped at 100. A run that is executing writes
 * events continuously, so it cannot fall out of that window; a task that
 * stopped to ask a question and then sat untouched behind a hundred more
 * recently active ones can. It is still in its transcript and still in search —
 * what it loses is the fold. The honest fix if an account ever grows that far
 * is a server-side triage query, not a second poll here.
 *
 * ── Saying it, not only listing it ──────────────────────────────────────────
 *
 * A fold in a column is a notification only for somebody already looking at
 * that column, and a Work run outlives the tab that started it — so the reader
 * this list exists for is usually reading something else. When the number of
 * conversations waiting on a person RISES, `useWorkRunsByConversation` says so
 * twice: a toast for the reader who is in the app, and a system notification
 * for the reader whose browser is behind another window.
 *
 * The system notification is deliberately best-effort and never prompts. Asking
 * for permission unbidden is the pattern every browser built a mute button for;
 * a reader who has already granted it to this origin gets it, and everybody
 * else gets the toast. It cannot reach a tab that is hidden, because nothing is
 * polled while the tab is hidden — that is the trade the paragraph above makes
 * and it is not being reopened for a nicer notification. The channel that does
 * reach a closed tab is the account change feed, and Work joins it when
 * `prisma/migrations-pending/20260815141000_work_change_capture_triggers` is
 * safe to apply; see `src/lib/work/notify/deliver.ts` for why it is not yet.
 *
 * IT ANNOUNCES FROM THE SIDEBAR'S POLL, not from `useWorkNeedsYouCount`. That
 * hook's only caller was the Chat|Work pill this merge deletes, so announcing
 * there would be announcing from a surface nobody mounts.
 */

const SESSION_PAGE = 100;

/**
 * The shared read. `options` is passed straight to the list route, so a caller
 * asking a narrower question pays for exactly that question.
 *
 * Null until the first answer lands, and the last good answer STAYS on a failed
 * read: a dropped request is not evidence that nothing is waiting, and a fold
 * that empties itself on a flaky connection is worse than one that is stale.
 *
 * THIS REVERSES WHAT THIS FILE USED TO DO, for both callers, so it is worth
 * saying which ones. `useWorkNeedsYouCount` — the badge on
 * `ComposerModeSwitch` — went back to null after a failed read, and the reason
 * recorded then was that a badge reading 0 on a dropped request tells the
 * reader nothing is waiting when Juno simply could not find out. That argument
 * is untouched and is still satisfied here: keeping the last good answer never
 * shows 0 on a dropped read either, and it is the stronger of the two, because
 * a badge that blinks out mid-poll says "resolved" just as loudly as a 0 does.
 * What it costs is a count that can be a poll interval out of date while the
 * connection is bad — a number that was true thirty seconds ago, which is what
 * every polled count in this product already is.
 */
function useWorkSessionPoll(options: { needsAttention?: boolean }, enabled: boolean): WorkInboxSession[] | null {
  const [sessions, setSessions] = React.useState<WorkInboxSession[] | null>(null);
  const needsAttention = options.needsAttention;

  React.useEffect(() => {
    if (!enabled) {
      setSessions(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const result = await fetchWorkSessions({ limit: SESSION_PAGE, needsAttention });
      if (cancelled) return;
      if (result.kind === "ok") setSessions(result.value);
    };
    // Nothing is fetched while the tab is hidden: a surface that mounts once and
    // lives for the session must not turn that into a background poll on a tab
    // nobody is looking at.
    const tick = () => {
      if (!document.hidden) void load();
    };
    tick();
    const interval = window.setInterval(tick, WORK_POLL_MS);
    // The same `WORK_SYNC_EVENT` every other Work surface dispatches, so
    // answering an approval clears the row now rather than in thirty seconds.
    window.addEventListener(WORK_SYNC_EVENT, tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener(WORK_SYNC_EVENT, tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled, needsAttention]);

  return sessions;
}

export interface WorkRunsByConversation {
  /** The newest session per conversation, for that row's status dot. */
  byConversation: Map<string, WorkInboxSession>;
  /** Conversation ids whose newest session has stopped for a person. */
  needsYou: Set<string>;
  /** False until the first answer lands, so an empty fold is never drawn on a guess. */
  loaded: boolean;
}

const EMPTY: WorkRunsByConversation = {
  byConversation: new Map(),
  needsYou: new Set(),
  loaded: false,
};

/**
 * The sidebar's read. `enabled` is false in the Code product, where the rows
 * are Code sessions and this list has nothing to say about them — a hook cannot
 * be called conditionally, so the condition lives inside it.
 */
export function useWorkRunsByConversation({ enabled = true }: { enabled?: boolean } = {}): WorkRunsByConversation {
  const sessions = useWorkSessionPoll({}, enabled);

  const result = React.useMemo(() => {
    if (sessions === null) return EMPTY;
    const byConversation = newestPerConversation(
      sessions,
      (session) => session.conversationId,
      (session) => session.lastActivityAt,
    );
    const needsYouIds = new Set<string>();
    for (const [conversationId, session] of byConversation) {
      if (workRunNeedsYou(session.status, session.needsAttention)) needsYouIds.add(conversationId);
    }
    return { byConversation, needsYou: needsYouIds, loaded: true };
  }, [sessions]);

  /*
   * Announced in an effect rather than in the memo above, because saying
   * something out loud is a side effect and a memo may run twice. The previous
   * value lives in a ref so the effect depends only on the number it is
   * comparing: a dependency on the count's own state would re-run the effect
   * that sets it.
   */
  const previous = React.useRef<number | null>(null);
  const waiting = result.loaded ? result.needsYou.size : null;
  React.useEffect(() => {
    announceRise(previous.current, waiting);
    previous.current = waiting;
  }, [waiting]);

  return result;
}

/**
 * How many tasks are blocked on the reader, for a badge outside Work: the
 * account's rows with `needsAttention` set (the whole account rather than a
 * page), re-checked through `needsYou` so the badge and the inbox's "Needs you"
 * pill count the same rows. Null until the first answer lands.
 *
 * Its one caller is `ComposerModeSwitch`, the Chat|Work pill the composer's own
 * half of this merge deletes; it counts SESSIONS, including the ones that point
 * at no conversation, which is why it is still its own narrow read rather than
 * a view over the map above.
 */
export function useWorkNeedsYouCount(): number | null {
  const sessions = useWorkSessionPoll({ needsAttention: true }, true);
  return sessions === null ? null : sessions.filter(needsYou).length;
}

/**
 * Says a rise out loud, in whichever of the two ways is available.
 *
 * Never throws. Every branch here is optional browser surface — `Notification`
 * is absent in an insecure context and in some embedded webviews, and its
 * constructor throws on a few platforms even when the object exists — and a
 * counter that stopped updating because an announcement failed would be a
 * strictly worse outcome than an announcement nobody heard.
 */
function announceRise(previous: number | null, next: number | null): void {
  const sentence = describeNeedsYouRise(previous, next);
  if (sentence === null) return;

  toast(sentence, { description: "Open the task to answer it." });

  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    // `tag` collapses successive notifications into one entry rather than
    // stacking them: the reader needs to know that something is waiting, not
    // to clear four of them.
    new Notification(sentence, { body: "Open Juno to answer it.", tag: WORK_NEEDS_YOU_TAG });
  } catch {
    // Permission granted and the constructor still refused. The toast is out.
  }
}

/** One notification for this, replaced rather than repeated. */
const WORK_NEEDS_YOU_TAG = "juno-work-needs-you";
