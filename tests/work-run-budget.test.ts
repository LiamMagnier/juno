import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Plan } from "@prisma/client";
import { NO_BUDGET, narrowestBudget } from "@/lib/work/domain";
import { DEFAULT_RUN_BUDGET, maxStepsForBudget, runBudgetForPlan } from "@/lib/work/budget";
import { UNIT_CEILING_MICRO_USD, unitCeilingMicroUsd } from "@/lib/spend-ceiling";
import { RUN_CEILINGS, runCeilingsFor } from "@/components/work/clarify/run-disclosure";

/*
 * The one run budget, and the places that have to agree with it.
 *
 * `DEFAULT_RUN_BUDGET` used to be private to the runs route. The composer's
 * "Stops at $2 or 20 minutes" was a hand-copied mirror of it with a comment
 * asking whoever moved the original to come and move the copy, and the
 * schedule dispatchers did not apply it at all — a schedule with no budget of
 * its own stored zeros, and zero means "no ceiling" to `budgetExceeded`, so
 * the runs firing at 03:00 with nobody watching were the ones with no ceiling.
 * These cases are what stop either of those coming back.
 *
 * Since the ceiling became plan-shaped there is a second failure to guard, and
 * it is quieter: admission and the executor's guard read two different numbers.
 * `reserveSpend` refuses a run whose ceiling is above the per-unit ceiling, so
 * a build where those disagree refuses at the door every run on the plan that
 * pays for the larger one — with a message about a spending limit the account
 * had in fact bought past.
 */

const PLANS: readonly Plan[] = ["FREE", "PRO", "MAX", "MAX20", "OWNER"];

test("PRO's ceiling is exactly what every run in the product had before", () => {
  // The one figure that must not move. Everything else here may be re-priced;
  // this one changing means an existing account's runs changed length without
  // anybody choosing that.
  assert.deepEqual(runBudgetForPlan("PRO"), {
    maxCostMicroUsd: 2_000_000,
    maxTokens: 600_000,
    maxRuntimeMs: 20 * 60_000,
  });
  assert.deepEqual(DEFAULT_RUN_BUDGET, runBudgetForPlan("PRO"));
});

test("a trial account gets less and a paid account more, on every axis", () => {
  const free = runBudgetForPlan("FREE");
  const pro = runBudgetForPlan("PRO");
  const max = runBudgetForPlan("MAX");
  const max20 = runBudgetForPlan("MAX20");

  for (const axis of ["maxCostMicroUsd", "maxTokens", "maxRuntimeMs"] as const) {
    assert.ok(free[axis] < pro[axis], `FREE is not below PRO on ${axis}`);
    assert.ok(max[axis] > pro[axis], `MAX is not above PRO on ${axis}`);
    assert.ok(max20[axis] >= max[axis], `MAX20 is below MAX on ${axis}`);
  }
});

test("no plan gets an unbounded run, including the owner", () => {
  // `spend-ceiling.ts` exists because BUDGET_EUR.OWNER was null and switched
  // off both the pre-flight gate and the mid-stream abort on the one account
  // nobody bills. A zero on any axis here means "no ceiling" to
  // `budgetExceeded`, which would reopen that from the per-run side.
  for (const plan of PLANS) {
    const budget = runBudgetForPlan(plan);
    assert.ok(budget.maxCostMicroUsd > 0, `${plan} has no cost ceiling`);
    assert.ok(budget.maxTokens > 0, `${plan} has no token ceiling`);
    assert.ok(budget.maxRuntimeMs > 0, `${plan} has no runtime ceiling`);
  }
});

test("the table hands out copies, so one dispatcher cannot narrow another's", () => {
  const first = runBudgetForPlan("PRO");
  first.maxCostMicroUsd = 1;
  assert.equal(runBudgetForPlan("PRO").maxCostMicroUsd, 2_000_000);
});

test("admission and the run guard read the same number on every plan", () => {
  for (const plan of PLANS) {
    assert.equal(
      unitCeilingMicroUsd("work", plan),
      runBudgetForPlan(plan).maxCostMicroUsd,
      `${plan} would be refused by admission at its own ceiling`
    );
  }
  // Every other kind still reads the flat table, and a kind with no entry
  // still has no per-unit ceiling at all.
  assert.equal(unitCeilingMicroUsd("research", "FREE"), UNIT_CEILING_MICRO_USD.research);
  assert.equal(unitCeilingMicroUsd("chat", "MAX"), undefined);
});

test("the composer's sentence is derived from the plan, not copied", () => {
  for (const plan of PLANS) {
    const ceilings = runCeilingsFor(plan);
    const budget = runBudgetForPlan(plan);
    assert.equal(ceilings.costUsd * 1_000_000, budget.maxCostMicroUsd, plan);
    assert.equal(ceilings.tokens, budget.maxTokens, plan);
    assert.equal(ceilings.minutes * 60_000, budget.maxRuntimeMs, plan);
  }
  // The fallback a surface states when it has not been told whose account it
  // is drawing is PRO's, which is what every such surface was written against.
  assert.deepEqual(RUN_CEILINGS, runCeilingsFor("PRO"));
});

test("a schedule with no budget of its own gets its plan's ceiling on every axis", () => {
  assert.deepEqual(narrowestBudget(NO_BUDGET, runBudgetForPlan("FREE")), runBudgetForPlan("FREE"));
  assert.deepEqual(narrowestBudget(NO_BUDGET, runBudgetForPlan("MAX")), runBudgetForPlan("MAX"));
});

test("a schedule may lower a ceiling and never raise one", () => {
  const merged = narrowestBudget(
    { maxCostMicroUsd: 500_000, maxTokens: 0, maxRuntimeMs: 60 * 60_000 },
    DEFAULT_RUN_BUDGET
  );
  assert.equal(merged.maxCostMicroUsd, 500_000);
  assert.equal(merged.maxTokens, DEFAULT_RUN_BUDGET.maxTokens);
  // An hour asked for, twenty minutes granted: the plan's budget is a ceiling,
  // not a default.
  assert.equal(merged.maxRuntimeMs, DEFAULT_RUN_BUDGET.maxRuntimeMs);
});

test("a trial account cannot be handed a paid account's ceiling by a schedule", () => {
  // The direction that matters most: the schedule row is client-writable, so a
  // schedule storing MAX's figures must still dispatch under FREE's.
  const merged = narrowestBudget(runBudgetForPlan("MAX"), runBudgetForPlan("FREE"));
  assert.deepEqual(merged, runBudgetForPlan("FREE"));
});

test("the step cap follows the clock it was given, and only ever upwards", () => {
  // 200 steps was sized for twenty minutes. A two-hour run left at 200 would
  // stop with three-quarters of its ceiling unspent, for a reason no surface
  // names.
  assert.equal(maxStepsForBudget(runBudgetForPlan("PRO"), 200), 200);
  assert.equal(maxStepsForBudget(runBudgetForPlan("MAX"), 200), 600);
  assert.equal(maxStepsForBudget(runBudgetForPlan("MAX20"), 200), 1200);
  // A shorter clock is already stopped by the clock; cutting its steps as well
  // would refuse a short run that was doing many small things.
  assert.equal(maxStepsForBudget(runBudgetForPlan("FREE"), 200), 200);
  // A run written before ceilings were filled in carries zeros, which mean "no
  // ceiling" — not "no steps".
  assert.equal(maxStepsForBudget(NO_BUDGET, 200), 200);
});

test("every dispatcher merges the plan's budget in", () => {
  // Source checks, because each of these builds a `budget` object for
  // `createRun` and the failure — a zero copied straight onto the run, or a
  // flat constant that ignores the account — is invisible from any client
  // until a run has spent an unbounded amount or stopped far too early.
  for (const file of [
    "../src/app/api/work/sessions/[id]/runs/route.ts",
    "../src/app/api/work/schedules/[id]/run-now/route.ts",
    "../scripts/work-scheduler.ts",
    "../scripts/work-trigger-poller.ts",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /runBudgetForPlan\(/, file);
    assert.doesNotMatch(source, /DEFAULT_RUN_BUDGET/, file);
  }
  for (const file of [
    "../src/app/api/work/schedules/[id]/run-now/route.ts",
    "../scripts/work-scheduler.ts",
    "../scripts/work-trigger-poller.ts",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /narrowestBudget\(/, file);
  }
});
