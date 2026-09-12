import test from "node:test";
import assert from "node:assert/strict";
import { clampMaxTokens, PROVIDER_MAX_OUTPUT } from "@/lib/provider-limits";
import { MODELS, type ModelInfo } from "@/lib/models";
import { PROVIDER_LIST } from "@/lib/providers";
import { estimateCostUsd, tokenRate } from "@/lib/pricing";
import { reasoningCaps } from "@/lib/model-metrics";

/*
 * Table-completeness, asserted per provider.
 *
 * A missing row in any of these tables raises no error anywhere: the output cap
 * quietly falls to 8192 (Meta and LongCat could never write a long answer), a
 * price silently becomes zero, a thinking ladder silently disappears. The only
 * thing that catches it is iterating PROVIDER_LIST.
 */

const chatModelFor = (provider: string): ModelInfo | undefined =>
  Object.values(MODELS)
    .filter((m) => m.provider === provider && m.modality === "chat" && !m.comingSoon)
    .sort((a, b) => a.cost - b.cost)[0];

test("every provider declares an output ceiling", () => {
  for (const provider of PROVIDER_LIST) {
    assert.equal(typeof PROVIDER_MAX_OUTPUT[provider], "number", `${provider} has no PROVIDER_MAX_OUTPUT entry`);
  }
});

test("every provider that serves chat can produce a long answer", () => {
  for (const provider of PROVIDER_LIST) {
    if (!chatModelFor(provider)) continue; // seedance is media-only
    assert.ok(
      clampMaxTokens(provider, 100_000) > 8_192,
      `${provider} is capped at the 8192 fallback — add it to PROVIDER_MAX_OUTPUT`,
    );
  }
});

test("clamping keeps a floor as well as a ceiling", () => {
  assert.equal(clampMaxTokens("google", 10), 1_024);
  assert.equal(clampMaxTokens("google", 10_000_000), PROVIDER_MAX_OUTPUT.google);
  // An unknown provider string still yields a usable request rather than NaN.
  assert.equal(clampMaxTokens("not-a-provider", 100_000), 8_192);
});

test("every provider's chat model has a price and a reasoning verdict", () => {
  for (const provider of PROVIDER_LIST) {
    const model = chatModelFor(provider);
    if (!model) continue;
    const rate = tokenRate(model);
    assert.ok(rate.input > 0, `${provider}: ${model.id} has no input rate`);
    assert.ok(rate.output > 0, `${provider}: ${model.id} has no output rate`);
    assert.ok(
      estimateCostUsd(model, { input: 1_000, output: 1_000 }) > 0,
      `${provider}: ${model.id} costs nothing to run`,
    );
    // Never throws, and never claims a ladder for a model that cannot reason.
    const caps = reasoningCaps(model);
    if (!model.reasoning) assert.deepEqual(caps.tiers, []);
  }
});
