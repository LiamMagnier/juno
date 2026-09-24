/**
 * The Responses tool loop: every OpenAI model, and Grok on xAI's Responses
 * surface (SPEC §5.2, §5.5).
 *
 * `openai-responses.ts` turns the conversation into input items (which reads
 * attachment bytes from storage) and wires in the SDK client; everything after
 * that lives here, free of `server-only`, and takes the provider transport as
 * an input so a whole tool loop runs offline against a scripted stream
 * (SPEC §5.0, §13 harness rule 2).
 *
 * One request per loop step, as the loop controller counts them. A request's
 * output items are replayed in wire order on the next one — reasoning with its
 * encrypted content, the assistant message with its `phase`, the function and
 * web-search calls — because `store: false` keeps nothing between requests and
 * a reasoning item replayed without the item it led to is a 400 (H6). Hosted
 * search runs inside a response and is reported, never dispatched; function
 * calls go through the turn's tool runner and come back as
 * `function_call_output` items in call order.
 *
 * The xAI dialect is the same protocol at another host: no `phase`, no prompt
 * cache fields, the system prompt as an input message, search bounded by
 * `max_turns`, and never `search_parameters` (Live Search answers 410 since
 * 2026-01-12) or `x_search` (not attached in this rework, O-25).
 */

import type OpenAI from "openai";

import { normalizeFinishReason } from "@/lib/finish-reason";
import { roundBudgetFor } from "@/lib/llm/loop";
import {
  outputTextFor,
  stampCallId,
  toolSourceFor,
  turnSignal,
  type ToolSource,
} from "@/lib/llm/openai-shared";
import type { AdapterRequest, ProviderTransport } from "@/lib/llm/types";
import type { McpToolset } from "@/lib/mcp";
import { reasoningCaps, supportsProMode } from "@/lib/model-metrics";
import { providerRequestModel } from "@/lib/model-request";
import { hostedSearchAllowedAt, toolCapabilitiesFor } from "@/lib/model-tools";
import type { ModelInfo } from "@/lib/models";
import { openAIPromptCacheRequestFields, openAIResponsesSystemInput } from "@/lib/openai-prompt-cache";
import { sendableToolImages, toDataUrl, toolImageIntro, withheldImagesNote } from "@/lib/tool-result-images";
import type { BatchResult, executeToolBatch, ToolCallInput } from "@/lib/tools/dispatch";
import type { ClientSource, ReasoningEffort } from "@/types/chat";
import type { LlmEvent } from "@/types/llm";

export type ResponsesDialect = "openai" | "xai";

/** One Responses input item. Kept loose: the xAI surface adds fields the SDK does not type. */
export type ResponsesInputItem = Record<string, unknown>;

export interface ResponsesLoopInput {
  req: AdapterRequest;
  dialect: ResponsesDialect;
  /** The conversation as input items, oldest first, without the system prompt or dynamic context. */
  history: ResponsesInputItem[];
  transport: ProviderTransport;
  /** Deprecated positional path: the `McpToolset` `streamChat` opened itself (until WS9a). */
  legacyToolset?: McpToolset;
  /** Test seam: stands in for `executeToolBatch`. Absent in production. */
  dispatch?: typeof executeToolBatch;
  /** Start/finish lines for the server log; absent in tests. */
  log?: (event: "start" | "finish", data: Record<string, unknown>) => void;
}

/**
 * Map Juno's tier to the Responses API's reasoning.effort (OpenAI).
 *
 * The gpt-5.x-pro models accept medium|high|xhigh and cannot be run
 * non-thinking, so a missing/too-shallow tier is raised to their "high" default
 * rather than dropped. Everything else relays the tier as-is — including
 * "xhigh" and "max", which this used to flatten to "high" and thereby silently
 * cap the deepest settings the user picked.
 */
export function mapResponsesEffort(model: ModelInfo, effort?: ReasoningEffort): string | undefined {
  const id = model.providerModel.toLowerCase();
  if (/-pro$/.test(id)) {
    if (effort === "medium" || effort === "high" || effort === "xhigh") return effort;
    return "high"; // pro's own default; it has no none/low
  }
  if (!effort) return canDisableViaNoneEffort(model) ? "none" : undefined;
  // "max" exists on GPT-5.6 and GPT-6 Astra/Sol/Luna; older Responses models
  // top out at xhigh.
  if (effort === "max" && !/gpt-5\.6|gpt-6-(astra|sol|luna)/.test(id)) return "xhigh";
  return effort;
}

/**
 * GPT-5.1+ express "don't think" as an explicit effort of "none".
 *
 * It must be SENT, not left out: GPT-5.5 and later default to `medium` when
 * the parameter is absent, so omitting it made Instant a no-op. The per-model
 * caps carry each snapshot's live-probed enum (5.3-codex accepts "none",
 * 5.1/5.2-codex reject it; GPT-6 Sol/Luna list it, Astra does not), and
 * `model.reasoning &&` keeps a non-reasoning model — whose caps report
 * canDisable — from ever being sent it.
 */
function canDisableViaNoneEffort(model: ModelInfo): boolean {
  const id = model.providerModel.toLowerCase();
  if (!/gpt-5\.\d|gpt-6/.test(id)) return false;
  return model.reasoning && reasoningCaps(model).canDisable;
}

/**
 * The output ceiling an OpenAI request may ask for.
 *
 * Every OpenAI model is on Responses now, including the legacy lines that
 * reject a cap above their own ceiling with a 400: gpt-4o at 16,384, gpt-4-turbo
 * and gpt-3.5 at 4,096. Reasoning models count hidden reasoning against the
 * cap, so a tight one can end in empty output; the 16,000 floor is the
 * headroom the compat path always gave them.
 */
export function openAIMaxOutputTokens(model: ModelInfo, maxTokens: number): number {
  const id = model.providerModel.toLowerCase();
  const legacyCap = /gpt-4o/.test(id) ? 16_384 : /gpt-4-turbo|gpt-3\.5/.test(id) ? 4_096 : Infinity;
  return Math.min(Math.max(maxTokens, 16_000), legacyCap);
}

/** What one request carries besides the input: decided once per turn. */
interface TurnShape {
  model: ModelInfo;
  dialect: ResponsesDialect;
  functionTools: Array<Record<string, unknown>>;
  hostedSearch: boolean;
  effort: string | undefined;
  usePro: boolean;
  wantsSummary: boolean;
  /** Set when the system prompt travels as `instructions` rather than as an input item. */
  instructions?: string;
}

/**
 * The per-turn decisions: which tools ride along, and how reasoning is asked for.
 *
 * Function tools are dropped for a model that takes none
 * (`grok-4.20-multi-agent-0309`, SPEC §5.5 item 4) whatever the caller passed.
 * Hosted search needs the web toggle, the model's native search, and an effort
 * the model accepts it at (the original gpt-5 rejects it at "minimal").
 */
function turnShape(req: AdapterRequest, dialect: ResponsesDialect, source: ToolSource | null): TurnShape {
  const { model } = req;
  const caps = toolCapabilitiesFor(model);
  const functionTools = source && caps.supported
    ? source.tools.map((tool) => ({
        // Responses uses a flat function-tool shape (no nested `function` wrapper).
        type: "function",
        name: tool.function.name,
        description: tool.function.description ?? "",
        parameters: tool.function.parameters ?? { type: "object" },
        strict: false,
      }))
    : [];
  const rc = reasoningCaps(model);
  // The effort the request will run at: the chosen tier, else the model's own
  // default when it cannot switch thinking off.
  const searchEffort = req.reasoningEffort ?? (rc.canDisable ? undefined : rc.defaultLevel ?? undefined);
  const hostedSearch = !!req.webSearch && hostedSearchAllowedAt(caps, searchEffort);

  if (dialect === "xai") {
    return {
      model,
      dialect,
      functionTools,
      hostedSearch,
      effort: model.reasoning && req.reasoningEffort ? req.reasoningEffort : undefined,
      usePro: false,
      wantsSummary: false,
    };
  }

  // Pro is a SECOND axis, not a deeper effort: `reasoning.mode` selects standard
  // or pro execution while `reasoning.effort` controls how much reasoning happens
  // inside it. Gated on supportsProMode — every other Responses model 400s on an
  // unknown reasoning key.
  const usePro = !!req.proMode && supportsProMode(model);
  const requestedEffort = mapResponsesEffort(model, req.reasoningEffort);
  // "none" and pro contradict each other; drop the effort and let the API apply
  // its own default rather than send a self-cancelling pair.
  const effort = usePro && requestedEffort === "none" ? undefined : requestedEffort;
  // Without `summary` the API emits no reasoning_summary_* events at all, so
  // the steps of every run were invisible. "detailed" over "auto" because the
  // parts ARE the steps. Skipped at "none" (nothing to summarise), and on o1,
  // whose summaries are not documented.
  const wantsSummary = (usePro || (!!effort && effort !== "none")) && !/^o1(\b|-)/.test(model.providerModel.toLowerCase());
  return { model, dialect, functionTools, hostedSearch, effort, usePro, wantsSummary };
}

/**
 * One request's body (SPEC §5.2, §5.5).
 *
 * `final` is the loop controller's verdict for this request: the function
 * tools stay in the array (the cache and the model's view of the turn do not
 * change) and `tool_choice: "none"` forbids calling them (SPEC §4.6).
 */
function buildResponsesRequest(
  req: AdapterRequest,
  shape: TurnShape,
  input: ResponsesInputItem[],
  step: { index: number; final: boolean },
): Record<string, unknown> {
  const { model, dialect } = shape;
  const params: Record<string, unknown> = {
    // The one identifier an adapter may serialize — it re-checks the
    // catalog-id/provider-id equality every other adapter enforces.
    model: providerRequestModel(model),
    ...(shape.instructions === undefined ? {} : { instructions: shape.instructions }),
    // A copy: the loop appends to its own array after this request is sent.
    input: [...input],
    stream: true,
    // No server-side persistence: history is resent per request, like every
    // other Juno adapter — nothing about the chat lives in provider storage.
    store: false,
    max_output_tokens: dialect === "openai" ? openAIMaxOutputTokens(model, req.maxTokens) : req.maxTokens,
  };

  // `store: false` keeps nothing between requests, so a request's reasoning
  // must travel back with the calls it produced; `reasoning.encrypted_content`
  // is what makes the reasoning items returnable at all. Non-reasoning models
  // reject it. The hosted search's full source lists come only through
  // `web_search_call.action.sources` (OpenAI; xAI reports citations instead).
  const include: string[] = [];
  if (model.reasoning) include.push("reasoning.encrypted_content");
  if (shape.hostedSearch && dialect === "openai") include.push("web_search_call.action.sources");
  if (include.length) params.include = include;

  if (shape.effort || shape.usePro) {
    params.reasoning = {
      ...(shape.effort ? { effort: shape.effort } : {}),
      ...(shape.usePro ? { mode: "pro" } : {}),
      ...(shape.wantsSummary ? { summary: "detailed" } : {}),
    };
  }

  const tools: Array<Record<string, unknown>> = [...shape.functionTools];
  if (shape.hostedSearch) {
    // `user_location` is left out on purpose: the request carries no location.
    tools.push(dialect === "openai" ? { type: "web_search", search_context_size: "medium" } : { type: "web_search" });
  }
  if (tools.length) {
    params.tools = tools;
    if (shape.functionTools.length) params.tool_choice = step.final ? "none" : "auto";
    if (dialect === "xai") {
      // xAI runs its server-side tools in a loop of its own inside one
      // request; `max_turns` bounds it by what is left of the turn's budget
      // (SPEC §4.1). A lone tool-less request counts against the effort's own
      // budget, or Grok could search once and no more.
      const budget = req.loop.budget > 1 ? req.loop.budget : roundBudgetFor(req.reasoningEffort, false);
      params.max_turns = Math.max(1, budget - step.index);
    }
  }

  if (req.responseSchema) {
    params.text = {
      format: { type: "json_schema", name: req.responseSchema.name, schema: req.responseSchema.schema, strict: false },
    };
  }
  if (dialect === "openai") {
    // Official OpenAI prompt caching (key + GPT-5.6 options / retention).
    Object.assign(params, openAIPromptCacheRequestFields(model, req.cacheKey));
    // Priority processing; the route gates fastMode to eligible models.
    if (req.fastMode) params.service_tier = "priority";
  }
  return params;
}

/**
 * The conversation as the first request sends it: system prompt placed for
 * the dialect, and the per-request dynamic context as a system item just
 * before the newest user turn, never ahead of the stable prefix.
 */
function openingInput(
  req: AdapterRequest,
  dialect: ResponsesDialect,
  history: ResponsesInputItem[],
): { input: ResponsesInputItem[]; instructions?: string } {
  const input = [...history];
  let instructions: string | undefined;
  if (dialect === "xai") {
    // xAI takes the system prompt as an input message.
    input.unshift({ role: "system", content: req.system });
  } else {
    // GPT-5.6+: system in `input` with an explicit cache breakpoint, so the
    // static prefix is a first-class cached segment. Older models keep `instructions`.
    const systemAsInput = openAIResponsesSystemInput(req.model, req.system);
    if (systemAsInput) input.unshift(...systemAsInput);
    else instructions = req.system;
  }
  if (req.dynamicContext) {
    let lastUser = input.length;
    for (let i = input.length - 1; i >= 0; i--) {
      if (input[i].role === "user") {
        lastUser = i;
        break;
      }
    }
    input.splice(lastUser, 0, { role: "system", content: [{ type: "input_text", text: req.dynamicContext }] });
  }
  return { input, instructions };
}

/** A `phase` the API declared on a message item, in the stream's vocabulary. */
function textPhase(phase: unknown): "commentary" | "answer" | undefined {
  if (phase === "commentary") return "commentary";
  if (phase === "final_answer") return "answer";
  return undefined;
}

/** The replayable copy of an output item. xAI has no `phase`. */
function replayItem(item: Record<string, unknown>, dialect: ResponsesDialect): ResponsesInputItem {
  if (dialect !== "xai" || item.type !== "message" || !("phase" in item)) return item;
  const copy = { ...item };
  delete copy.phase;
  return copy;
}

/** The query a hosted search call ran, for the row. */
function searchQuery(action: unknown): string | undefined {
  if (!action || typeof action !== "object") return undefined;
  const a = action as { type?: string; query?: unknown; queries?: unknown; url?: unknown };
  if (Array.isArray(a.queries)) {
    const queries = a.queries.filter((q): q is string => typeof q === "string" && q.trim() !== "");
    if (queries.length) return queries.join(" · ");
  }
  if (typeof a.query === "string" && a.query.trim()) return a.query;
  if (typeof a.url === "string") return a.url;
  return undefined;
}

function searchSources(action: unknown): string[] {
  const sources = (action as { sources?: unknown } | null)?.sources;
  if (!Array.isArray(sources)) return [];
  return sources
    .map((s) => (s && typeof s === "object" ? (s as { url?: unknown }).url : undefined))
    .filter((url): url is string => typeof url === "string" && url !== "");
}

function citationSources(item: Record<string, unknown>): ClientSource[] {
  const out: ClientSource[] = [];
  const content = Array.isArray(item.content) ? item.content : [];
  for (const part of content) {
    const annotations = (part as { annotations?: unknown }).annotations;
    if (!Array.isArray(annotations)) continue;
    for (const a of annotations) {
      const ann = a as { type?: string; url?: unknown; title?: unknown };
      if (ann.type !== "url_citation" || typeof ann.url !== "string") continue;
      out.push({ title: typeof ann.title === "string" && ann.title ? ann.title : ann.url, url: ann.url, snippet: "" });
    }
  }
  return out;
}

/** xAI bills server search from `server_side_tool_usage`; the spellings seen so far. */
function xaiSearchCount(response: Record<string, unknown>): number | null {
  const usage = (response.usage ?? {}) as Record<string, unknown>;
  for (const candidate of [response.server_side_tool_usage, usage.server_side_tool_usage, usage.server_side_tool_usage_details]) {
    if (!candidate || typeof candidate !== "object") continue;
    const map = candidate as Record<string, unknown>;
    for (const key of ["SERVER_SIDE_TOOL_WEB_SEARCH", "web_search_requests", "web_search_calls", "web_search"]) {
      const n = map[key];
      if (typeof n === "number" && Number.isFinite(n)) return n;
    }
  }
  return null;
}

/** The follow-up items for one round's results, in call order (SPEC §4.2). */
function resultItems(
  results: readonly BatchResult[],
  model: ModelInfo,
  dialect: ResponsesDialect,
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  const imageParts: Array<Record<string, unknown>> = [];
  for (const result of results) {
    const images = sendableToolImages(result.images, model.vision);
    const text = withheldImagesNote(outputTextFor(result), result.images, images.length);
    const callId = result.providerCallId ?? result.callId;
    if (images.length && dialect === "openai") {
      // A function's output may be an array of input parts, so its pixels ride
      // on the result they belong to instead of a user turn that reads like an
      // upload.
      items.push({
        type: "function_call_output",
        call_id: callId,
        output: [
          { type: "input_text", text },
          ...images.map((image) => ({ type: "input_image", detail: "high", image_url: toDataUrl(image) })),
        ],
      });
      continue;
    }
    items.push({ type: "function_call_output", call_id: callId, output: text });
    if (images.length) {
      // xAI: array outputs are not confirmed there, so the pictures follow
      // every output as one user turn, introduced as tool output.
      imageParts.push({ type: "input_text", text: toolImageIntro(result.name, images) });
      for (const image of images) imageParts.push({ type: "input_image", detail: "high", image_url: toDataUrl(image) });
    }
  }
  if (imageParts.length) items.push({ role: "user", content: imageParts });
  return items;
}

/** Cumulative usage over the turn's requests (each is billed on its own). */
interface TurnUsage {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  webSearches: number;
  seen: boolean;
}

function addResponseUsage(into: TurnUsage, usage: Record<string, unknown> | undefined): void {
  if (!usage) return;
  into.seen = true;
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const inputDetails = (usage.input_tokens_details ?? {}) as Record<string, unknown>;
  const outputDetails = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
  into.input += n(usage.input_tokens);
  into.output += n(usage.output_tokens);
  into.cached += n(inputDetails.cached_tokens);
  // Docs: cache writes are `cache_write_tokens` (GPT-5.6+); older SDKs exposed
  // `cache_creation_tokens` — accept both.
  into.cacheWrite += n(inputDetails.cache_write_tokens ?? inputDetails.cache_creation_tokens);
  into.reasoning += n(outputDetails.reasoning_tokens);
  into.total += n(usage.total_tokens);
}

function usageEvent(usage: TurnUsage, round: number): LlmEvent {
  return {
    type: "usage",
    input: usage.input,
    output: usage.output,
    reasoning: usage.reasoning || undefined,
    total: usage.total || undefined,
    cacheRead: usage.cached || undefined,
    cacheWrite: usage.cacheWrite || undefined,
    webSearchRequests: usage.webSearches || undefined,
    round,
  };
}

/** Runs the whole turn: every request the loop controller allows, and the tools between them. */
export async function* runResponsesLoop(opts: ResponsesLoopInput): AsyncGenerator<LlmEvent> {
  const { req, dialect, transport } = opts;
  const { model, loop } = req;
  const signal = turnSignal(req.signal);
  const source = toolSourceFor(req, opts.legacyToolset, opts.dispatch);
  const opening = openingInput(req, dialect, opts.history);
  const shape: TurnShape = { ...turnShape(req, dialect, source), instructions: opening.instructions };
  const input = opening.input;

  opts.log?.("start", {
    dialect,
    model: model.providerModel,
    maxTokens: req.maxTokens,
    reasoningEffort: shape.effort ?? null,
    proMode: shape.usePro,
    tools: shape.functionTools.length,
    webSearch: shape.hostedSearch,
    budget: loop.budget,
  });

  const usage: TurnUsage = { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0, total: 0, webSearches: 0, seen: false };
  const seenSources = new Set<string>();
  const stampedIds = new Set<string>();
  // The model step: +1 every time the model resumes after tool results, its
  // own hosted search included (SPEC §2.9).
  let round = 0;
  // Monotonic across requests: each response restarts summary_index at 0, but
  // the reader is watching one continuous run, so round 2's first part must
  // not overwrite round 1's.
  let summaryPart = -1;
  let finishRaw: string | undefined;

  const newSources = (list: ClientSource[]): ClientSource[] =>
    list.filter((source) => {
      if (seenSources.has(source.url)) return false;
      seenSources.add(source.url);
      return true;
    });

  for (;;) {
    const step = loop.beginRequest();
    const body = buildResponsesRequest(req, shape, input, step);
    const stream = transport.request(body, signal);

    const calls: ToolCallInput[] = [];
    // Everything this request produced that the next one must see again, in
    // wire order. Order is the contract: a reasoning item after its own call
    // is rejected.
    const replay: ResponsesInputItem[] = [];
    const phases = new Map<string, "commentary" | "answer" | undefined>();
    let stepHasText = false;
    let stepSearches = 0;
    let requestSearchCalls = 0;
    let requestFinish: string | undefined;
    let xaiBilledSearches: number | null = null;

    for await (const raw of stream) {
      const event = raw as OpenAI.Responses.ResponseStreamEvent;
      switch (event.type) {
        case "response.output_item.added": {
          const item = event.item as unknown as { type?: string; id?: string; phase?: unknown };
          if (item.type === "message" && item.id && dialect === "openai") phases.set(item.id, textPhase(item.phase));
          break;
        }
        case "response.output_text.delta": {
          if (!event.delta) break;
          stepHasText = true;
          const phase = phases.get(event.item_id);
          yield { type: "text", text: event.delta, round, ...(phase ? { phase } : {}) };
          break;
        }
        // A part boundary is a FACT the API states: each `part.added` opens a
        // step, and every delta until the next one belongs to it.
        case "response.reasoning_summary_part.added":
          summaryPart++;
          break;
        case "response.reasoning_summary_text.delta":
          // A delta with no preceding part.added still belongs to a real part.
          if (summaryPart < 0) summaryPart = 0;
          yield { type: "reasoning", text: event.delta, part: summaryPart, round };
          break;
        case "response.output_item.done": {
          const item = event.item as unknown as Record<string, unknown> & { type?: string };
          replay.push(replayItem(item, dialect));
          if (item.type === "message") {
            const cited = newSources(citationSources(item));
            if (cited.length) yield { type: "sources", sources: cited, origin: "provider_search" };
          } else if (item.type === "function_call" && typeof item.name === "string") {
            const index = calls.length;
            const providerId = typeof item.call_id === "string" ? item.call_id : undefined;
            const ids = stampCallId(providerId, round, index, req.batch?.seenCallIds, stampedIds);
            const argsText = typeof item.arguments === "string" ? item.arguments : "";
            calls.push({ name: item.name, round, index, argsText, ...ids });
            // The whole argument JSON is here before dispatch, so it rides on
            // the call and the row is complete while the tool runs.
            yield {
              type: "tool",
              phase: "call",
              server: source?.labelFor(item.name) ?? item.name,
              name: item.name,
              callId: ids.callId,
              ...(ids.providerCallId && ids.providerCallId !== ids.callId ? { providerCallId: ids.providerCallId } : {}),
              round,
              index,
              args: argsText,
            };
          } else if (item.type === "web_search_call") {
            const callId = typeof item.id === "string" && item.id ? item.id : `ps_${round}_${stepSearches}`;
            const urls = searchSources(item.action);
            const query = searchQuery(item.action);
            yield { type: "server_tool", phase: "call", tool: "provider_web_search", callId, round, ...(query ? { query } : {}) };
            yield {
              type: "server_tool",
              phase: "result",
              tool: "provider_web_search",
              callId,
              round,
              results: urls.length,
              ok: item.status !== "failed",
            };
            const fresh = newSources(urls.map((url) => ({ title: url, url, snippet: "" })));
            if (fresh.length) yield { type: "sources", sources: fresh, origin: "provider_search" };
            stepSearches++;
            requestSearchCalls++;
            // A search after text inside one response starts a new step: the
            // text before it and the text after it are both answer text, but
            // they are not one paragraph (SPEC §2.9).
            if (stepHasText) {
              yield { type: "round_end", round, tools: 0, serverTools: stepSearches, final: step.final, stop: null };
              round++;
              stepHasText = false;
              stepSearches = 0;
            }
          }
          break;
        }
        case "response.completed":
        case "response.incomplete": {
          const response = event.response as unknown as Record<string, unknown> & {
            usage?: Record<string, unknown>;
            incomplete_details?: { reason?: string } | null;
            citations?: unknown;
          };
          addResponseUsage(usage, response.usage);
          if (dialect === "xai") {
            xaiBilledSearches = xaiSearchCount(response);
            if (Array.isArray(response.citations)) {
              const urls = response.citations.filter((url): url is string => typeof url === "string" && url !== "");
              const fresh = newSources(urls.map((url) => ({ title: url, url, snippet: "" })));
              if (fresh.length) yield { type: "sources", sources: fresh, origin: "provider_search" };
            }
          }
          requestFinish =
            event.type === "response.incomplete"
              ? response.incomplete_details?.reason === "max_output_tokens"
                ? "length"
                : (response.incomplete_details?.reason ?? "stop")
              : calls.length > 0
                ? "tool_calls"
                : "stop";
          break;
        }
        case "response.failed": {
          const err = event.response.error;
          throw Object.assign(new Error(err?.message ?? "Responses API run failed."), {
            status: undefined,
            error: { message: err?.message },
          });
        }
        case "error": {
          const ev = event as { message?: string };
          throw Object.assign(new Error(ev.message ?? "Responses API stream error."), {
            error: { message: ev.message },
          });
        }
        default:
          break;
      }
    }

    // Hosted search is billed per call: OpenAI per `web_search_call`, xAI from
    // its own usage map when it reports one.
    usage.webSearches += xaiBilledSearches ?? requestSearchCalls;
    finishRaw = requestFinish;
    if (usage.seen || usage.webSearches > 0) yield usageEvent(usage, round);

    // Never run a call from the tools-off request, or from one that ran out of
    // room: its arguments may be cut mid-JSON.
    const dispatch = !!source && !step.final && calls.length > 0 && requestFinish !== "length";
    if (!dispatch) {
      for (const call of calls) {
        yield {
          type: "tool",
          phase: "result",
          server: source?.labelFor(call.name) ?? call.name,
          name: call.name,
          callId: call.callId,
          round: call.round,
          index: call.index,
          result: "Cancelled.",
          ok: false,
          status: "cancelled",
          error: { code: "cancelled" },
        };
      }
    }
    yield { type: "round_end", round, tools: calls.length, serverTools: stepSearches, final: step.final, stop: requestFinish ?? null };
    if (!dispatch || !source) break;

    const results: BatchResult[] = yield* source.run(calls, signal);
    // The request's own output first — verbatim and in order — then one
    // output per call.
    input.push(...replay, ...resultItems(results, model, dialect));
    round++;
  }

  // A trailing tool_calls means even the forced-answer request wanted more
  // tools — surface "length" so the UI warns and offers Continue.
  const finalRaw = finishRaw === "tool_calls" ? "length" : finishRaw;
  yield { type: "finish", reason: normalizeFinishReason(finalRaw ?? "stop"), raw: finalRaw };
  opts.log?.("finish", {
    dialect,
    model: model.providerModel,
    finishReason: finalRaw ?? "stop",
    requests: loop.requests,
    promptTokens: usage.seen ? usage.input : null,
    completionTokens: usage.seen ? usage.output : null,
    reasoningTokens: usage.seen ? usage.reasoning || null : null,
    cachedTokens: usage.seen ? usage.cached : null,
    webSearches: usage.webSearches || null,
  });
}
