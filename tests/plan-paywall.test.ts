import test from "node:test";
import assert from "node:assert/strict";
import { PLANS, canUseModel, effectiveMinPlan } from "@/lib/plans";
import { MODEL_LIST } from "@/lib/models";
import { pickAutoModel } from "@/lib/auto-model";

/*
 * The paywall, pinned from both sides: a Free account cannot call any model —
 * not even the ones the catalog itself prices at minPlan FREE — and every paid
 * plan can call what it pays for. The matching zero spend ceiling
 * (BUDGET_EUR.FREE, spend.ts) and the chat route's early 402 are enforced at
 * runtime and deliberately not imported here: their module chains are
 * server-only.
 */

test("FREE includes no messages, and says so first", () => {
  const free = PLANS.FREE;
  assert.equal(free.monthlyMessages, 0);
  // Settings renders only the first three feature lines — the constraint must
  // lead, and nothing may promise a model reply.
  assert.match(free.features[0], /No messages/);
  for (const line of [free.tagline, ...free.features]) {
    assert.doesNotMatch(line, /\b\d+ messages\b|trial|everyday models|canvas|artifact|upload/i, line);
  }
});

test("every model is floored at Pro", () => {
  assert.equal(effectiveMinPlan("FREE"), "PRO");
  assert.equal(effectiveMinPlan("PRO"), "PRO");
  assert.equal(effectiveMinPlan("MAX"), "MAX", "a higher catalog minimum is kept");
});

test("FREE cannot use any model, even the ones the catalog prices at FREE", () => {
  const freePriced = MODEL_LIST.filter((m) => m.minPlan === "FREE");
  assert.ok(freePriced.length > 0, "the catalog still prices some models at FREE");
  for (const m of MODEL_LIST) {
    assert.equal(canUseModel("FREE", m.id), false, `${m.id} (${m.minPlan}) is usable on FREE`);
  }
});

test("Auto stays selectable on FREE, but the router has nothing FREE may call", () => {
  // The sentinel is selectable so the picker has a default; the quota (limit 0)
  // is what the composer reads to show the upgrade notice instead of sending.
  assert.equal(canUseModel("FREE", "juno:auto"), true);
  assert.equal(canUseModel("FREE", "auto"), true);
  const pick = pickAutoModel({ message: "hi", plan: "FREE" });
  assert.equal(
    canUseModel("FREE", pick.model.id),
    false,
    "Auto's last resort must not be a model FREE is entitled to; the route's own gates refuse it"
  );
});

test("PRO can use the Pro tier, and plan floors still order above it", () => {
  const proTier = MODEL_LIST.filter(
    (m) => m.modality === "chat" && !m.comingSoon && (m.minPlan === "FREE" || m.minPlan === "PRO")
  );
  assert.ok(proTier.length > 0, "the catalog must offer a Pro tier");
  for (const m of proTier) {
    assert.ok(canUseModel("PRO", m.id), `${m.id} (${m.minPlan}) is locked for PRO`);
  }
  const pick = pickAutoModel({ message: "hi", plan: "PRO" });
  assert.ok(canUseModel("PRO", pick.model.id), `Auto picked ${pick.model.id}, which PRO cannot call`);

  const maxOnly = MODEL_LIST.find((m) => m.minPlan === "MAX");
  if (maxOnly) assert.equal(canUseModel("PRO", maxOnly.id), false);
});
