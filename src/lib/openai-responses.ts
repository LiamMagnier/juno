import "server-only";
import OpenAI from "openai";
import { getObjectBytes } from "@/lib/storage";
import { providerApiKey, providerBaseUrl, PROVIDERS, type Provider } from "@/lib/providers";
import { getModelMetrics } from "@/lib/model-metrics";
import type { ModelInfo } from "@/lib/models";
import type { ReasoningEffort } from "@/types/chat";
import type { LlmEvent, MessageForModel } from "@/types/llm";
import type { McpToolset } from "@/lib/mcp";
import { attachedFileText, pdfAttachmentFallbackNote } from "@/lib/attachment-context";
import { attachmentTextBudget } from "@/lib/knowledge/document-text";
import {
  canInlineDocument,
  isPdfAttachment,
  oversizeDocumentNote,
  providerReceivesDocumentBytes,
} from "@/lib/attachment-bytes";
import { createLoopController } from "@/lib/llm/loop";
import {
  runResponsesLoop,
  type ResponsesDialect,
  type ResponsesInputItem,
} from "@/lib/llm/responses-loop";
import type { AdapterRequest, ProviderTransport } from "@/lib/llm/types";

/**
 * The Responses API adapter — every OpenAI model, and Grok on xAI's Responses
 * surface (SPEC §5.2, §5.5).
 *
 * It was the adapter for the models that are not served on /chat/completions
 * at all (the gpt-*-pro line and Responses-only Codex snapshots). It is the
 * adapter for every OpenAI model now: GPT-6 and the GPT-5.6 line cannot call
 * tools on /chat/completions at any real effort, and the hosted web search,
 * `phase` and encrypted reasoning replay exist only here. Grok moved for the
 * same reason search did: xAI's server-side tools live only on Responses.
 *
 * This module turns the conversation into input items (attachment bytes come
 * from storage) and wires in the SDK client; the loop itself lives in
 * `llm/responses-loop.ts`, free of `server-only`, so it can be driven offline.
 */

const clients = new Map<Provider, OpenAI>();

function client(provider: Provider): OpenAI {
  const apiKey = providerApiKey(provider);
  if (!apiKey) throw new Error(`${PROVIDERS[provider].label} API key is not configured.`);
  let c = clients.get(provider);
  if (!c) {
    // SDK retries are disabled so a partially consumed paid response cannot be
    // replayed without a new, explicitly metered attempt.
    c = new OpenAI({ apiKey, baseURL: providerBaseUrl(provider), maxRetries: 0 });
    clients.set(provider, c);
  }
  return c;
}

/**
 * The SDK as a `ProviderTransport`: the request body in, the stream's events out.
 *
 * xAI routes requests of one conversation to one prompt cache through the
 * `x-grok-conv-id` header; it has no body field for it.
 */
function sdkTransport(dialect: ResponsesDialect, cacheKey: string | undefined): ProviderTransport {
  const c = client(dialect === "xai" ? "xai" : "openai");
  const headers = dialect === "xai" && cacheKey ? { "x-grok-conv-id": cacheKey } : undefined;
  return {
    async *request(body, signal) {
      const stream = await c.responses.create(body as OpenAI.Responses.ResponseCreateParamsStreaming, {
        signal,
        headers,
      });
      yield* stream;
    },
  };
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const BINARY_ATTACHMENT_LOOKBACK = 8; // kept in sync with the compat/Anthropic adapters

async function toResponsesInput(
  history: MessageForModel[],
  model: ModelInfo,
  /** Per-file text ceiling, from the model's own context window. */
  attachmentTextMaxChars?: number
): Promise<ResponsesInputItem[]> {
  const vision = model.vision;
  const out: ResponsesInputItem[] = [];
  // Whether this surface takes a PDF as `input_file`: OpenAI does, xAI has not
  // been shown to (attachment-bytes.ts).
  const documentBytes = providerReceivesDocumentBytes(model);
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
      });
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
           * layer. The text still rides along when extraction produced any,
           * because a text layer is cheaper and more exact than reading a
           * rendering of it, and the two together are what the providers do
           * internally.
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
        } else if (isPdfAttachment(att) && !att.extractedText && vision && embedBinary) {
          // xAI: no document part, so a PDF with no text layer — a scan — goes
          // as its first pages rendered to images, as it did on compat.
          const { bytes } = await getObjectBytes(att.storageKey);
          const { renderDocumentPages } = await import("@/lib/media/raster");
          const pages = canInlineDocument(bytes.byteLength) ? await renderDocumentPages({ bytes, maxPages: 4 }) : [];
          if (pages.length) {
            parts.push({
              type: "input_text",
              text: `[The PDF "${att.fileName}" has no text layer, so the first ${pages.length} page${pages.length === 1 ? "" : "s"} follow as images. Read them as the document itself. Use read_document or inspect_image for anything beyond them.]`,
            });
            for (const page of pages) {
              parts.push({
                type: "input_image",
                detail: "auto",
                image_url: `data:${page.mimeType};base64,${Buffer.from(page.bytes).toString("base64")}`,
              });
            }
          } else {
            parts.push({
              type: "input_text",
              text: `[Attached file "${att.fileName}" (${att.mimeType}) — ${pdfAttachmentFallbackNote(att.parserState)}]`,
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

    out.push({ role: "user", content: parts });
  }

  return out;
}

/** Legacy positional calls get today's six tool rounds and the forced final request. */
const LEGACY_TOOL_BUDGET = 7;

function isAdapterRequest(value: unknown): value is AdapterRequest {
  return !!value && typeof value === "object" && "loop" in value && "history" in value && "model" in value;
}

/**
 * Stream one turn through the Responses API.
 *
 * Takes one `AdapterRequest` (SPEC §5.0). The positional form is the
 * deprecated one `streamChat` still calls until its caller passes a toolset
 * (WS9a): its `McpToolset` runs through the legacy tool runner, on today's
 * budget of six tool rounds and a forced final request.
 */
export function streamOpenAIResponses(req: AdapterRequest): AsyncGenerator<LlmEvent>;
/** @deprecated Pass one `AdapterRequest` (SPEC §5.0). */
export function streamOpenAIResponses(
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
  fastMode?: boolean,
  proMode?: boolean
): AsyncGenerator<LlmEvent>;
export async function* streamOpenAIResponses(
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
  fastMode?: boolean,
  proMode?: boolean
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
      proMode,
      loop: createLoopController({ budget: hasTools ? LEGACY_TOOL_BUDGET : 1 }),
    };
  }

  const dialect: ResponsesDialect = req.model.provider === "xai" ? "xai" : "openai";
  const historyItems = await toResponsesInput(
    req.history,
    req.model,
    attachmentTextBudget(getModelMetrics(req.model).contextTokens)
  );
  yield* runResponsesLoop({
    req,
    dialect,
    history: historyItems,
    transport: req.transport ?? sdkTransport(dialect, req.cacheKey),
    legacyToolset,
    log: (event, data) => console.info(`[llm:${dialect}-responses] stream ${event}`, data),
  });
}
