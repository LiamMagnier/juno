/**
 * A crew member's own budget, inside the account's windows.
 *
 * The account's rolling 5-hour and weekly usage windows are the ceiling for
 * everything the account does. A member may carry its own, smaller cap
 * (`Agent.budgetMicroUsd`) for the account's current weekly window: "Scout may
 * spend up to $5 a week". It can only narrow what the account allows, never
 * widen it, so the account's own gates run first and this one after.
 *
 * Enforced in three places, each with the same sentence:
 *   - admission, when a task the member owns is started (`startWorkRunForUser`)
 *     and when a routine is run now (`fire-now.ts`);
 *   - while a run is going, on the runner's usage poll (`scripts/work-runner.ts`),
 *     which stops the run the moment the member's spend reaches its cap.
 *
 * What a member has spent is the cost of the runs of the tasks it owns that
 * started inside the window. A run that started before the window counts
 * towards the window it started in, which is the same rule the account's holds
 * follow.
 *
 * This file is pure and client-safe (the domain reads its limit); the reads
 * that need the database are in `budget-store.ts`. Both are tested in
 * `tests/agents-budget.test.ts` and `tests/crew-foundations.integration.test.ts`.
 */

/** The window a member's cap applies to when the account has no weekly window (enforcement off). */
export const MEMBER_BUDGET_ROLLING_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The largest cap a person may set, in micro-USD: $2,000 a week.
 *
 * Bounded by the column, which is a 32-bit `Int` (`Agent.budgetMicroUsd`, like
 * every other micro-USD column on Work). The bound used to be $10,000, which
 * the schema accepted and Postgres did not: any cap above $2,147.48 failed on
 * write, a 500 from the profile and a "problem on Juno's side" from a setup
 * change. A member that should spend more than this has no cap of its own.
 */
export const MAX_MEMBER_BUDGET_MICRO_USD = 2_000 * 1_000_000;

export interface MemberBudgetVerdict {
  allowed: boolean;
  /** Room left under the cap, never negative. Null when the member has no cap. */
  remainingMicroUsd: number | null;
}

/**
 * Whether a member may spend `pendingMicroUsd` more, having spent
 * `spentMicroUsd` in the current window. No cap is always allowed. At the cap
 * exactly is spent: a cap is "up to", and a run started with nothing left would
 * stop on its first poll.
 */
export function memberBudgetVerdict(input: {
  capMicroUsd: number | null | undefined;
  spentMicroUsd: number;
  pendingMicroUsd?: number;
}): MemberBudgetVerdict {
  const cap = input.capMicroUsd;
  if (cap === null || cap === undefined) return { allowed: true, remainingMicroUsd: null };
  const used = Math.max(0, Math.round(input.spentMicroUsd)) + Math.max(0, Math.round(input.pendingMicroUsd ?? 0));
  const remaining = Math.max(0, cap - used);
  return { allowed: used < cap, remainingMicroUsd: remaining };
}

/** "$5.00", as every cost is written to a person. */
export function formatBudget(microUsd: number): string {
  return `$${(Math.max(0, microUsd) / 1_000_000).toFixed(2)}`;
}

function whenItFrees(resetsAtMs: number | null): string | null {
  if (resetsAtMs === null) return null;
  const when = new Date(resetsAtMs).toLocaleString("en-US", {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${when} UTC`;
}

/**
 * The sentence a person reads when a member's own budget stops something.
 *
 * `stage` says which: a task that was not started, or one that was running and
 * stopped. Both name the member, the cap, when it frees up and the one thing
 * the person can do about it now.
 */
export function memberBudgetMessage(input: {
  name: string;
  capMicroUsd: number;
  resetsAtMs: number | null;
  stage: "admission" | "running";
}): string {
  const name = input.name.trim() || "This crew member";
  const cap = formatBudget(input.capMicroUsd);
  const frees = whenItFrees(input.resetsAtMs);
  const lead =
    input.stage === "admission"
      ? `${name} has used the ${cap} you set for this week, so nothing was started.`
      : `${name} reached the ${cap} you set for this week, so this task stopped.`;
  const when = frees ? ` It frees up ${frees}.` : " It frees up as the week's older spend ages out.";
  return `${lead}${when} You can raise ${name}'s budget in its setup.`;
}

/**
 * The start of the window a member's cap is counted in, and when it frees up:
 * the account's weekly cell when the account has one, else a rolling week.
 */
export function memberBudgetWindow(input: {
  weekly: { startMs: number; resetsAtMs: number } | null;
  now: Date;
}): { since: Date; resetsAtMs: number | null } {
  const weekly = input.weekly;
  // An unmetered account reports a zero-width window (start = reset = now).
  if (weekly && weekly.resetsAtMs > weekly.startMs) {
    return { since: new Date(weekly.startMs), resetsAtMs: weekly.resetsAtMs };
  }
  return { since: new Date(input.now.getTime() - MEMBER_BUDGET_ROLLING_MS), resetsAtMs: null };
}
