import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_LIST, getModel, type ModelInfo } from "@/lib/models";
import { reasoningCaps, reasoningOptions, REASONING_TIERS } from "@/lib/model-metrics";
import { reasoningCapabilityForModel } from "@/lib/model-reasoning-capabilities";
import { effectiveReasoningEffort } from "@/lib/chat-responses";
import { providerAdapterFor } from "@/lib/provider-routing";
import { nativeModelCatalog } from "@/lib/native-model-manifest";
import { anthropicThinkingBits as agentCoreThinkingBits } from "../runner/agent-core/src/providers/thinking.js";
import { buildAnthropicThinkingBits } from "@/lib/anthropic-thinking";
import { scripted, sseResponse } from "./fixtures/tool-loop";
import type { ReasoningEffort } from "@/types/chat";
import type { MessageForModel } from "@/types/llm";

/*
 * Every effort a picker offers has to reach the provider as a value the
 * provider accepts. This walks the whole chat catalogue through the REAL
 * production adapters (llm.ts's switch), with only provider I/O scripted, and
 * checks the reasoning fragment of the request body each offered option
 * produces. The owner-visible failure this exists for: Claude Haiku 5.5 was
 * offered tiers that one request builder turned into
 * `thinking: {type: "enabled", budget_tokens}`, which Haiku 5.5 rejects.
 *
 * No network and no keys: fetch throws, and every adapter takes a transport.
 */
const modules = Module as unknown as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const originalLoad = modules._load;
modules._load = function (name, parent, main) {
  return name === "server-only" ? {} : originalLoad.call(this, name, parent, main);
};
globalThis.fetch = async () => {
  throw new Error("effort wire test attempted network I/O");
};
const require = createRequire(import.meta.url);
const { streamAnthropic } = require("../src/lib/anthropic") as typeof import("@/lib/anthropic");
const { streamOpenAICompat } = require("../src/lib/openai-compat") as typeof import("@/lib/openai-compat");
const { streamOpenAIResponses } = require("../src/lib/openai-responses") as typeof import("@/lib/openai-responses");
const { streamGemini } = require("../src/lib/gemini") as typeof import("@/lib/gemini");
const { compatReasoningFields } = require("../src/lib/llm/compat-loop") as typeof import("@/lib/llm/compat-loop");

type Raw = Record<string, unknown>;
const history: MessageForModel[] = [{ role: "USER", content: "Say hi.", attachments: [] }];

const ANTHROPIC_DONE: Raw[] = [
  { type: "message_start", message: { usage: { input_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
];
const COMPAT_DONE: Raw[] = [
  { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
];
const RESPONSES_DONE: Raw[] = [
  { type: "response.output_text.delta", delta: "hi" },
  { type: "response.completed", response: { id: "r", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
];
const GEMINI_DONE: Raw[] = [
  { candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } },
];

/** The first request body the production adapter for `model` sends at `effort`. */
async function firstBody(model: ModelInfo, effort: ReasoningEffort | undefined): Promise<Raw> {
  let body: Raw | undefined;
  const capture = (b: unknown) => {
    body ??= structuredClone(b) as Raw;
  };
  const adapter = providerAdapterFor(model);
  const e = effort ?? undefined;
  let gen: AsyncGenerator<unknown>;
  switch (adapter) {
    case "anthropic-native":
      gen = streamAnthropic(model, "System", history, 1000, undefined, e, false, undefined, undefined, false, undefined, {
        create: async (b: unknown) => (capture(b), scripted(ANTHROPIC_DONE as never[])),
      });
      break;
    case "gemini-native":
      gen = streamGemini(model, "System", history, 1000, undefined, e, false, undefined, undefined, undefined, {
        request: async ({ body: b }: { body: unknown }) => (capture(b), sseResponse(GEMINI_DONE)),
      });
      break;
    case "openai-responses":
    case "xai-responses":
    case "meta-responses":
      gen = streamOpenAIResponses(model, "System", history, 1000, undefined, e, false, undefined, undefined, undefined, false, false, {
        create: async (b: unknown) => (capture(b), scripted(RESPONSES_DONE as never[])),
      });
      break;
    default:
      gen = streamOpenAICompat(model, "System", history, 1000, undefined, e, false, undefined, undefined, undefined, false, {
        create: async (b: unknown) => (capture(b), scripted(COMPAT_DONE as never[])),
      });
  }
  for await (const _ of gen) void _;
  assert.ok(body, `${model.id}: no request was sent`);
  return body;
}

/** Just the reasoning part of a request body, per wire family. */
function reasoningFragment(model: ModelInfo, body: Raw): Raw {
  const pick = (keys: string[]) =>
    Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  switch (providerAdapterFor(model)) {
    case "anthropic-native": {
      const thinking = body.thinking as Raw | undefined;
      // block_binding is cache plumbing, not the reasoning control.
      const { block_binding: _bb, ...rest } = thinking ?? {};
      void _bb;
      return { ...(thinking ? { thinking: rest } : {}), ...pick(["output_config"]) };
    }
    case "gemini-native": {
      const config = (body.generationConfig ?? body.generation_config ?? {}) as Raw;
      return config.thinkingConfig ? { thinkingConfig: config.thinkingConfig as Raw } : {};
    }
    case "openai-responses":
    case "xai-responses":
    case "meta-responses": {
      const reasoning = body.reasoning as Raw | undefined;
      return reasoning?.effort !== undefined ? { "reasoning.effort": reasoning.effort } : {};
    }
    default:
      return pick(["reasoning_effort", "thinking", "enable_thinking", "thinking_budget"]);
  }
}

// comingSoon rows too: the day one ships, its options must already be right.
const CHAT_MODELS = MODEL_LIST.filter((m) => m.modality === "chat");
const REASONING_MODELS = CHAT_MODELS.filter((m) => m.reasoning);

if (process.env.DUMP_EFFORT_WIRE) {
  test("dump", async () => {
    for (const model of CHAT_MODELS) {
      const options = model.reasoning ? reasoningOptions(model) : [{ value: null, label: "-" }];
      for (const option of options) {
        const sent = effectiveReasoningEffort(model, option.value ?? undefined);
        const fragment = reasoningFragment(model, await firstBody(model, sent));
        console.log(`${model.id}\t${option.label}\t${sent ?? "-"}\t${JSON.stringify(fragment)}`);
      }
    }
  });
}

/** What turning thinking off has to look like on each wire, when it is offered. */
function isExplicitOff(model: ModelInfo, fragment: Raw): boolean {
  const thinking = fragment.thinking as Raw | undefined;
  switch (providerAdapterFor(model)) {
    case "anthropic-native":
      // Omitted is off only on the models whose API default is off.
      if (!thinking) return !buildAnthropicThinkingBits(model.providerModel, 1000).thinking && !fragment.output_config;
      return (thinking.type === "disabled" || thinking.type === "between_tools") && !fragment.output_config;
    case "openai-responses":
    case "xai-responses":
    case "meta-responses":
      return fragment["reasoning.effort"] === "none";
    case "gemini-native": {
      const config = fragment.thinkingConfig as Raw | undefined;
      return config?.thinkingBudget === 0;
    }
    default:
      return (
        fragment.reasoning_effort === "none" ||
        thinking?.type === "disabled" ||
        fragment.enable_thinking === false
      );
  }
}

/** The wire value an offered tier must arrive as. */
function assertTierOnWire(model: ModelInfo, tier: string, fragment: Raw, label: string) {
  const cap = reasoningCapabilityForModel(model);
  const thinking = fragment.thinking as Raw | undefined;
  switch (providerAdapterFor(model)) {
    case "anthropic-native":
      if (cap.controlType === "adaptive") {
        assert.equal(thinking?.type, "adaptive", label);
        assert.deepEqual(fragment.output_config, { effort: tier }, label);
      } else {
        assert.equal(thinking?.type, "enabled", label);
        assert.ok(typeof thinking?.budget_tokens === "number" && thinking.budget_tokens >= 1024, label);
        assert.equal(fragment.output_config, undefined, `${label}: manual models take no effort here`);
      }
      return;
    case "openai-responses":
    case "xai-responses":
    case "meta-responses":
      assert.equal(fragment["reasoning.effort"], tier, label);
      return;
    case "gemini-native": {
      const config = fragment.thinkingConfig as Raw;
      if (cap.parameter?.endsWith("thinkingLevel")) assert.equal(config.thinkingLevel, tier.toUpperCase(), label);
      else assert.ok(typeof config.thinkingBudget === "number" && config.thinkingBudget > 0, label);
      return;
    }
    default:
      if (cap.controlType === "on_off") {
        // One "Thinking" state: whatever the spelling, it must say on.
        const on =
          thinking?.type === "enabled" || thinking?.type === "adaptive" ||
          fragment.enable_thinking === true || fragment.reasoning_effort === "high";
        assert.ok(on, `${label}: ${JSON.stringify(fragment)}`);
        return;
      }
      if (cap.parameter?.includes("reasoning_effort")) {
        assert.equal(fragment.reasoning_effort, tier, label);
        assert.equal(fragment.thinking_budget, undefined, `${label}: never effort and budget together`);
      } else if (cap.parameter?.includes("thinking_budget")) {
        assert.equal(fragment.enable_thinking, true, label);
        assert.ok(typeof fragment.thinking_budget === "number", label);
      } else {
        assert.fail(`${label}: no wire parameter for an offered tier (${cap.parameter})`);
      }
  }
}

test("every offered effort tier reaches the provider as that tier, on every chat model", async () => {
  for (const model of REASONING_MODELS) {
    const caps = reasoningCaps(model);
    for (const option of reasoningOptions(model)) {
      const label = `${model.id} · ${option.label}`;
      const sent = effectiveReasoningEffort(model, option.value ?? undefined);
      // The route never silently remaps an option the picker itself offered.
      assert.equal(sent ?? null, option.value === null ? null : caps.onOff ? "high" : option.value, `${label}: route clamp`);
      const fragment = reasoningFragment(model, await firstBody(model, sent));
      if (option.value === null) {
        assert.ok(isExplicitOff(model, fragment), `${label}: Instant must switch thinking off, sent ${JSON.stringify(fragment)}`);
      } else {
        assert.ok(!isExplicitOff(model, fragment), `${label}: a tier must not switch thinking off`);
        assertTierOnWire(model, option.value, fragment, label);
      }
    }
  }
});

test("a model with no offered control sends no reasoning parameter it could reject", async () => {
  for (const model of CHAT_MODELS) {
    if (reasoningOptions(model).length > 0) continue;
    const adapter = providerAdapterFor(model);
    if (adapter === "anthropic-native" || adapter === "gemini-native") continue;
    const fragment = reasoningFragment(model, await firstBody(model, effectiveReasoningEffort(model, "high")));
    assert.equal(fragment.reasoning_effort, undefined, model.id);
    assert.equal(fragment["reasoning.effort"], undefined, model.id);
    assert.equal(fragment.thinking_budget, undefined, model.id);
  }
});

test("both compat request builders agree on the reasoning fields for every option", async () => {
  for (const model of REASONING_MODELS) {
    if (providerAdapterFor(model) !== "openai-compatible") continue;
    for (const option of reasoningOptions(model)) {
      const sent = effectiveReasoningEffort(model, option.value ?? undefined);
      const { reasoning_split: _split, ...loopFields } = compatReasoningFields(model, sent);
      void _split;
      assert.deepEqual(reasoningFragment(model, await firstBody(model, sent)), loopFields, `${model.id} · ${option.label}`);
    }
  }
});

test("the agent runtime (Code, Work) sends Anthropic the same thinking shape as chat", () => {
  for (const model of REASONING_MODELS.filter((m) => m.provider === "anthropic")) {
    for (const effort of [undefined, ...REASONING_TIERS]) {
      assert.deepEqual(
        agentCoreThinkingBits(model.providerModel, 8192, effort),
        buildAnthropicThinkingBits(model.providerModel, 8192, effort),
        `${model.id} @ ${effort ?? "instant"}`,
      );
    }
  }
});

test("the native manifest carries each model's exact tiers, Instant flag and default", () => {
  const entries = new Map(nativeModelCatalog(CHAT_MODELS).models.map((entry) => [entry.id, entry]));
  for (const model of CHAT_MODELS) {
    const entry = entries.get(model.id);
    assert.ok(entry, model.id);
    const caps = reasoningCaps(model);
    assert.deepEqual(entry.supportedReasoningEfforts, caps.tiers, model.id);
    assert.equal(entry.reasoning.supported, model.reasoning, model.id);
    assert.equal(entry.reasoning.canDisable, caps.canDisable, model.id);
    assert.equal(entry.reasoning.onOffOnly, caps.onOff, model.id);
    assert.equal(entry.reasoning.defaultEffort, caps.defaultLevel, model.id);
    if (caps.defaultLevel !== null) {
      assert.ok(caps.onOff || caps.tiers.includes(caps.defaultLevel as (typeof caps.tiers)[number]), `${model.id}: default ${caps.defaultLevel} is not one of its tiers`);
    } else if (model.reasoning && caps.tiers.length > 0) {
      assert.ok(caps.canDisable, `${model.id}: an always-on ladder needs a default`);
    }
  }
});

/*
 * Anthropic's published contract, transcribed from platform.claude.com
 * (effort + thinking-troubleshooting, read 2026-10-18). `instant` is the
 * thinking object an Instant turn must send: null = no Instant (always on),
 * "omit" = the API default is already off.
 */
type AnthropicDoc = { tiers: string[]; apiDefault: "high" | "medium"; instant: "disabled" | "between_tools" | "omit" | null; manual?: true };
const ALL5 = ["low", "medium", "high", "xhigh", "max"];
const ANTHROPIC_DOCS: Record<string, AnthropicDoc> = {
  "claude-fable-5-1": { tiers: ALL5, apiDefault: "high", instant: null },
  "claude-fable-5": { tiers: ALL5, apiDefault: "high", instant: null },
  "claude-opus-5-5": { tiers: ALL5, apiDefault: "medium", instant: null },
  "claude-opus-5": { tiers: ALL5, apiDefault: "high", instant: "disabled" },
  "claude-opus-4-8": { tiers: ALL5, apiDefault: "high", instant: "omit" },
  "claude-opus-4-7": { tiers: ALL5, apiDefault: "high", instant: "omit" },
  "claude-sonnet-5-5": { tiers: ALL5, apiDefault: "high", instant: "between_tools" },
  "claude-sonnet-5": { tiers: ALL5, apiDefault: "high", instant: "disabled" },
  "claude-haiku-5-5": { tiers: ALL5, apiDefault: "medium", instant: "disabled" },
  "claude-opus-4-6": { tiers: ["low", "medium", "high", "max"], apiDefault: "high", instant: "omit" },
  "claude-sonnet-4-6": { tiers: ["low", "medium", "high", "max"], apiDefault: "high", instant: "omit" },
  // Extended-thinking-only: the slider maps onto budget_tokens.
  "claude-opus-4-5": { tiers: ["low", "medium", "high"], apiDefault: "high", instant: "omit", manual: true },
  "claude-sonnet-4-5": { tiers: ["low", "medium", "high"], apiDefault: "high", instant: "omit", manual: true },
  "claude-haiku-4-5": { tiers: [], apiDefault: "high", instant: "omit", manual: true },
};

test("every Claude row matches Anthropic's published effort and thinking contract", async () => {
  for (const model of CHAT_MODELS.filter((m) => m.provider === "anthropic")) {
    const doc = ANTHROPIC_DOCS[model.providerModel];
    assert.ok(doc, `${model.id}: add it to ANTHROPIC_DOCS from platform.claude.com`);
    const caps = reasoningCaps(model);
    assert.deepEqual(caps.tiers, doc.tiers, `${model.id} tiers`);
    assert.equal(caps.canDisable, doc.instant !== null, `${model.id} Instant`);
    // Always-on models start at the API's own default effort.
    if (doc.instant === null) assert.equal(caps.defaultLevel, doc.apiDefault, `${model.id} default`);
    assert.equal(reasoningCapabilityForModel(model).controlType === "adaptive", !doc.manual, `${model.id} wire kind`);
    if (doc.instant !== null) {
      const fragment = reasoningFragment(model, await firstBody(model, effectiveReasoningEffort(model, undefined)));
      const thinking = fragment.thinking as Raw | undefined;
      assert.equal(thinking?.type, doc.instant === "omit" ? undefined : doc.instant, `${model.id} Instant wire`);
      // `disabled` / `between_tools` are 400s at xhigh or max: Instant sends no effort.
      assert.equal(fragment.output_config, undefined, `${model.id}: Instant carries no effort`);
    }
  }
});

/*
 * Exact request fragments, one representative per wire family. A change here
 * is a change to what a provider receives: check it against the lab's docs.
 */
const SNAPSHOTS: Array<[string, ReasoningEffort | null, Raw]> = [
  ["anthropic:claude-haiku-5-5", null, { thinking: { type: "disabled" } }],
  ["anthropic:claude-haiku-5-5", "low", { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "low" } }],
  ["anthropic:claude-haiku-5-5", "medium", { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "medium" } }],
  ["anthropic:claude-haiku-5-5", "high", { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" } }],
  ["anthropic:claude-haiku-5-5", "xhigh", { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "xhigh" } }],
  ["anthropic:claude-haiku-5-5", "max", { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "max" } }],
  ["anthropic:claude-haiku-4-5", null, {}],
  ["anthropic:claude-haiku-4-5", "high", { thinking: { type: "enabled", budget_tokens: 12750 } }],
  ["anthropic:claude-sonnet-5-5", null, { thinking: { type: "between_tools" } }],
  ["anthropic:claude-opus-5-5", "medium", { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "medium" } }],
  ["openai:gpt-6-sol", null, { "reasoning.effort": "none" }],
  ["openai:gpt-6-astra", "max", { "reasoning.effort": "max" }],
  ["openai:gpt-5.5-pro", "xhigh", { "reasoning.effort": "xhigh" }],
  ["xai:grok-4.7", "xhigh", { "reasoning.effort": "xhigh" }],
  ["google:gemini-3.1-pro-preview", "medium", { thinkingConfig: { includeThoughts: true, thinkingLevel: "MEDIUM" } }],
  ["google:gemini-2.5-pro", "high", { thinkingConfig: { includeThoughts: true, thinkingBudget: 16384 } }],
  ["deepseek:deepseek-flash", null, { thinking: { type: "disabled" } }],
  ["deepseek:deepseek-flash", "max", { reasoning_effort: "max" }],
  ["moonshot:kimi-k3", "low", { reasoning_effort: "low" }],
  ["moonshot:kimi-k2.6", null, { thinking: { type: "disabled" } }],
  ["qwen:qwen3.8-max", "xhigh", { reasoning_effort: "xhigh", enable_thinking: true }],
  ["qwen:qwen3.8-max", null, { enable_thinking: false }],
  ["qwen:qwen3.7-plus", "medium", { enable_thinking: true, thinking_budget: 8192 }],
  ["mistral:mistral-medium-latest", null, { reasoning_effort: "none" }],
  ["mistral:mistral-medium-latest", "high", { reasoning_effort: "high" }],
  ["minimax:MiniMax-M3", "high", { thinking: { type: "adaptive" } }],
  ["mimo:mimo-v2.6-pro", null, { thinking: { type: "disabled" } }],
  ["longcat:LongCat-2.0", "high", { thinking: { type: "enabled" } }],
  ["meta:muse-spark-1.3", "minimal", { reasoning_effort: "minimal" }],
];

test("a lab failing its health probe stays listed but is offered nowhere: web, Mac and iOS", () => {
  const { withAvailability } = require("../src/lib/model-catalog-api") as typeof import("@/lib/model-catalog-api");
  const haiku = getModel("anthropic:claude-haiku-5-5")!;
  const gpt = getModel("openai:gpt-6-sol")!;
  const anthropicDown = (provider: ModelInfo["provider"]) => provider !== "anthropic";
  // Native manifest (Mac and iOS): disabled with the reason, never a selection.
  const manifest = nativeModelCatalog([haiku, gpt], "PRO", undefined, { providerHealthy: anthropicDown });
  const entry = manifest.models.find((m) => m.id === haiku.id)!;
  assert.equal(entry.availability, "health_check_failed");
  assert.equal(entry.availabilityReason, "provider_unhealthy");
  assert.equal(manifest.models.find((m) => m.id === gpt.id)!.availability, "available");
  // Auto is a router, not a lab: it stays available while any lab is up.
  assert.equal(manifest.models[0].availability, "available");
  // A failed per-model probe is reported as such.
  const probed = nativeModelCatalog([gpt], "PRO", new Map([[gpt.id, { allowed: false, reason: "model_health_check" }]]));
  assert.equal(probed.models.find((m) => m.id === gpt.id)!.availabilityReason, "model_health_check");
  // Web (/api/models): the same verdicts, as `unavailableReason`.
  const web = withAvailability([haiku, gpt], new Map([[gpt.id, { allowed: true }]]), anthropicDown);
  assert.equal(web[0].unavailableReason, "provider_unhealthy");
  assert.equal(web[1].unavailableReason, undefined);
  assert.equal(withAvailability([gpt], new Map([[gpt.id, { allowed: false }]]), () => true)[0].unavailableReason, "model_health_check");
  // Healthy everywhere: nothing is marked, and the manifest is unchanged.
  assert.equal(nativeModelCatalog([haiku]).contractDigest, nativeModelCatalog([haiku], undefined, undefined, { providerHealthy: () => true }).contractDigest);
});

test("request body reasoning fragments, per provider family (snapshot)", async () => {
  for (const [id, effort, expected] of SNAPSHOTS) {
    const model = getModel(id);
    assert.ok(model && model.id === id, `${id} is not in the catalogue`);
    const fragment = reasoningFragment(model, await firstBody(model, effectiveReasoningEffort(model, effort ?? undefined)));
    assert.deepEqual(fragment, expected, `${id} @ ${effort ?? "instant"}`);
  }
});
