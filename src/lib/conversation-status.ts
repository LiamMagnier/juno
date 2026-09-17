import { RUN_STATE_META, type RunState } from "@/lib/code-runs";
import { isLiveStatus, isTerminalStatus, statusNeedsAttention, type WorkStatus } from "@/lib/work/domain";

/*
 * THE STATUS A CONVERSATION ROW CARRIES, for either product.
 *
 * After the Work merge there is one sidebar and two things that can be running
 * behind a row in it: a `WorkSession` under a chat, and a `CodeTask` under a
 * Code session. Both answer the same two questions for the row — is this
 * blocked on the reader, and what colour is the mark — and both used to answer
 * them in a component, in two different vocabularies: `STATUS_META`'s
 * neutral/live/attention/good/bad in `work-vocabulary.tsx` and
 * `RUN_STATE_META`'s neutral/active/attention/positive/danger in
 * `lib/code-runs.ts`. Five tones each, the same five meanings, no shared name.
 *
 * This module is that shared name, plus the two predicates the sidebar joins on.
 * It is deliberately pure — no React, no `window`, no fetch, no "server-only" —
 * so the join can be tested without a DOM (tests/conversation-status.test.ts)
 * and so a server component could read it. The WORDS still live where they
 * already lived: `statusLabel`/`statusSentence` for Work, `RUN_STATE_META` for
 * Code. Nothing here restates a label, because a second copy of a sentence is
 * how two surfaces start calling one state two things.
 */

/**
 * The five tones a status mark can take, and the whole vocabulary.
 *
 * `live` rather than `active` (Code's word) and `good`/`bad` rather than
 * `positive`/`danger`: those are `work-vocabulary.tsx`'s names, which reached
 * this point first and are keyed by both the dot and the pill there.
 */
export type StatusTone = "neutral" | "live" | "attention" | "good" | "bad";

/** Code's tone names, mapped onto the shared five. A pure rename, not a policy. */
const CODE_TONE: Record<(typeof RUN_STATE_META)[RunState]["tone"], StatusTone> = {
  attention: "attention",
  active: "live",
  neutral: "neutral",
  positive: "good",
  danger: "bad",
};

export function codeRunTone(state: RunState): StatusTone {
  return CODE_TONE[RUN_STATE_META[state].tone];
}

/**
 * Whether a chat's newest run is still the reader's business.
 *
 * `draft` is excluded although the domain calls it live: a draft was composed
 * and never dispatched, so there is nothing happening behind that row and a
 * mark saying otherwise is the row lying about itself. Everything else the
 * domain calls live IS happening — queued and paused included, because both are
 * runs the reader started that have not finished.
 *
 * `needsAttention` is the session's own denormalised flag and wins outright,
 * including over a terminal status: `host_offline` is over and still carries a
 * decision (wake the Mac, or run it somewhere else), which is exactly the case
 * `statusNeedsAttention` was written for.
 */
export function workRunIsOpen(status: WorkStatus, needsAttention: boolean): boolean {
  if (needsAttention || statusNeedsAttention(status)) return true;
  if (isTerminalStatus(status)) return false;
  return isLiveStatus(status) && status !== "draft";
}

/** A chat whose newest run has stopped for a person. Drives the "Needs you" fold. */
export function workRunNeedsYou(status: WorkStatus, needsAttention: boolean): boolean {
  return needsAttention || statusNeedsAttention(status);
}

/**
 * The newest row per conversation, from a list that may be truncated.
 *
 * The sidebar joins runs onto conversation rows by `conversationId`, and both
 * list routes answer with a page rather than with the whole account — so the
 * join has to be told, once, what "newest" means rather than trusting the order
 * a route happened to return. Rows with no conversation are dropped: the
 * sidebar's unit is the conversation, so a run pointing at nothing has no row
 * to light up.
 *
 * An unparsable timestamp sorts oldest rather than throwing or winning, so one
 * bad row from a deployment ahead of this bundle cannot take over a dot.
 */
export function newestPerConversation<T>(
  rows: readonly T[],
  conversationOf: (row: T) => string | null | undefined,
  activityOf: (row: T) => string,
): Map<string, T> {
  const newest = new Map<string, T>();
  for (const row of rows) {
    const conversationId = conversationOf(row);
    if (!conversationId) continue;
    const held = newest.get(conversationId);
    if (held === undefined || stampOf(activityOf(row)) > stampOf(activityOf(held))) {
      newest.set(conversationId, row);
    }
  }
  return newest;
}

function stampOf(iso: string): number {
  const stamp = new Date(iso).getTime();
  return Number.isNaN(stamp) ? 0 : stamp;
}
