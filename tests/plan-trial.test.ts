import test from "node:test";
import assert from "node:assert/strict";
import { PLANS, canUseModel, effectiveMinPlan } from "@/lib/plans";
import { MODEL_LIST } from "@/lib/models";

/*
 * The FREE trial, pinned from both sides: a signed-up user can actually send
 * a message (the audit's conversion killer was monthlyMessages: 0), and the
 * paid catalog stays paid — the trial only unlocks what the catalog itself
 * prices at minPlan FREE. The matching spend ceiling (BUDGET_EUR.FREE,
 * spend.ts) is enforced at runtime through checkBudget and is deliberately
 * not imported here: its module chain is server-only.
 */

test("FREE grants a real trial allowance, and says so first", () => {
  const free = PLANS.FREE;
  assert.equal(free.monthlyMessages, 15);
  // Settings renders only the first three feature lines — the allowance must
  // lead, and must state the same number the quota enforces.
  assert.match(free.features[0], /15/);
});

test("the trial unlocks exactly the models the catalog prices at FREE", () => {
  assert.equal(effectiveMinPlan("FREE"), "FREE", "the Pro floor is lifted for the trial tier");

  const trialTier = MODEL_LIST.filter(
    (m) => m.modality === "chat" && !m.comingSoon && m.minPlan === "FREE"
  );
  assert.ok(trialTier.length > 0, "the catalog must offer a trial tier");
  for (const m of trialTier) {
    assert.ok(canUseModel("FREE", m.id), `${m.id} is FREE-priced but locked for FREE`);
  }
});

test("paid models stay locked for trial users", () => {
  for (const m of MODEL_LIST) {
    if (m.minPlan === "FREE") continue;
    assert.equal(canUseModel("FREE", m.id), false, `${m.id} (${m.minPlan}) leaked into the trial`);
  }
  // And plan floors still order correctly above the trial.
  const maxOnly = MODEL_LIST.find((m) => m.minPlan === "MAX");
  if (maxOnly) assert.equal(canUseModel("PRO", maxOnly.id), false);
});
