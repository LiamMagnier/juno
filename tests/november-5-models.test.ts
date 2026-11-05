import test from "node:test";
import assert from "node:assert/strict";
import { defaultReasoning, getModelMetrics, reasoningCaps } from "@/lib/model-metrics";
import { probeRequestFor } from "@/lib/model-capability-probe";
import { providerRequestModel } from "@/lib/model-request";
import { GEN_MODELS, MODEL_LIST, RETIRED_MODELS, migrateModelId, resolveModel, type ModelInfo } from "@/lib/models";
import { estimateCostUsd, tokenRate } from "@/lib/pricing";
import { providerAdapterFor } from "@/lib/provider-routing";
import { toolCapabilitiesFor } from "@/lib/model-tools";
import { mapResponsesEffort } from "@/lib/llm/responses-loop";
import { capabilitiesFor } from "@/lib/media-params";
import { isGoogleOmniModel } from "@/lib/video-gen-core";

/*
 * The 2026-11-05 audit (docs/models-november-5-2026.md). Each fact below is
 * from the lab's own page, read that day:
 *  - GPT-6.1 Terra: developers.openai.com/api/docs/models/gpt-6.1-terra
 *  - GPT Image 2.6 Sunburst / Flare: developers.openai.com/api/docs/models/gpt-image-2.6-*
 *  - Gemini Omni 1.2 Flash: blog.google launch post (GA on the Gemini API)
 *  - GLM-5.3-FlashX-Legal: docs.z.ai/guides/overview/pricing
 */

function model(id: string): ModelInfo {
  const resolved = resolveModel(id);
  assert.ok(resolved, `${id} must resolve`);
  return resolved;
}

const listed = (id: string) => [...MODEL_LIST, ...GEN_MODELS].find((entry) => entry.id === id);

test("GPT-6.1 Terra is the current Terra; GPT-5.6 Terra steps down but answers as itself", () => {
  const terra = listed("openai:gpt-6.1-terra");
  assert.ok(terra, "GPT-6.1 Terra is in the picker's catalog");
  assert.equal(terra.status, "current");
  assert.equal(terra.family, "gpt-value");
  assert.equal(terra.contextWindow, 1_050_000);
  assert.equal(terra.vision, true);
  assert.equal(terra.reasoning, true);
  const previous = model("openai:gpt-5.6-terra");
  assert.equal(previous.id, "openai:gpt-5.6-terra");
  assert.equal(previous.status, "legacy");
  // Stored ids that pointed at the old Terra land on the new one.
  assert.equal(RETIRED_MODELS["openai:gpt-3.5-turbo"], "openai:gpt-6.1-terra");
  assert.equal(RETIRED_MODELS["openai:gpt-5.1-codex-mini"], "openai:gpt-6.1-terra");
});

test("GPT-6.1 Terra rides Responses with its documented id and effort ladder", () => {
  const terra = model("openai:gpt-6.1-terra");
  assert.equal(providerAdapterFor(terra), "openai-responses");
  assert.equal(providerRequestModel(terra), "gpt-6.1-terra");
  assert.equal(toolCapabilitiesFor(terra).chatCompletions, false, "tool calling requires the Responses API");
  const request = probeRequestFor(terra, "test-key");
  assert.equal(request?.url, "https://api.openai.com/v1/responses");
  assert.equal(request?.body.model, "gpt-6.1-terra");
  // none|low|medium(default)|high|xhigh|max: Instant is real.
  assert.deepEqual(reasoningCaps(terra), {
    tiers: ["low", "medium", "high", "xhigh", "max"], canDisable: true, onOff: false, defaultLevel: "medium",
  });
  assert.equal(defaultReasoning(terra), "medium");
  for (const tier of ["low", "medium", "high", "xhigh", "max"] as const) assert.equal(mapResponsesEffort(terra, tier), tier);
});

test("GPT-6.1 Terra bills $1 / $5, cached $0.05, 2x / 1.5x past 272K", () => {
  const terra = model("openai:gpt-6.1-terra");
  const close = (actual: number, expected: number, label: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} ≠ ${expected}`);
  const rate = tokenRate(terra);
  close(rate.input, 1, "input");
  close(rate.output, 5, "output");
  close(rate.cacheRead, 0.05, "cached input");
  close(rate.cacheWrite, 1.25, "cache write (30-minute retention)");
  close(estimateCostUsd(terra, { input: 1_000, output: 1_000 }), (1_000 * 1 + 1_000 * 5) / 1e6, "short prompt");
  close(estimateCostUsd(terra, { input: 272_001, output: 100_000 }), (272_001 * 1 * 2 + 100_000 * 5 * 1.5) / 1e6, "past 272K");
  const metrics = getModelMetrics(terra);
  assert.deepEqual({ input: metrics.inputUsdPerMTok, output: metrics.outputUsdPerMTok }, { input: 1, output: 5 });
});

test("GPT Image 2.6 Sunburst and Flare are the current image tiers, offered only documented options", () => {
  for (const [id, family] of [
    ["openai:gpt-image-2.6-sunburst", "gpt-image"],
    ["openai:gpt-image-2.6-flare", "gpt-image-fast"],
  ] as const) {
    const row = listed(id);
    assert.ok(row, `${id} is in the catalog`);
    assert.equal(row.modality, "image");
    assert.equal(row.status, "current");
    assert.equal(row.family, family);
    const caps = capabilitiesFor(id);
    assert.ok(caps, `${id} has media parameters`);
    const quality = caps.options.quality;
    assert.ok(quality && quality.kind === "select");
    assert.deepEqual(quality.choices.map((c) => c.value), ["auto", "low", "medium", "high"], "xhigh/max are documented for 2.5 only");
    assert.equal(caps.options.background, undefined, "transparency is documented for 2.5 only");
  }
  assert.equal(model("openai:gpt-image-2.5-sunburst").status, "legacy");
  assert.equal(model("openai:gpt-image-2.5-flare").status, "legacy");
  assert.equal(migrateModelId("openai:dall-e-3"), "openai:gpt-image-2.6-sunburst");
});

test("Gemini Omni 1.2 Flash is the current Omni and runs on the Omni path", () => {
  const omni = listed("google:gemini-omni-1.2-flash");
  assert.ok(omni, "Gemini Omni 1.2 Flash is in the catalog");
  assert.equal(omni.modality, "video");
  assert.equal(omni.status, "current");
  assert.equal(isGoogleOmniModel(omni), true);
  assert.ok(capabilitiesFor("google:gemini-omni-1.2-flash"), "has media parameters");
  const previous = model("google:gemini-omni-1.1-flash");
  assert.equal(previous.status, "legacy");
  assert.equal(isGoogleOmniModel(previous), true, "1.1 is still served");
});

test("GLM-5.3 FlashX Legal is carried on FlashX's wiring and price, text only", () => {
  const legal = listed("zhipu:glm-5.3-flashx-legal");
  assert.ok(legal, "GLM-5.3 FlashX Legal is in the catalog");
  assert.equal(legal.status, "current");
  assert.equal(legal.vision, false, "Z.ai documents no image input for it");
  assert.equal(legal.reasoning, true);
  assert.equal(providerRequestModel(legal), "glm-5.3-flashx-legal");
  assert.deepEqual(reasoningCaps(legal), reasoningCaps(model("zhipu:glm-5.3-flashx")));
  const rate = tokenRate(legal);
  assert.equal(rate.input, 0.37);
  assert.equal(rate.output, 1.25);
  assert.equal(model("zhipu:glm-5.3-flashx").status, "current", "the general FlashX stays current");
});
