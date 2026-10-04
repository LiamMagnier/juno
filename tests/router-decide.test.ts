import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { MODEL_LIST, type ModelInfo } from "@/lib/models";
import { classifyPromptComplexity } from "@/lib/auto-model";
import {
  NoAutoCandidateError,
  REQUIRED_INTELLIGENCE,
  priorSuccess,
  routeAuto,
  type RouteInput,
} from "@/lib/router/decide";
import {
  PROVIDER_DATA_POLICIES,
  autoDataUseVerdict,
  parsePaidTierAttestation,
  providersWithUnverifiedTerms,
} from "@/lib/router/data-policy";
import { MIN_SAMPLES, aggregateOutcomes, posterior, shrink } from "@/lib/router/evidence";
import { classifyTask } from "@/lib/router/task-class";
import { parseRoutingReceipt, receiptFromDecision, receiptLine } from "@/lib/router/receipt";
import {
  __resetProviderPressureForTests,
  providerRetryPressure,
  recordProviderRateLimit,
} from "@/lib/router/provider-pressure";

/*
 * Auto Router 2.0 (src/lib/router): task classification, data-use policy,
 * expected-total-cost ranking, evidence with a sample guard and shrinkage,
 * availability/budget fallbacks, and the receipt. Pure — every environmental
 * fact is an input, so each branch is reachable here.
 */

const byId = (id: string): ModelInfo => {
  const m = MODEL_LIST.find((x) => x.id === id);
  assert.ok(m, `catalogue has ${id}`);
  return m;
};

const POOL = [
  "openai:gpt-6-luna",
  "anthropic:claude-opus-5-5",
  "anthropic:claude-sonnet-5-5",
  "qwen:qwen3.8-flash",
  "zhipu:glm-4.7-flash",
  "deepseek:deepseek-flash",
  "meta:muse-spark-1.3-contributor",
  "google:gemini-3.8-flash",
].map(byId);

function route(message: string, extra: Partial<RouteInput> = {}) {
  return routeAuto({ message, plan: "PRO", catalogue: POOL, isConfigured: () => true, ...extra });
}

const HARD_CODING =
  "Refactor this repository's auth module across multiple files to use a distributed session store, handle race conditions, and prove it correct step by step.";

describe("task classification", () => {
  const cls = (message: string, extra: Partial<Parameters<typeof classifyTask>[0]> = {}) =>
    classifyTask({ message, complexity: classifyPromptComplexity(message), ...extra });

  test("primary classes", () => {
    assert.equal(cls("hey, what's 2+2?").taskClass, "everyday");
    assert.equal(cls("Write a warm thank-you email to my landlord").taskClass, "writing");
    assert.equal(cls(HARD_CODING).taskClass, "coding");
    assert.equal(cls("What changed in the EU AI Act this week?", { wantsWebSearch: true }).taskClass, "research");
    assert.equal(cls("Return a JSON schema for a user profile").taskClass, "structured_output");
    assert.equal(cls("what is in this picture", { hasImages: true }).taskClass, "vision");
    assert.equal(cls("summarise", { contextTokens: 200_000 }).taskClass, "long_context");
    assert.equal(cls("send an email to Sam on my behalf about Friday", { toolsOffered: 2 }).taskClass, "agentic");
  });

  test("signals name what the router acted on", () => {
    const p = cls(HARD_CODING);
    assert.ok(p.signals.includes("repository-scale coding"), p.signals.join());
    assert.ok(p.signals.includes("complex reasoning"), p.signals.join());
    assert.ok(p.needs.coding && p.needs.reasoning);
  });

  test("works across locales (French coding ask)", () => {
    assert.equal(cls("Refactorise cette fonction Python et corrige le bug").taskClass, "coding");
  });
});

describe("data-use policy (BRIEF §51)", () => {
  const paid = parsePaidTierAttestation("google, Mistral");

  test("attestation parsing", () => {
    assert.deepEqual([...paid].sort(), ["google", "mistral"]);
    assert.equal(parsePaidTierAttestation(undefined).size, 0);
  });

  test("a training tier and a training provider are never eligible", () => {
    assert.equal(autoDataUseVerdict(byId("meta:muse-spark-1.3-contributor"), { paidTier: paid }).eligible, false);
    const v = autoDataUseVerdict(byId("deepseek:deepseek-flash"), { paidTier: paid });
    assert.equal(v.eligible, false);
    assert.equal(!v.eligible && v.reason, "trains_on_prompts");
  });

  test("unknown terms are ineligible, and every unknown is on the owner-blocker list", () => {
    const v = autoDataUseVerdict(byId("zhipu:glm-4.7-flash"), { paidTier: paid });
    assert.equal(!v.eligible && v.reason, "terms_unknown");
    for (const provider of providersWithUnverifiedTerms()) {
      assert.equal(PROVIDER_DATA_POLICIES[provider].source, null, `${provider} has no source`);
    }
    assert.equal(autoDataUseVerdict({ provider: "newlab" }, { paidTier: paid }).eligible, false);
  });

  test("tier-dependent terms need the owner's paid-tier attestation", () => {
    const gemini = byId("google:gemini-3.8-flash");
    const unattested = autoDataUseVerdict(gemini, { paidTier: new Set() });
    assert.equal(!unattested.eligible && unattested.reason, "unpaid_tier_unattested");
    assert.equal(autoDataUseVerdict(gemini, { paidTier: paid }).eligible, true);
  });

  test("the user's boundary only narrows", () => {
    const qwen = byId("qwen:qwen3.8-flash");
    assert.equal(autoDataUseVerdict(qwen, { paidTier: paid }).eligible, true);
    assert.equal(autoDataUseVerdict(qwen, { paidTier: paid, boundary: "exclude_prc" }).eligible, false);
    assert.equal(autoDataUseVerdict(byId("openai:gpt-6-luna"), { paidTier: paid, boundary: "eu_us_only" }).eligible, true);
  });

  test("the router never picks a model the policy refuses, on any prompt", () => {
    for (const message of ["hi", HARD_CODING, "Write a poem", "Return a JSON schema for orders"]) {
      const d = route(message);
      assert.equal(autoDataUseVerdict(d.model, { paidTier: new Set() }).eligible, true, `${message} → ${d.model.id}`);
      for (const c of d.ranked) {
        assert.ok(!["zhipu", "deepseek", "google"].includes(c.provider), `${c.modelId} was scored`);
        assert.notEqual(c.modelId, "meta:muse-spark-1.3-contributor");
      }
    }
    assert.ok((route("hi").excluded.data_use_terms ?? 0) >= 4);
  });
});

describe("expected total cost", () => {
  test("the total is exactly its parts", () => {
    for (const c of route(HARD_CODING).ranked) {
      assert.equal(
        c.expectedTotalMicroUsd,
        c.callMicroUsd + c.toolRoundsMicroUsd + c.retriesMicroUsd + c.failureMicroUsd + c.latencyMicroUsd
      );
    }
  });

  test("a quick question goes cheap; a hard one buys success odds", () => {
    const easy = route("hey, what's 2+2?");
    const hard = route(HARD_CODING);
    assert.equal(easy.profile.complexity, "simple");
    assert.ok(hard.ranked[0].pSuccess > easy.ranked.find((c) => c.modelId === easy.model.id)!.pSuccess - 0.1);
    const hardWinnerIntel = hard.ranked[0].pSuccess;
    const luna = hard.ranked.find((c) => c.modelId === "openai:gpt-6-luna")!;
    assert.ok(hardWinnerIntel >= luna.pSuccess, "the hard pick is at least as likely to succeed as the cheapest");
  });

  test("not merely the cheapest call: a cheaper model can lose on expected total", () => {
    const d = route(HARD_CODING, { preference: "quality" });
    const cheapestCall = [...d.ranked].sort((a, b) => a.callMicroUsd - b.callMicroUsd)[0];
    assert.notEqual(d.model.id, cheapestCall.modelId);
    assert.ok(d.reasons.some((r) => r.includes("better odds")), d.reasons.join(" | "));
  });

  test("preference moves the pick: quality never picks lower odds than economy", () => {
    const q = route(HARD_CODING, { preference: "quality" });
    const e = route(HARD_CODING, { preference: "economy" });
    assert.ok(q.ranked[0].pSuccess >= e.ranked[0].pSuccess);
    assert.ok(q.ranked[0].callMicroUsd >= e.ranked[0].callMicroUsd);
  });

  test("priors: tool-unreliable and probe-failed models lose odds on tool tasks", () => {
    const profile = classifyTask({
      message: "send an email to Sam on my behalf",
      complexity: classifyPromptComplexity("send an email to Sam on my behalf"),
      toolsOffered: 1,
    });
    const luna = byId("openai:gpt-6-luna");
    const base = priorSuccess(luna, null, profile, "untested");
    assert.ok(priorSuccess(luna, null, profile, "failed") < base);
    assert.ok(priorSuccess({ ...luna, agenticTools: false }, null, profile) < base);
    assert.equal(REQUIRED_INTELLIGENCE.expert, 9);
  });
});

describe("evidence: minimum samples and shrinkage (BRIEF §26)", () => {
  test("shrink math", () => {
    assert.equal(shrink(0, 0, 0.9), 0.9);
    assert.equal(shrink(30, 30, 0.5, 30), 0.75);
  });

  test("below the guard the prior stands; above it the rate moves toward the measurement", () => {
    const prior = { success: 0.9, toolRounds: 0, retries: 0.02 };
    const rows = (n: number, ok: boolean) =>
      Array.from({ length: n }, () => ({
        modelId: "openai:gpt-6-luna",
        taskClass: "everyday" as const,
        completionState: "completed",
        userRegenerated: !ok,
        userSwitchedModel: false,
        userEdited: false,
        feedback: null,
        toolRounds: 0,
        retryCount: 0,
        latencyMs: 1000,
        costMicroUsd: 300,
      }));
    const few = aggregateOutcomes(rows(MIN_SAMPLES - 1, false)).values().next().value;
    assert.equal(posterior(few, prior).success, 0.9);
    assert.equal(posterior(few, prior).measured, false);
    const many = aggregateOutcomes(rows(120, false)).values().next().value;
    const post = posterior(many, prior);
    assert.ok(post.measured && post.success < 0.25 && post.success > 0, String(post.success));
  });

  test("measured failures move Auto off a model", () => {
    const before = route("hey, what's 2+2?");
    const failing = Array.from({ length: 200 }, () => ({
      modelId: before.model.id,
      taskClass: before.profile.taskClass,
      completionState: "failed",
      userRegenerated: false,
      userSwitchedModel: false,
      userEdited: false,
      feedback: null,
      toolRounds: 0,
      retryCount: 1,
      latencyMs: null,
      costMicroUsd: null,
    }));
    const after = route("hey, what's 2+2?", { evidence: aggregateOutcomes(failing) });
    assert.notEqual(after.model.id, before.model.id);
    const scored = after.ranked.find((c) => c.modelId === before.model.id)!;
    assert.ok(scored.measured && scored.samples === 200);
  });
});

describe("availability, rate limits, budget and fallback", () => {
  test("an unavailable provider is excluded and the alternates are on other providers", () => {
    const first = route(HARD_CODING);
    const without = route(HARD_CODING, { isProviderAvailable: (p) => p !== first.model.provider });
    assert.notEqual(without.model.provider, first.model.provider);
    assert.equal(without.excluded.provider_unavailable! > 0, true);
    for (const alt of first.alternates) assert.notEqual(alt.provider, first.model.provider);
  });

  test("every provider down: answer anyway, flagged degraded", () => {
    const d = route("hi", { isProviderAvailable: () => false });
    assert.equal(d.degraded, "all_providers_unavailable");
  });

  test("rate-limit pressure raises expected retries", () => {
    __resetProviderPressureForTests();
    const now = Date.now();
    assert.equal(providerRetryPressure("openai", now), 0);
    recordProviderRateLimit("openai", now);
    recordProviderRateLimit("openai", now);
    const pressure = providerRetryPressure("openai", now);
    assert.ok(pressure > 0.15 && pressure <= 0.6);
    assert.equal(providerRetryPressure("openai", now + 11 * 60 * 1000), 0, "decays");
    const d = route("hi", { retryPressure: (p) => (p === "openai" ? 0.6 : 0) });
    const luna = d.ranked.find((c) => c.modelId === "openai:gpt-6-luna")!;
    assert.ok(luna.expectedRetries >= 0.6);
    __resetProviderPressureForTests();
  });

  test("budget: models whose turn would not fit are dropped; nothing fits → cheapest call, degraded", () => {
    const full = route(HARD_CODING, { preference: "quality" });
    const cap = full.ranked[0].callMicroUsd - 1;
    const tight = route(HARD_CODING, { preference: "quality", remainingBudgetMicroUsd: cap });
    assert.notEqual(tight.model.id, full.model.id);
    assert.ok(tight.ranked.every((c) => c.callMicroUsd + c.toolRoundsMicroUsd <= cap));
    const broke = route(HARD_CODING, { remainingBudgetMicroUsd: 0 });
    assert.equal(broke.degraded, "over_budget");
    const cheapest = Math.min(...broke.ranked.map((c) => c.callMicroUsd));
    assert.equal(broke.ranked[0].callMicroUsd, cheapest);
  });

  test("no eligible model is an error that names the filters, never a silent pick", () => {
    assert.throws(
      () => route("hi", { catalogue: [byId("zhipu:glm-4.7-flash"), byId("meta:muse-spark-1.3-contributor")] }),
      (err: unknown) => err instanceof NoAutoCandidateError && (err.excluded.data_use_terms ?? 0) === 2
    );
    assert.throws(() => route("hi", { isConfigured: () => false }), NoAutoCandidateError);
  });

  test("vision and web search are hard requirements", () => {
    const d = route("what is this", { hasImages: true, wantsWebSearch: true });
    assert.ok(d.model.vision && d.model.webSearch);
  });
});

describe("receipt (BRIEF §27)", () => {
  test("built from the decision, round-trips, and malformed reads as none", () => {
    const d = route(HARD_CODING);
    const receipt = receiptFromDecision(d);
    assert.deepEqual(parseRoutingReceipt(JSON.parse(JSON.stringify(receipt))), { ...receipt, rerouted: null });
    assert.deepEqual(receipt.reasons, d.reasons);
    assert.ok(receipt.reasons.length > 0 && receipt.reasons.length <= 4);
    assert.match(receiptLine("Claude Opus 5.5", { ...receipt, effort: "high" }), /^Auto · Claude Opus 5\.5 · High$/);
    assert.equal(receiptLine("GPT-6 Luna", { ...receipt, effort: null }), "Auto · GPT-6 Luna · Instant");
    assert.equal(parseRoutingReceipt({ v: 2 }), null);
    assert.equal(parseRoutingReceipt(null), null);
    assert.equal(parseRoutingReceipt({ v: 1, taskClass: "nope", reasons: [] }), null);
  });
});
