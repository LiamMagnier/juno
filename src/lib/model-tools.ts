/**
 * What each model can do with tools, on Juno's transport (SPEC §5.6).
 *
 * A resolver rather than a required `ModelInfo` field, so the `ModelInfo`
 * literals outside the catalog — Auto, discovered models, test fixtures — keep
 * compiling unchanged. It reads a per-lab row, then the rules that follow from
 * the model itself (pre-Gemini-3, Responses-only snapshots), then a per-model
 * override map, then the catalog entry's own optional `tools` override. A model
 * nobody has listed gets its lab's row, which is the permissive direction for
 * the same reason `guessAgenticTools` is: a lab's next model is far more likely
 * to behave like its last than not.
 *
 * Values from the provider capability audit
 * (docs/chat-rework/audit/gap-provider-tool-capabilities.md §2), 2026-09-23.
 * Items marked "probe" there keep the conservative value until the probe runs.
 *
 * Pure and client-safe: the composer reads it for the web toggle.
 */

import type { ModelInfo } from "@/lib/models";
import type { Provider } from "@/lib/providers";
import type { ReasoningEffort } from "@/types/chat";

export interface ModelToolCapabilities {
  supported: boolean;                                  // accepts function tools at all
  chatCompletions: boolean;                            // tools work on /chat/completions
  responses: boolean;                                  // served through a Responses adapter
  parallel: "default" | "opt_in" | "unknown";
  finalRound: "tool_choice_none" | "omit_tools";
  replay: "must" | "should" | "none";
  replayField?: "reasoning_content" | "reasoning_details" | "think_tags" | "thinkchunk";
  userAfterTool: boolean;                              // a user message may follow a tool message
  nativeSearch: boolean;                               // provider search available on Juno's transport
  anthropicSearchVersion?: "20250305" | "20260318";
  /** Hosted search rejected below this effort (original gpt-5 at "minimal"). */
  hostedSearchMinEffort?: "low";
  maxTools: number;                                    // provider cap; Juno caps at min(64, this)
}

/** A compat lab nobody has characterised: tools on, nothing assumed beyond that. */
const COMPAT: ModelToolCapabilities = {
  supported: true,
  chatCompletions: true,
  responses: false,
  parallel: "unknown",
  finalRound: "tool_choice_none",
  replay: "none",
  userAfterTool: true,
  nativeSearch: false,
  maxTools: 128,
};

/**
 * One row per lab. `replay` describes what the COMPAT adapter must send back
 * (SPEC §5.4); the native adapters (Anthropic, Gemini, Responses) replay their
 * own reasoning items by protocol and read `none` here.
 */
const LAB_TOOLS: Record<Provider, ModelToolCapabilities> = {
  anthropic: {
    ...COMPAT,
    parallel: "default",
    nativeSearch: true,
    // The basic version; the models that take the 2026 one are listed below.
    anthropicSearchVersion: "20250305",
  },
  openai: {
    ...COMPAT,
    // Every OpenAI model goes through the Responses adapter (SPEC §5.2 item 1).
    responses: true,
    parallel: "default",
    nativeSearch: true,
  },
  google: {
    ...COMPAT,
    parallel: "default",
    // `functionCallingConfig.mode: "NONE"` with the declarations kept (probe P2).
    nativeSearch: true,
  },
  xai: {
    ...COMPAT,
    responses: true,
    parallel: "default",
    nativeSearch: true,
    maxTools: 350,
  },
  deepseek: {
    ...COMPAT,
    // A tool round without every earlier turn's reasoning_content is a 400.
    replay: "must",
    replayField: "reasoning_content",
  },
  moonshot: {
    ...COMPAT,
    parallel: "default",
    // Preserved Thinking is always on; 400 enforcement pending probe P5.
    replay: "must",
    replayField: "reasoning_content",
  },
  zhipu: {
    ...COMPAT,
    // "tool_choice only supports auto" (probe P6 before switching).
    finalRound: "omit_tools",
    replay: "should",
    replayField: "reasoning_content",
  },
  minimax: {
    ...COMPAT,
    // No tool_choice field in the Chat schema (probe P7).
    finalRound: "omit_tools",
    replay: "should",
    replayField: "reasoning_details",
  },
  mistral: {
    ...COMPAT,
    parallel: "default",
    // "Unexpected role 'user' after role 'tool'".
    userAfterTool: false,
  },
  meta: {
    ...COMPAT,
    parallel: "default",
    // tool_choice "none" is an HTTP 400; Chat Completions redacts reasoning, so nothing to replay.
    finalRound: "omit_tools",
  },
  mimo: {
    ...COMPAT,
    // Undocumented tool_choice (probe P19).
    finalRound: "omit_tools",
    replay: "must",
    replayField: "reasoning_content",
  },
  qwen: {
    ...COMPAT,
    // All calls arrive only with parallel_tool_calls: true.
    parallel: "opt_in",
    replay: "should",
    replayField: "reasoning_content",
  },
  longcat: {
    ...COMPAT,
    // No tools or tool_choice documented yet (probe P18 before the model ships).
    finalRound: "omit_tools",
  },
  // Video only: no chat tools.
  seedance: { ...COMPAT, supported: false, chatCompletions: false },
};

/** Per-model exceptions to the lab row, keyed by the canonical model id. */
const MODEL_TOOLS: Readonly<Record<string, Partial<ModelToolCapabilities>>> = {
  "anthropic:claude-fable-5-1": { anthropicSearchVersion: "20260318" },
  "anthropic:claude-opus-5-5": { anthropicSearchVersion: "20260318" },
  "anthropic:claude-sonnet-5": { anthropicSearchVersion: "20260318" },

  // Tool calling needs Responses: on /chat/completions it fails outright
  // (Astra) or whenever the effort is above "none".
  "openai:gpt-6-astra": { chatCompletions: false },
  "openai:gpt-6-sol": { chatCompletions: false },
  "openai:gpt-6-luna": { chatCompletions: false },
  "openai:gpt-5.6-sol": { chatCompletions: false },
  "openai:gpt-5.6-terra": { chatCompletions: false },
  "openai:gpt-5.6-luna": { chatCompletions: false },
  // The original gpt-5 rejects hosted search at "minimal".
  "openai:gpt-5": { hostedSearchMinEffort: "low" },
  // Hosted search is documented for GPT-4o, o3, o4-mini and GPT-5 onward, not
  // for these retiring snapshots: they get Juno's web_search instead of a 400.
  "openai:o1": { nativeSearch: false },
  "openai:o3-mini": { nativeSearch: false },
  "openai:gpt-4-turbo": { nativeSearch: false },
  "openai:gpt-3.5-turbo": { nativeSearch: false },

  // Built-in search and remote MCP only; no client function tools, no Chat Completions.
  "xai:grok-4.20-multi-agent-0309": { supported: false, chatCompletions: false, responses: true },
  // Server search support unconfirmed (probe P13b): Juno web_search instead.
  "xai:grok-build-0.1": { nativeSearch: false },
  // Slug unconfirmed (probe P14): left on today's compat route, where Live Search is gone.
  "xai:grok-4.1-fast": { responses: false, nativeSearch: false },

  // Thinking chunks, replayed as typed chunks on the models that think.
  "mistral:mistral-small-latest": { replay: "should", replayField: "thinkchunk" },
  "mistral:mistral-medium-latest": { replay: "should", replayField: "thinkchunk" },
};

/** Gemini 1.x and 2.x: search and function tools cannot share a request, so chat keeps the functions. */
const PRE_GEMINI_3 = /^gemini-[12](?:\.|-)/i;

function providerModelOf(id: string): string {
  const at = id.indexOf(":");
  return at === -1 ? id : id.slice(at + 1);
}

/** The rules that follow from the model entry itself, before any listed exception. */
function derivedFor(model: Pick<ModelInfo, "provider" | "id" | "api">): Partial<ModelToolCapabilities> {
  const derived: Partial<ModelToolCapabilities> = {};
  if (model.provider === "google" && PRE_GEMINI_3.test(providerModelOf(model.id))) derived.nativeSearch = false;
  // Responses-only snapshots (gpt-*-pro, some Codex) are not served on /chat/completions at all.
  if (model.api === "responses") derived.chatCompletions = false;
  return derived;
}

export function toolCapabilitiesFor(
  model: Pick<ModelInfo, "provider" | "id" | "api" | "tools">,
): ModelToolCapabilities {
  const lab = LAB_TOOLS[model.provider] ?? COMPAT;
  return {
    ...lab,
    ...derivedFor(model),
    ...(MODEL_TOOLS[model.id] ?? {}),
    ...(model.tools ?? {}),
  };
}

/**
 * Whether a lab's models search natively on Juno's transport, by its lab row.
 *
 * For the places that know only a provider — a deployment's configured labs,
 * a model discovered at runtime. A model in hand is read through
 * `toolCapabilitiesFor(model).nativeSearch`, which also sees its exceptions.
 */
export function labHasNativeSearch(provider: Provider): boolean {
  return (LAB_TOOLS[provider] ?? COMPAT).nativeSearch;
}

const EFFORT_RANK: Record<NonNullable<ReasoningEffort>, number> = {
  minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5,
};

/**
 * Whether provider-hosted search may ride a request at this effort.
 *
 * The original gpt-5 rejects hosted `web_search` at "minimal" (SPEC §5.2
 * item 3), so its minimal turns carry no native search and get Juno's
 * `web_search` instead. No effort at all ranks below every tier.
 */
export function hostedSearchAllowedAt(
  caps: Pick<ModelToolCapabilities, "nativeSearch" | "hostedSearchMinEffort">,
  effort: ReasoningEffort | null | undefined,
): boolean {
  if (!caps.nativeSearch) return false;
  if (!caps.hostedSearchMinEffort) return true;
  const rank = effort ? EFFORT_RANK[effort] : -1;
  return rank >= EFFORT_RANK[caps.hostedSearchMinEffort];
}
