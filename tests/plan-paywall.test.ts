import test from "node:test";
import assert from "node:assert/strict";
import { PLANS, PLAN_LIST, canUseModel, effectiveMinPlan, modelRequiredPlan, planRank } from "@/lib/plans";
import { MODEL_LIST } from "@/lib/models";
import { pickAutoModel } from "@/lib/auto-model";
import { NoAutoCandidateError } from "@/lib/router/decide";

/*
 * The paywall, pinned from both sides: a Free account gets a small allowance
 * on cost-1 models only, Lite adds the rest of the catalog's FREE-priced
 * models, and Pro-priced models stay Pro. The matching spend ceilings
 * (BUDGET_EUR, spend.ts) and the chat route's 402 are enforced at runtime and
 * deliberately not imported here: their module chains are server-only.
 */

test("FREE leads with its allowance and promises nothing it cannot deliver", () => {
  const free = PLANS.FREE;
  assert.equal(free.monthlyMessages, null, "Free is metered by its token budget, not a message count");
  assert.match(free.features[0], /allowance/);
  for (const line of [free.tagline, ...free.features]) {
    assert.doesNotMatch(line, /\b\d+ messages\b|unlimited|voice|web search|agents/i, line);
  }
  for (const flag of ["voice", "webSearch", "code", "agents", "research"] as const) {
    assert.equal(free[flag], false, `Free must not include ${flag}`);
  }
});

test("Lite is chat-first: web search yes, Code, agents, research and voice no", () => {
  const lite = PLANS.LITE;
  assert.equal(lite.webSearch, true);
  for (const flag of ["voice", "code", "agents", "research"] as const) {
    assert.equal(lite[flag], false, `Lite must not include ${flag}`);
  }
  for (const plan of ["PRO", "PLUS", "MAX", "MAX20", "ULTRA"] as const) {
    assert.equal(PLANS[plan].code, true, `${plan} includes Code`);
    assert.equal(PLANS[plan].agents, true, `${plan} includes agents`);
  }
});

test("tier order runs Free < Lite < Pro < Plus < Max ×5 < Max ×10 < Ultra", () => {
  const order = ["FREE", "LITE", "PRO", "PLUS", "MAX", "MAX20", "ULTRA", "OWNER"] as const;
  for (let i = 1; i < order.length; i++) {
    assert.ok(planRank(order[i]) > planRank(order[i - 1]), `${order[i]} ranks above ${order[i - 1]}`);
  }
  assert.deepEqual(
    PLAN_LIST.map((p) => p.id),
    ["FREE", "LITE", "PRO", "PLUS", "MAX", "MAX20", "ULTRA"]
  );
});

test("FREE-priced models split by cost: cost 1 is Free, the rest is Lite; Pro stays Pro", () => {
  for (const m of MODEL_LIST) {
    const required = modelRequiredPlan(m);
    if (m.minPlan === "FREE") assert.equal(required, m.cost <= 1 ? "FREE" : "LITE", m.id);
    else assert.equal(required, m.minPlan, m.id);
  }
  assert.equal(effectiveMinPlan("FREE"), "LITE");
  assert.equal(effectiveMinPlan("PRO"), "PRO");
  assert.equal(effectiveMinPlan("MAX"), "MAX", "a higher catalog minimum is kept");
});

test("FREE can use exactly the cost-1 FREE-priced models", () => {
  const cheap = MODEL_LIST.filter((m) => m.minPlan === "FREE" && m.cost <= 1);
  assert.ok(cheap.length > 0, "the catalog has cost-1 FREE models for the allowance");
  for (const m of MODEL_LIST) {
    assert.equal(canUseModel("FREE", m.id), m.minPlan === "FREE" && m.cost <= 1, `${m.id} on FREE`);
    assert.equal(canUseModel("LITE", m.id), m.minPlan === "FREE", `${m.id} on LITE`);
  }
});

test("Auto stays selectable on FREE, and routes only inside the plan when a provider is configured", () => {
  assert.equal(canUseModel("FREE", "juno:auto"), true);
  assert.equal(canUseModel("FREE", "auto"), true);
  // With every provider configured the router routes inside the plan or says
  // why it cannot (NoAutoCandidateError) — it has no "last resort" that
  // ignores the plan (Auto Router 2.0, src/lib/router/decide.ts).
  try {
    const pick = pickAutoModel({ message: "hi", plan: "FREE", context: { isConfigured: () => true } });
    assert.equal(canUseModel("FREE", pick.model.id), true);
  } catch (error) {
    assert.ok(error instanceof NoAutoCandidateError);
  }
});

test("PRO can use the Pro tier, and plan floors still order above it", () => {
  const proTier = MODEL_LIST.filter(
    (m) => m.modality === "chat" && !m.comingSoon && (m.minPlan === "FREE" || m.minPlan === "PRO")
  );
  assert.ok(proTier.length > 0, "the catalog must offer a Pro tier");
  for (const m of proTier) {
    assert.ok(canUseModel("PRO", m.id), `${m.id} (${m.minPlan}) is locked for PRO`);
  }
  const pick = pickAutoModel({ message: "hi", plan: "PRO", context: { isConfigured: () => true } });
  assert.ok(canUseModel("PRO", pick.model.id), `Auto picked ${pick.model.id}, which PRO cannot call`);

  const maxOnly = MODEL_LIST.find((m) => m.minPlan === "MAX");
  if (maxOnly) assert.equal(canUseModel("PRO", maxOnly.id), false);
});
