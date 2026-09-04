import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_LIST, GEN_MODELS, resolveModel, RETIRED_MODELS } from "../src/lib/models";
import { providerRequestModel } from "../src/lib/model-request";

const ALL_MODELS = [...MODEL_LIST, ...GEN_MODELS];

test("GPT-6 Astra is selectable with the exact documented API id", () => {
  const astra = MODEL_LIST.find((model) => model.id === "openai:gpt-6-astra");
  assert.ok(astra);
  assert.equal(astra.providerModel, "gpt-6-astra");
  assert.equal(astra.contextWindow, 1_050_000);
  assert.equal(astra.status, "current");
});

test("model catalog fidelity: every displayed model has matching providerModel", () => {
  for (const m of ALL_MODELS) {
    assert.ok(m.id, "Model must have an id");
    assert.ok(m.providerModel, `Model ${m.id} must have a providerModel`);
    assert.ok(m.name, `Model ${m.id} must have a display name`);

    // Provider model must be the suffix of model id for standard models
    const expectedId = `${m.provider}:${m.providerModel}`;
    assert.equal(m.id, expectedId, `Model id ${m.id} should equal ${expectedId}`);

  }
});

test("image catalog includes every active provider image variant", () => {
  const imageIds = new Set(GEN_MODELS.filter((model) => model.modality === "image").map((model) => model.id));
  for (const id of [
    "openai:gpt-image-2",
    "openai:gpt-image-1-mini",
    "openai:gpt-image-1.5",
    "openai:gpt-image-1",
    "google:gemini-3-pro-image",
    "google:gemini-3.1-flash-image",
    "google:gemini-3.1-flash-lite-image",
    "google:gemini-2.5-flash-image",
    "xai:grok-imagine-image-2.0",
    "xai:grok-imagine-image-quality",
    "xai:grok-imagine-image",
    "zhipu:glm-image",
    "minimax:image-01",
    "minimax:image-01-live",
  ]) {
    assert.equal(imageIds.has(id), true, `${id} should be selectable when its provider is configured`);
  }
});

test("displayed catalog entries send the same provider model id", () => {
  for (const model of MODEL_LIST) {
    assert.equal(providerRequestModel(model), model.providerModel, `${model.id} must invoke its displayed providerModel`);
  }
});

test("retired/aliased models migrate to real registered models with matching providerModel", () => {
  for (const [retiredId, targetId] of Object.entries(RETIRED_MODELS)) {
    const resolved = resolveModel(retiredId);
    assert.ok(resolved, `Retired model ${retiredId} should resolve to a valid model`);
    assert.equal(resolved.id, targetId, `Retired model ${retiredId} should resolve to ${targetId}`);
    assert.ok(ALL_MODELS.some((m) => m.id === targetId), `Target model ${targetId} must exist in ALL_MODELS`);
  }
});
