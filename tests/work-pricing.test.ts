import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_LIST, resolveModel } from "@/lib/models";
import { tokenRate } from "@/lib/pricing";
import { isWorkCapableModel } from "@/lib/work/models";

/*
 * What a Work run's tokens cost.
 *
 * `WorkBudgetGuard.record()` returns before the cost arithmetic when it has no
 * pricing, and `scripts/work-runner.ts` never supplied any — so every cloud run
 * counted its tokens correctly and reported `costMicroUsd: 0`. A run that had
 * spent real money displayed "$0.00", and `budgetExceeded` compares the
 * per-run ceiling against that same zero, so `maxCostMicroUsd` could never
 * fire: only the token and runtime limits could stop a run.
 *
 * The runner now derives pricing from `tokenRate` — the same catalog rate the
 * chat surfaces bill against, so a Work run and a chat turn on one model cannot
 * disagree. `pricingFor` itself is not importable (work-runner.ts ends in
 * `void main()` and would start a worker), so what is pinned here is the
 * property the wiring depends on: the catalog gives every model a usable rate,
 * and the conversion into the guard's integer units is faithful.
 */

/** The conversion in `pricingFor`: catalog USD/MTok → guard micro-USD/MTok. */
function microUsdPerMillion(usdPerMillion: number): number {
  return Math.round(usdPerMillion * 1_000_000);
}

test("every work-capable model has a non-zero rate to bill against", () => {
  const capable = MODEL_LIST.filter(isWorkCapableModel);
  assert.ok(capable.length > 0, "no work-capable models in the catalog");

  for (const model of capable) {
    const rate = tokenRate(model);
    // A zero rate would put the guard back where it started: tokens counted,
    // cost zero, ceiling unenforceable — but silently, for one model rather
    // than for all of them, which is harder to notice.
    assert.ok(
      rate.input > 0,
      `${model.id} has no input rate, so its runs would bill nothing`
    );
    assert.ok(
      rate.output > 0,
      `${model.id} has no output rate, so its runs would bill nothing`
    );
  }
});

test("the conversion into the guard's integer units is faithful", () => {
  // The guard accumulates in integers against `WorkRun.maxCostMicroUsd`, an Int
  // column. Floating-point currency summed over a few hundred steps drifts away
  // from the ceiling it is compared against.
  assert.equal(microUsdPerMillion(1.5), 1_500_000);
  assert.equal(microUsdPerMillion(7.5), 7_500_000);
  assert.equal(microUsdPerMillion(0.15), 150_000);
  // Sub-micro rates round rather than truncate to zero.
  assert.equal(microUsdPerMillion(0.0000004), 0);
  assert.equal(microUsdPerMillion(0.0000006), 1);
});

test("the model a real run used is priced, and 17K tokens is not free", () => {
  // The reported run: mistral-medium-latest, 17K tokens, displayed as $0.00.
  const model = resolveModel("mistral:mistral-medium-latest");
  assert.ok(model, "mistral-medium-latest is missing from the catalog");
  const rate = tokenRate(model);
  assert.equal(microUsdPerMillion(rate.input), 1_500_000);
  assert.equal(microUsdPerMillion(rate.output), 7_500_000);

  // Even entirely as input — the cheaper half — that run cost something.
  const costMicroUsd = Math.round((17_000 * microUsdPerMillion(rate.input)) / 1_000_000);
  assert.ok(costMicroUsd > 0, "17K tokens still prices to zero");
  assert.equal(costMicroUsd, 25_500); // $0.0255
});

test("a per-run ceiling can now actually be reached", () => {
  // The default is $2.00 (`DEFAULT_RUN_BUDGET.maxCostMicroUsd = 2_000_000`).
  // With pricing wired, a long run reaches it; with pricing absent it could
  // not, which is the defect this file exists for.
  const model = resolveModel("mistral:mistral-medium-latest");
  assert.ok(model);
  const rate = tokenRate(model);
  const outputMicro = microUsdPerMillion(rate.output);

  const tokensToBurnTwoDollars = Math.ceil((2_000_000 * 1_000_000) / outputMicro);
  // Reachable inside a plausible run rather than an absurd one: if this needed
  // billions of tokens the ceiling would be decorative even when wired.
  assert.ok(
    tokensToBurnTwoDollars < 1_000_000,
    `$2.00 needs ${tokensToBurnTwoDollars} output tokens, which no run would reach`
  );
});
