import test from "node:test";
import assert from "node:assert/strict";
import { defaultReasoning, getModelMetrics, reasoningCaps, reasoningOptions } from "@/lib/model-metrics";
import { probeRequestFor } from "@/lib/model-capability-probe";
import { providerRequestModel } from "@/lib/model-request";
import { MODEL_LIST, resolveModel, type ModelInfo } from "@/lib/models";
import { nativeModelCatalog } from "@/lib/native-model-manifest";
import { estimateCostUsd, fastModeMultiplier, tokenRate } from "@/lib/pricing";
import { providerAdapterFor } from "@/lib/provider-routing";
import { toolCapabilitiesFor } from "@/lib/model-tools";
import { mapResponsesEffort } from "@/lib/llm/responses-loop";
import { reasoningCapabilityForModel } from "@/lib/model-reasoning-capabilities";

/*
 * GPT-6.1 Sol, pinned to its model page
 * (https://developers.openai.com/api/docs/models/gpt-6.1-sol, read 2026-10-04):
 * id `gpt-6.1-sol`; 1,050,000 context, 128,000 output; text + image in, text
 * out; Chat Completions without tool calling, so Responses; reasoning.effort
 * low | medium (default) | high | xhigh | max — `none` and `minimal` are not
 * available; $2 input, $0.10 cached, $2.50 cache write, $10 output; >272K
 * input bills 2x input and 1.5x output; fast mode 2x.
 */

function model(id: string): ModelInfo {
  const resolved = resolveModel(id);
  assert.ok(resolved, `${id} must resolve`);
  return resolved;
}

test("GPT-6.1 Sol is the current Sol and resolves to itself", () => {
  const listed = MODEL_LIST.find((entry) => entry.id === "openai:gpt-6.1-sol");
  assert.ok(listed, "GPT-6.1 Sol is in the picker's catalog");
  assert.equal(listed.status, "current");
  assert.equal(listed.family, "gpt");
  assert.equal(listed.contextWindow, 1_050_000);
  assert.equal(listed.vision, true);
  assert.equal(listed.reasoning, true);
  assert.equal(model("openai:gpt-6-sol").status, "legacy", "GPT-6 Sol steps down for 6.1");
});

test("it is routed to the Responses API with the documented wire id", () => {
  const sol = model("openai:gpt-6.1-sol");
  assert.equal(providerAdapterFor(sol), "openai-responses");
  assert.equal(providerRequestModel(sol), "gpt-6.1-sol");
  assert.equal(toolCapabilitiesFor(sol).chatCompletions, false, "no tool calling on Chat Completions");
  const request = probeRequestFor(sol, "test-key");
  assert.equal(request?.url, "https://api.openai.com/v1/responses");
  assert.equal(request?.body.model, "gpt-6.1-sol");
  const evidence = reasoningCapabilityForModel(sol);
  assert.equal(evidence.parameter, "reasoning.effort");
});

test("the thinking control offers exactly Low through Max, Medium by default, no Instant", () => {
  const sol = model("openai:gpt-6.1-sol");
  assert.deepEqual(reasoningCaps(sol), {
    tiers: ["low", "medium", "high", "xhigh", "max"], canDisable: false, onOff: false, defaultLevel: "medium",
  });
  assert.deepEqual(reasoningOptions(sol).map((option) => option.label), ["Low", "Medium", "High", "Extra high", "Max"]);
  assert.equal(defaultReasoning(sol), "medium");
  const entry = nativeModelCatalog([sol]).models.find((item) => item.id === sol.id);
  assert.deepEqual(entry?.supportedReasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(entry?.reasoning.canDisable, false);
  assert.equal(entry?.reasoning.defaultEffort, "medium");
});

test("each selected effort is sent as itself; nothing it rejects is ever sent", () => {
  const sol = model("openai:gpt-6.1-sol");
  for (const tier of ["low", "medium", "high", "xhigh", "max"] as const) {
    assert.equal(mapResponsesEffort(sol, tier), tier, tier);
  }
  // No tier selected: the API default (medium), never "none".
  assert.equal(mapResponsesEffort(sol, undefined), undefined);
  // A stale "minimal" from another model lands on the lowest listed tier.
  assert.equal(mapResponsesEffort(sol, "minimal"), "low");
});

test("efforts outside a model's ladder move to the nearest listed tier", () => {
  assert.equal(mapResponsesEffort(model("openai:gpt-5.5"), "max"), "xhigh");
  assert.equal(mapResponsesEffort(model("openai:gpt-5.1"), "xhigh"), "high");
  assert.equal(mapResponsesEffort(model("openai:gpt-5.3-codex"), "max"), "xhigh");
  assert.equal(mapResponsesEffort(model("openai:gpt-5.5-pro"), "low"), "medium");
  assert.equal(mapResponsesEffort(model("openai:gpt-5.5-pro"), undefined), "high", "5.5 Pro's documented default");
  assert.equal(mapResponsesEffort(model("openai:gpt-5.4-pro"), undefined), "medium", "5.4 Pro's documented default");
  assert.equal(mapResponsesEffort(model("openai:gpt-6-sol"), undefined), "none", "GPT-6 Sol's Instant is sent");
  assert.equal(mapResponsesEffort(model("openai:gpt-5.3-codex"), undefined), undefined, "5.3 Codex lists no none");
});

test("it bills its published rates", () => {
  const sol = model("openai:gpt-6.1-sol");
  const close = (actual: number, expected: number, label: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} ≠ ${expected}`);
  const rate = tokenRate(sol);
  close(rate.input, 2, "input");
  close(rate.output, 10, "output");
  close(rate.cacheRead, 0.1, "cached input");
  close(rate.cacheWrite, 2.5, "cache write");
  assert.equal(fastModeMultiplier(sol), 2);
  close(estimateCostUsd(sol, { input: 272_001, output: 100_000 }), (272_001 * 2 * 2 + 100_000 * 10 * 1.5) / 1e6, "past 272K");
  const metrics = getModelMetrics(sol);
  assert.deepEqual({ input: metrics.inputUsdPerMTok, output: metrics.outputUsdPerMTok }, { input: 2, output: 10 });
});
