import type { WorkBudget } from "@/lib/work/domain";
import { UNATTENDED_RUN_DEFAULT_MICRO_USD } from "@/lib/spend-ceiling";

/*
 * What bounds a Work run.
 *
 * ── There is no per-run ceiling any more ────────────────────────────────────
 *
 * This file used to hold a five-row table — a `maxCostMicroUsd`, a `maxTokens`
 * and a `maxRuntimeMs` per plan — and `runBudgetForPlan` handed a copy of the
 * account's row to every dispatcher. A PRO run stopped at $2, 600,000 tokens or
 * twenty minutes of working time, whichever came first, and the composer, the
 * schedule editor and the voice briefing all read their sentences from it.
 *
 * The table is gone. The only limit on a run is the account's rolling 5-hour
 * window and its weekly window — the model the references use. A run goes until
 * the work is done or until the account is out of window, and then it stops and
 * says when the window frees up.
 *
 * The argument the table made for itself was that a per-run ceiling and a
 * monthly one answer different questions: the monthly figure is what an account
 * may spend, and the per-run figure is how much of it one unattended loop may
 * take before somebody is asked. That question is real, and the windows answer
 * it better than the table did. A five-hour window is a bound on exactly the
 * thing the table was afraid of — a loop spending a month in an afternoon —
 * and it is the account's own number rather than a figure filed per plan, so it
 * never cuts a run short while the account still has room. The table's failure
 * mode was the opposite one and it was the common one: a task that genuinely
 * needed thirty minutes stopped at twenty with the month barely touched.
 *
 * ── What is still enforced, and where ───────────────────────────────────────
 *
 * The cost axis stays wired, to the window's remainder rather than to a
 * constant. A guard with every axis at zero is a guard that cannot stop a
 * runaway loop at all, and the window is precisely the number that should stop
 * it. So `runBudgetForWindow` puts the remaining micro-USD of the tighter
 * window into `maxCostMicroUsd` and leaves tokens and runtime at zero, which
 * `budgetExceeded` already reads as "no ceiling on this axis".
 *
 * That gives the executor's in-process guard a real number without teaching it
 * about the database it deliberately does not have. What the guard cannot see
 * is the window MOVING while the run works — other chat turns, another run —
 * so `scripts/work-runner.ts`, which does have the database, re-checks the
 * window on the same poll that already watches for a stop and ends the run
 * through the guard's own seam when it is spent.
 *
 * Admission is `checkUsageWindows` in `src/lib/spend.ts`, beside the monthly
 * `checkBudget` that remains the outer bound.
 *
 * ── What may still narrow it ────────────────────────────────────────────────
 *
 * `narrowestBudget` stays. A skill, a schedule, a project or a host may still
 * ask for LESS than the window allows, and nothing may ask for more — that was
 * never about the plan table, it is about a task being allowed to declare its
 * own smaller appetite. An empty field in the schedule editor is a zero, which
 * means "no ceiling of its own", which now means the window.
 */

/**
 * The ceilings a run is dispatched under, from what its account has left.
 *
 * `remainingMicroUsd` is `UsageWindowStatus.remainingMicroUsd` — the room in
 * whichever of the two windows binds, after settled spend and open holds. Null
 * means there is no window to enforce, which happens only for an account with
 * `Settings.spendCapDisabled`; that run gets the backstop in `spend-ceiling.ts`
 * rather than an unbounded one, and the argument is on that constant.
 *
 * Floored at one micro-USD when the window has room, because zero is the value
 * `budgetExceeded` reads as "no ceiling": rounding a nearly-spent window down
 * to nothing would hand the run the one budget that cannot stop it, which is
 * the exact inversion of what the caller asked for.
 */
export function runBudgetForWindow(remainingMicroUsd: number | null): WorkBudget {
  return {
    maxCostMicroUsd:
      remainingMicroUsd == null
        ? UNATTENDED_RUN_DEFAULT_MICRO_USD
        : Math.max(1, Math.floor(remainingMicroUsd)),
    // Zero on both axes, deliberately, and not a deletion: `WorkBudget` is the
    // shape the executor, the `WorkRun` columns and the native clients all
    // speak, and `budgetExceeded` skips an axis at zero. A run is no longer
    // stopped by how many tokens it used or by how long it took — only by what
    // it cost, against the window.
    maxTokens: 0,
    maxRuntimeMs: 0,
  };
}

/**
 * How many model turns one run may take.
 *
 * This was `maxStepsForBudget`, a ratio: the runtime's own `MAX_STEPS_PER_RUN`
 * is 200, sized for the twenty minutes every run used to get, and a plan with a
 * longer clock had its step cap scaled by the runtime ratio so the two ceilings
 * agreed. There is no runtime ceiling left to take a ratio of, so a ratio would
 * now be arithmetic over a number that is gone — it would silently collapse to
 * 200 and quietly become the thing that ends long work.
 *
 * So: one honest figure, sized for the longest run the product means to
 * support, which is what the largest plan used to be scaled to. It is a
 * backstop against a run going in a circle and nothing else. The detectors that
 * catch that shape properly are the loop's own — `DEFAULT_STALL_THRESHOLD` (six
 * consecutive tool calls that told the run nothing new) and
 * `DEFAULT_REPETITION_THRESHOLD` (three identical calls) both set the session's
 * halt reason and abort the loop, so a run going nowhere is stopped in seconds
 * rather than at step twelve hundred. They are the loop backstop now that the
 * clock is gone; this is the backstop behind them.
 */
export const WORK_MAX_STEPS_PER_RUN = 1_200;

/**
 * A ceiling typed into a form, or null when the form may not send it.
 *
 * Empty is zero, which every dispatcher reads as "no ceiling of its own" — that
 * is what makes an untouched field mean "whatever my windows allow" rather than
 * "nothing".
 *
 * It used to take a `limit` and refuse anything above the plan's own figure,
 * because a schedule may only ever LOWER a ceiling and storing a larger number
 * left the reader a saved schedule whose figures were not the figures it ran
 * under. There is no plan figure to check against any more, and there is no
 * honest one to invent: a schedule fires in the future, and what its window has
 * left at 07:00 tomorrow is not knowable today. So any non-negative number is
 * accepted and the helper text says the true thing — whichever is smaller, this
 * or what the window has left when it fires.
 *
 * Pure and here rather than in the editor so a test can hold it, since the
 * editor is a client component a test cannot import.
 */
export function ceilingFieldValue(raw: string): number | null {
  if (raw.trim() === "") return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}
