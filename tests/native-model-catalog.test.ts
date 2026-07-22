import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AUTO_MODEL_ID } from "../src/lib/auto-model";
import { sortModelsForDisplay } from "../src/lib/model-metrics";
import { nativeModelCatalog } from "../src/lib/native-model-manifest";
import type { ModelInfo } from "../src/lib/models";

function fakeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: "anthropic:claude-sonnet-4-6",
    provider: "anthropic",
    providerModel: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    minPlan: "FREE",
    vision: true,
    reasoning: true,
    cost: 2,
    modality: "chat",
    webSearch: true,
    status: "current",
    ...overrides,
  };
}

function entry(catalog: ReturnType<typeof nativeModelCatalog>, id: string) {
  const found = catalog.models.find((model) => model.id === id);
  assert.ok(found, `expected ${id} in the manifest`);
  return found;
}

describe("native model catalog", () => {
  it("publishes Auto as a real selectable entry rather than a client-side constant", () => {
    const catalog = nativeModelCatalog([fakeModel()]);
    const auto = entry(catalog, AUTO_MODEL_ID);

    assert.equal(auto.provider.id, "juno");
    assert.equal(auto.availability, "available");
    assert.equal(catalog.models[0].id, AUTO_MODEL_ID, "Auto leads the manifest");
    assert.ok(auto.description);
    assert.ok(auto.highlights && auto.highlights.length > 0);
  });

  it("gives Auto no reasoning tiers, because the router picks the depth", () => {
    const auto = entry(nativeModelCatalog([fakeModel()]), AUTO_MODEL_ID);

    assert.deepEqual(auto.supportedReasoningEfforts, []);
    assert.equal(auto.reasoning.automatic, true);
    assert.equal(auto.reasoning.canDisable, true);
    // Auto is a router: no single context window, price, speed or intelligence.
    assert.equal(auto.metrics, null);
    assert.equal(auto.pricing, null);
    assert.equal(auto.contextWindowTokens, null);
  });

  it("omits Auto when the plan cannot call any chat model", () => {
    const catalog = nativeModelCatalog([fakeModel({ minPlan: "MAX" })], "FREE");

    assert.equal(catalog.models.some((model) => model.id === AUTO_MODEL_ID), false);
  });

  it("marks models the plan cannot call as requires_plan, with the enforced plan", () => {
    const catalog = nativeModelCatalog([fakeModel({ id: "anthropic:claude-opus-4-8", minPlan: "MAX" })], "PRO");
    const gated = entry(catalog, "anthropic:claude-opus-4-8");

    assert.equal(gated.availability, "requires_plan");
    assert.equal(gated.requiredPlan, "max");
    // Still streams — it is gated, not broken, so a client can explain it.
    assert.equal(gated.capabilities.streaming, true);
  });

  it("floors the required plan the same way canUseModel does", () => {
    // A FREE-labelled paid model is Pro-floored by effectiveMinPlan, so a FREE
    // account must be told "Pro", not "Free".
    const catalog = nativeModelCatalog([fakeModel()], "FREE");
    const gated = entry(catalog, "anthropic:claude-sonnet-4-6");

    assert.equal(gated.availability, "requires_plan");
    assert.equal(gated.minimumPlan, "free");
    assert.equal(gated.requiredPlan, "pro");
  });

  it("carries the real 1-10 grades the selector bars read from", () => {
    const model = entry(nativeModelCatalog([fakeModel()]), "anthropic:claude-sonnet-4-6");

    assert.ok(model.metrics);
    for (const value of [model.metrics.speed, model.metrics.intelligence]) {
      assert.ok(Number.isInteger(value) && value >= 1 && value <= 10, `bad grade ${value}`);
    }
  });

  it("keeps the digest sensitive to plan-driven availability", () => {
    const models = [fakeModel({ id: "anthropic:claude-opus-4-8", minPlan: "MAX" })];

    assert.notEqual(
      nativeModelCatalog(models, "PRO").contractDigest,
      nativeModelCatalog(models, "MAX").contractDigest
    );
  });

  it("keeps non-chat models out of the streaming set", () => {
    const catalog = nativeModelCatalog([fakeModel({ id: "google:imagen-4", modality: "image", reasoning: false })]);
    const image = entry(catalog, "google:imagen-4");

    assert.equal(image.capabilities.streaming, false);
  });
});

describe("display order", () => {
  function model(overrides: Partial<ModelInfo>): ModelInfo {
    return fakeModel({ provider: "openai", ...overrides });
  }

  it("leads each lab with its newest generation, then orders that generation by power", () => {
    // Three siblings shipped the same month, plus last season's flagship.
    const catalog = nativeModelCatalog(
      sortModelsForDisplay([
        model({ id: "openai:gpt-5.5", providerModel: "gpt-5.5", name: "GPT-5.5", released: "2026-06", cost: 3, status: "legacy" }),
        model({ id: "openai:gpt-5.6-luna", providerModel: "gpt-5.6-luna", name: "GPT-5.6 Luna", released: "2026-07", cost: 1 }),
        model({ id: "openai:gpt-5.6-sol", providerModel: "gpt-5.6-sol", name: "GPT-5.6 Sol", released: "2026-07", cost: 3 }),
        model({ id: "openai:gpt-5.6-terra", providerModel: "gpt-5.6-terra", name: "GPT-5.6 Terra", released: "2026-07", cost: 2 }),
      ])
    );

    assert.deepEqual(
      catalog.models.filter((m) => m.provider.id === "openai").map((m) => m.displayName),
      ["GPT-5.6 Sol", "GPT-5.6 Terra", "GPT-5.6 Luna", "GPT-5.5"]
    );
  });

  it("never lets a superseded model outrank a current one, whatever its grades", () => {
    const catalog = nativeModelCatalog(
      sortModelsForDisplay([
        // Older but brilliant; must still sort below the current generation.
        model({ id: "openai:gpt-5.4-pro", providerModel: "gpt-5.4-pro", name: "GPT-5.4 Pro", released: "2026-03", cost: 3, status: "legacy" }),
        model({ id: "openai:gpt-5.6-mini", providerModel: "gpt-5.6-mini", name: "GPT-5.6 Mini", released: "2026-07", cost: 1 }),
      ])
    );

    const openai = catalog.models.filter((m) => m.provider.id === "openai");
    assert.deepEqual(openai.map((m) => m.displayName), ["GPT-5.6 Mini", "GPT-5.4 Pro"]);
    assert.equal(openai[1].legacy, true);
  });

  it("publishes the modality that drives the pickers' sections", () => {
    const catalog = nativeModelCatalog([
      fakeModel({ id: "google:imagen-4", modality: "image", reasoning: false }),
    ]);

    assert.equal(catalog.models.find((m) => m.id === "google:imagen-4")?.modality, "image");
  });
});
