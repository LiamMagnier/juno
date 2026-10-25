import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { MODEL_LIST, type ModelInfo } from "@/lib/models";
import { routeAuto, type RouteInput } from "@/lib/router/decide";
import {
  costTierOf,
  latencyTierOf,
  parseRoutingFactors,
  parseRoutingReceipt,
  receiptFromDecision,
  receiptSummary,
  type RoutingReceipt,
} from "@/lib/router/receipt";

/*
 * Auto's receipt as a truthful internal record (master brief Part 4.2): every
 * decision factor the router turned on is stored with the answer — selected
 * model, task class, complexity, modality, tools needed, context size,
 * provider health, cost and latency tier, plan, preference — each one equal to
 * the decision's own fact, and a plain sentence for the reader is derived from
 * them. Old receipts (no factors) still parse; malformed factors are dropped
 * whole rather than half-believed.
 */

const byId = (id: string): ModelInfo => {
  const m = MODEL_LIST.find((x) => x.id === id);
  assert.ok(m, `catalogue has ${id}`);
  return m;
};

const POOL: ModelInfo[] = [
  "openai:gpt-6-luna",
  "openai:gpt-6.1-sol",
  "anthropic:claude-haiku-5-5",
  "anthropic:claude-sonnet-5-5",
  "anthropic:claude-opus-5-5",
  "google:gemini-3.8-flash",
  "xai:grok-4.7",
  "qwen:qwen3.8-flash",
].map(byId);

function route(message: string, extra: Partial<RouteInput> = {}) {
  return routeAuto({
    message,
    plan: "PRO",
    catalogue: POOL,
    isConfigured: () => true,
    paidTier: new Set(["google"]),
    ...extra,
  });
}

const HARD_CODING =
  "Refactor this repository's auth module across multiple files to use a distributed session store, handle race conditions, and prove it correct step by step.";

describe("factors are the decision's own facts", () => {
  test("selected model, class, complexity, plan, preference, candidates, context", () => {
    const d = route(HARD_CODING, { plan: "MAX", preference: "quality", contextTokens: 42_000 });
    const f = receiptFromDecision(d).factors!;
    assert.equal(f.selected, d.model.id);
    assert.equal(f.complexity, d.profile.complexity);
    assert.equal(f.plan, "MAX");
    assert.equal(f.preference, "quality");
    assert.equal(f.candidates, d.ranked.length);
    assert.equal(f.contextTokens, d.profile.estInputTokens);
    assert.ok(f.contextTokens >= 42_000, "the router's context estimate, not just the prompt");
    assert.equal(f.routerVersion, d.routerVersion);
    assert.equal(f.cost.tier, costTierOf(d.model.cost));
    assert.equal(
      f.cost.expectedMicroUsd,
      d.ranked[0].callMicroUsd + d.ranked[0].toolRoundsMicroUsd + d.ranked[0].retriesMicroUsd
    );
    assert.equal(f.latency.tier, latencyTierOf(d.ranked[0].expectedLatencyS));
    assert.equal(f.evidence.source, "prior");
    assert.equal(f.evidence.shiftedFrom, null);
  });

  test("modality and tools needed", () => {
    const plain = receiptFromDecision(route("hi")).factors!;
    assert.deepEqual(plain.modality, { input: "text", output: "text" });
    assert.deepEqual(plain.tools, { webSearch: false, imageGeneration: false, connectors: 0, reliable: false });

    const seeing = receiptFromDecision(route("what is this", { hasImages: true })).factors!;
    assert.equal(seeing.modality.input, "text_image");

    const web = receiptFromDecision(route("latest news on the EU AI Act", { wantsWebSearch: true })).factors!;
    assert.equal(web.tools.webSearch, true);
    assert.equal(web.tools.reliable, true);

    const picture = receiptFromDecision(route("draw a fox", { wantsImage: true })).factors!;
    assert.equal(picture.modality.output, "image");
    assert.equal(picture.tools.imageGeneration, true);

    const agentic = receiptFromDecision(route("send an email to Sam on my behalf", { toolsOffered: 3 })).factors!;
    assert.equal(agentic.tools.connectors, 3);
    assert.equal(agentic.tools.reliable, true);
  });

  test("an image request on a field with no tool-calling model says the answer is text", () => {
    const noTools = POOL.map((m) => ({ ...m, agenticTools: false }));
    const d = routeAuto({ message: "draw a fox", plan: "PRO", catalogue: noTools, isConfigured: () => true, wantsImage: true });
    assert.equal(d.factors.tools.imageGeneration, true, "the need is recorded");
    assert.equal(d.factors.modality.output, "text", "but the turn cannot make a picture");
    assert.ok(!/picture/.test(receiptSummary(receiptFromDecision(d))!));
  });

  test("provider health: who was down, and the rate-limit pressure on the answer's provider", () => {
    const first = route(HARD_CODING);
    const down = first.model.provider;
    const d = route(HARD_CODING, {
      isProviderAvailable: (p) => p !== down,
      retryPressure: (p) => (p === "xai" ? 0.375 : 0),
    });
    const f = receiptFromDecision(d).factors!;
    assert.deepEqual(f.providerHealth.down, [down]);
    assert.notEqual(f.selected.split(":")[0], down);
    assert.equal(f.providerHealth.retryPressure, d.model.provider === "xai" ? 0.38 : 0);
    assert.match(receiptSummary(receiptFromDecision(d))!, /skipped a provider that was having trouble/);

    const healthy = receiptFromDecision(route(HARD_CODING)).factors!;
    assert.deepEqual(healthy.providerHealth.down, []);
  });

  test("the choice factor matches the decision's comparison", () => {
    const easy = route("hey, what's 2+2?");
    assert.equal(easy.factors.choice, "lowest_cost");
    assert.ok(easy.reasons.some((r) => r.startsWith("lowest expected cost")));
    const hard = route(HARD_CODING, { preference: "quality" });
    assert.equal(hard.factors.choice, "better_odds");
    assert.ok(hard.reasons.some((r) => r.startsWith("better odds")));
    const alone = routeAuto({ message: "hi", plan: "PRO", catalogue: [byId("openai:gpt-6-luna")], isConfigured: () => true });
    assert.equal(alone.factors.choice, "only_option");
  });

  test("budget saver: recorded, never cut from the reasons, and said plainly", () => {
    // Four task signals compete for the four reason lines here.
    const d = route("Fix the bug in this Python function shown in the screenshot; return the result as a JSON table", {
      hasImages: true,
      wantsWebSearch: true,
      lowBudget: true,
    });
    assert.equal(d.budgetSaver, true);
    assert.equal(d.factors.budgetSaver, true);
    const receipt = receiptFromDecision(d);
    assert.ok(receipt.reasons.length <= 4);
    assert.ok(receipt.reasons.includes("saving your remaining budget"), receipt.reasons.join(" | "));
    assert.match(receiptSummary(receipt)!, /budget is nearly used/);
  });
});

describe("a reroute describes the model that answered", () => {
  test("per-model facts follow the substitute; the router's pick stays as selected", () => {
    const d = route(HARD_CODING);
    const other = d.ranked.find((c) => c.provider !== d.model.provider)!;
    const receipt = { ...receiptFromDecision(d, other.modelId), rerouted: d.model.id, rerouteReason: "unreachable" as const };
    const f = receipt.factors!;
    assert.equal(f.selected, d.model.id);
    assert.equal(f.pSuccess, other.pSuccess);
    assert.equal(f.latency.expectedS, other.expectedLatencyS);
    assert.equal(f.cost.tier, costTierOf(other.costTier));
    assert.equal(f.cost.expectedMicroUsd, other.callMicroUsd + other.toolRoundsMicroUsd + other.retriesMicroUsd);
    assert.equal(f.choice, "only_option");
    assert.match(receiptSummary(receipt)!, /first choice couldn't be reached/);
    const capacity: RoutingReceipt = { ...receipt, rerouteReason: "capacity" };
    assert.match(receiptSummary(capacity)!, /today's capacity/);
    // The reason survives storage, and only alongside a reroute.
    assert.equal(parseRoutingReceipt(JSON.parse(JSON.stringify(capacity)))?.rerouteReason, "capacity");
    assert.equal(parseRoutingReceipt({ ...capacity, rerouted: null })?.rerouteReason, undefined);
  });

  test("the same model, or one the decision never scored, leaves the factors alone", () => {
    const d = route("hi");
    assert.deepEqual(receiptFromDecision(d, d.model.id).factors, d.factors);
    assert.deepEqual(receiptFromDecision(d, "nobody:model").factors, d.factors);
  });
});

describe("storage", () => {
  test("round-trips exactly", () => {
    const d = route(HARD_CODING, { isProviderAvailable: (p) => p !== "openai" });
    const receipt = receiptFromDecision(d);
    assert.deepEqual(parseRoutingReceipt(JSON.parse(JSON.stringify(receipt))), { ...receipt, rerouted: null });
  });

  test("a receipt written before factors existed still reads, without a summary", () => {
    const old = { v: 1, effort: "high", taskClass: "coding", reasons: ["coding"], degraded: null, rerouted: null };
    const parsed = parseRoutingReceipt(old);
    assert.ok(parsed);
    assert.equal(parsed.factors, undefined);
    assert.equal(receiptSummary(parsed), null);
  });

  test("malformed factors are dropped whole; the rest of the receipt stands", () => {
    const good = receiptFromDecision(route("hi"));
    const bad = (patch: Record<string, unknown>) =>
      parseRoutingReceipt(JSON.parse(JSON.stringify({ ...good, factors: { ...good.factors, ...patch } })));
    for (const patch of [
      { pSuccess: 2 },
      { tools: null },
      { complexity: "galaxy" },
      { choice: "whim" },
      { contextTokens: -1 },
      { providerHealth: { down: [], retryPressure: 3 } },
      { evidence: { source: "rumour", samples: 1, shiftedFrom: null } },
    ]) {
      const parsed = bad(patch);
      assert.ok(parsed, JSON.stringify(patch));
      assert.equal(parsed.factors, undefined, JSON.stringify(patch));
      assert.deepEqual(parsed.reasons, good.reasons);
    }
    assert.equal(parseRoutingFactors("nope"), null);
    assert.equal(parseRoutingFactors(null), null);
  });
});

describe("the reader's sentence", () => {
  const summary = (message: string, extra: Partial<RouteInput> = {}) => receiptSummary(receiptFromDecision(route(message, extra)))!;

  test("names the need that decided it", () => {
    assert.match(summary("hey, what's 2+2?"), /^A quick everyday question/);
    assert.match(summary("what is in this picture", { hasImages: true }), /includes an image/);
    assert.match(summary("What changed this week?", { wantsWebSearch: true }), /search the web/);
    assert.match(summary("summarise this thread", { contextTokens: 250_000 }), /about 251k tokens/);
    assert.match(summary("draw a fox", { wantsImage: true }), /picture/);
    assert.match(summary("send an email to Sam on my behalf", { toolsOffered: 2 }), /connected apps/);
    assert.match(summary(HARD_CODING), /^Complex coding/);
  });

  test("claims a trade-off only as the factors record it", () => {
    const easy = receiptFromDecision(route("hey, what's 2+2?"));
    assert.equal(easy.factors!.choice, "lowest_cost");
    assert.match(receiptSummary(easy)!, easy.factors!.cost.tier === "low" ? /low-cost/ : /best-value|fast/);
    assert.ok(!/more likely to get it right/.test(receiptSummary(easy)!));
    const hard = receiptFromDecision(route(HARD_CODING, { preference: "quality" }));
    assert.match(receiptSummary(hard)!, /more likely to get it right first time/);
    // Adjectives come from the tiers, not the wording.
    const slow: RoutingReceipt = {
      ...easy,
      factors: { ...easy.factors!, latency: { tier: "slow", expectedS: 30 }, cost: { tier: "high", expectedMicroUsd: 90_000 } },
    };
    assert.equal(receiptSummary(slow), "A quick everyday question, so Auto chose the best-value model.");
  });

  test("relaxed rules come first", () => {
    assert.match(summary(HARD_CODING, { remainingBudgetMicroUsd: 0 }), /what's left of your budget/);
    assert.match(summary("hi", { isProviderAvailable: () => false }), /Every eligible provider was reporting trouble/);
  });

  test("short, and never a number it should not show", () => {
    for (const s of [summary("hi"), summary(HARD_CODING), summary("what is this", { hasImages: true, wantsWebSearch: true })]) {
      assert.ok(s.length <= 200, s);
      assert.ok(!/\$|%|µ|\b0\.\d/.test(s), s);
    }
  });
});
