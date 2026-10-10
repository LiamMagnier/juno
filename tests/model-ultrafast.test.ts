import Module, { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import type OpenAI from "openai";

import { chatBodySchema } from "@/lib/chat/request";
import { nativeModelCatalog } from "@/lib/native-model-manifest";
import { getModel, type ModelInfo } from "@/lib/models";
import {
  estimateCostUsd,
  fastModeMultiplier,
  resolveFastMode,
  serviceTierFor,
  supportsUltraFastMode,
  tokenRate,
  ultraFastMultiplier,
} from "@/lib/pricing";
import type { LlmEvent, MessageForModel } from "@/types/llm";
import { scripted } from "./fixtures/tool-loop";

/*
 * GPT-6.1 Sol's Ultrafast mode (developers.openai.com/api/docs/guides/
 * ultrafast-mode, read 2026-10-10): `service_tier: "ultrafast"` on the
 * Responses API, for GPT-6 Astra and GPT-6.1 Sol, priced at 6x Standard.
 * The tier, the multiplier and the rates all come from OpenAI's Ultrafast
 * pricing table via models:sync (model-rates.generated.ts), never inferred.
 */

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const { streamOpenAIResponses } = req("../src/lib/openai-responses") as typeof import("@/lib/openai-responses");

function model(id: string): ModelInfo {
  const found = getModel(id);
  assert.ok(found, `${id} is in the catalog`);
  return found;
}

test("Ultrafast is offered on GPT-6.1 Sol and GPT-6 Astra only, at OpenAI's 6x", () => {
  for (const id of ["openai:gpt-6.1-sol", "openai:gpt-6-astra"]) {
    assert.equal(supportsUltraFastMode(model(id)), true, id);
    assert.equal(ultraFastMultiplier(model(id)), 6, id);
  }
  for (const id of ["openai:gpt-6-luna", "openai:gpt-6-sol", "anthropic:claude-opus-5-5", "anthropic:claude-haiku-5-5", "google:gemini-3.8-flash"]) {
    assert.equal(supportsUltraFastMode(model(id)), false, id);
  }
  // Flash on the same model is OpenAI's 2x Fast tier, a separate premium.
  assert.equal(fastModeMultiplier(model("openai:gpt-6.1-sol")), 2);
});

test("an Ultrafast turn bills OpenAI's Ultrafast column, cache rates included", () => {
  const sol = model("openai:gpt-6.1-sol");
  const ultra = tokenRate(sol, "ultrafast");
  assert.equal(ultra.input, 12);
  assert.equal(ultra.output, 60);
  assert.ok(Math.abs(ultra.cacheRead - 0.6) < 1e-9);
  assert.ok(Math.abs(ultra.cacheWrite - 15) < 1e-9);
  const fast = tokenRate(sol, true);
  assert.deepEqual([fast.input, fast.output], [4, 20]);
  // 100K in + 100K out (under the 272K band): $7.20 Ultrafast against $1.20 standard.
  assert.ok(Math.abs(estimateCostUsd(sol, { input: 100_000, output: 100_000 }, "ultrafast") - 7.2) < 1e-9);
  assert.ok(Math.abs(estimateCostUsd(sol, { input: 100_000, output: 100_000 }) - 1.2) < 1e-9);
  // Above 272K the long-context surcharge stacks on the Ultrafast rate.
  assert.ok(estimateCostUsd(sol, { input: 300_000, output: 0 }, "ultrafast") > estimateCostUsd(sol, { input: 300_000, output: 0 }, true));
});

test("the route serves Ultrafast only where the model has it, and never silently downgrades to Flash", () => {
  const sol = model("openai:gpt-6.1-sol");
  const opus = model("anthropic:claude-opus-5-5");
  assert.equal(resolveFastMode(sol, { ultraFast: true }), "ultrafast");
  assert.equal(resolveFastMode(sol, { ultraFast: true, fastMode: true }), "ultrafast", "Ultrafast wins");
  assert.equal(resolveFastMode(opus, { ultraFast: true, fastMode: true }), false, "asked for 6x, not 2x");
  assert.equal(resolveFastMode(opus, { fastMode: true }), true);
  assert.equal(resolveFastMode(sol, {}), false);
  assert.equal(serviceTierFor("ultrafast"), "ultrafast");
  assert.equal(serviceTierFor(true), "priority");
  assert.equal(serviceTierFor(false), undefined);
  const parsed = chatBodySchema.safeParse({ model: "openai:gpt-6.1-sol", message: "hi", ultraFast: true });
  assert.ok(parsed.success, "the chat body accepts ultraFast");
  assert.equal(parsed.data?.ultraFast, true);
});

test("the Responses request carries service_tier ultrafast", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const transport = {
    async create(params: OpenAI.Responses.ResponseCreateParamsStreaming, options: { signal?: AbortSignal }) {
      requests.push(structuredClone(params) as unknown as Record<string, unknown>);
      return scripted(
        [
          { type: "response.output_text.delta", delta: "Hi" },
          { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } },
        ] as unknown as OpenAI.Responses.ResponseStreamEvent[],
        options.signal,
      );
    },
  };
  const history: MessageForModel[] = [{ role: "USER", content: "Hi", attachments: [] }];
  const events: LlmEvent[] = [];
  for await (const e of streamOpenAIResponses(model("openai:gpt-6.1-sol"), "sys", history, 1_000, undefined, "medium", false, undefined, undefined, "c", "ultrafast", false, transport)) events.push(e);
  assert.equal(requests[0].service_tier, "ultrafast");
  requests.length = 0;
  for await (const e of streamOpenAIResponses(model("openai:gpt-6.1-sol"), "sys", history, 1_000, undefined, "medium", false, undefined, undefined, "c", true, false, transport)) events.push(e);
  assert.equal(requests[0].service_tier, "priority");
});

test("the native manifest publishes ultraFastMode beside fastMode, null for everything else and for Auto", () => {
  const manifest = nativeModelCatalog([model("openai:gpt-6.1-sol"), model("anthropic:claude-opus-5-5")]);
  const byId = new Map(manifest.models.map((m) => [m.id, m]));
  assert.deepEqual(byId.get("openai:gpt-6.1-sol")?.ultraFastMode, { rateMultiplier: 6 });
  assert.deepEqual(byId.get("openai:gpt-6.1-sol")?.fastMode, { rateMultiplier: 2 });
  assert.equal(byId.get("anthropic:claude-opus-5-5")?.ultraFastMode, null);
  assert.equal(byId.get("juno:auto")?.ultraFastMode, null);
});
