import test from "node:test";
import assert from "node:assert/strict";
import { buildAnthropicThinkingBits } from "@/lib/anthropic-thinking";
import { defaultReasoning, getModelMetrics, reasoningCaps, reasoningOptions } from "@/lib/model-metrics";
import { probeRequestFor } from "@/lib/model-capability-probe";
import { providerRequestModel } from "@/lib/model-request";
import { MODEL_LIST, RETIRED_MODELS, resolveModel, type ModelInfo } from "@/lib/models";
import { nativeModelCatalog } from "@/lib/native-model-manifest";
import { estimateCostUsd, fastModeMultiplier, tokenRate } from "@/lib/pricing";
import { providerAdapterFor } from "@/lib/provider-routing";
import { toolCapabilitiesFor } from "@/lib/model-tools";

/*
 * The four models that landed on 2026-09-22 — Claude Opus 5.5, GPT-6 Sol,
 * GPT-6 Luna and Grok 4.7 — followed from the id a picker stores all the way
 * to the request a provider receives.
 *
 * "Routes to the right model" is several claims, and each one has failed on
 * its own before in this codebase: the id must resolve to itself rather than
 * migrate somewhere else, the transport must be the provider's own, the wire
 * id must be the one the provider documents, and the thinking parameters must
 * be ones the model accepts — a 400 on every message is a routing failure
 * too, just one the picker cannot see.
 */

interface Expected {
  id: string;
  providerModel: string;
  family: string;
  adapter: ReturnType<typeof providerAdapterFor>;
  url: string;
}

const NEW_MODELS: Expected[] = [
  {
    id: "anthropic:claude-opus-5-5",
    providerModel: "claude-opus-5-5",
    family: "opus",
    adapter: "anthropic-native",
    url: "https://api.anthropic.com/v1/messages",
  },
  // Every OpenAI model is served through Responses (SPEC §5.2): GPT-6 Sol and
  // Luna call tools on /chat/completions only at effort "none". GPT-6 Sol was
  // itself superseded on 2026-09-29 by GPT-6.1 Sol, which leads the Sol line
  // now (its own contract is pinned in gpt-6-1-sol.test.ts).
  {
    id: "openai:gpt-6.1-sol",
    providerModel: "gpt-6.1-sol",
    family: "gpt",
    adapter: "openai-responses",
    url: "https://api.openai.com/v1/responses",
  },
  {
    id: "openai:gpt-6-luna",
    providerModel: "gpt-6-luna",
    family: "gpt-luna",
    adapter: "openai-responses",
    url: "https://api.openai.com/v1/responses",
  },
  // Grok searches only on xAI's Responses surface since Live Search was
  // retired (SPEC §5.5).
  {
    id: "xai:grok-4.7",
    providerModel: "grok-4.7",
    family: "grok",
    adapter: "xai-responses",
    url: "https://api.x.ai/v1/responses",
  },
];

function model(id: string): ModelInfo {
  const resolved = resolveModel(id);
  assert.ok(resolved, `${id} must resolve`);
  return resolved;
}

test("each new model is selectable and resolves to itself, not to a migration target", () => {
  for (const expected of NEW_MODELS) {
    const listed = MODEL_LIST.find((entry) => entry.id === expected.id);
    assert.ok(listed, `${expected.id} is in the picker's catalog`);
    assert.equal(listed.status, "current", `${expected.id} is the current row of its family`);
    assert.equal(listed.family, expected.family, `${expected.id} leads ${expected.family}`);
    assert.notEqual(listed.comingSoon, true, `${expected.id} is routable`);
    assert.equal(listed.modality, "chat");
    assert.ok(listed.vision, `${expected.id} takes images`);
    assert.ok(listed.reasoning, `${expected.id} is a reasoning model`);

    const resolved = model(expected.id);
    assert.equal(resolved.id, expected.id, `${expected.id} must not migrate`);
    assert.equal(resolved.provider, expected.id.split(":")[0]);
    assert.equal(resolved.providerModel, expected.providerModel);
  }
});

test("each new model goes out on its provider's own transport, with the documented wire id", () => {
  for (const expected of NEW_MODELS) {
    const resolved = model(expected.id);
    assert.equal(providerAdapterFor(resolved), expected.adapter, `${expected.id} transport`);
    assert.equal(providerRequestModel(resolved), expected.providerModel, `${expected.id} wire id`);

    // The capability probe builds its request from the same routing and the
    // same wire-id boundary the chat adapters use, so it is the one place the
    // URL and body can be asserted without a live key.
    const request = probeRequestFor(resolved, "test-key");
    assert.ok(request, `${expected.id} has a probe request`);
    assert.equal(request.adapter, expected.adapter);
    assert.equal(request.url, expected.url, `${expected.id} endpoint`);
    assert.equal(request.body.model, expected.providerModel, `${expected.id} body.model`);
    if (expected.adapter !== "anthropic-native") assert.equal(request.body.store, false, `${expected.id} keeps nothing`);
  }
});

test("each new model searches natively on the transport that serves it", () => {
  for (const expected of NEW_MODELS) {
    const resolved = model(expected.id);
    assert.equal(resolved.webSearch, true, `${expected.id} advertises native search`);
    assert.equal(toolCapabilitiesFor(resolved).supported, true, `${expected.id} takes function tools`);
  }
});

test("the models each one replaced stay routable under their own ids", () => {
  for (const [id, successor] of [
    ["anthropic:claude-opus-5", "anthropic:claude-opus-5-5"],
    ["openai:gpt-5.6-sol", "openai:gpt-6.1-sol"],
    ["openai:gpt-6-sol", "openai:gpt-6.1-sol"],
    ["openai:gpt-5.6-luna", "openai:gpt-6-luna"],
    ["xai:grok-4.6", "xai:grok-4.7"],
  ] as const) {
    const previous = model(id);
    assert.equal(previous.id, id, `${id} is superseded, not retired — it must still answer as itself`);
    assert.equal(previous.status, "legacy", `${id} steps down for ${successor}`);
    assert.equal(previous.family, model(successor).family, `${id} and ${successor} are one product line`);
  }
  // GPT-5.6 Terra has no GPT-6 tier, so it keeps its place.
  assert.equal(model("openai:gpt-5.6-terra").status, "current");
});

test("stored ids that pointed at a Sol tier land on the current Sol, GPT-6.1 Sol", () => {
  for (const alias of ["openai:gpt-5.6", "openai:gpt-5.5-thinking", "openai:o1-preview"]) {
    assert.equal(RETIRED_MODELS[alias], "openai:gpt-6.1-sol", alias);
    assert.equal(model(alias).id, "openai:gpt-6.1-sol", `${alias} routes to GPT-6.1 Sol`);
  }
  for (const retiring of ["openai:gpt-5", "openai:o3", "openai:o1", "openai:gpt-4-turbo"]) {
    assert.equal(model(retiring).replacedBy, "openai:gpt-6.1-sol", `${retiring} retires into GPT-6.1 Sol`);
  }
});

test("Claude Opus 5.5 always thinks: no Instant, medium by default, never `disabled`", () => {
  const opus = model("anthropic:claude-opus-5-5");
  assert.deepEqual(reasoningCaps(opus), {
    tiers: ["low", "medium", "high", "xhigh", "max"], canDisable: false, onOff: false, defaultLevel: "medium",
  });
  assert.equal(reasoningOptions(opus).some((option) => option.value === null), false, "no Instant option");
  assert.equal(defaultReasoning(opus), "medium");

  // With no tier, Opus 5 was left to its default; Opus 5.5 400s on
  // `{type: "disabled"}` and a manual budget, so it must get adaptive.
  const untiered = buildAnthropicThinkingBits("claude-opus-5-5", 8192, undefined);
  assert.equal(untiered.thinking?.type, "adaptive");
  assert.equal(untiered.outputConfig?.effort, "medium", "the API's own default, not Fable's high");
  if (untiered.thinking?.type === "adaptive") assert.equal(untiered.thinking.display, "summarized");

  for (const tier of ["low", "medium", "high", "xhigh", "max"] as const) {
    const bits = buildAnthropicThinkingBits("claude-opus-5-5", 8192, tier);
    assert.equal(bits.thinking?.type, "adaptive", tier);
    assert.equal(bits.outputConfig?.effort, tier);
  }

  // Opus 5 keeps its old contract: it still accepts a thinking-off request.
  assert.equal(reasoningCaps(model("anthropic:claude-opus-5")).canDisable, true);
  // Opus 5 thinks when `thinking` is omitted (Anthropic's per-model table:
  // default "On"), so its Instant has to send `disabled` explicitly.
  assert.deepEqual(buildAnthropicThinkingBits("claude-opus-5", 8192, undefined).thinking, { type: "disabled" });
});

test("GPT-6 Sol and Luna take the full none…max ladder; Astra still has no Instant", () => {
  for (const id of ["openai:gpt-6-sol", "openai:gpt-6-luna"]) {
    const gpt = model(id);
    assert.deepEqual(reasoningCaps(gpt).tiers, ["low", "medium", "high", "xhigh", "max"], id);
    assert.equal(reasoningCaps(gpt).canDisable, true, `${id} documents effort "none"`);
    assert.equal(reasoningOptions(gpt)[0]?.label, "Instant");
  }
  assert.equal(reasoningCaps(model("openai:gpt-6-astra")).canDisable, false);
});

test("Grok 4.7 keeps 4.6's ladder: low through xhigh, high by default, no off switch", () => {
  const grok = model("xai:grok-4.7");
  assert.deepEqual(reasoningCaps(grok), {
    tiers: ["low", "medium", "high", "xhigh"], canDisable: false, onOff: false, defaultLevel: "high",
  });
});

test("the native manifest publishes the same thinking contract for all four", () => {
  const models = NEW_MODELS.map((expected) => model(expected.id));
  const manifest = nativeModelCatalog(models).models;
  for (const source of models) {
    const entry = manifest.find((item) => item.id === source.id);
    assert.ok(entry, `${source.id} is in the native manifest`);
    const caps = reasoningCaps(source);
    assert.deepEqual(entry.supportedReasoningEfforts, caps.tiers, source.id);
    assert.equal(entry.reasoning.defaultEffort, caps.defaultLevel, source.id);
  }
});

test("Opus 5.5 is metered at its launch price, not Opus 5's", () => {
  const opus = model("anthropic:claude-opus-5-5");
  assert.deepEqual(tokenRate(opus), {
    input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8, cacheWrite5m: 5, cacheWrite1h: 8,
  });
  const fast = tokenRate(opus, true);
  assert.deepEqual({ input: fast.input, output: fast.output }, { input: 8, output: 40 });
  assert.equal(fastModeMultiplier(opus), 2);
  const metrics = getModelMetrics(opus);
  assert.deepEqual({ input: metrics.inputUsdPerMTok, output: metrics.outputUsdPerMTok }, { input: 4, output: 20 });
  // The rest of the family is unchanged.
  assert.equal(tokenRate(model("anthropic:claude-opus-5")).input, 5);
  assert.equal(tokenRate(model("anthropic:claude-opus-5")).cacheRead, 0.5);
});

test("GPT-6 Sol and Luna bill their published standard, cache, fast and long-context rates", () => {
  const sol = model("openai:gpt-6-sol");
  const luna = model("openai:gpt-6-luna");
  const close = (actual: number, expected: number, label: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} ≠ ${expected}`);

  const solRate = tokenRate(sol);
  close(solRate.input, 2, "sol input");
  close(solRate.output, 10, "sol output");
  close(solRate.cacheRead, 0.2, "sol cached input");
  close(solRate.cacheWrite, 2.5, "sol cache write");
  const lunaRate = tokenRate(luna);
  close(lunaRate.input, 0.1, "luna input");
  close(lunaRate.output, 0.5, "luna output");
  close(lunaRate.cacheRead, 0.01, "luna cached input");
  close(lunaRate.cacheWrite, 0.125, "luna cache write");
  assert.equal(fastModeMultiplier(sol), 2);
  assert.equal(fastModeMultiplier(luna), 2);

  // Past 272K input tokens the whole request is 2x input and 1.5x output.
  close(estimateCostUsd(sol, { input: 272_000, output: 100_000 }), 0.544 + 1, "sol at the threshold");
  close(estimateCostUsd(sol, { input: 272_001, output: 100_000 }), (272_001 * 2 * 2 + 100_000 * 10 * 1.5) / 1e6, "sol past it");
  close(estimateCostUsd(luna, { input: 272_001, output: 100_000 }), (272_001 * 0.1 * 2 + 100_000 * 0.5 * 1.5) / 1e6, "luna past it");
});

test("Grok 4.7 doubles every rate once a prompt reaches 200K tokens", () => {
  const grok = model("xai:grok-4.7");
  const close = (actual: number, expected: number, label: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} ≠ ${expected}`);
  const rate = tokenRate(grok);
  assert.deepEqual({ input: rate.input, output: rate.output, cacheRead: rate.cacheRead }, { input: 2, output: 6, cacheRead: 0.5 });
  close(estimateCostUsd(grok, { input: 199_999, output: 10_000 }), (199_999 * 2 + 10_000 * 6) / 1e6, "below the tier");
  close(estimateCostUsd(grok, { input: 200_000, output: 10_000 }), (200_000 * 4 + 10_000 * 12) / 1e6, "at the tier");
  // Cached input doubles with it: $1.00 rather than $0.50.
  close(
    estimateCostUsd(grok, { input: 250_000, cacheRead: 100_000, output: 0 }),
    (150_000 * 4 + 100_000 * 1) / 1e6,
    "cached input past the tier"
  );
});
