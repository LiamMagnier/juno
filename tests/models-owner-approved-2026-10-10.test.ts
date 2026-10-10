import Module, { createRequire } from "node:module";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { capabilitiesFor } from "@/lib/media-params";
import { getModel, GEN_MODELS, MODEL_LIST, RETIRED_MODELS, resolveModel } from "@/lib/models";
import { reasoningCaps } from "@/lib/model-metrics";
import { tokenRate } from "@/lib/pricing";

// spend.ts is server-only; load it past the guard, as the other route tests do.
const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};
const { mediaRequestCost } = createRequire(import.meta.url)("../src/lib/spend") as typeof import("@/lib/spend");

/*
 * The three models the owner approved on 2026-10-10 ("yes add the 3 models"),
 * each checked against the official page it was read from:
 *  - Mistral Large 4: docs.mistral.ai/models/mistral-large-4-0
 *  - Qwen3.8 Omni Flash: alibabacloud.com/help/en/model-studio/qwen3-8-omni-flash
 *    and model-pricing (Qwen-Omni, Singapore)
 *  - Nano Banana 2.1: ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1
 *    and ai.google.dev/gemini-api/docs/pricing
 */

test("Mistral Large 4 is its own preview row at list price; mistral-large-latest is still Large 3", () => {
  const large4 = MODEL_LIST.find((m) => m.id === "mistral:mistral-large-4");
  assert.ok(large4);
  assert.equal(large4.providerModel, "mistral-large-4", "an API name on the card");
  assert.equal(large4.status, "current");
  assert.equal(large4.vision, true);
  assert.equal(large4.reasoning, false, "the card states no reasoning control");
  assert.equal(large4.contextWindow, 1_000_000);
  const rate = tokenRate(large4);
  assert.deepEqual([rate.input, rate.output, rate.cacheRead], [1.36, 4.18, 0.14]);
  assert.equal(getModel("mistral:mistral-large-latest")!.name, "Mistral Large 3");
  assert.equal(getModel("mistral:mistral-large-latest")!.status, "current");
});

test("Qwen3.8 Omni Flash: official price and window, and no invented effort ladder", () => {
  const omni = MODEL_LIST.find((m) => m.id === "qwen:qwen3.8-omni-flash");
  assert.ok(omni);
  assert.equal(omni.vision, true);
  assert.equal(omni.reasoning, false);
  assert.deepEqual(reasoningCaps(omni).tiers, [], "no slider: the levels are not published");
  assert.equal(omni.contextWindow, 1_000_000);
  const rate = tokenRate(omni);
  assert.deepEqual([rate.input, rate.output, rate.cacheRead], [0.15, 0.47, 0.016]);
});

test("Nano Banana 2.1 leads the Flash image line, priced per image, and the retired ids land on it", () => {
  const nb = GEN_MODELS.find((m) => m.id === "google:gemini-nano-banana-2.1");
  assert.ok(nb);
  assert.equal(nb.modality, "image");
  assert.equal(nb.status, "current");
  assert.equal(getModel("google:gemini-3.1-flash-image")!.status, "legacy", "Nano Banana 2 steps down, still callable");
  assert.equal(nb.family, getModel("google:gemini-3.1-flash-image")!.family);
  assert.equal(mediaRequestCost(nb.id, "image"), 33_600, "$0.0336 a 1K image");
  const caps = capabilitiesFor(nb.id);
  assert.ok(caps);
  const sizes = (caps.options.resolution as { choices: { value: string }[] }).choices.map((c) => c.value);
  assert.deepEqual(sizes, ["1K", "2K", "4K"]);
  for (const id of ["google:gemini-2.5-flash-image", "google:imagen-4.0-generate-001", "google:imagen-3.0-generate-002"]) {
    assert.equal(RETIRED_MODELS[id], nb.id, id);
    assert.equal(resolveModel(id)?.id, nb.id, id);
  }
  const page = readFileSync(path.join(process.cwd(), "tests/fixtures/model-sync/ai.google.dev_gemini-api_docs_models_gemini-nano-banana-2.1.md.txt"), "utf8");
  assert.match(page, /`gemini-nano-banana-2\.1`/);
  assert.match(page, /`1K`, `2K`, and `4K` output resolutions \(default `1K`\)/);
});
