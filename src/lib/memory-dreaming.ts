/*
 * DREAMING — learning from history nobody asked Juno to read.
 *
 * ChatGPT's Dreaming (June 2026) is a background job that reads across a
 * user's past conversations between sessions and rewrites what it remembers,
 * without being asked. Juno already distilled NEW conversations after every
 * turn, but anything older — chats from before memory was switched on, chats
 * whose after-turn extraction failed, an account migrated in with history —
 * was read only if the user found the "Learn from past chats" button and
 * pressed it. Most never would. This is the rest of that job.
 *
 * The worker lives in scripts/memory-dreamer.ts and the database half in
 * src/lib/memory.ts; this file holds the rules, pure, so that "when may Juno
 * read someone's history on its own" is a thing a test can state.
 *
 * FOUR CONDITIONS, all required:
 *
 *   1. Memory is on. A paused memory is not read or written, by anything.
 *   2. The account has not switched background learning off. The switch is
 *      the user's say in an unattended job spending on their behalf.
 *   3. The account is BETWEEN SESSIONS — nothing in the last few minutes.
 *      Partly because that is what Dreaming means, and partly because the chat
 *      a person is in the middle of is already being distilled turn by turn,
 *      and a background job hammering the same provider's rate limit at the
 *      same moment only makes their live reply slower.
 *   4. The account's usage windows have room. Background memory work is billed
 *      to the account like any other model call (runUtilityPrompt writes the
 *      ledger), so a job nobody watches must not be the thing that spends a
 *      user's last headroom before their next real question.
 */

/** How often the worker wakes. Each tick is small; the queue drains over hours, not minutes. */
export const DREAM_INTERVAL_MS = 10 * 60_000;
/** Minutes without activity before an account counts as between sessions. */
export const DREAM_IDLE_MINUTES = 10;
/** Accounts visited per tick — bounds a tick's total model calls. */
export const DREAM_ACCOUNTS_PER_TICK = 5;
/** Conversations distilled per account per tick (two chunks each, see backfillMemories). */
export const DREAM_CONVERSATIONS_PER_ACCOUNT = 2;
/**
 * Conversations a Batch API pass reads per account per tick. Larger, because
 * a batched pass advances each conversation by one chunk per batch round
 * (queue, then apply on a later tick) instead of two chunks inline — and a
 * queued prompt costs nothing until the batch runs, at half price.
 */
export const DREAM_BATCH_CONVERSATIONS_PER_ACCOUNT = 6;
/**
 * Project summaries checked per account per productive tick — the projects
 * with the most recent memory activity first. Each one that turns out stale
 * is a model call, so this bounds them the way the line above bounds reading.
 */
export const DREAM_PROJECT_SUMMARIES_PER_ACCOUNT = 3;
/**
 * Chats an older reader distilled, queued per account per tick once nothing
 * new is left to read (queueRereads). Small, because a re-read is a whole
 * chat's worth of model calls and there is no hurry: the facts it recovers
 * were missing yesterday too.
 */
export const DREAM_REREADS_PER_ACCOUNT = 2;

export type DreamSkipReason = "memory_off" | "background_learning_off" | "active" | "over_budget";

export function dreamEligibility(input: {
  memoryEnabled: boolean;
  memoryBackgroundLearning: boolean;
  /** The account's most recent message, anywhere. */
  lastActiveAt: Date | null;
  /** Whether the account's usage windows still have room. */
  budgetAllowed: boolean;
  now: Date;
}): { ok: true } | { ok: false; reason: DreamSkipReason } {
  if (!input.memoryEnabled) return { ok: false, reason: "memory_off" };
  if (!input.memoryBackgroundLearning) return { ok: false, reason: "background_learning_off" };
  if (
    input.lastActiveAt &&
    input.now.getTime() - input.lastActiveAt.getTime() < DREAM_IDLE_MINUTES * 60_000
  ) {
    return { ok: false, reason: "active" };
  }
  if (!input.budgetAllowed) return { ok: false, reason: "over_budget" };
  return { ok: true };
}
