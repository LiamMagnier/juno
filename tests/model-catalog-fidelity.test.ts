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

/*
 * The September 2026 additions, each pinned to the exact id its provider
 * serves. A wrong id here is a 404 on every message sent with the model, and
 * the picker cannot tell — which is the whole failure mode this file exists
 * to prevent.
 */
test("the September 2026 models carry the ids their providers actually serve", () => {
  const byId = new Map(ALL_MODELS.map((model) => [model.id, model]));

  // DeepSeek points the UNVERSIONED alias at the current Flash generation, the
  // way `deepseek-chat` used to work. `deepseek-v4.1-flash` is the product
  // name, not the id.
  const deepseek = byId.get("deepseek:deepseek-flash");
  assert.ok(deepseek, "DeepSeek V4.1 Flash is in the catalog");
  assert.equal(deepseek.providerModel, "deepseek-flash");
  assert.equal(deepseek.status, "current");
  assert.equal(byId.get("deepseek:deepseek-v4-flash")?.status, "legacy", "V4 Flash steps down");

  // Both image variants ship under one version with two names.
  for (const [id, family] of [
    ["openai:gpt-image-2.5-sunburst", "gpt-image"],
    ["openai:gpt-image-2.5-flare", "gpt-image-fast"],
  ] as const) {
    const model = byId.get(id);
    assert.ok(model, `${id} is in the catalog`);
    assert.equal(model.modality, "image");
    assert.equal(model.status, "current");
    assert.equal(model.family, family, "Flare and Sunburst are separate families — both stay current");
  }
  assert.equal(byId.get("openai:gpt-image-2")?.status, "legacy");

  // xAI's volume tier: the widest context window in the catalog.
  const fast = byId.get("xai:grok-4.1-fast");
  assert.ok(fast, "Grok 4.1 Fast is in the catalog");
  assert.equal(fast.contextWindow, 2_000_000);
  assert.equal(fast.reasoning, true, "reasoning is a switch on this model, not absent");

  // Google's Lite line moved on a generation.
  const lite = byId.get("google:gemini-3.5-flash-lite");
  assert.ok(lite, "Gemini 3.5 Flash-Lite is in the catalog");
  assert.equal(lite.contextWindow, 1_048_576);
  assert.equal(byId.get("google:gemini-3.1-flash-lite")?.status, "legacy");

  // And the one retirement: Google deprecates this endpoint on 30 Sep 2026.
  const omni = byId.get("google:gemini-omni-flash-preview");
  assert.ok(omni);
  assert.equal(omni.status, "deprecated");
  assert.equal(omni.retiresOn, "2026-09-30");
  assert.ok(omni.replacedBy, "a retirement without a replacement is how a stored id becomes a 404");
});
