import assert from "node:assert/strict";
import test from "node:test";
import { effectiveReasoningEffort } from "@/lib/chat-responses";
import { reasoningCapabilityForModel } from "@/lib/model-reasoning-capabilities";
import { nativeModelCatalog } from "@/lib/native-model-manifest";
import { defaultReasoning, reasoningCaps, reasoningOptions } from "@/lib/model-metrics";
import { getModel } from "@/lib/models";

const gemini = getModel("google:gemini-3.7-flash")!;
const astra = getModel("openai:gpt-6-astra")!;

test("GPT-6 Astra exposes Low through Max without a fabricated Instant tier", () => {
  assert.deepEqual(reasoningCaps(astra), {
    tiers: ["low", "medium", "high", "xhigh", "max"], canDisable: false, onOff: false, defaultLevel: "medium",
  });
  assert.deepEqual(reasoningOptions(astra).map((option) => option.label), ["Low", "Medium", "High", "Extra high", "Max"]);
  assert.equal(defaultReasoning(astra), "medium");
});

test("Gemini 3.7 exposes exactly Low, Medium and High with Medium default", () => {
  assert.deepEqual(reasoningCaps(gemini), {
    tiers: ["low", "medium", "high"], canDisable: false, onOff: false, defaultLevel: "medium",
  });
  assert.deepEqual(reasoningOptions(gemini).map((option) => option.label), ["Low", "Medium", "High"]);
  assert.equal(defaultReasoning(gemini), "medium");
});

test("invalid persisted Gemini 3.7 efforts reset to Medium at the server boundary", () => {
  for (const invalid of ["minimal", "xhigh", "max"] as const) {
    assert.equal(effectiveReasoningEffort(gemini, invalid), "medium");
  }
  assert.equal(effectiveReasoningEffort(gemini), "medium");
});

test("native manifest publishes the same Gemini 3.7 contract", () => {
  const entry = nativeModelCatalog([gemini]).models.find((model) => model.id === gemini.id)!;
  assert.deepEqual(entry.supportedReasoningEfforts, ["low", "medium", "high"]);
  assert.equal(entry.reasoning.canDisable, false);
  assert.equal(entry.reasoning.defaultEffort, "medium");
});

test("curated Gemini 3.8 exposes its thinking levels", () => {
  const flash = getModel("google:gemini-3.8-flash")!;
  assert.equal(flash.reasoning, true);
  assert.deepEqual(reasoningOptions(flash).map((option) => option.label), ["Low", "Medium", "High"]);
  assert.equal(defaultReasoning(flash), "medium");
  const manifestEntry = nativeModelCatalog([flash]).models.find((model) => model.id === flash.id);
  assert.deepEqual(manifestEntry?.supportedReasoningEfforts, ["low", "medium", "high"]);
});

test("GLM-5.3 always thinks and takes the effort enum: a ladder, no Instant, never the thinking object", () => {
  const glm = getModel("zhipu:glm-5.3")!;
  assert.deepEqual(reasoningCaps(glm).tiers, ["low", "high", "max"]);
  assert.equal(reasoningCaps(glm).canDisable, false);
  assert.equal(reasoningOptions(glm).some((option) => option.value === null), false, "no Instant");
  const evidence = reasoningCapabilityForModel(glm);
  assert.equal(evidence.parameter, "reasoning_effort");
  assert.equal(evidence.controlType, "enum");
  const entry = nativeModelCatalog([glm]).models.find((model) => model.id === glm.id)!;
  assert.deepEqual(entry.supportedReasoningEfforts, ["low", "high", "max"]);
  assert.equal(entry.reasoning.canDisable, false);
  // The on/off GLMs keep their toggle.
  assert.equal(reasoningCapabilityForModel(getModel("zhipu:glm-4.7")!).parameter, "thinking.type");
});

test("DeepSeek V4.1 Flash reasons, with low/high/max and a real Instant", () => {
  const flash = getModel("deepseek:deepseek-flash")!;
  assert.equal(flash.reasoning, true);
  // The same contract as V4 Pro.
  assert.deepEqual(reasoningCaps(flash), reasoningCaps(getModel("deepseek:deepseek-v4-pro")!));
  // api-docs.deepseek.com: reasoning_effort none|low|high|max.
  assert.deepEqual(reasoningCaps(flash).tiers, ["low", "high", "max"]);
  assert.equal(reasoningCaps(flash).canDisable, true);
  assert.equal(reasoningOptions(flash)[0]?.label, "Instant");
  const entry = nativeModelCatalog([flash]).models.find((model) => model.id === flash.id)!;
  assert.equal(entry.reasoning.supported, true);
  assert.deepEqual(entry.supportedReasoningEfforts, ["low", "high", "max"]);
});

test("OpenAI and Grok declare the Responses wire they are now served on", () => {
  for (const id of ["openai:gpt-6-sol", "openai:gpt-5.5-pro", "xai:grok-4.7"]) {
    const evidence = reasoningCapabilityForModel(getModel(id)!);
    assert.equal(evidence.apiSurface, "OpenAI Responses-compatible", id);
    assert.equal(evidence.parameter, "reasoning.effort", id);
  }
  assert.equal(reasoningCapabilityForModel(getModel("deepseek:deepseek-v4-pro")!).apiSurface, "OpenAI chat-compatible");
});
