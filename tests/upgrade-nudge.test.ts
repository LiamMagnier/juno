import test from "node:test";
import assert from "node:assert/strict";
import { upgradeNudge } from "@/lib/billing/upgrade-nudge";

const window = (spent: number, budget: number | null) => ({ pct: 0, spentMicroUsd: spent, budgetMicroUsd: budget, resetsAtMs: 0 });
const spend = (spent: number, budget: number | null, session = window(0, 100), weekly = window(0, 100)) => ({
  spentMicroUsd: spent,
  reservedMicroUsd: 0,
  budgetMicroUsd: budget,
  windows: { session, weekly },
});
const SOLD = ["PRO", "MAX", "MAX20"] as const;

test("Free is always offered the way up, whatever it has used", () => {
  assert.equal(upgradeNudge({ plan: "FREE", billing: true, purchasablePlans: [...SOLD], spend: spend(0, 1000) }), "free");
});

test("a paid plan is offered it only near its limit", () => {
  const base = { plan: "PRO" as const, billing: true, purchasablePlans: [...SOLD] };
  assert.equal(upgradeNudge({ ...base, spend: spend(500, 1000) }), null);
  assert.equal(upgradeNudge({ ...base, spend: spend(800, 1000) }), "near_limit");
  assert.equal(upgradeNudge({ ...base, spend: spend(100, 1000, window(95, 100)) }), "near_limit");
  assert.equal(upgradeNudge({ ...base, spend: spend(100, 1000, window(0, 100), window(91, 100)) }), "near_limit");
});

test("never when there is nowhere to go, no billing, no budget, or the owner", () => {
  assert.equal(upgradeNudge({ plan: "MAX20", billing: true, purchasablePlans: [...SOLD], spend: spend(999, 1000) }), null);
  assert.equal(upgradeNudge({ plan: "FREE", billing: false, purchasablePlans: [...SOLD], spend: spend(0, 1000) }), null);
  assert.equal(upgradeNudge({ plan: "PRO", billing: true, purchasablePlans: [...SOLD], spend: spend(999, null) }), null);
  assert.equal(upgradeNudge({ plan: "OWNER", billing: true, purchasablePlans: [...SOLD], spend: spend(0, null) }), null);
});
