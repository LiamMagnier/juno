import assert from "node:assert/strict";
import test from "node:test";
import { effectiveReasoningEffort } from "@/lib/chat-responses";
import { nativeModelCatalog } from "@/lib/native-model-manifest";
import { defaultReasoning, reasoningCaps, reasoningOptions } from "@/lib/model-metrics";
import { getModel } from "@/lib/models";

const gemini = getModel("google:gemini-3.7-flash")!;

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
