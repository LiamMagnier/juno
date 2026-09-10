import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NO_BUDGET, narrowestBudget } from "@/lib/work/domain";
import { DEFAULT_RUN_BUDGET } from "@/lib/work/budget";
import { RUN_CEILINGS } from "@/components/work/clarify/run-disclosure";

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
 */

test("the composer's sentence is derived from the budget, not copied", () => {
  assert.equal(RUN_CEILINGS.costUsd * 1_000_000, DEFAULT_RUN_BUDGET.maxCostMicroUsd);
  assert.equal(RUN_CEILINGS.tokens, DEFAULT_RUN_BUDGET.maxTokens);
  assert.equal(RUN_CEILINGS.minutes * 60_000, DEFAULT_RUN_BUDGET.maxRuntimeMs);
});

test("a schedule with no budget of its own gets the standard ceiling on every axis", () => {
  assert.deepEqual(narrowestBudget(NO_BUDGET, DEFAULT_RUN_BUDGET), DEFAULT_RUN_BUDGET);
});

test("a schedule may lower a ceiling and never raise one", () => {
  const merged = narrowestBudget(
    { maxCostMicroUsd: 500_000, maxTokens: 0, maxRuntimeMs: 60 * 60_000 },
    DEFAULT_RUN_BUDGET
  );
  assert.equal(merged.maxCostMicroUsd, 500_000);
  assert.equal(merged.maxTokens, DEFAULT_RUN_BUDGET.maxTokens);
  // An hour asked for, twenty minutes granted: the standard budget is a
  // ceiling, not a default.
  assert.equal(merged.maxRuntimeMs, DEFAULT_RUN_BUDGET.maxRuntimeMs);
});

test("every dispatcher merges the standard budget in", () => {
  // Source checks, because each of these builds a `budget` object for
  // `createRun` and the failure — a zero copied straight onto the run — is
  // invisible from any client until a run has spent an unbounded amount.
  for (const file of [
    "../src/app/api/work/sessions/[id]/runs/route.ts",
    "../src/app/api/work/schedules/[id]/run-now/route.ts",
    "../scripts/work-scheduler.ts",
    "../scripts/work-trigger-poller.ts",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /DEFAULT_RUN_BUDGET/, file);
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
