import "server-only";
import { serviceTierFor, type FastMode } from "@/lib/pricing";
import OpenAI from "openai";
import { getObjectBytes } from "@/lib/storage";
import { providerApiKey, providerBaseUrl, PROVIDERS } from "@/lib/providers";
import { normalizeFinishReason } from "@/lib/finish-reason";
import { getModelMetrics, reasoningCaps, supportsProMode } from "@/lib/model-metrics";
import { hostedSearchAllowedAt, toolCapabilitiesFor } from "@/lib/model-tools";
import {
  actionSourceList,
  hostedSearchCallBillable,
  hostedWebSearchTool,
  OPENAI_WEB_SEARCH_INCLUDE,
  xaiResponseCitations,
  xaiServerToolCounts,
  type HostedSearchDialect,
} from "@/lib/hosted-web-search";
import {
  openAIResponsesSystemInput,
  responsesPromptCacheRequestFields,
} from "@/lib/openai-prompt-cache";
import type { ModelInfo } from "@/lib/models";
import type { ReasoningEffort } from "@/types/chat";
import type { LlmEvent, MessageForModel } from "@/types/llm";
import { wireCallId, type ToolLoop } from "@/lib/tools/loop";
import type { ToolCallInput } from "@/lib/tools/types";
import { attachedFileText, pdfAttachmentFallbackNote } from "@/lib/attachment-context";
import { attachmentTextBudget } from "@/lib/knowledge/document-text";
import { canInlineDocument, isPdfAttachment, oversizeDocumentNote } from "@/lib/attachment-bytes";
import {
  sendableToolImages,
  toDataUrl,
  toolImageIntro,
  withheldImagesNote,
} from "@/lib/tool-result-images";
import { providerRequestModel } from "@/lib/model-request";
import { mapResponsesEffort } from "@/lib/llm/responses-loop";
import {
  META_WEB_SEARCH_INCLUDE,
  META_WEB_SEARCH_TOOL,
  metaBillableQueries,
  metaReplayReasoning,
  metaSearchQueries,
  metaSearchResultSources,
  urlCitationSources,
} from "@/lib/meta-web-search";
import type { ClientSource } from "@/types/chat";

/**
 * Responses API adapter — every OpenAI model, every Grok model (at xAI's host,
 * in xAI's dialect) and Meta's search turns (at Meta's host). Mirrors streamOpenAICompat's contract exactly: same LlmEvent
 * stream, same MCP tool loop, same usage/finish semantics, so routes and the
 * UI can't tell which wire protocol served the request.
 */

/** The labs whose Responses API this adapter speaks to. */
export type ResponsesHost = "openai" | "xai" | "meta";

const cached = new Map<ResponsesHost, OpenAI>();

/**
 * The host serving a model's Responses turn, from the model's own provider.
 * Grok ("xai-responses") goes to `api.x.ai/v1` with XAI_API_KEY; Meta's search
 * turns ("meta-responses") to Meta's `/v1/responses` with META_API_KEY; every
 * other model here is OpenAI's.
 */
export function responsesHostFor(model: Pick<ModelInfo, "provider">): ResponsesHost {
  if (model.provider === "xai") return "xai";
  if (model.provider === "meta") return "meta";
  return "openai";
}

/** The SDK client for the host serving this request (key and base URL from that lab's env). */
function client(host: ResponsesHost = "openai"): OpenAI {
  const apiKey = providerApiKey(host);
  if (!apiKey) throw new Error(`${PROVIDERS[host].label} API key is not configured.`);
  // SDK retries are disabled so a partially consumed paid response cannot be
  // replayed without a new, explicitly metered attempt.
  let c = cached.get(host);
  if (!c) {
    c = new OpenAI({ apiKey, baseURL: providerBaseUrl(host), maxRetries: 0 });
    cached.set(host, c);
  }
  return c;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const BINARY_ATTACHMENT_LOOKBACK = 8; // kept in sync with the compat/Anthropic adapters
const MAX_TOOL_ROUNDS = 6;

type InputItem = OpenAI.Responses.ResponseInputItem;

async function toResponsesInput(
  history: MessageForModel[],
  vision: boolean,
  /** Per-file text ceiling, from the model's own context window. */
  attachmentTextMaxChars?: number,
  /** False where the route was told the model gets no PDF bytes (Meta: `providerReceivesDocumentBytes`). */
  documentBytes = true
): Promise<InputItem[]> {
  const out: InputItem[] = [];
  // Block-anchored (see openai-compat.ts): keeps the cacheable prefix stable
  // between steps instead of moving it every turn.
  const binaryFrom = Math.max(
    0,
    Math.floor((history.length - BINARY_ATTACHMENT_LOOKBACK) / BINARY_ATTACHMENT_LOOKBACK) * BINARY_ATTACHMENT_LOOKBACK
  );

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role === "SYSTEM") continue;
    if (msg.role === "ASSISTANT") {
      out.push({
        role: "assistant",
        content: [{ type: "output_text", text: msg.content || "(no content)" }],
      } as InputItem);
      continue;
    }

    if (msg.attachments.length === 0) {
      out.push({ role: "user", content: [{ type: "input_text", text: msg.content || "(no content)" }] });
      continue;
    }

    const embedBinary = i >= binaryFrom;
    const parts: Array<Record<string, unknown>> = [];
    if (msg.content.trim()) parts.push({ type: "input_text", text: msg.content });

    for (const att of msg.attachments) {
      try {
        if (att.kind === "IMAGE" && IMAGE_TYPES.includes(att.mimeType) && vision && embedBinary) {
          const { bytes } = await getObjectBytes(att.storageKey);
          parts.push({
            type: "input_image",
            detail: "auto",
            image_url: `data:${att.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
          });
        } else if (att.kind === "IMAGE" && IMAGE_TYPES.includes(att.mimeType) && vision && !embedBinary) {
          parts.push({ type: "input_text", text: `[Image "${att.fileName}" shared earlier in the conversation.]` });
        } else if (isPdfAttachment(att) && vision && embedBinary && documentBytes) {
          /*
           * `input_file` — THE PATH THAT WAS NEVER TAKEN.
           *
           * The Responses API accepts a PDF as a first-class input and, like
           * Anthropic and Gemini, rasterises each page alongside its text
           * layer. Juno never used it: a PDF reached every GPT model as the
           * bracketed sentence below, so a scanned document was unreadable on
           * OpenAI no matter how good the file was — and the apology said
           * "this model does not receive raw PDF bytes", which had stopped
           * being true of the API long before it stopped being true here.
           *
           * The text still rides along when extraction produced any, because
           * a text layer is cheaper and more exact than reading a rendering
           * of it, and the two together are what the providers do internally.
           */
          const { bytes } = await getObjectBytes(att.storageKey);
          if (canInlineDocument(bytes.byteLength)) {
            parts.push({
              type: "input_file",
              filename: att.fileName,
              file_data: `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}`,
            });
          } else {
            if (att.extractedText) {
              parts.push({
                type: "input_text",
                text: attachedFileText(att.fileName, att.extractedText, { maxChars: attachmentTextMaxChars }),
              });
            }
            parts.push({
              type: "input_text",
              text: oversizeDocumentNote(att.fileName, bytes.byteLength, !!att.extractedText),
            });
          }
        } else if (att.extractedText) {
          parts.push({ type: "input_text", text: attachedFileText(att.fileName, att.extractedText, { maxChars: attachmentTextMaxChars }) });
        } else {
          const note = att.mimeType === "application/pdf"
            ? ` — ${pdfAttachmentFallbackNote(att.parserState)}`
            : att.kind === "IMAGE" && !vision
            ? " — this model cannot view images"
            : "";
          parts.push({ type: "input_text", text: `[Attached file "${att.fileName}" (${att.mimeType})${note}.]` });
        }
      } catch {
        parts.push({ type: "input_text", text: `[Attachment "${att.fileName}" could not be loaded.]` });
      }
    }

    out.push({ role: "user", content: parts } as unknown as InputItem);
  }

  return out;
}

/**
 * The seam the scripted-transport tests replace: `responses.create` returning
 * the streamed events. Production leaves it absent.
 */
export interface ResponsesTransport {
  create(
    params: OpenAI.Responses.ResponseCreateParamsStreaming,
    options: { signal?: AbortSignal }
  ): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>>;
}

/**
 * Production's transport: the SDK client for `host`. Exported so a test can
 * drive it with a stubbed `fetch` and see the URL and key a turn really uses.
 */
export function sdkResponsesTransport(host: ResponsesHost): ResponsesTransport {
  return {
    create: (body, options) =>
      client(host).responses.create(body, options) as unknown as Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>>,
  };
}

export async function* streamOpenAIResponses(
  model: ModelInfo,
  system: string,
  history: MessageForModel[],
  maxTokens: number,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort,
  webSearch?: boolean,
  tools?: ToolLoop,
  dynamicContext?: string,
  cacheKey?: string,
  fastMode?: FastMode,
  proMode?: boolean,
  transport?: ResponsesTransport
): AsyncGenerator<LlmEvent> {
  const toolset = tools?.toolset;
  /*
   * META'S DIALECT. Only a Muse Spark turn with web search on is routed here
   * ("meta-responses"), and Meta's Responses API differs from OpenAI's in
   * four ways that matter: `tool_choice` is "auto" only, so the final round
   * drops the function tools instead of sending "none"; reasoning is private,
   * so no summary is asked for; every replayed reasoning item needs a
   * `summary`; and the route was told Meta reads no PDF bytes, so none are sent.
   */
  const host = responsesHostFor(model);
  const meta = host === "meta";
  /*
   * XAI'S DIALECT ("xai-responses": every Grok model the catalog serves). The
   * same protocol at `api.x.ai/v1` with XAI_API_KEY. What differs: the system
   * prompt travels as a system input message (the form every xAI example
   * uses); `reasoning.effort` goes only to a model with an effort ladder
   * (low|medium|high, xhigh on grok-4.6+; docs.x.ai reasoning guide) and no
   * summary is asked for; `prompt_cache_key` but no other OpenAI prompt-cache
   * fields; no PDF bytes (the
   * route was told `providerReceivesDocumentBytes` is false for Grok); and a
   * model that takes no function tools (grok-4.20-multi-agent) is sent none.
   */
  const xai = host === "xai";
  const caps = toolCapabilitiesFor(model);
  /*
   * HOSTED SEARCH. The composer's Web toggle reaches here as `webSearch`, and
   * for OpenAI, xAI and Meta models the chat route attaches no search tool of
   * its own: the model's provider search IS the turn's web search. Meta's is
   * its own `web_search` (meta-web-search.ts); OpenAI's and xAI's are the
   * hosted `web_search` tool (hosted-web-search.ts), at an effort the model
   * accepts it at (gpt-5 rejects it at "minimal").
   */
  const rcSearch = reasoningCaps(model);
  const searchEffort = reasoningEffort ?? (rcSearch.canDisable ? undefined : rcSearch.defaultLevel ?? undefined);
  const hostedSearch = meta ? !!webSearch : !!webSearch && hostedSearchAllowedAt(caps, searchEffort);
  const searchDialect: HostedSearchDialect = xai ? "xai" : "openai";
  const input = await toResponsesInput(
    history,
    model.vision,
    attachmentTextBudget(getModelMetrics(model).contextTokens),
    !meta && !xai
  );
  // GPT-5.6+: put system into input with an explicit cache breakpoint so the
  // static prefix is a first-class cached segment (see openai-prompt-cache.ts).
  // Older models keep `instructions` below. xAI: a plain system message.
  const systemAsInput = xai
    ? [{ role: "system", content: system }]
    : openAIResponsesSystemInput(model, system);
  if (systemAsInput) {
    input.unshift(...(systemAsInput as unknown as InputItem[]));
  }
  // Same cache-safe placement as the compat adapter: dynamic context lands as a
  // system item just before the newest user turn, never ahead of the stable prefix.
  if (dynamicContext) {
    let lastUser = input.length;
    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i] as { role?: string };
      if (item.role === "user") {
        lastUser = i;
        break;
      }
    }
    input.splice(lastUser, 0, {
      role: "system",
      content: [{ type: "input_text", text: dynamicContext }],
    } as InputItem);
  }

  // A model that takes no function tools (grok-4.20-multi-agent) is sent none.
  const hasTools = !!toolset && toolset.tools.length > 0 && caps.supported;
  // Responses uses a flat function-tool shape (no nested `function` wrapper).
  const wireTools: OpenAI.Responses.Tool[] | undefined = hasTools
    ? toolset!.tools.map((t) => {
        const fn = (t as { function: { name: string; description?: string; parameters?: Record<string, unknown> } }).function;
        return {
          type: "function" as const,
          name: fn.name,
          description: fn.description ?? "",
          parameters: fn.parameters ?? { type: "object" },
          strict: false,
        };
      })
    : undefined;

  // Pro is a SECOND axis, not a deeper effort: `reasoning.mode` selects standard
  // or pro execution while `reasoning.effort` controls how much reasoning happens
  // inside it, and the two are set independently. Gated on supportsProMode rather
  // than relayed blind — every other Responses model 400s on an unknown
  // reasoning key, and this adapter also serves the 5.x-pro and Codex lines.
  const usePro = !xai && !!proMode && supportsProMode(model);
  // xAI: an effort only for a model that lists one, moved onto its own ladder
  // (grok-4.5 tops out at "high"); a model without a ladder is left to xAI.
  const requestedEffort = xai
    ? model.reasoning && reasoningEffort && rcSearch.tiers.length > 0
      ? mapResponsesEffort(model, reasoningEffort)
      : undefined
    : mapResponsesEffort(model, reasoningEffort);
  // "none" and pro contradict each other — pro mode's whole content is that the
  // model deliberates more. Rather than send a self-cancelling pair, drop the
  // effort and let the API apply its own default (medium in both modes).
  const effort = usePro && requestedEffort === "none" ? undefined : requestedEffort;
  // ASK FOR WHAT THE MODEL ALREADY MAKES.
  //
  // Without this key the API emits no reasoning_summary_* events at all, so the
  // handler below was dead code and every gpt-*-pro / gpt-*-codex run showed NO
  // reasoning whatsoever. Verified live on all seven api:"responses" models Juno
  // ships (5.5/5.4/5.2-pro, 5.3/5.2/5.1-codex, 5.1-codex-mini): every one
  // accepts summary:"detailed" -> 200.
  //
  // "detailed" over "auto" because "auto" collapses to a single part on most
  // prompts, and the parts ARE the steps. Cost: summary tokens bill as output
  // tokens (already counted by the usage handler below) — measured ~600 chars
  // per part, 17 parts on a hard prompt ≈ 2.5k output tokens.
  //
  // Skipped when effort is "none": the model does not think, so there is
  // nothing to summarise and nothing to pay for.
  // Pro mode reasons even when the effort is left to the API's default, so the
  // summary is worth asking for on `usePro` alone — keying it off `effort` would
  // hide the steps on exactly the runs that produce the most of them.
  const wantsSummary = !meta && !xai && (usePro || (!!effort && effort !== "none"));

  console.info("[llm:openai-responses] stream start", {
    model: model.providerModel,
    host,
    maxTokens,
    reasoningEffort: effort ?? null,
    proMode: usePro,
    tools: hasTools ? toolset!.tools.length : 0,
    webSearch: hostedSearch,
  });

  let cumInput = 0;
  let cumOutput = 0;
  let cumCached = 0;
  let cumCacheWrite = 0;
  let cumReasoning = 0;
  let cumTotal = 0;
  let sawUsage = false;
  let finishRaw: string | undefined;
  // Declared OUTSIDE the round loop on purpose: a tool round starts a fresh
  // response whose summary_index restarts at 0, but the user is watching one
  // continuous run. Keeping the ordinal monotonic across rounds is what stops
  // round 2's first part from overwriting round 1's.
  let summaryPart = -1;
  // Meta search: billable queries over the turn, and the source URLs already
  // shown (results and citations overlap; each URL is listed once).
  let webSearchQueries = 0;
  const seenSources = new Set<string>();
  const freshSources = (list: ClientSource[]) =>
    list.filter((source) => {
      if (seenSources.has(source.url)) return false;
      seenSources.add(source.url);
      return true;
    });

  // xAI reports its own search counts; when it does they win over counting items.
  let xaiReportedSearches: number | null = null;
  let xaiReportedXSearches = 0;
  const c: ResponsesTransport = transport ?? sdkResponsesTransport(host);
  const maxRounds = hasTools ? (tools?.maxRounds ?? MAX_TOOL_ROUNDS) + 1 : 1;
  for (let round = 0; round < maxRounds; round++) {
    const isFinalRound = round === maxRounds - 1;
    const params: OpenAI.Responses.ResponseCreateParamsStreaming & Record<string, unknown> = {
      // The one identifier an adapter may serialize — it re-checks the
      // catalog-id/provider-id equality every other adapter enforces.
      model: providerRequestModel(model),
      // When system is already in `input` with a cache breakpoint (GPT-5.6+),
      // omit `instructions` so the prefix is one contiguous cached block.
      ...(systemAsInput ? {} : { instructions: system }),
      input,
      stream: true,
      // No server-side persistence: history is resent per round, like every
      // other Juno adapter — nothing about the chat lives in OpenAI storage.
      store: false,
      max_output_tokens: maxTokens,
    };
    // ASK FOR THE REASONING BACK IN A FORM THAT CAN BE RETURNED.
    //
    // `store: false` is stateless, so OpenAI keeps nothing between rounds: the
    // reasoning items a round produced have to travel back with the function
    // calls they produced or the model restarts its chain of thought every
    // round (worse tool use, reasoning tokens paid for twice, and an outright
    // error on some snapshots). `include: ["reasoning.encrypted_content"]` is
    // what makes those items returnable at all — without it the output carries
    // no encrypted payload to echo.
    const include: string[] = [];
    if (model.reasoning) include.push("reasoning.encrypted_content");
    // Meta: each `web_search_call` then lists what it retrieved (title, url, snippet).
    // OpenAI: each `web_search_call` lists the URLs it consulted.
    if (hostedSearch && meta) include.push(META_WEB_SEARCH_INCLUDE);
    if (hostedSearch && host === "openai") include.push(OPENAI_WEB_SEARCH_INCLUDE);
    if (include.length) params.include = include as OpenAI.Responses.ResponseIncludable[];
    // Cast: the installed openai types predate the "none"/"xhigh"/"max" values
    // that the Responses API now accepts.
    if (effort || usePro) {
      params.reasoning = {
        ...(effort ? { effort } : {}),
        ...(usePro ? { mode: "pro" } : {}),
        ...(wantsSummary ? { summary: "detailed" } : {}),
      } as OpenAI.Responses.ResponseCreateParams["reasoning"];
    }
    if (meta) {
      // No tool_choice at all (Meta takes "auto" only, the default): the
      // final round forbids calls by leaving the function tools out.
      const metaTools: unknown[] = [
        ...(wireTools && !isFinalRound ? wireTools : []),
        ...(hostedSearch ? [{ ...META_WEB_SEARCH_TOOL }] : []),
      ];
      if (metaTools.length) params.tools = metaTools as unknown as OpenAI.Responses.Tool[];
    } else {
      const roundTools: unknown[] = [
        ...(wireTools ?? []),
        ...(hostedSearch ? [hostedWebSearchTool(searchDialect)] : []),
      ];
      if (roundTools.length) params.tools = roundTools as OpenAI.Responses.Tool[];
      // Only function tools need steering; the forced-answer round's "none"
      // also stops the search, which is what a final answer means.
      if (wireTools) params.tool_choice = isFinalRound ? "none" : "auto";
    }
    // Prompt caching per host: OpenAI's full set (key + GPT-5.6 options /
    // retention); `prompt_cache_key` on xAI and Meta, plus Meta's 24h retention.
    Object.assign(params, responsesPromptCacheRequestFields(model, host, cacheKey));
    // OpenAI priority processing (premium latency). The route gates fastMode to
    // priority-eligible models, so relaying it straight through is safe.
    // "priority" (Fast) or "ultrafast" (GPT-6.1 Sol / GPT-6 Astra, Responses only).
    const tier = serviceTierFor(fastMode);
    // The SDK's service_tier union predates "ultrafast"; the API accepts it.
    if (tier) params.service_tier = tier as typeof params.service_tier;

    const stream = await c.create(params, { signal });

    const calls: Array<{ callId: string; name: string; args: string }> = [];
    /**
     * Everything this round produced that the NEXT round must see again, in
     * wire order: each reasoning item followed by the function call it led to.
     * Order is the contract — a reasoning item after its own call is rejected.
     */
    const replayItems: InputItem[] = [];
    let roundFinish: string | undefined;

    for await (const event of stream) {
      switch (event.type) {
        case "response.output_text.delta":
          yield { type: "text", text: event.delta };
          break;
        // A part boundary is a FACT the API states, not something to infer from
        // the text later. Counting the announcements is the whole mechanism:
        // each `part.added` opens a step, and every delta until the next one
        // belongs to it.
        case "response.reasoning_summary_part.added":
          summaryPart++;
          break;
        case "response.reasoning_summary_text.delta":
          // Defensive: a delta with no preceding part.added still belongs to a
          // real part, so open one rather than emitting part:-1.
          if (summaryPart < 0) summaryPart = 0;
          yield { type: "reasoning", text: event.delta, part: summaryPart };
          break;
        case "response.output_item.done": {
          const item = event.item as { type: string; call_id?: string; name?: string; arguments?: string };
          // Carries `encrypted_content` thanks to the `include` above.
          if (item.type === "reasoning") {
            replayItems.push((meta ? metaReplayReasoning(event.item as unknown as Record<string, unknown>) : event.item) as unknown as InputItem);
          }
          if (hostedSearch && item.type === "web_search_call") {
            // Reported, never dispatched: the provider ran it inside this response.
            const call = event.item as unknown as Record<string, unknown>;
            const callId = typeof call.id === "string" && call.id ? call.id : `ps_${round}_${webSearchQueries}`;
            const queries = metaSearchQueries(call);
            // Meta lists results (with snippets); OpenAI lists `action.sources`.
            const results = meta ? metaSearchResultSources(call) : actionSourceList(call);
            // Meta bills per query; OpenAI and xAI per search call.
            webSearchQueries += meta ? metaBillableQueries(call) : hostedSearchCallBillable(call) ? 1 : 0;
            yield {
              type: "server_tool",
              phase: "call",
              tool: "provider_web_search",
              callId,
              round,
              ...(queries.length ? { query: queries.join(" · ") } : {}),
            };
            yield {
              type: "server_tool",
              phase: "result",
              tool: "provider_web_search",
              callId,
              round,
              results: results.length,
              ok: call.status !== "failed",
            };
            const fresh = freshSources(results);
            if (fresh.length) yield { type: "sources", sources: fresh, origin: "provider_search" };
          }
          if (hostedSearch && item.type === "message") {
            const fresh = freshSources(urlCitationSources(event.item as unknown as Record<string, unknown>));
            if (fresh.length) yield { type: "sources", sources: fresh, origin: "provider_search" };
          }
          if (item.type === "function_call" && item.call_id && item.name) {
            calls.push({ callId: item.call_id, name: item.name, args: item.arguments ?? "{}" });
            replayItems.push(event.item as unknown as InputItem);
          }
          break;
        }
        case "response.completed":
        case "response.incomplete": {
          const resp = event.response;
          if (xai && hostedSearch) {
            const raw = resp as unknown as Record<string, unknown>;
            const counts = xaiServerToolCounts(raw);
            if (counts.web != null) xaiReportedSearches = (xaiReportedSearches ?? 0) + counts.web;
            if (counts.x != null) xaiReportedXSearches += counts.x;
            const fresh = freshSources(xaiResponseCitations(raw));
            if (fresh.length) yield { type: "sources", sources: fresh, origin: "provider_search" };
          }
          if (resp.usage) {
            sawUsage = true;
            cumInput += resp.usage.input_tokens ?? 0;
            cumOutput += resp.usage.output_tokens ?? 0;
            cumCached += resp.usage.input_tokens_details?.cached_tokens ?? 0;
            // Docs: cache writes are `cache_write_tokens` (GPT-5.6+). Older SDKs
            // sometimes exposed `cache_creation_tokens` — accept both.
            const details = resp.usage as {
              input_tokens_details?: {
                cached_tokens?: number;
                cache_write_tokens?: number;
                cache_creation_tokens?: number;
              };
              output_tokens_details?: { reasoning_tokens?: number };
              total_tokens?: number;
            };
            const writeTok =
              details.input_tokens_details?.cache_write_tokens ??
              details.input_tokens_details?.cache_creation_tokens ??
              0;
            if (writeTok > 0) cumCacheWrite += writeTok;
            const reasoningTok = details.output_tokens_details?.reasoning_tokens ?? 0;
            if (reasoningTok > 0) cumReasoning += reasoningTok;
            if (details.total_tokens != null) cumTotal += details.total_tokens;
          }
          roundFinish =
            event.type === "response.incomplete"
              ? resp.incomplete_details?.reason === "max_output_tokens"
                ? "length"
                : (resp.incomplete_details?.reason ?? "stop")
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
          const ev = event as { message?: string; code?: string };
          throw Object.assign(new Error(ev.message ?? "Responses API stream error."), {
            error: { message: ev.message },
          });
        }
        default:
          break;
      }
    }
    finishRaw = roundFinish;

    if (tools && hasTools && !isFinalRound && calls.length > 0) {
      // The round's own output first — reasoning items and the calls they
      // produced, verbatim and in order — then one output per call below.
      input.push(...replayItems);
      const inputs: ToolCallInput[] = calls.map((call, index) => ({
        name: call.name,
        callId: tools.issueCallId(call.callId, round, index),
        providerCallId: call.callId,
        round,
        index,
        argsText: call.args,
      }));
      for (const call of inputs) {
        // The whole argument JSON is here before the dispatch, so the
        // arguments ride on the CALL.
        yield {
          type: "tool",
          server: toolset!.labelFor(call.name),
          name: call.name,
          phase: "call",
          callId: call.callId,
          args: call.argsText,
          ...(call.providerCallId && call.providerCallId !== call.callId ? { providerCallId: call.providerCallId } : {}),
          round,
          index: call.index,
        };
      }
      const batch = yield* tools.run(inputs, signal, { nextIsFinal: round + 1 === maxRounds - 1 });
      const imageTurns: InputItem[] = [];
      for (const result of batch) {
        // `function_call_output.output` is a string, so pixels follow the
        // outputs as a user turn carrying `input_image` parts — the documented
        // way to show a Responses model an image a function produced.
        const images = sendableToolImages(result.images, model.vision);
        input.push({
          type: "function_call_output",
          call_id: wireCallId(result),
          output: withheldImagesNote(result.text, result.images, images.length),
        } as InputItem);
        if (images.length) {
          imageTurns.push({
            role: "user",
            content: [
              { type: "input_text", text: toolImageIntro(result.name, images) },
              ...images.map((image) => ({
                type: "input_image",
                detail: "high",
                image_url: toDataUrl(image),
              })),
            ],
          } as unknown as InputItem);
        }
      }
      input.push(...imageTurns);
      continue;
    }
    break;
  }

  // xAI's own count, when it gives one, is what it bills.
  if (xaiReportedSearches != null) webSearchQueries = xaiReportedSearches;
  if (sawUsage || webSearchQueries > 0 || xaiReportedXSearches > 0) {
    yield {
      type: "usage",
      input: cumInput,
      output: cumOutput,
      reasoning: cumReasoning || undefined,
      total: cumTotal || undefined,
      cacheRead: cumCached || undefined,
      cacheWrite: cumCacheWrite || undefined,
      // Hosted searches, priced per lab in `toolFeesUsd` (Meta per query,
      // OpenAI and xAI per call). Meta and OpenAI report no counter of their own.
      webSearchRequests: webSearchQueries || undefined,
      xSearchRequests: xaiReportedXSearches || undefined,
    };
  }
  // A trailing tool_calls means even the forced-answer round wanted more tools —
  // surface "length" so the UI warns + offers Continue (same as the compat path).
  const finalRaw = finishRaw === "tool_calls" ? "length" : finishRaw;
  yield { type: "finish", reason: normalizeFinishReason(finalRaw ?? "stop"), raw: finalRaw };
  console.info("[llm:openai-responses] stream finish", {
    model: model.providerModel,
    finishReason: finalRaw ?? "stop",
    promptTokens: sawUsage ? cumInput : null,
    completionTokens: sawUsage ? cumOutput : null,
    reasoningTokens: sawUsage ? cumReasoning || null : null,
    cachedTokens: sawUsage ? cumCached : null,
  });
}
