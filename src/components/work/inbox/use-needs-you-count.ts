"use client";

import * as React from "react";
import { toast } from "sonner";
import { needsYou } from "@/components/work/inbox/triage";
import { describeNeedsYouRise } from "@/lib/work/notifications";
import {
  WORK_POLL_MS,
  WORK_SYNC_EVENT,
  fetchWorkSessions,
} from "@/components/work/work-transport";

/*
 * How many tasks are blocked on the reader, for a badge outside Work.
 *
 * The Work home's own header comment has promised a "3 need you" mark in the
 * sidebar since the inbox was written, and the sidebar has had a plain "Work"
 * link the whole time. This is the number for that mark: the account's rows
 * with `needsAttention` set (`?needsAttention=true`, the whole account rather
 * than a page), re-checked through `needsYou` so the badge and the inbox's
 * "Needs you" pill count the same rows.
 *
 * Null until the first answer lands and null again after a failed read — a
 * badge that showed 0 on a dropped request would be telling the reader nothing
 * is waiting when Juno simply could not find out. Refreshed on the same clock
 * and the same `WORK_SYNC_EVENT` every other Work surface uses, so answering an
 * approval clears the number now rather than in thirty seconds.
 *
 * Nothing is fetched while the tab is hidden. Every call is one small GET; a
 * sidebar that mounts once and lives for the session must not turn that into a
 * background poll on a tab nobody is looking at.
 *
 * ── Saying it, not only counting it ─────────────────────────────────────────
 *
 * A dot appearing on a switch in the corner is a notification only for somebody
 * already looking at that corner, and a Work run outlives the tab that started
 * it — so the reader this number exists for is usually reading something else.
 * When the count RISES, this now says so twice: a toast for the reader who is
 * in the app, and a system notification for the reader whose browser is behind
 * another window.
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
 */
export function useWorkNeedsYouCount(): number | null {
  const [count, setCount] = React.useState<number | null>(null);
  /*
   * Read in a ref rather than through the state closure, because the effect
   * below mounts once for the life of the session. A dependency on `count`
   * would tear down and rebuild the interval and both listeners on every poll.
   */
  const previous = React.useRef<number | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const result = await fetchWorkSessions({ needsAttention: true, limit: 100 });
      if (cancelled) return;
      const next = result.kind === "ok" ? result.value.filter(needsYou).length : null;
      announceRise(previous.current, next);
      previous.current = next;
      setCount(next);
    };
    const tick = () => {
      if (!document.hidden) void load();
    };
    tick();
    const interval = window.setInterval(tick, WORK_POLL_MS);
    window.addEventListener(WORK_SYNC_EVENT, tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener(WORK_SYNC_EVENT, tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  return count;
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
