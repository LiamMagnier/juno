import assert from "node:assert/strict";
import test from "node:test";
import { MODELS } from "@/lib/models";
import { providerAdapterFor } from "@/lib/provider-routing";
import { reasoningCapabilityForModel } from "@/lib/model-reasoning-capabilities";
import { longContextPricing, tokenRate, ultraFastMultiplier } from "@/lib/pricing";

const releases = [
  { id: "google:gemini-4-neon", adapter: "gemini-native", context: 1_048_576, price: [3, 15], tiers: ["low", "medium", "high", "xhigh"], effort: "high", off: false },
  { id: "openai:gpt-6.2-astra", adapter: "openai-responses", context: 1_050_000, price: [8, 40], tiers: ["low", "medium", "high", "xhigh", "max"], effort: "medium", off: false },
  { id: "openai:gpt-6.2-sol", adapter: "openai-responses", context: 1_050_000, price: [2, 10], tiers: ["low", "medium", "high", "xhigh", "max"], effort: "medium", off: false },
  { id: "qwen:qwen4-max", adapter: "openai-compatible", context: 1_000_000, price: [1.5, 4.5], tiers: ["low", "high", "xhigh"], effort: "high", off: true },
] as const;

for (const release of releases) {
  test(`${release.id} exposes the public API model and supported thinking controls`, () => {
    const model = MODELS[release.id];
    assert.ok(model, `${release.id} is available in the catalog`);
    assert.equal(model.status, "current");
    assert.equal(model.minPlan, "PRO");
    assert.equal(model.vision, true);
    assert.equal(model.contextWindow, release.context);
    assert.equal(providerAdapterFor(model), release.adapter);
    const rate = tokenRate(model);
    assert.deepEqual([rate.input, rate.output], [...release.price]);
    const reasoning = reasoningCapabilityForModel(model);
    assert.deepEqual(reasoning.tiers, [...release.tiers]);
    assert.equal(reasoning.defaultLevel, release.effort);
    assert.equal(reasoning.canDisable, release.off);
    assert.equal(reasoning.method, "official_docs");
  });
}

test("GPT-6.2 bills the published Ultrafast rates at the Pacific cutoff", () => {
  const cutoff = Date.parse("2027-03-01T08:00:00Z");
  for (const [id, input, output, cached] of [["openai:gpt-6.2-astra", 8, 40, 0.4], ["openai:gpt-6.2-sol", 2, 10, 0.1]] as const) {
    const model = MODELS[id];
    assert.ok(model);
    assert.deepEqual(longContextPricing(model), { threshold: 272_000, inclusive: false, inputMultiplier: 2, outputMultiplier: 1.5 });
    assert.equal(ultraFastMultiplier(model, cutoff - 1), 3);
    assert.equal(ultraFastMultiplier(model, cutoff), 6);
    for (const [at, multiplier] of [[cutoff - 1, 3], [cutoff, 6]]) {
      const rate = tokenRate(model, "ultrafast", at);
      assert.deepEqual([rate.input, rate.output, rate.cacheRead], [input * multiplier, output * multiplier, cached * multiplier]);
    }
  }
});
