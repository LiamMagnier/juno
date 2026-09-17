import type { Plan } from "@prisma/client";
import type { WorkBudget } from "@/lib/work/domain";

/*
 * The ceilings every Work run is dispatched under.
 *
 * One module, importable by a client bundle, a route and a script alike — and
 * that reach is the reason it exists. These numbers used to be a single
 * constant private to the runs route, so the composer's "Stops at $2 or 20
 * minutes" was a hand-copied mirror of it, the scheduler and run-now routes did
 * not apply it at all (a schedule with no budget of its own dispatched runs
 * with NO ceiling, since zero means "no ceiling" to `budgetExceeded`), and
 * nothing but a comment kept the three in step. Every dispatcher now merges its
 * own figures with the plan's through `narrowestBudget`, and the composer reads
 * its sentence from here.
 *
 * ── Why the ceiling is shaped by the plan ───────────────────────────────────
 *
 * One flat figure for every account is two wrong answers at once. It is far too
 * much for a trial account whose whole month is 0.15 € — one run could spend it
 * — and it is the reason a paying account cannot ask for the long, unattended
 * piece of work the product is sold on. A ceiling is a pricing decision, so it
 * is derived from the thing that already carries pricing: `Plan`.
 *
 * `runBudgetForPlan` is the only seam. Every dispatcher reads the plan through
 * `getUserPlan` — which it already loads for the model gate — and hands it
 * here; nothing else may invent a figure. `DEFAULT_RUN_BUDGET` survives as the
 * PRO row under its old name, because a client that has not been told whose
 * account it is drawing must fall back to something and PRO's figures are the
 * ones every existing surface was written against.
 *
 * ── The numbers, and what each one has to defend ────────────────────────────
 *
 * PRO is untouched, deliberately. It is what every run in the product is
 * dispatched under today, so leaving it alone means no existing account's
 * behaviour changes because of this file:
 *
 *  - Two US dollars. A Work run is meant to be worth more than a chat turn and
 *    materially less than a person's hour. Two dollars buys a few hundred
 *    thousand tokens on the models Work admits, which covers research, a draft
 *    and a revision, and stops a loop at the cost of a coffee rather than the
 *    cost of a laptop.
 *  - 600,000 tokens. Deliberately reached at roughly the same time as the cost
 *    ceiling on a mid-priced model, so the two do not disagree about what a
 *    long run is — and so a run on a cheap model is stopped by tokens rather
 *    than running eight times longer for the same money.
 *  - Twenty minutes of *running* time. The guard stops its clock while a run
 *    waits for a person (`WorkBudgetGuard.suspend` in the runtime), so this is
 *    twenty minutes of work and not twenty minutes of elapsed wall clock. A run
 *    that asks a question at 17:00 and is answered at 09:00 has spent none of
 *    it waiting — which is why a ceiling measured in hours below is a ceiling
 *    on a PERSON's hours, not on a meter left running overnight.
 *
 * FREE is the trial tier and its cost axis is its whole monthly budget
 * (`BUDGET_EUR.FREE` is 0.15 €). Anything larger would be a ceiling the monthly
 * cap reaches first, which is a ceiling that does not exist; anything smaller
 * would refuse a run the trial was sold as including. So one trial run may
 * spend at most one trial month, and the second one is refused by the monthly
 * ceiling rather than by this.
 *
 * MAX is three times PRO on every axis, and MAX20 five times on cost and tokens
 * with two hours of working time. Both are well under the ratio the plans
 * themselves advertise (5× and 10× of PRO's monthly budget), because a per-run
 * ceiling and a monthly one answer different questions: the monthly figure is
 * what an account may spend, and this is how much of it one unattended loop may
 * take before somebody is asked. An account that wants the whole month in one
 * run can still say so — the ceiling narrows from here, never upwards.
 *
 * OWNER gets MAX20's figures rather than none. `spend-ceiling.ts` exists
 * because `BUDGET_EUR.OWNER` was null, which switched off both the pre-flight
 * gate and the mid-stream abort on the one account no billing system watches;
 * handing the same account an unbounded per-run ceiling here would reopen
 * exactly that hole from the other side.
 *
 * They are ceilings and not targets: `narrowestBudget` means a skill, a
 * schedule, a project or a host may lower any of them and none may raise them.
 * Nothing on the wire raises them, which is exactly why this table is the whole
 * policy and is stated here rather than defaulted somewhere quieter.
 */
const RUN_BUDGET_BY_PLAN: Record<Plan, WorkBudget> = {
  FREE: {
    maxCostMicroUsd: 150_000,
    maxTokens: 150_000,
    maxRuntimeMs: 10 * 60_000,
  },
  PRO: {
    maxCostMicroUsd: 2_000_000,
    maxTokens: 600_000,
    maxRuntimeMs: 20 * 60_000,
  },
  MAX: {
    maxCostMicroUsd: 6_000_000,
    maxTokens: 1_800_000,
    maxRuntimeMs: 60 * 60_000,
  },
  MAX20: {
    maxCostMicroUsd: 10_000_000,
    maxTokens: 3_000_000,
    maxRuntimeMs: 120 * 60_000,
  },
  OWNER: {
    maxCostMicroUsd: 10_000_000,
    maxTokens: 3_000_000,
    maxRuntimeMs: 120 * 60_000,
  },
};

/**
 * The ceilings a run started by this account is dispatched under.
 *
 * A fresh object every call. The table above is module state shared by a route,
 * a scheduler and a poller in the same process, and `narrowestBudget` callers
 * treat what they are handed as theirs; returning the stored row would make one
 * dispatcher's narrowing visible to the next.
 */
export function runBudgetForPlan(plan: Plan): WorkBudget {
  return { ...RUN_BUDGET_BY_PLAN[plan] };
}

/**
 * The figures a surface uses when it does not know whose account it is drawing.
 *
 * PRO's row, under the name it has always had. Every client that imports this —
 * the composer's disclosure, the schedule editor's placeholders, the desktop
 * contract — was written against these numbers, and a fallback that guessed
 * lower would tell a paying reader their run stops earlier than it does. Read
 * the plan and call `runBudgetForPlan` wherever the plan is in hand; this is
 * for the surfaces where it is not.
 */
export const DEFAULT_RUN_BUDGET: WorkBudget = runBudgetForPlan("PRO");

/**
 * How many model turns one run may take, scaled to the runtime it was given.
 *
 * The runtime's own `MAX_STEPS_PER_RUN` is 200, sized for PRO's twenty minutes.
 * Left at 200 a MAX20 run would have two hours of ceiling and stop at the same
 * two hundred steps, which is a ceiling that lies: the budget bar would read a
 * quarter full when the run ended. Scaled by the runtime ratio the two agree
 * again, and the step limit goes back to being what it was meant to be — a
 * backstop against a run going in a circle, not the thing that ends long work.
 *
 * Floored at the runtime's own figure so this can only ever raise it: a plan
 * with a shorter clock is already stopped by the clock, and cutting its steps
 * as well would refuse a short run that was simply doing many small things.
 */
export function maxStepsForBudget(budget: WorkBudget, baseSteps: number): number {
  const base = Math.max(1, Math.floor(baseSteps));
  const ratio = budget.maxRuntimeMs / DEFAULT_RUN_BUDGET.maxRuntimeMs;
  if (!Number.isFinite(ratio) || ratio <= 1) return base;
  return Math.round(base * ratio);
}
