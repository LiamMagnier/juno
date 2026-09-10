import type { WorkBudget } from "@/lib/work/domain";

/*
 * The ceilings every Work run is dispatched under.
 *
 * One module, importable by a client bundle, a route and a script alike — and
 * that reach is the reason it exists. This constant used to be private to the
 * runs route, so the composer's "Stops at $2 or 20 minutes" was a hand-copied
 * mirror of it, the scheduler and run-now routes did not apply it at all (a
 * schedule with no budget of its own dispatched runs with NO ceiling, since
 * zero means "no ceiling" to `budgetExceeded`), and nothing but a comment kept
 * the three in step. Every dispatcher now merges its own figures with this one
 * through `narrowestBudget`, and the composer reads its sentence from here.
 *
 * Each number is a number somebody has to be able to defend, so:
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
 *    waits for a person (`WorkBudgetGuard.suspend`), so this is twenty minutes
 *    of work and not twenty minutes of elapsed wall clock — a run that asks a
 *    question at 17:00 and is answered at 09:00 has spent none of it waiting.
 *
 * They are a ceiling and not a target: `narrowestBudget` means a skill, a
 * schedule or a host may lower any of them and none may raise them. Nothing on
 * the wire raises them, which is exactly why this constant is the whole policy
 * and is stated here rather than defaulted somewhere quieter.
 */
export const DEFAULT_RUN_BUDGET: WorkBudget = {
  maxCostMicroUsd: 2_000_000,
  maxTokens: 600_000,
  maxRuntimeMs: 20 * 60_000,
};
