import test from "node:test";
import assert from "node:assert/strict";
import {
  PERSONAL_DEFAULT_CAP_EUR,
  UNATTENDED_RUN_DEFAULT_MICRO_USD,
  applyHold,
  applyRelease,
  applySettle,
  describeCapSource,
  effectiveBudget,
  eurToMicroUsd,
  unattendedRunCeiling,
  type SpendLedger,
} from "@/lib/spend-ceiling";
import { createStreamBudgetGuard } from "@/lib/chat-budget-guard";

/*
 * The hole this closes, in one sentence: BUDGET_EUR.OWNER was null, so
 * budgetForPlan returned null, so checkBudget answered allowed:true without
 * reading the database — and createStreamBudgetGuard no-ops on a null ceiling.
 * The personal account had neither a pre-flight gate nor a mid-stream abort,
 * and nothing in the suite noticed, because every path to the decision went
 * through Prisma. The arithmetic now lives outside Prisma, so it can be tested.
 */

/** What `budgetForPlan` returns today, so the fixtures speak the real units. */
const PLAN_MICRO_USD = { FREE: 0, PRO: 11_000_000, OWNER: null } as const;

test("the personal account is capped by default rather than unlimited", () => {
  const owner = effectiveBudget({
    planBudgetMicroUsd: PLAN_MICRO_USD.OWNER,
    userCapEur: null,
    capDisabled: false,
  });
  assert.equal(owner.budgetMicroUsd, eurToMicroUsd(PERSONAL_DEFAULT_CAP_EUR));
  assert.equal(owner.budgetMicroUsd, 15_000_000);
  assert.equal(owner.source, "personal-default");
  assert.equal(owner.capDisabled, false);
  // The precise regression: a null budget used to reach every caller as
  // "unlimited". Only one branch may produce null now.
  assert.notEqual(owner.budgetMicroUsd, null);
});

test("the lower of the plan's ceiling and the account's own is the one that binds", () => {
  const lowered = effectiveBudget({
    planBudgetMicroUsd: PLAN_MICRO_USD.PRO,
    userCapEur: 4,
    capDisabled: false,
  });
  assert.equal(lowered.budgetMicroUsd, 4_000_000);
  assert.equal(lowered.source, "user");

  // Raising above the plan buys nothing — MIN, never MAX. A user cap that
  // outbid the plan would be a self-service upgrade.
  const raised = effectiveBudget({
    planBudgetMicroUsd: PLAN_MICRO_USD.PRO,
    userCapEur: 500,
    capDisabled: false,
  });
  assert.equal(raised.budgetMicroUsd, PLAN_MICRO_USD.PRO);
  assert.equal(raised.source, "plan");

  // FREE's zero survives any number the account writes.
  const free = effectiveBudget({
    planBudgetMicroUsd: PLAN_MICRO_USD.FREE,
    userCapEur: 50,
    capDisabled: false,
  });
  assert.equal(free.budgetMicroUsd, 0);
});

test("a personal account's own ceiling binds, above or below the default", () => {
  const lower = effectiveBudget({
    planBudgetMicroUsd: PLAN_MICRO_USD.OWNER,
    userCapEur: 3,
    capDisabled: false,
  });
  assert.equal(lower.budgetMicroUsd, 3_000_000);
  assert.equal(lower.source, "user");

  // No plan figure means there is nothing to take a minimum against, so this IS
  // the ceiling — which is exactly why the field is offered on that account.
  const higher = effectiveBudget({
    planBudgetMicroUsd: PLAN_MICRO_USD.OWNER,
    userCapEur: 40,
    capDisabled: false,
  });
  assert.equal(higher.budgetMicroUsd, 40_000_000);
  assert.equal(higher.source, "user");
});

test("spendCapDisabled is the only bypass, and it reports itself", () => {
  const off = effectiveBudget({
    planBudgetMicroUsd: PLAN_MICRO_USD.OWNER,
    userCapEur: 5,
    capDisabled: true,
  });
  assert.equal(off.budgetMicroUsd, null);
  assert.equal(off.capDisabled, true);
  assert.equal(off.source, "disabled");
  // The attribution string is what the settings tile renders; a bypass that
  // rendered as an ordinary ceiling would be indistinguishable from a generous
  // plan, which is how the personal account looked for a year.
  assert.match(describeCapSource(off.source), /switched off/i);

  // Emptying the number field is NOT a bypass. The two controls are separate
  // so that clearing one cannot silently disable enforcement.
  const empty = effectiveBudget({
    planBudgetMicroUsd: PLAN_MICRO_USD.OWNER,
    userCapEur: null,
    capDisabled: false,
  });
  assert.notEqual(empty.budgetMicroUsd, null);

  // Nor is a zero: zero is the tightest ceiling there is, not the absence of one.
  const zero = effectiveBudget({
    planBudgetMicroUsd: PLAN_MICRO_USD.OWNER,
    userCapEur: 0,
    capDisabled: false,
  });
  assert.equal(zero.budgetMicroUsd, 0);
  assert.equal(zero.capDisabled, false);
});

test("the EUR→micro-USD conversion follows the billing rate", () => {
  assert.equal(eurToMicroUsd(15, 1), 15_000_000);
  // 15 EUR of budget buys more USD of model spend when a USD costs 0.92 EUR.
  assert.equal(eurToMicroUsd(15, 0.92), 16_304_348);
  // A nonsense rate must not silently zero the ceiling.
  assert.equal(eurToMicroUsd(15, 0), 15_000_000);
});

test("two concurrent reservations cannot jointly exceed the ceiling", () => {
  /*
   * The window this closes is the whole duration of every in-flight
   * generation: checkBudget reads SETTLED spend, and the ledger is only written
   * when a turn ENDS, so two turns starting a second apart both read the same
   * under-budget total and were both admitted.
   *
   * `applyHold` is the predicate the production path runs as ONE conditional
   * SQL UPDATE. Applying it here the way the database does — decide and mutate
   * without yielding — is what shows the second caller being refused.
   */
  const ceiling = 1_000_000;
  let ledger: SpendLedger = { committedMicroUsd: 900_000, reservedMicroUsd: 0 };

  const admit = (estimate: number): boolean => {
    const next = applyHold(ledger, estimate, ceiling);
    if (!next) return false;
    ledger = next;
    return true;
  };

  assert.equal(admit(80_000), true, "the first turn fits in the remaining 100k");
  assert.equal(admit(80_000), false, "the second must see the first turn's hold");
  assert.equal(ledger.reservedMicroUsd, 80_000);
  assert.ok(ledger.committedMicroUsd + ledger.reservedMicroUsd <= ceiling);

  // Read-then-act, for contrast: both callers consult only settled spend, both
  // are admitted, and the account ends the pair 60k over its ceiling. This is
  // the behaviour that shipped.
  const settledOnly = 900_000;
  const naive = [80_000, 80_000].filter(() => settledOnly < ceiling);
  assert.equal(naive.length, 2);
  assert.ok(settledOnly + naive[0] + naive[1] > ceiling);
});

test("a hold released by settling frees exactly what it took", () => {
  const ceiling = 1_000_000;
  let ledger: SpendLedger = { committedMicroUsd: 0, reservedMicroUsd: 0 };
  ledger = applyHold(ledger, 400_000, ceiling)!;
  ledger = applyHold(ledger, 400_000, ceiling)!;
  assert.equal(applyHold(ledger, 400_000, ceiling), null, "1.2M would breach a 1M ceiling");

  ledger = applyRelease(ledger, 400_000);
  assert.equal(ledger.reservedMicroUsd, 400_000);
  assert.notEqual(applyHold(ledger, 400_000, ceiling), null, "the freed room is usable again");
});

test("settling refunds an over-estimate instead of keeping it", () => {
  // The estimate is a placeholder, not a charge: a chat turn held at $0.05 that
  // really cost $0.002 must give the difference back, or a busy day of cheap
  // turns would exhaust a ceiling it never came close to spending.
  const held: SpendLedger = { committedMicroUsd: 2_000, reservedMicroUsd: 50_000 };
  const { ledger, refundMicroUsd } = applySettle(held, 50_000, 2_000);
  assert.equal(refundMicroUsd, 48_000);
  assert.equal(ledger.reservedMicroUsd, 0);
  // The truth reached `committedMicroUsd` through recordSpend, which is the one
  // writer of settled money; settling must not add it a second time.
  assert.equal(ledger.committedMicroUsd, 2_000);
});

test("an under-estimate refunds nothing and the hold still clears", () => {
  const held: SpendLedger = { committedMicroUsd: 900_000, reservedMicroUsd: 50_000 };
  const { ledger, refundMicroUsd } = applySettle(held, 50_000, 900_000);
  assert.equal(refundMicroUsd, 0);
  assert.equal(ledger.reservedMicroUsd, 0);
});

test("a hold closed twice cannot manufacture headroom it never held", () => {
  // A retried terminal write, a runner and a sweeper can all arrive within a
  // second of each other. The floor is what stops the second one inventing
  // budget; production also guards on `state = "open"`.
  let ledger: SpendLedger = { committedMicroUsd: 0, reservedMicroUsd: 50_000 };
  ledger = applyRelease(ledger, 50_000);
  ledger = applyRelease(ledger, 50_000);
  assert.equal(ledger.reservedMicroUsd, 0);
});

test("a disabled ceiling admits every hold without pretending to meter", () => {
  const ledger: SpendLedger = { committedMicroUsd: 10 ** 9, reservedMicroUsd: 10 ** 9 };
  const next = applyHold(ledger, 10 ** 9, null);
  assert.notEqual(next, null);
});

test("the mid-stream guard now fires for the personal account", () => {
  /*
   * The second half of the same bug. `createStreamBudgetGuard` returns
   * immediately when `ceilingMicroUsd` is null, so the account with no plan
   * budget also had no abort: a runaway tool loop ran to completion.
   *
   * Same guard, same usage, two ceilings — the one the owner used to get and
   * the one effectiveBudget gives it now.
   */
  const usage = () => ({
    promptTokens: 2_000_000,
    completionTokens: 1_000_000,
    outputChars: 0,
    reasoningChars: 0,
  });
  const rates = { input: 3, output: 15 }; // µUSD per token — a frontier model

  const before: number[] = [];
  createStreamBudgetGuard({
    ceilingMicroUsd: null, // what budgetForPlan("OWNER") used to yield
    rates,
    inputChars: 0,
    usage,
    onHalt: () => before.push(1),
  }).enforce();
  assert.equal(before.length, 0, "this is the behaviour that shipped");

  const owner = effectiveBudget({
    planBudgetMicroUsd: PLAN_MICRO_USD.OWNER,
    userCapEur: null,
    capDisabled: false,
  });
  const after: number[] = [];
  const guard = createStreamBudgetGuard({
    ceilingMicroUsd: owner.budgetMicroUsd,
    rates,
    inputChars: 0,
    usage,
    onHalt: () => after.push(1),
  });
  guard.enforce();
  // 2M × 3 + 1M × 15 = 21 µUSD-million, past the €15 ceiling.
  assert.equal(after.length, 1);
  assert.equal(guard.halted, true);
});

test("a disabled ceiling still switches the mid-stream guard off", () => {
  // Honest about the cost of the bypass: turning enforcement off turns BOTH
  // halves off, which is why the settings tile shouts about it.
  const off = effectiveBudget({
    planBudgetMicroUsd: PLAN_MICRO_USD.OWNER,
    userCapEur: 1,
    capDisabled: true,
  });
  const halts: number[] = [];
  createStreamBudgetGuard({
    ceilingMicroUsd: off.budgetMicroUsd,
    rates: { input: 3, output: 15 },
    inputChars: 0,
    usage: () => ({
      promptTokens: 10 ** 9,
      completionTokens: 10 ** 9,
      outputChars: 0,
      reasoningChars: 0,
    }),
    onHalt: () => halts.push(1),
  }).enforce();
  assert.equal(halts.length, 0);
});

test("an unattended Work run gets a ceiling instead of 0-means-unlimited", () => {
  // Scheduled and trigger-fired runs defaulted to 0, and `budgetExceeded` reads
  // 0 as UNLIMITED — so the runs with nobody watching were the only ones with
  // no cost ceiling, while a manually started run got $2.
  assert.equal(unattendedRunCeiling(0), UNATTENDED_RUN_DEFAULT_MICRO_USD);
  assert.ok(UNATTENDED_RUN_DEFAULT_MICRO_USD > 0);
  // A figure the user actually chose is left exactly alone, in both directions.
  assert.equal(unattendedRunCeiling(250_000), 250_000);
  assert.equal(unattendedRunCeiling(9_000_000), 9_000_000);
  // Garbage from a stale row must fail toward the ceiling, not away from it.
  assert.equal(unattendedRunCeiling(Number.NaN), UNATTENDED_RUN_DEFAULT_MICRO_USD);
  assert.equal(unattendedRunCeiling(-5), UNATTENDED_RUN_DEFAULT_MICRO_USD);
});
