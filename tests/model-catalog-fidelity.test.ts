import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_LIST, GEN_MODELS, resolveModel, RETIRED_MODELS } from "../src/lib/models";

const ALL_MODELS = [...MODEL_LIST, ...GEN_MODELS];

test("model catalog fidelity: every displayed model has matching providerModel", () => {
  for (const m of ALL_MODELS) {
    assert.ok(m.id, "Model must have an id");
    assert.ok(m.providerModel, `Model ${m.id} must have a providerModel`);
    assert.ok(m.name, `Model ${m.id} must have a display name`);

    // Provider model must be the suffix of model id for standard models
    const expectedId = `${m.provider}:${m.providerModel}`;
    assert.equal(m.id, expectedId, `Model id ${m.id} should equal ${expectedId}`);

    // No non-existent 3.7 model in selectable list
    assert.notEqual(m.providerModel, "gemini-3.7-flash", "gemini-3.7-flash must not be in selectable MODEL_LIST");
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
