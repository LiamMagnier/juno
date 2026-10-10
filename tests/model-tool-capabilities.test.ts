import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  hostedSearchAllowedAt,
  labHasNativeSearch,
  providerSearchAvailable,
  toolCapabilitiesFor,
  type ModelToolCapabilities,
} from "@/lib/model-tools";
import { MODEL_LIST, modelSearchesNatively, providerSupportsWebSearch, resolveModel } from "@/lib/models";
import { providerSearchServed } from "@/lib/provider-routing";
import { PROVIDER_LIST } from "@/lib/providers";

/*
 * The per-model tool capabilities (SPEC §5.6): the record every adapter reads
 * for what a model's host accepts — whether it takes function tools, how its
 * last request is made tools-off, what thinking it needs back, whether it
 * searches natively on Juno's transport.
 *
 * Values from the provider capability audit
 * (docs/chat-rework/audit/gap-provider-tool-capabilities.md §2). The items
 * that audit marks "needs live probe" keep their conservative value until the
 * probe in scripts/probes/ runs; changing one is a change to this snapshot.
 */

test("the capabilities stay importable by the composer", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/model-tools.ts"), "utf8");
  assert.doesNotMatch(source, /^import "server-only";/m);
});

/** One line per model: the whole record, in a form a diff reads. */
function signature(id: string, c: ModelToolCapabilities): string {
  const flags = [
    c.supported ? "tools" : "no-tools",
    c.chatCompletions ? "cc" : "no-cc",
    c.responses ? "responses" : "",
    `parallel:${c.parallel}`,
    `final:${c.finalRound === "tool_choice_none" ? "none" : "omit"}`,
    c.replay === "none" ? "" : `replay:${c.replay}/${c.replayField ?? "-"}`,
    c.userAfterTool ? "" : "no-user-after-tool",
    c.nativeSearch ? "search" : "",
    c.anthropicSearchVersion ? `ws:${c.anthropicSearchVersion}` : "",
    c.hostedSearchMinEffort ? `search>=${c.hostedSearchMinEffort}` : "",
    `max:${c.maxTools}`,
  ];
  return `${id} ${flags.filter(Boolean).join(" ")}`;
}

const TABLE = [
  "anthropic:claude-fable-5-1 tools cc parallel:default final:none search ws:20260318 max:128",
  "anthropic:claude-fable-5 tools cc parallel:default final:none search ws:20250305 max:128",
  "anthropic:claude-opus-5-5 tools cc parallel:default final:none search ws:20260318 max:128",
  "anthropic:claude-opus-5 tools cc parallel:default final:none search ws:20250305 max:128",
  "anthropic:claude-opus-4-8 tools cc parallel:default final:none search ws:20250305 max:128",
  "anthropic:claude-sonnet-5-5 tools cc parallel:default final:none search ws:20260318 max:128",
  "anthropic:claude-sonnet-5 tools cc parallel:default final:none search ws:20260318 max:128",
  "anthropic:claude-haiku-5-5 tools cc parallel:default final:none search ws:20250305 max:128",
  "anthropic:claude-haiku-4-5 tools cc parallel:default final:none search ws:20250305 max:128",
  "anthropic:claude-sonnet-4-6 tools cc parallel:default final:none search ws:20250305 max:128",
  "anthropic:claude-opus-4-7 tools cc parallel:default final:none search ws:20250305 max:128",
  "anthropic:claude-opus-4-6 tools cc parallel:default final:none search ws:20250305 max:128",
  "anthropic:claude-opus-4-5 tools cc parallel:default final:none search ws:20250305 max:128",
  "anthropic:claude-sonnet-4-5 tools cc parallel:default final:none search ws:20250305 max:128",
  "openai:gpt-6-astra tools no-cc responses parallel:default final:none search max:128",
  "openai:gpt-6.1-sol tools no-cc responses parallel:default final:none search max:128",
  "openai:gpt-6-sol tools no-cc responses parallel:default final:none search max:128",
  "openai:gpt-6-luna tools no-cc responses parallel:default final:none search max:128",
  "openai:gpt-5.6-sol tools no-cc responses parallel:default final:none search max:128",
  "openai:gpt-5.6-terra tools no-cc responses parallel:default final:none search max:128",
  "openai:gpt-5.6-luna tools no-cc responses parallel:default final:none search max:128",
  "openai:gpt-5.5 tools cc responses parallel:default final:none search max:128",
  "openai:gpt-5.5-pro tools no-cc responses parallel:default final:none search max:128",
  "openai:gpt-5.4 tools cc responses parallel:default final:none search max:128",
  "openai:gpt-5.4-mini tools cc responses parallel:default final:none search max:128",
  "openai:gpt-5.4-nano tools cc responses parallel:default final:none search max:128",
  "openai:gpt-5.3-codex tools no-cc responses parallel:default final:none search max:128",
  "openai:gpt-5.4-pro tools no-cc responses parallel:default final:none search max:128",
  "openai:gpt-5.2 tools cc responses parallel:default final:none search max:128",
  "openai:gpt-5.2-pro tools no-cc responses parallel:default final:none search max:128",
  "openai:gpt-5.1 tools cc responses parallel:default final:none search max:128",
  "openai:gpt-5 tools cc responses parallel:default final:none search search>=low max:128",
  "openai:gpt-5-mini tools cc responses parallel:default final:none search max:128",
  "openai:o3 tools cc responses parallel:default final:none search max:128",
  "openai:o3-mini tools cc responses parallel:default final:none max:128",
  "openai:o1 tools cc responses parallel:default final:none max:128",
  "openai:gpt-4o tools cc responses parallel:default final:none search max:128",
  "openai:gpt-4o-mini tools cc responses parallel:default final:none search max:128",
  "openai:gpt-4-turbo tools cc responses parallel:default final:none max:128",
  "openai:gpt-3.5-turbo tools cc responses parallel:default final:none max:128",
  "google:gemini-3.8-flash tools cc parallel:default final:none search max:128",
  "google:gemini-3.6-flash tools cc parallel:default final:none search max:128",
  "google:gemini-3.1-pro-preview tools cc parallel:default final:none search max:128",
  "google:gemini-3.5-flash-lite tools cc parallel:default final:none search max:128",
  "google:gemini-3.1-flash-lite tools cc parallel:default final:none search max:128",
  "google:gemini-3-flash-preview tools cc parallel:default final:none search max:128",
  "google:gemini-2.5-pro tools cc parallel:default final:none max:128",
  "meta:muse-spark-1.3 tools cc parallel:default final:omit search max:128",
  "meta:muse-spark-1.3-contributor tools cc parallel:default final:omit search max:128",
  "meta:muse-spark-1.2 tools cc parallel:default final:omit search max:128",
  "meta:muse-spark-1.2-contributor tools cc parallel:default final:omit search max:128",
  "meta:muse-spark-1.1 tools cc parallel:default final:omit search max:128",
  "zhipu:glm-5.3 tools cc parallel:unknown final:omit replay:should/reasoning_content search max:128",
  "zhipu:glm-5.3-flash tools cc parallel:unknown final:omit replay:should/reasoning_content search max:128",
  "zhipu:glm-5.3-flashx tools cc parallel:unknown final:omit replay:should/reasoning_content search max:128",
  "zhipu:glm-5.2 tools cc parallel:unknown final:omit replay:should/reasoning_content search max:128",
  "zhipu:glm-4.7-flash tools cc parallel:unknown final:omit replay:should/reasoning_content search max:128",
  "zhipu:glm-4.7-flashx tools cc parallel:unknown final:omit replay:should/reasoning_content search max:128",
  "zhipu:glm-5.1 tools cc parallel:unknown final:omit replay:should/reasoning_content search max:128",
  "zhipu:glm-5 tools cc parallel:unknown final:omit replay:should/reasoning_content search max:128",
  "zhipu:glm-4.7 tools cc parallel:unknown final:omit replay:should/reasoning_content search max:128",
  "zhipu:glm-4.6 tools cc parallel:unknown final:omit replay:should/reasoning_content search max:128",
  "zhipu:glm-4.6v tools cc parallel:unknown final:omit replay:should/reasoning_content search max:128",
  "zhipu:glm-4.6v-flashx tools cc parallel:unknown final:omit replay:should/reasoning_content search max:128",
  "zhipu:glm-4.6v-flash tools cc parallel:unknown final:omit replay:should/reasoning_content search max:128",
  "zhipu:glm-4.5v tools cc parallel:unknown final:omit replay:should/reasoning_content search max:128",
  "zhipu:glm-4.5-x tools cc parallel:unknown final:omit replay:should/reasoning_content search max:128",
  "zhipu:glm-4.5-air tools cc parallel:unknown final:omit replay:should/reasoning_content search max:128",
  "zhipu:glm-4.5-airx tools cc parallel:unknown final:omit replay:should/reasoning_content search max:128",
  "zhipu:glm-4-32b-0414-128k tools cc parallel:unknown final:omit replay:should/reasoning_content search max:128",
  "zhipu:glm-4.5-flash tools cc parallel:unknown final:omit replay:should/reasoning_content search max:128",
  "moonshot:kimi-k3 tools cc parallel:default final:none replay:must/reasoning_content max:128",
  "moonshot:kimi-k2.6 tools cc parallel:default final:none replay:must/reasoning_content max:128",
  "moonshot:kimi-k2.7-code tools cc parallel:default final:none replay:must/reasoning_content max:128",
  "moonshot:kimi-k2.7-code-highspeed tools cc parallel:default final:none replay:must/reasoning_content max:128",
  "deepseek:deepseek-flash tools cc parallel:unknown final:none replay:must/reasoning_content max:128",
  "deepseek:deepseek-v4-pro tools cc parallel:unknown final:none replay:must/reasoning_content max:128",
  "mistral:mistral-medium-latest tools cc parallel:default final:none replay:should/thinkchunk no-user-after-tool max:128",
  "mistral:mistral-large-4 tools cc parallel:default final:none no-user-after-tool max:128",
  "mistral:mistral-large-latest tools cc parallel:default final:none no-user-after-tool max:128",
  "mistral:mistral-small-latest tools cc parallel:default final:none replay:should/thinkchunk no-user-after-tool max:128",
  "mistral:codestral-latest tools cc parallel:default final:none no-user-after-tool max:128",
  "mistral:ministral-14b-latest tools cc parallel:default final:none no-user-after-tool max:128",
  "mistral:ministral-8b-latest tools cc parallel:default final:none no-user-after-tool max:128",
  "mistral:ministral-3b-latest tools cc parallel:default final:none no-user-after-tool max:128",
  "xai:grok-4.7 tools cc responses parallel:default final:none search max:350",
  "xai:grok-4.6 tools cc responses parallel:default final:none search max:350",
  "xai:grok-4.5 tools cc responses parallel:default final:none search max:350",
  "xai:grok-4.3 tools cc responses parallel:default final:none search max:350",
  "xai:grok-build-0.1 tools cc responses parallel:default final:none max:350",
  "xai:grok-4.20-multi-agent-0309 no-tools no-cc responses parallel:default final:none search max:350",
  "xai:grok-4.20-0309-reasoning tools cc responses parallel:default final:none search max:350",
  "xai:grok-4.20-0309-non-reasoning tools cc responses parallel:default final:none search max:350",
  "minimax:MiniMax-M3 tools cc parallel:unknown final:omit replay:should/reasoning_details max:128",
  "minimax:MiniMax-M3.1-Flash-Preview tools cc parallel:unknown final:omit replay:should/reasoning_details max:128",
  "minimax:MiniMax-M2.7-highspeed tools cc parallel:unknown final:omit replay:should/reasoning_details max:128",
  "minimax:MiniMax-M2.7 tools cc parallel:unknown final:omit replay:should/reasoning_details max:128",
  "minimax:MiniMax-M2.5 tools cc parallel:unknown final:omit replay:should/reasoning_details max:128",
  "mimo:mimo-v2.6-pro tools cc parallel:unknown final:omit replay:must/reasoning_content search max:128",
  "mimo:mimo-v2.6-pro-ultraspeed tools cc parallel:unknown final:omit replay:must/reasoning_content search max:128",
  "mimo:mimo-v2.6-flash tools cc parallel:unknown final:omit replay:must/reasoning_content search max:128",
  "mimo:mimo-v2.5 tools cc parallel:unknown final:omit replay:must/reasoning_content search max:128",
  "mimo:mimo-v2.5-pro tools cc parallel:unknown final:omit replay:must/reasoning_content search max:128",
  "qwen:qwen3.8-max tools cc parallel:opt_in final:none replay:should/reasoning_content search max:128",
  "qwen:qwen3.7-max tools cc parallel:opt_in final:none replay:should/reasoning_content search max:128",
  "qwen:qwen3.7-plus tools cc parallel:opt_in final:none replay:should/reasoning_content search max:128",
  "qwen:qwen3.8-omni-flash tools cc parallel:opt_in final:none replay:should/reasoning_content search max:128",
  "qwen:qwen3.8-flash tools cc parallel:opt_in final:none replay:should/reasoning_content search max:128",
  "qwen:qwen3.7-flash tools cc parallel:opt_in final:none replay:should/reasoning_content search max:128",
  "qwen:qwen3.6-flash tools cc parallel:opt_in final:none replay:should/reasoning_content search max:128",
  "qwen:qwen3.6-plus tools cc parallel:opt_in final:none replay:should/reasoning_content search max:128",
  "qwen:qwen3.5-plus tools cc parallel:opt_in final:none replay:should/reasoning_content search max:128",
  "qwen:qwen3.5-flash tools cc parallel:opt_in final:none replay:should/reasoning_content search max:128",
  "qwen:qwen3-vl-plus no-tools cc parallel:opt_in final:none replay:should/reasoning_content max:128",
  "qwen:qwen3-vl-flash no-tools cc parallel:opt_in final:none replay:should/reasoning_content max:128",
  "qwen:qwen3-coder-plus no-tools cc parallel:opt_in final:none replay:should/reasoning_content max:128",
  "qwen:qwen3-235b-a22b no-tools cc parallel:opt_in final:none replay:should/reasoning_content max:128",
  "qwen:qwen3-30b-a3b no-tools cc parallel:opt_in final:none replay:should/reasoning_content max:128",
  "qwen:qwen-max no-tools cc parallel:opt_in final:none replay:should/reasoning_content max:128",
  "longcat:LongCat-2.0 tools cc parallel:unknown final:omit max:128",
  "longcat:LongCat-2.5-Preview tools cc parallel:unknown final:omit max:128",
];

/*
 * Pinned per model, not as one ordered list, and only for models still in
 * MODEL_LIST. The ordered list broke a deploy on 2026-10-09: three Qwen rows
 * reached their retiresOn, left MODEL_LIST by the clock, and the snapshot no
 * longer matched although nothing had changed. A line for a model that has
 * since retired is simply not checked; a live model without a line still
 * fails, because adding a model is a change to this snapshot.
 */
test("every chat model in the catalog has a record, and the table is pinned", () => {
  const chat = MODEL_LIST.filter((model) => model.modality === "chat");
  const pinned = new Map(TABLE.map((line) => [line.split(" ")[0], line]));
  for (const model of chat) {
    assert.equal(signature(model.id, toolCapabilitiesFor(model)), pinned.get(model.id) ?? `${model.id} (no pinned line)`);
  }
  for (const model of chat) {
    const caps = toolCapabilitiesFor(model);
    assert.ok(caps.maxTools > 0, model.id);
    // Only the compat adapter reads `replay`; the native ones replay their own items.
    if (["anthropic", "openai", "google", "xai"].includes(model.provider)) assert.equal(caps.replay, "none", model.id);
    if (caps.replay !== "none") assert.ok(caps.replayField, `${model.id} names its replay field`);
  }
});

test("ModelInfo.webSearch is the provider's own search, read from the record", () => {
  for (const model of MODEL_LIST.filter((m) => m.modality === "chat")) {
    assert.equal(model.webSearch, providerSearchAvailable(model), model.id);
    assert.equal(model.webSearch, modelSearchesNatively(model), model.id);
  }
  // RC-2: every current OpenAI model searches on Responses now.
  for (const id of ["openai:gpt-6-astra", "openai:gpt-6.1-sol", "openai:gpt-6-sol", "openai:gpt-6-luna", "openai:gpt-5.6-terra"]) {
    assert.equal(resolveModel(id)?.webSearch, true, id);
  }
  // Pre-Gemini-3 grounds on a request that carries no functions. The flag the
  // chat route reads until WS9a stays on, while the tool plan counts it as
  // having no native search and gives it Juno's web_search beside its tools.
  const legacyGemini = MODEL_LIST.find((m) => m.id === "google:gemini-2.5-pro");
  assert.ok(legacyGemini);
  assert.equal(legacyGemini.webSearch, true);
  assert.equal(toolCapabilitiesFor(legacyGemini).nativeSearch, false);
  // No provider search on Juno's transport: Live Search is gone, and the
  // unconfirmed Grok slug has no Responses search yet (probe P13b).
  for (const id of ["xai:grok-build-0.1"]) {
    assert.equal(MODEL_LIST.find((m) => m.id === id)?.webSearch, false, id);
  }
  // A lab-level answer for the places that know only a provider.
  for (const provider of PROVIDER_LIST) assert.equal(providerSupportsWebSearch(provider), labHasNativeSearch(provider), provider);
  assert.equal(labHasNativeSearch("openai"), true);
  assert.equal(labHasNativeSearch("deepseek"), false);
});

test("the catalog flag never reads the deployment's env; the server's own gate does", () => {
  const sol = { provider: "openai", id: "openai:gpt-6-sol" } as const;
  const saved = process.env.OPENAI_RESPONSES;
  process.env.OPENAI_RESPONSES = "0";
  try {
    // The composer reads ModelInfo.webSearch in the browser, where server env
    // is undefined, so the flag must not depend on it.
    assert.equal(modelSearchesNatively(sol), true);
    // Chat Completions carries no hosted search.
    assert.equal(providerSearchServed(sol), false);
    // A Responses-only snapshot keeps its route, and so its search.
    assert.equal(providerSearchServed({ provider: "openai", id: "openai:gpt-5.5-pro", api: "responses" }), true);
  } finally {
    if (saved === undefined) delete process.env.OPENAI_RESPONSES;
    else process.env.OPENAI_RESPONSES = saved;
  }
  assert.equal(providerSearchServed(sol), saved !== "0");
  assert.equal(providerSearchServed({ provider: "google", id: "google:gemini-2.5-pro" }), true, "grounding alone");
  assert.equal(providerSearchServed({ provider: "xai", id: "xai:grok-4.7" }), true);
  assert.equal(providerSearchServed({ provider: "xai", id: "xai:grok-4.7", tools: { responses: false } }), false, "compat maps no search");
  assert.equal(providerSearchServed({ provider: "deepseek", id: "deepseek:deepseek-flash" }), false);
});

test("toolCapabilitiesFor reads the lab row, the model's own rules and the overrides", () => {
  const caps = (provider: Parameters<typeof toolCapabilitiesFor>[0]["provider"], id: string, extra: object = {}) =>
    toolCapabilitiesFor({ provider, id: `${provider}:${id}`, ...extra });
  assert.equal(caps("anthropic", "claude-opus-5-5").anthropicSearchVersion, "20260318");
  assert.equal(caps("anthropic", "claude-haiku-4-5").anthropicSearchVersion, "20250305");
  assert.equal(caps("openai", "gpt-6-astra").chatCompletions, false);
  assert.equal(caps("openai", "gpt-5.5-pro", { api: "responses" }).chatCompletions, false);
  assert.equal(caps("openai", "gpt-5").hostedSearchMinEffort, "low");
  assert.equal(caps("google", "gemini-3.8-flash").nativeSearch, true);
  assert.equal(caps("google", "gemini-2.5-pro").nativeSearch, false, "pre-Gemini-3 keeps its functions");
  assert.equal(caps("xai", "grok-4.20-multi-agent-0309").supported, false);
  assert.equal(caps("xai", "grok-4.20-multi-agent-0309").responses, true, "Responses is its only route");
  assert.equal(caps("xai", "grok-build-0.1").nativeSearch, false, "server search unconfirmed (P13b)");
  assert.equal(caps("deepseek", "deepseek-v4-pro").replay, "must");
  assert.equal(caps("meta", "muse-spark-1.3").finalRound, "omit_tools");
  assert.equal(caps("mistral", "mistral-large-latest").userAfterTool, false);
  assert.equal(caps("qwen", "qwen3.8-max").parallel, "opt_in");
  assert.equal(caps("moonshot", "kimi-k9-unreleased").replay, "must", "an unlisted model gets its lab's row");
  assert.equal(caps("openai", "gpt-9-unreleased").responses, true, "a discovered OpenAI model is a Responses model");
  assert.equal(caps("openai", "gpt-6-sol", { tools: { maxTools: 32 } }).maxTools, 32, "the catalog override wins");
});

test("hosted search is allowed at an effort only where the model takes it", () => {
  const gpt5 = toolCapabilitiesFor({ provider: "openai", id: "openai:gpt-5" });
  assert.equal(hostedSearchAllowedAt(gpt5, "minimal"), false);
  assert.equal(hostedSearchAllowedAt(gpt5, null), false, "no effort ranks below every tier");
  assert.equal(hostedSearchAllowedAt(gpt5, "low"), true);
  assert.equal(hostedSearchAllowedAt(gpt5, "high"), true);
  const sol = toolCapabilitiesFor({ provider: "openai", id: "openai:gpt-6-sol" });
  assert.equal(hostedSearchAllowedAt(sol, null), true);
  assert.equal(hostedSearchAllowedAt(toolCapabilitiesFor({ provider: "deepseek", id: "deepseek:deepseek-flash" }), "high"), false);
});
