import test from "node:test";
import assert from "node:assert/strict";
import { GEN_MODELS, MODEL_LIST, resolveModel, type ModelInfo } from "@/lib/models";
import { estimateCostUsd, longContextPricing, tokenRate } from "@/lib/pricing";
import {
  estimateCost,
  fitsTier,
  formatContextTokens,
  priceDelta,
  tiersFor,
  validateContextTier,
  withContextTiers,
} from "@/lib/code-v2/context-tiers";
import { CODE_MODEL_RANKING, codeModels, codeProviderModels, isCodeAgentModel } from "@/lib/code-v2/code-models";
import { nativeModelCatalog } from "@/lib/native-model-manifest";

const model = (id: string): ModelInfo => {
  const m = resolveModel(id);
  assert.ok(m, `${id} is in the catalogue`);
  return m;
};

test("labels read the way labs name their windows", () => {
  assert.equal(formatContextTokens(272_000), "272K");
  assert.equal(formatContextTokens(1_000_000), "1M");
  assert.equal(formatContextTokens(1_048_576), "1M");
  assert.equal(formatContextTokens(1_050_000), "1.05M");
  assert.equal(formatContextTokens(262_144), "256K");
  assert.equal(formatContextTokens(200_000), "200K");
});

test("GPT-6.1 Sol: 272K at the standard rate, 1.05M at 2x input and 1.5x output", () => {
  const sol = model("openai:gpt-6.1-sol");
  const tiers = tiersFor(sol);
  assert.equal(tiers.length, 2);
  const [standard, long] = tiers;
  const rate = tokenRate(sol);
  assert.deepEqual(
    { tokens: standard.tokens, in: standard.inputPerMTok, out: standard.outputPerMTok, cached: standard.cachedInputPerMTok },
    { tokens: 272_000, in: rate.input, out: rate.output, cached: rate.cacheRead },
  );
  assert.equal(long.tokens, sol.contextWindow);
  assert.equal(long.inputPerMTok, rate.input * 2);
  assert.equal(long.outputPerMTok, rate.output * 1.5);
  assert.equal(long.note, "2× input, 1.5× output above 272K");
  const delta = priceDelta(long, standard);
  assert.equal(delta.inputMultiplier, 2);
  assert.equal(delta.outputMultiplier, 1.5);
  assert.equal(delta.label, "2× input, 1.5× output");
  assert.equal(priceDelta(standard, standard).label, "Same price");
});

test("Grok 4.7: 200K standard, 500K at 2x on both", () => {
  const grok = model("xai:grok-4.7");
  const tiers = tiersFor(grok);
  assert.deepEqual(tiers.map((t) => t.tokens), [200_000, 500_000]);
  assert.equal(priceDelta(tiers[1], tiers[0]).label, "2× input, 2× output");
});

test("a model without a surcharge has exactly one tier, its curated window", () => {
  const opus = model("anthropic:claude-opus-5-5");
  const tiers = tiersFor(opus);
  assert.equal(tiers.length, 1);
  assert.equal(tiers[0].tokens, 1_000_000);
  assert.equal(tiers[0].unverified, undefined);
  const haiku = tiersFor(model("anthropic:claude-haiku-4-5"));
  assert.deepEqual(haiku.map((t) => t.tokens), [200_000]);
});

test("unrecorded long-context bands are marked, never priced as if flat", () => {
  const pro = tiersFor(model("google:gemini-3.1-pro-preview"));
  assert.equal(pro.length, 1);
  assert.equal(pro[0].unverified, true);
  assert.match(pro[0].note ?? "", /200K not confirmed/);
});

test("tiers agree with billing: each band's rate is what estimateCostUsd charges inside it", () => {
  for (const m of MODEL_LIST.filter((x) => x.modality === "chat" && longContextPricing(x))) {
    const tiers = tiersFor(m);
    if (tiers.length < 2) continue;
    const [standard, long] = tiers;
    const small = Math.floor(standard.tokens / 2);
    const big = standard.tokens + 10_000;
    const billedSmall = estimateCostUsd(m, { input: small, output: 1000 });
    const billedBig = estimateCostUsd(m, { input: big, output: 1000 });
    const tierSmall = estimateCost(small, long, { tiers, outputTokens: 1000 });
    const tierBig = estimateCost(big, long, { tiers, outputTokens: 1000 });
    assert.ok(tierSmall !== null && Math.abs(tierSmall - billedSmall) < 1e-6, `${m.id} small prompt`);
    assert.ok(tierBig !== null && Math.abs(tierBig - billedBig) < 1e-6, `${m.id} long prompt`);
  }
});

test("estimateCost refuses a thread that does not fit and honours cache hits", () => {
  const sol = model("openai:gpt-6.1-sol");
  const [standard] = tiersFor(sol);
  assert.equal(estimateCost(300_000, standard), null);
  const fresh = estimateCost(100_000, standard)!;
  const cached = estimateCost(100_000, standard, { cachedInputTokens: 100_000 })!;
  assert.ok(cached < fresh);
  assert.equal(fresh, (100_000 * standard.inputPerMTok) / 1_000_000);
  assert.equal(fitsTier(272_000, standard), true);
  assert.equal(fitsTier(272_001, standard), false);
});

test("validateContextTier accepts offered windows only", () => {
  const sol = model("openai:gpt-6.1-sol");
  assert.equal(validateContextTier(sol, undefined).ok, true);
  const v = validateContextTier(sol, 1_050_000);
  assert.ok(v.ok && v.tier.tokens === 1_050_000);
  const bad = validateContextTier(sol, 500_000);
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.error : "", /272K or 1\.05M/);
  assert.equal(validateContextTier(sol, -1).ok, false);
  assert.equal(validateContextTier(sol, 1.5).ok, false);
});

test("a curated contextTiers override wins over derivation", () => {
  const base = model("anthropic:claude-opus-5-5");
  const custom: ModelInfo = {
    ...base,
    contextTiers: [
      { tokens: 1_000_000, label: "1M", inputPerMTok: 8, outputPerMTok: 30 },
      { tokens: 200_000, label: "200K", inputPerMTok: 4, outputPerMTok: 20 },
    ],
  };
  assert.deepEqual(tiersFor(custom).map((t) => t.tokens), [200_000, 1_000_000]);
  assert.equal(withContextTiers(base).contextTiers.length, 1);
});

test("Code catalogue: agentic chat models only, curated order first", () => {
  const list = codeModels();
  assert.ok(list.length > 10);
  assert.ok(list.every((m) => m.modality === "chat" && m.agenticTools && !m.comingSoon));
  assert.ok(!list.some((m) => m.id === "mistral:mistral-medium-latest"), "non-agentic model excluded");
  assert.equal(list[0].id, CODE_MODEL_RANKING[0]);
  const ranked = list.filter((m) => CODE_MODEL_RANKING.includes(m.id)).map((m) => m.id);
  assert.deepEqual(ranked, CODE_MODEL_RANKING.filter((id) => ranked.includes(id)));
  // Every ranked id is live, agentic and current today.
  for (const id of CODE_MODEL_RANKING) {
    const m = model(id);
    assert.ok(isCodeAgentModel(m), `${id} is agentic`);
  }
  const contributor = list.findIndex((m) => m.id === "meta:muse-spark-1.3-contributor");
  assert.ok(contributor === -1 || contributor >= CODE_MODEL_RANKING.length, "trains-on-prompts tier never ranked first");
  for (const m of GEN_MODELS) assert.equal(isCodeAgentModel(m), false);
});

test("Code provider models carry tiers, efforts and one default", () => {
  const models = codeProviderModels();
  assert.equal(models.filter((m) => m.isDefault).length, 1);
  const sol = models.find((m) => m.id === "openai:gpt-6.1-sol")!;
  assert.equal(sol.contextTiers?.length, 2);
  assert.ok(sol.effortLevels?.includes("medium"));
  const anthropicOnly = codeProviderModels(MODEL_LIST, { provider: "anthropic" });
  assert.ok(anthropicOnly.every((m) => m.id.startsWith("anthropic:")));
  assert.equal(anthropicOnly[0].isDefault, true);
});

test("the native manifest ships tiers and the Code flags", () => {
  const manifest = nativeModelCatalog([...MODEL_LIST, ...GEN_MODELS]);
  const sol = manifest.models.find((m) => m.id === "openai:gpt-6.1-sol")!;
  assert.deepEqual(sol.contextTiers?.map((t) => t.tokens), [272_000, 1_050_000]);
  assert.deepEqual(sol.code, { agentic: true, rank: 1 });
  const image = manifest.models.find((m) => m.modality === "image");
  assert.ok(image);
  assert.equal(image.contextTiers, null);
  assert.equal(image.code?.agentic, false);
});
