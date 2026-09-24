import "server-only";
import OpenAI from "openai";
import { getObjectBytes } from "@/lib/storage";
import { providerApiKey, providerBaseUrl, PROVIDERS, type Provider } from "@/lib/providers";
import { getModelMetrics } from "@/lib/model-metrics";
import { openAISystemMessage } from "@/lib/openai-prompt-cache";
import type { ModelInfo } from "@/lib/models";
import type { ReasoningEffort } from "@/types/chat";
import type { LlmEvent, MessageForModel } from "@/types/llm";
import type { McpToolset } from "@/lib/mcp";
import { attachedFileText, pdfAttachmentFallbackNote } from "@/lib/attachment-context";
import { attachmentTextBudget } from "@/lib/knowledge/document-text";
import { canInlineDocument, isPdfAttachment } from "@/lib/attachment-bytes";
import { createLoopController } from "@/lib/llm/loop";
import {
  compatHistoryAssistantMessage,
  compatOffersTools,
  runCompatLoop,
  type CompatMessage,
} from "@/lib/llm/compat-loop";
import type { AdapterRequest, ProviderTransport } from "@/lib/llm/types";

/**
 * The OpenAI-compatible adapter: every Chat Completions lab (SPEC §5.4), and
 * any OpenAI or xAI model a deployment keeps off Responses.
 *
 * This module turns the conversation into messages (attachment bytes come
 * from storage) and wires in the SDK client; the loop itself lives in
 * `llm/compat-loop.ts`, free of `server-only`, so it can be driven offline.
 */

const clients = new Map<Provider, OpenAI>();

function client(provider: Provider): OpenAI {
  const apiKey = providerApiKey(provider);
  if (!apiKey) throw new Error(`${PROVIDERS[provider].label} API key is not configured.`);
  let c = clients.get(provider);
  if (!c) {
    // Do not let the SDK replay a billable request behind the accounting
    // boundary. A streamed request can have consumed tokens before a
    // transport error is observed, and an invisible retry would either charge
    // twice or make the usage ledger under-report. Work retries at a higher
    // level where the attempt gets a new idempotency key and an explicit
    // provider/model attribution.
    c = new OpenAI({ apiKey, baseURL: providerBaseUrl(provider), maxRetries: 0 });
    clients.set(provider, c);
  }
  return c;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

// Only the most recent messages re-embed full images; older ones become a text
// placeholder so a long chat doesn't re-upload megabytes every turn (kept in
// sync with the Anthropic adapter's lookback).
const BINARY_ATTACHMENT_LOOKBACK = 8;

async function toOpenAIMessages(
  system: string,
  history: MessageForModel[],
  vision: boolean,
  model: ModelInfo,
  /** Whether the turn offers tools: DeepSeek then wants every earlier turn's reasoning. */
  toolsOffered: boolean
): Promise<CompatMessage[]> {
  // OpenAI GPT-5.6+: system as structured text with an explicit cache breakpoint
  // so the static instructions stay a warm prefix (docs: prompt-caching).
  const systemMsg = model.provider === "openai" ? openAISystemMessage(model, system) : { role: "system" as const, content: system };
  const out: CompatMessage[] = [systemMsg];
  // Anchored to LOOKBACK-sized blocks (not a per-turn slide) so image →
  // placeholder rewrites only move the cacheable-prefix boundary once per
  // block, keeping provider prompt caches warm between steps.
  const binaryFrom = Math.max(
    0,
    Math.floor((history.length - BINARY_ATTACHMENT_LOOKBACK) / BINARY_ATTACHMENT_LOOKBACK) * BINARY_ATTACHMENT_LOOKBACK
  );
  // What one attachment may spend, derived from this model's own window —
  // never a constant, for the reason attachmentTextBudget's header gives.
  const textBudget = attachmentTextBudget(getModelMetrics(model).contextTokens);

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role === "SYSTEM") continue;
    if (msg.role === "ASSISTANT") {
      out.push(compatHistoryAssistantMessage(msg, model, toolsOffered));
      continue;
    }

    if (msg.attachments.length === 0) {
      out.push({ role: "user", content: msg.content || "(no content)" });
      continue;
    }

    const embedBinary = i >= binaryFrom;
    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    if (msg.content.trim()) parts.push({ type: "text", text: msg.content });

    for (const att of msg.attachments) {
      try {
        if (att.kind === "IMAGE" && IMAGE_TYPES.includes(att.mimeType) && vision && embedBinary) {
          const { bytes } = await getObjectBytes(att.storageKey);
          parts.push({
            type: "image_url",
            image_url: { url: `data:${att.mimeType};base64,${Buffer.from(bytes).toString("base64")}` },
          });
        } else if (att.kind === "IMAGE" && IMAGE_TYPES.includes(att.mimeType) && vision && !embedBinary) {
          parts.push({ type: "text", text: `[Image "${att.fileName}" shared earlier in the conversation.]` });
        } else if (isPdfAttachment(att) && !att.extractedText && vision && embedBinary) {
          /*
           * THE ONE PLACE LOCAL RASTERISATION IS THE RIGHT ANSWER.
           *
           * These are the OpenAI-compatible gateways — xAI, Mistral, DeepSeek,
           * Moonshot and the rest. They are vision-capable but implement only
           * `image_url`: no document part exists, so unlike Anthropic, Gemini
           * and the Responses API there is no way to hand them the PDF and let
           * them rasterise it themselves. A scanned document reached them as a
           * bracketed apology and nothing else.
           *
           * Gated on `!att.extractedText` deliberately: when the text layer
           * read, the text is cheaper, exact, and complete, and pictures of
           * the pages would be paying several times over for a worse copy.
           * This runs only for the file that has no text at all — which is
           * precisely the scan that used to be unreadable here.
           */
          const { bytes } = await getObjectBytes(att.storageKey);
          const { renderDocumentPages } = await import("@/lib/media/raster");
          const pages = canInlineDocument(bytes.byteLength)
            ? await renderDocumentPages({ bytes, maxPages: 4 })
            : [];
          if (pages.length) {
            parts.push({
              type: "text",
              text: `[The PDF "${att.fileName}" has no text layer, so the first ${pages.length} page${pages.length === 1 ? "" : "s"} follow as images. Read them as the document itself. Use read_document or inspect_image for anything beyond them.]`,
            });
            for (const page of pages) {
              parts.push({
                type: "image_url",
                image_url: { url: `data:${page.mimeType};base64,${Buffer.from(page.bytes).toString("base64")}` },
              });
            }
          } else {
            parts.push({
              type: "text",
              text: `[Attached file "${att.fileName}" (${att.mimeType}) — ${pdfAttachmentFallbackNote(att.parserState)}]`,
            });
          }
        } else if (att.extractedText) {
          parts.push({ type: "text", text: attachedFileText(att.fileName, att.extractedText, { maxChars: textBudget }) });
        } else {
          const note = att.mimeType === "application/pdf"
            ? ` — ${pdfAttachmentFallbackNote(att.parserState)}`
            : att.kind === "IMAGE" && !vision
            ? " — this model cannot view images"
            : "";
          parts.push({ type: "text", text: `[Attached file "${att.fileName}" (${att.mimeType})${note}.]` });
        }
      } catch {
        parts.push({ type: "text", text: `[Attachment "${att.fileName}" could not be loaded.]` });
      }
    }

    out.push({ role: "user", content: parts });
  }

  return out;
}

/**
 * The SDK as a `ProviderTransport`: the request body in, the stream's chunks out.
 *
 * xAI routes requests of one conversation to one prompt cache through the
 * `x-grok-conv-id` header; its Chat Completions surface has no body field for it.
 */
function sdkTransport(model: ModelInfo, cacheKey: string | undefined): ProviderTransport {
  const c = client(model.provider);
  const headers = model.provider === "xai" && cacheKey ? { "x-grok-conv-id": cacheKey } : undefined;
  return {
    async *request(body, signal) {
      const stream = await c.chat.completions.create(
        body as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        { signal, headers }
      );
      yield* stream;
    },
  };
}

/** Legacy positional calls get today's six tool rounds and the forced final request. */
const LEGACY_TOOL_BUDGET = 7;

function isAdapterRequest(value: unknown): value is AdapterRequest {
  return !!value && typeof value === "object" && "loop" in value && "history" in value && "model" in value;
}

/**
 * Stream one turn from an OpenAI-compatible provider.
 *
 * Takes one `AdapterRequest` (SPEC §5.0). The positional form is the
 * deprecated one `streamChat` still calls until its caller passes a toolset
 * (WS9a): its `McpToolset` runs through the legacy tool runner, on today's
 * budget of six tool rounds and a forced final request. `webSearch` means
 * provider-native search, which no compat lab has on this transport (SPEC
 * §5.4 item 9), so it is accepted and not read.
 */
export function streamOpenAICompat(req: AdapterRequest): AsyncGenerator<LlmEvent>;
/** @deprecated Pass one `AdapterRequest` (SPEC §5.0). */
export function streamOpenAICompat(
  model: ModelInfo,
  system: string,
  history: MessageForModel[],
  maxTokens: number,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort,
  webSearch?: boolean,
  toolset?: McpToolset,
  dynamicContext?: string,
  cacheKey?: string,
  fastMode?: boolean
): AsyncGenerator<LlmEvent>;
export async function* streamOpenAICompat(
  first: AdapterRequest | ModelInfo,
  system?: string,
  history?: MessageForModel[],
  maxTokens?: number,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort,
  webSearch?: boolean,
  toolset?: McpToolset,
  dynamicContext?: string,
  cacheKey?: string,
  fastMode?: boolean
): AsyncGenerator<LlmEvent> {
  let req: AdapterRequest;
  let legacyToolset: McpToolset | undefined;
  if (isAdapterRequest(first)) {
    req = first;
  } else {
    legacyToolset = toolset;
    const hasTools = !!toolset && toolset.tools.length > 0;
    req = {
      model: first,
      system: system ?? "",
      history: history ?? [],
      maxTokens: maxTokens ?? 0,
      signal,
      reasoningEffort,
      webSearch: !!webSearch,
      dynamicContext,
      cacheKey,
      fastMode,
      loop: createLoopController({ budget: hasTools ? LEGACY_TOOL_BUDGET : 1 }),
    };
  }

  const messages = await toOpenAIMessages(
    req.system,
    req.history,
    req.model.vision,
    req.model,
    compatOffersTools(req, legacyToolset)
  );
  yield* runCompatLoop({
    req,
    messages,
    transport: req.transport ?? sdkTransport(req.model, req.cacheKey),
    legacyToolset,
    log: (event, data) => console.info(`[llm:openai-compat] stream ${event}`, data),
  });
}
