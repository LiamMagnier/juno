/**
 * The OpenAI-compatible tool loop: every Chat Completions lab — DeepSeek,
 * Moonshot, Zhipu, MiniMax, Mistral, Meta, MiMo, Qwen, LongCat — plus any
 * OpenAI or xAI model a deployment keeps off Responses (SPEC §5.4).
 *
 * `openai-compat.ts` turns the conversation into messages (which reads
 * attachment bytes from storage) and wires in the SDK client; everything after
 * that lives here, free of `server-only`, and takes the provider transport as
 * an input so a whole tool loop runs offline against a scripted stream
 * (SPEC §5.0, §13 harness rule 2).
 *
 * One request per loop step, as the loop controller counts them. Thirteen
 * hosts share this wire and disagree about its edges, so the per-lab choices
 * come from the tool capability record (`toolCapabilitiesFor`) rather than
 * from branches here:
 *
 * - `replay`/`replayField`: what a host needs back from a round's thinking on
 *   the assistant message that carries its tool calls. DeepSeek answers a
 *   tool round without `reasoning_content` with a 400, and wants it on every
 *   earlier assistant turn too while `tools` is present.
 * - `finalRound`: how the last request is made tools-off. `tool_choice:
 *   "none"` where the host takes it; otherwise the tools are left out, because
 *   GLM accepts only "auto", Meta answers "none" with a 400 and MiniMax has no
 *   such field (SPEC §4.6).
 * - `userAfterTool`: Mistral rejects a user message after a tool message, so a
 *   tool's pictures are described in its result there instead of shown.
 * - `parallel`: Qwen issues more than one call only when asked to.
 *
 * xAI's Live Search (`search_parameters`) answers 410 since 2026-01-12 and is
 * never sent; Grok searches on Responses (`responses-loop.ts`).
 */

import { normalizeFinishReason } from "@/lib/finish-reason";
import { structuredOutputNote } from "@/lib/llm/compat-loop.prompt";
import {
  outputTextFor,
  stampCallId,
  toolSourceFor,
  turnSignal,
  type ToolSource,
} from "@/lib/llm/openai-shared";
import type { AdapterRequest, ProviderTransport } from "@/lib/llm/types";
import type { McpFunctionTool, McpToolset } from "@/lib/mcp";
import { reasoningCaps } from "@/lib/model-metrics";
import { providerRequestModel } from "@/lib/model-request";
import { toolCapabilitiesFor, type ModelToolCapabilities } from "@/lib/model-tools";
import type { ModelInfo } from "@/lib/models";
import {
  accumulateToolCallDeltas,
  addCompatUsage,
  emptyCompatUsage,
  finalizeToolCalls,
  foldCompatUsage,
  reasoningDetailsDelta,
  shouldRunToolRound,
  type CompatRoundUsage,
  type CompatToolCall,
  type CompatToolCallDelta,
  type CompatUsagePayload,
} from "@/lib/openai-compat-round";
import { openAIPromptCacheRequestFields } from "@/lib/openai-prompt-cache";
import type { Provider } from "@/lib/providers";
import { sendableToolImages, toDataUrl, toolImageIntro, withheldImagesNote } from "@/lib/tool-result-images";
import type { BatchResult, executeToolBatch, ToolCallInput } from "@/lib/tools/dispatch";
import type { ReasoningEffort } from "@/types/chat";
import type { LlmEvent, MessageForModel } from "@/types/llm";

/** One Chat Completions message. Kept loose: several hosts take fields the SDK does not type. */
export type CompatMessage = Record<string, unknown> & { role: string };

export interface CompatLoopInput {
  req: AdapterRequest;
  /** The system message, then the conversation, oldest first; no dynamic context. */
  messages: CompatMessage[];
  transport: ProviderTransport;
  /** Deprecated positional path: the `McpToolset` `streamChat` opened itself (until WS9a). */
  legacyToolset?: McpToolset;
  /** Test seam: stands in for `executeToolBatch`. Absent in production. */
  dispatch?: typeof executeToolBatch;
  /** Start/finish lines for the server log; absent in tests. */
  log?: (event: "start" | "finish", data: Record<string, unknown>) => void;
}

/**
 * Providers that reject `stream_options.include_usage`.
 *
 * Empty today, and that is the point: the parameter is what makes most compat
 * hosts report usage at all, so it stays on by default and a provider is added
 * here the day one 400s on it.
 */
const NO_STREAM_USAGE: ReadonlySet<Provider> = new Set<Provider>();

// ── Reasoning parameters ────────────────────────────────────────────────────

/**
 * True when the model expresses "don't think" as `reasoning_effort: "none"`.
 *
 * It must be SENT, not left out: GPT-5.5 and later default to `medium` when
 * the parameter is absent, and DeepSeek V4 thinks at "high" by default, so
 * omitting it made Instant a no-op. `model.reasoning &&` is load-bearing on
 * every branch: `reasoningCaps` reports `canDisable` for a NON-reasoning model
 * (its top gate), and sending "none" to one of those is exactly the Mistral
 * outage, where every model 400ed on a parameter it does not take.
 */
function canDisableViaNoneEffort(model: ModelInfo): boolean {
  const id = model.providerModel.toLowerCase();
  const offSwitch = model.reasoning && reasoningCaps(model).canDisable;
  switch (model.provider) {
    // Mistral: only medium/small expose the parameter; magistral reasons with
    // no control and rejects it (its caps say canDisable false).
    case "mistral":
      return offSwitch;
    // Google's compat shim accepts "none" and genuinely stops thinking;
    // gemini-3-flash-preview thinks by default when it is omitted.
    case "google":
      return offSwitch;
    // DeepSeek V4 Pro and V4.1 Flash think by default and take "none" as the
    // off switch (gap-provider §2.5). deepseek-reasoner has no off switch.
    case "deepseek":
      return offSwitch;
    case "openai":
      if (/gpt-5(\.\d)?-pro/.test(id)) return false; // always reason
      // Codex and GPT-6 are split per snapshot; the caps carry each one's enum.
      if (id.includes("codex") || /gpt-6/.test(id)) return offSwitch;
      return model.reasoning && /gpt-5\.\d/.test(id); // 5.1+ — the original gpt-5 has no "none"
    default:
      return false;
  }
}

/**
 * The reasoning fields one request carries (SPEC §5.4 item 8).
 *
 * Only some hosts speak OpenAI's top-level `reasoning_effort`; the rest each
 * have a dialect of their own, and sending the wrong one is at best ignored and
 * at worst a 400. The route has already clamped the effort to what the model
 * supports, so this only chooses the spelling.
 *
 *   reasoning_effort  → openai, google (compat shim), deepseek (V4), xai,
 *                       mistral (high|none), zhipu (GLM-5.2, GLM-5.3), meta,
 *                       moonshot (K3)
 *   thinking:{type}   → zhipu (the on/off GLMs), minimax, moonshot (K2.x),
 *                       mimo, longcat
 *   enable_thinking   → qwen
 */
export function compatReasoningFields(model: ModelInfo, effort: ReasoningEffort | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const id = model.providerModel.toLowerCase();
  const caps = reasoningCaps(model);
  // GLM-5.3 always thinks: its depth is the effort enum, and the `thinking`
  // object's off state is exactly what makes its requests fail.
  const glmEffortOnly = model.provider === "zhipu" && id.includes("glm-5.3");
  const usesReasoningEffort =
    model.provider === "openai" ||
    model.provider === "google" ||
    model.provider === "deepseek" ||
    model.provider === "xai" ||
    model.provider === "mistral" ||
    model.provider === "meta" ||
    (model.provider === "zhipu" && (id.includes("glm-5.2") || glmEffortOnly)) ||
    // Kimi K3 introduced a top-level enum; the K2.x line keeps `thinking`.
    (model.provider === "moonshot" && id.includes("k3"));

  if (usesReasoningEffort) {
    // Mistral's enum is only high|none, so any depth collapses to "high".
    if (effort) out.reasoning_effort = model.provider === "mistral" ? "high" : effort;
    else if (canDisableViaNoneEffort(model)) out.reasoning_effort = "none";
  }

  if (model.provider === "qwen" && model.reasoning) {
    // Instant turns thinking off on the hybrid models; Qwen3.8 Max thinks
    // always, so it always gets thinking on and a budget.
    const alwaysThinks = id.includes("qwen3.8-max") || !caps.canDisable;
    const qwenEffort = effort ?? (alwaysThinks ? "high" : null);
    out.enable_thinking = alwaysThinks ? true : !!qwenEffort;
    if (qwenEffort) {
      out.thinking_budget = { minimal: 1024, low: 2048, medium: 8192, high: 24000, xhigh: 32000, max: 38000 }[qwenEffort];
    }
  }

  if (model.provider === "zhipu" && model.reasoning && !glmEffortOnly) {
    // The on/off GLMs: an effort means enabled, its absence means off.
    out.thinking = { type: effort ? "enabled" : "disabled" };
  }

  const usesThinkingObject =
    model.provider === "minimax" || model.provider === "moonshot" || model.provider === "mimo" || model.provider === "longcat";
  if (usesThinkingObject && model.reasoning && caps.canDisable) {
    // Only to models that can actually switch: Kimi K2.7 REJECTS
    // {type:"disabled"} and MiniMax M2.x ignores the field. MiniMax M3 spells
    // its on-state "adaptive".
    const onType = model.provider === "minimax" ? "adaptive" : "enabled";
    out.thinking = { type: effort ? onType : "disabled" };
  }

  // Ask MiniMax for its reasoning in its own field rather than inline.
  if (model.provider === "minimax") out.reasoning_split = true;
  return out;
}

/** The output cap fields, per host ceiling. */
function maxTokenFields(model: ModelInfo, maxTokens: number): Record<string, unknown> {
  const id = model.providerModel.toLowerCase();
  if (model.provider === "openai") {
    // Legacy models reject caps above their ceiling with a 400; reasoning
    // models count hidden reasoning against the cap, so give them headroom.
    const legacyCap = /gpt-4o/.test(id) ? 16_384 : /gpt-4-turbo|gpt-3\.5/.test(id) ? 4_096 : Infinity;
    return { max_completion_tokens: Math.min(Math.max(maxTokens, 16_000), legacyCap) };
  }
  // glm-4.5v rejects max_tokens over 16,384; every other GLM takes more.
  const zhipuCap = model.provider === "zhipu" && id.includes("glm-4.5v") ? 16_384 : Infinity;
  return { max_tokens: Math.min(maxTokens, zhipuCap) };
}

// ── Messages ────────────────────────────────────────────────────────────────

/** The lab of a stored model id (`provider:model`); null when it is not one. */
function labOf(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  const at = modelId.indexOf(":");
  return at > 0 ? modelId.slice(0, at) : null;
}

/**
 * One earlier assistant turn, as the history sends it.
 *
 * DeepSeek wants `reasoning_content` on EVERY earlier assistant turn whenever
 * the request carries `tools` (SPEC §5.4 item 1): the turn's own thinking when
 * DeepSeek wrote it, and an empty string for a turn another lab wrote, whose
 * thinking means nothing to it (probe P4 confirms the empty string).
 */
export function compatHistoryAssistantMessage(
  message: Pick<MessageForModel, "content" | "reasoning" | "model">,
  model: Pick<ModelInfo, "provider" | "id" | "api">,
  toolsOffered: boolean,
): CompatMessage {
  const base: CompatMessage = { role: "assistant", content: message.content || "(no content)" };
  if (!toolsOffered || model.provider !== "deepseek" || toolCapabilitiesFor(model).replay !== "must") return base;
  const sameLab = labOf(message.model) === model.provider;
  return { ...base, reasoning_content: sameLab ? message.reasoning ?? "" : "" };
}

/**
 * Whether this turn offers function tools on this model at all.
 *
 * The messages are built before the loop starts, and DeepSeek's history rule
 * depends on it, so `openai-compat.ts` asks the same question the loop does.
 */
export function compatOffersTools(req: AdapterRequest, legacyToolset?: McpToolset): boolean {
  return !!toolSourceFor(req, legacyToolset) && toolCapabilitiesFor(req.model).supported;
}

/**
 * The messages the first request sends: the dynamic context, and the JSON
 * instruction of a structured call, as system messages just before the newest
 * user turn — never ahead of the stable prefix a host caches.
 */
function openingMessages(req: AdapterRequest, messages: readonly CompatMessage[]): CompatMessage[] {
  const out = [...messages];
  const inserts: CompatMessage[] = [];
  if (req.dynamicContext) inserts.push({ role: "system", content: req.dynamicContext });
  if (req.responseSchema) {
    // JSON mode promises valid JSON, not the shape, and several hosts refuse
    // it unless the conversation says "JSON" — so the schema is stated.
    inserts.push({
      role: "system",
      content: structuredOutputNote(req.responseSchema.name, JSON.stringify(req.responseSchema.schema)),
    });
  }
  if (!inserts.length) return out;
  let lastUser = out.length;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  out.splice(lastUser, 0, ...inserts);
  return out;
}

/**
 * Split a non-string `delta.content` into reasoning and answer text.
 *
 * Mistral's reasoning models stream thinking as an ARRAY of typed chunks —
 * [{ type: "thinking", thinking: [{ type: "text", text: "…" }] }] — and the
 * answer as ordinary string deltas afterwards. Concatenating those objects
 * rendered "[object Object]" into the answer.
 */
export function splitTypedContent(content: unknown): { reasoning: string; text: string } {
  let reasoning = "";
  let text = "";
  if (!Array.isArray(content)) return { reasoning, text };
  for (const chunk of content) {
    if (typeof chunk === "string") {
      text += chunk;
      continue;
    }
    if (!chunk || typeof chunk !== "object") continue;
    const c = chunk as { type?: string; text?: string; thinking?: unknown };
    if (c.type === "thinking") {
      const inner = Array.isArray(c.thinking) ? c.thinking : [];
      for (const part of inner) {
        if (typeof part === "string") reasoning += part;
        else if (part && typeof part === "object" && typeof (part as { text?: string }).text === "string") {
          reasoning += (part as { text: string }).text;
        }
      }
    } else if (typeof c.text === "string") {
      text += c.text;
    }
  }
  return { reasoning, text };
}

/** A round's thinking, as much of it as a host needs back. */
export interface RoundReasoning {
  text: string;
  /** MiniMax: the shape of the last `reasoning_details` entry it sent (id, format, index). */
  detailShape?: Record<string, unknown>;
}

/**
 * The assistant message that carries one round's tool calls (SPEC §5.4
 * item 1), with the round's thinking attached where the host needs it back:
 *
 * - `must` (DeepSeek, MiMo, Kimi): always, even empty — a missing field is the
 *   400, an empty one is not;
 * - `should` (GLM, MiniMax, Qwen, Mistral small/medium): when there is any;
 * - `none`: never.
 */
export function compatToolCallMessage(
  caps: Pick<ModelToolCapabilities, "replay" | "replayField">,
  text: string,
  reasoning: RoundReasoning,
  toolCalls: ReadonlyArray<{ id: string; name: string; args: string }>,
): CompatMessage {
  const message: CompatMessage = {
    role: "assistant",
    content: text || null,
    tool_calls: toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.args || "{}" },
    })),
  };
  if (caps.replay === "none") return message;
  if (caps.replay === "should" && !reasoning.text) return message;
  switch (caps.replayField ?? "reasoning_content") {
    case "reasoning_content":
      message.reasoning_content = reasoning.text;
      break;
    case "reasoning_details":
      message.reasoning_details = [{ ...(reasoning.detailShape ?? {}), type: "reasoning.text", text: reasoning.text }];
      break;
    case "think_tags":
      // The host reads its thinking back inline, where it wrote it.
      message.content = `<think>${reasoning.text}</think>${text}`;
      break;
    case "thinkchunk":
      // Mistral: the thinking goes back as the typed chunk it arrived as.
      message.content = [
        { type: "thinking", thinking: [{ type: "text", text: reasoning.text }] },
        ...(text ? [{ type: "text", text }] : []),
      ];
      break;
  }
  return message;
}

/**
 * The follow-up messages for one round's results: one `tool` message per call
 * in call order (SPEC §4.2), then — only where a user message may follow a
 * tool message — one user turn with every picture the tools returned. The
 * pictures cannot sit between the tool messages: every call of the assistant
 * message must be answered before anything else is said.
 */
export function compatResultMessages(
  results: readonly BatchResult[],
  model: Pick<ModelInfo, "vision">,
  caps: Pick<ModelToolCapabilities, "userAfterTool">,
): CompatMessage[] {
  const messages: CompatMessage[] = [];
  const imageParts: Array<Record<string, unknown>> = [];
  for (const result of results) {
    // Mistral (`userAfterTool: false`): the pictures are named in the result
    // instead, so the model knows they exist and that it has not seen them.
    const images = caps.userAfterTool ? sendableToolImages(result.images, model.vision) : [];
    messages.push({
      role: "tool",
      tool_call_id: result.providerCallId ?? result.callId,
      content: withheldImagesNote(outputTextFor(result), result.images, images.length),
    });
    if (images.length) {
      imageParts.push({ type: "text", text: toolImageIntro(result.name, images) });
      for (const image of images) imageParts.push({ type: "image_url", image_url: { url: toDataUrl(image) } });
    }
  }
  if (imageParts.length) messages.push({ role: "user", content: imageParts });
  return messages;
}

// ── Tools on the wire ───────────────────────────────────────────────────────

/**
 * Meta takes function names with at most one dot. Juno's names never have one
 * (`connector__tool`, sanitised in mcp.ts), so this is a guard, not a rename
 * anyone should see: a name with more dots goes out with the extra ones made
 * underscores, and the call comes back under the name the toolset knows.
 */
function wireToolName(provider: Provider, name: string): string {
  if (provider !== "meta") return name;
  const first = name.indexOf(".");
  if (first === -1) return name;
  return name.slice(0, first + 1) + name.slice(first + 1).replace(/\./g, "_");
}

interface WireTools {
  tools: Array<Record<string, unknown>>;
  /** Wire name → the toolset's name, for the names that differ. */
  fromWire: Map<string, string>;
}

function wireToolsFor(model: ModelInfo, tools: readonly McpFunctionTool[]): WireTools {
  const fromWire = new Map<string, string>();
  const wire = tools.map(({ type, function: fn }) => {
    const name = wireToolName(model.provider, fn.name);
    if (name !== fn.name) fromWire.set(name, fn.name);
    // Only the provider's shape: Juno-side metadata such as `annotations` is
    // a field no compat host defines, and the strict ones reject it.
    return { type, function: { ...fn, name } };
  });
  return { tools: wire, fromWire };
}

// ── The request ─────────────────────────────────────────────────────────────

interface TurnShape {
  model: ModelInfo;
  caps: ModelToolCapabilities;
  wire: WireTools;
  reasoning: Record<string, unknown>;
}

/**
 * One request's body (SPEC §5.4).
 *
 * `final` is the loop controller's verdict for this request, and the model's
 * `finalRound` says how that is made tools-off: `tool_choice: "none"` with the
 * tools kept (DeepSeek's replay rule relaxes when `tools` is absent, so its
 * tools stay), or no tools and no `tool_choice` at all.
 */
export function buildCompatRequest(
  req: AdapterRequest,
  shape: TurnShape,
  messages: readonly CompatMessage[],
  step: { final: boolean },
): Record<string, unknown> {
  const { model, caps } = shape;
  const params: Record<string, unknown> = {
    // The one identifier an adapter may serialize.
    model: providerRequestModel(model),
    messages: [...messages],
    stream: true,
  };
  // Without this most hosts report usage as null on every chunk.
  if (!NO_STREAM_USAGE.has(model.provider)) params.stream_options = { include_usage: true };
  // OpenAI priority processing; the route only sets fastMode on eligible models.
  if (req.fastMode && model.provider === "openai") params.service_tier = "priority";
  Object.assign(params, shape.reasoning, maxTokenFields(model, req.maxTokens));
  // OpenAI: prompt_cache_key and the GPT-5.6 options. Mistral caches only when
  // asked. xAI routes by header (the transport's). The rest cache stable
  // prefixes on their own.
  if (model.provider === "openai") Object.assign(params, openAIPromptCacheRequestFields(model, req.cacheKey));
  else if (model.provider === "mistral" && req.cacheKey) params.prompt_cache_key = req.cacheKey;

  const toolsOn = shape.wire.tools.length > 0 && (!step.final || caps.finalRound === "tool_choice_none");
  if (toolsOn) {
    params.tools = shape.wire.tools;
    // Never "required" and never a named choice: Kimi K2.7 takes only auto
    // and none, and a named choice 400s on DeepSeek and Kimi thinking.
    params.tool_choice = step.final ? "none" : "auto";
    // Qwen returns every call of a batch only when asked for parallel calls.
    if (caps.parallel === "opt_in") params.parallel_tool_calls = true;
  }
  // JSON mode, never a named tool choice (SPEC §5.0 `responseSchema`); the
  // caller validates the object it gets back.
  if (req.responseSchema) params.response_format = { type: "json_object" };
  return params;
}

// ── The loop ────────────────────────────────────────────────────────────────

function usageEvent(usage: CompatRoundUsage, sawTokens: boolean, round: number): LlmEvent {
  return {
    type: "usage",
    input: sawTokens ? usage.input : undefined,
    output: sawTokens ? usage.output : undefined,
    reasoning: usage.reasoning || undefined,
    total: usage.total || undefined,
    cacheRead: usage.cacheRead || undefined,
    cacheWrite: usage.cacheWrite || undefined,
    webSearchRequests: usage.webSearchRequests || undefined,
    xSearchRequests: usage.xSearchRequests || undefined,
    round,
  };
}

interface CompatChunk {
  choices?: Array<{
    delta?: {
      content?: unknown;
      reasoning_content?: string;
      reasoning?: string;
      reasoning_details?: Array<Record<string, unknown> & { text?: string }>;
      tool_calls?: CompatToolCallDelta[];
    } | null;
    finish_reason?: string | null;
  }>;
  usage?: CompatUsagePayload | null;
}

/** Runs the whole turn: every request the loop controller allows, and the tools between them. */
export async function* runCompatLoop(opts: CompatLoopInput): AsyncGenerator<LlmEvent> {
  const { req, transport } = opts;
  const { model, loop } = req;
  const signal = turnSignal(req.signal);
  const caps = toolCapabilitiesFor(model);
  const source: ToolSource | null = caps.supported ? toolSourceFor(req, opts.legacyToolset, opts.dispatch) : null;
  const shape: TurnShape = {
    model,
    caps,
    wire: wireToolsFor(model, source?.tools ?? []),
    reasoning: compatReasoningFields(model, req.reasoningEffort),
  };
  const messages = openingMessages(req, opts.messages);

  opts.log?.("start", {
    provider: model.provider,
    model: model.providerModel,
    maxTokens: req.maxTokens,
    reasoningEffort: req.reasoningEffort ?? null,
    tools: shape.wire.tools.length,
    budget: loop.budget,
  });

  // Turn total: a request folds its own chunks with `max` and is ADDED here,
  // because each request is billed on its own and re-sends the conversation.
  const turnUsage = emptyCompatUsage();
  let sawTokens = false;
  const stampedIds = new Set<string>();
  let round = 0;
  let lastFinish: string | undefined;

  for (;;) {
    const step = loop.beginRequest();
    const body = buildCompatRequest(req, shape, messages, step);
    const stream = transport.request(body, signal);

    let assistantText = "";
    let finishReason: string | undefined;
    let requestSawUsage = false;
    let detailsSoFar = "";
    const reasoning: RoundReasoning = { text: "" };
    // Keyed by the call's own id where the host sends one (openai-compat-round.ts).
    const toolCalls = new Map<string, CompatToolCall>();
    const requestUsage = emptyCompatUsage();

    for await (const raw of stream) {
      const chunk = raw as CompatChunk;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta ?? undefined;
      let reasoningText = delta?.reasoning_content ?? delta?.reasoning;
      if (!reasoningText && delta?.reasoning_details?.length) {
        // MiniMax repeats its details cumulatively; other hosts send deltas.
        const full = delta.reasoning_details.map((d) => (typeof d.text === "string" ? d.text : "")).join("");
        reasoningText = reasoningDetailsDelta(detailsSoFar, full);
        detailsSoFar = full;
        // Its id, format and index, for the copy that goes back (the text is
        // the whole round's, set when the message is built).
        const shapeOf: Record<string, unknown> = { ...(delta.reasoning_details.at(-1) ?? {}) };
        delete shapeOf.text;
        reasoning.detailShape = shapeOf;
      }
      if (reasoningText) {
        reasoning.text += reasoningText;
        yield { type: "reasoning", text: reasoningText, round };
      }
      // `content` is typed string|null, but Mistral streams typed chunks.
      const rawContent = delta?.content;
      let text = typeof rawContent === "string" ? rawContent : "";
      if (Array.isArray(rawContent)) {
        const split = splitTypedContent(rawContent);
        if (split.reasoning) {
          reasoning.text += split.reasoning;
          yield { type: "reasoning", text: split.reasoning, round };
        }
        text = split.text;
      }
      if (text) {
        assistantText += text;
        yield { type: "text", text, round };
      }
      accumulateToolCallDeltas(toolCalls, delta?.tool_calls);
      if (chunk.usage) {
        requestSawUsage = true;
        // Maximum within the request, so a repeated cumulative usage chunk
        // cannot bill the same cache write twice.
        foldCompatUsage(requestUsage, chunk.usage);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
    lastFinish = finishReason;

    // A call the host streamed without an id is still a call: it gets
    // `jc_<round>_<index>`, and that id goes back on the wire (RC-13).
    const calls = finalizeToolCalls(toolCalls).map((call, index) => {
      const ids = stampCallId(call.id || undefined, round, index, req.batch?.seenCallIds, stampedIds);
      const name = shape.wire.fromWire.get(call.name) ?? call.name;
      return { ...call, name, wireName: call.name, index, ...ids, wireId: ids.providerCallId ?? ids.callId };
    });
    const dispatch =
      !!source && shouldRunToolRound({ hasTools: true, isFinalRound: step.final, callCount: calls.length, finishReason });

    // The whole argument JSON is here before dispatch, so it rides on the call.
    for (const call of calls) {
      yield {
        type: "tool",
        phase: "call",
        server: source?.labelFor(call.name) ?? call.name,
        name: call.name,
        callId: call.callId,
        ...(call.providerCallId && call.providerCallId !== call.callId ? { providerCallId: call.providerCallId } : {}),
        round,
        index: call.index,
        args: call.args,
      };
      if (!dispatch) {
        // Never run a call from a request that ran out of room (its arguments
        // may be cut mid-JSON) or from the tools-off request.
        yield {
          type: "tool",
          phase: "result",
          server: source?.labelFor(call.name) ?? call.name,
          name: call.name,
          callId: call.callId,
          round,
          index: call.index,
          result: "Cancelled.",
          ok: false,
          status: "cancelled",
          error: { code: "cancelled" },
        };
      }
    }

    if (requestSawUsage) {
      sawTokens = true;
      addCompatUsage(turnUsage, requestUsage);
    }
    if (sawTokens || turnUsage.webSearchRequests > 0 || turnUsage.xSearchRequests > 0) {
      yield usageEvent(turnUsage, sawTokens, round);
    }
    yield { type: "round_end", round, tools: calls.length, serverTools: 0, final: step.final, stop: finishReason ?? null };
    if (!dispatch || !source) break;

    messages.push(
      compatToolCallMessage(
        caps,
        assistantText,
        reasoning,
        calls.map((call) => ({ id: call.wireId, name: call.wireName, args: call.args })),
      ),
    );
    const inputs: ToolCallInput[] = calls.map((call) => ({
      name: call.name,
      callId: call.callId,
      ...(call.providerCallId === undefined ? {} : { providerCallId: call.providerCallId }),
      round,
      index: call.index,
      // Raw: the dispatcher reports malformed JSON back to the model (RC-14).
      argsText: call.args,
    }));
    const results: BatchResult[] = yield* source.run(inputs, signal);
    messages.push(...compatResultMessages(results, model, caps));
    round++;
  }

  // A trailing tool_calls means even the forced-answer request wanted more
  // tools — report "length" so the UI warns and offers Continue.
  const finalRaw = lastFinish === "tool_calls" ? "length" : lastFinish;
  yield { type: "finish", reason: normalizeFinishReason(finalRaw ?? "stop"), raw: finalRaw };
  opts.log?.("finish", {
    provider: model.provider,
    model: model.providerModel,
    finishReason: finalRaw ?? "stop",
    requests: loop.requests,
    // Cache hit-rate instrumentation: cachedTokens/promptTokens per turn.
    promptTokens: sawTokens ? turnUsage.input : null,
    completionTokens: sawTokens ? turnUsage.output : null,
    reasoningTokens: sawTokens ? turnUsage.reasoning || null : null,
    cachedTokens: sawTokens ? turnUsage.cacheRead : null,
  });
}
