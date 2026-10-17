/**
 * What Retry and Edit and resend do to a Code thread, decided from its turns.
 *
 * Both start the turn's prompt again. In a coding thread "again" has to say
 * what happens to the files the first attempt wrote, so each plan names the
 * checkpoint it rolls back to first, or says it cannot (and then the action
 * is either offered with that said plainly, or not offered at all):
 *
 * - Retry is offered on the newest settled turn. When that turn changed files
 *   and the turn before it left a checkpoint, the files go back to that
 *   checkpoint first, so the second attempt starts where the first one did.
 * - Edit and resend is offered on any settled turn whose prompt can be edited
 *   without leaving stale work behind: a turn that changed nothing and has
 *   nothing after it, or one with a checkpoint before it to roll back to (the
 *   same rule as "Revert to here").
 *
 * The env server refuses a rollback while a turn runs, so neither is offered
 * while the thread is busy.
 */
import type { UserMessageItem } from "./contracts";
import type { Turn } from "./turns";

export interface RetryPlan {
  message: UserMessageItem;
  /** Roll the files back to this checkpoint before sending. */
  rollbackTo?: string;
  /** The turn changed files that cannot be rolled back first: they stay. */
  keepsChanges: boolean;
}

export interface EditPlan {
  text: string;
  rollbackTo?: string;
  /** What the rollback undoes, for the confirm line. */
  files: number;
  turns: number;
}

const settled = (t: Turn) => t.status !== "running" && t.status !== "waiting";

/** Retry for turn `index`, or null when it is not the newest settled turn with a prompt. */
export function retryPlan(turns: readonly Turn[], index: number, opts: { busy: boolean; canRollback: boolean }): RetryPlan | null {
  const turn = turns[index];
  if (!turn?.user || opts.busy || index !== turns.length - 1 || !settled(turn)) return null;
  if (!turn.changes.length) return { message: turn.user, keepsChanges: false };
  const before = index > 0 ? turns[index - 1].checkpoint : undefined;
  if (before && opts.canRollback) return { message: turn.user, rollbackTo: before.checkpointId, keepsChanges: false };
  return { message: turn.user, keepsChanges: true };
}

/** Edit and resend from turn `index`, or null when it cannot be done without leaving stale work. */
export function editPlan(turns: readonly Turn[], index: number, opts: { busy: boolean; canRollback: boolean }): EditPlan | null {
  const turn = turns[index];
  if (!turn?.user || opts.busy || !settled(turn)) return null;
  const later = turns.slice(index);
  const files = new Set(later.flatMap((t) => t.changes.map((c) => c.path))).size;
  const count = later.filter((t) => t.user).length;
  if (files === 0 && index === turns.length - 1) return { text: turn.user.text, files: 0, turns: 0 };
  const before = index > 0 ? turns[index - 1].checkpoint : undefined;
  if (!before || !opts.canRollback) return null;
  return { text: turn.user.text, rollbackTo: before.checkpointId, files, turns: count };
}

// Named *_TITLE so the i18n extractor catalogues them.
const RETRY_UNDO_TITLE = "Undo this turn's changes and run the prompt again";
const RETRY_KEEP_TITLE = "Run the prompt again. This turn's changes stay";
const RETRY_PLAIN_TITLE = "Run the prompt again";

/** Retry's tooltip: what it will do to the files. */
export function retryTitle(plan: RetryPlan): string {
  if (plan.rollbackTo) return RETRY_UNDO_TITLE;
  if (plan.keepsChanges) return RETRY_KEEP_TITLE;
  return RETRY_PLAIN_TITLE;
}

/** The last retryable turn's prompt, for the error row's Retry (resend the last turn's prompt). */
export function lastPrompt(turns: readonly Turn[]): UserMessageItem | null {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].user) return turns[i].user!;
  return null;
}
