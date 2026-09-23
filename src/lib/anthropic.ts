import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { attachedFileText } from "@/lib/attachment-context";
import { attachmentTextBudget } from "@/lib/knowledge/document-text";
import { getModelMetrics } from "@/lib/model-metrics";
import { canInlineDocument, isPdfAttachment, oversizeDocumentNote } from "@/lib/attachment-bytes";
import { env } from "@/lib/env";
import { anthropicLoop } from "@/lib/llm/anthropic-loop";
import type { AdapterRequest, ProviderTransport } from "@/lib/llm/types";
import { providerApiKey } from "@/lib/providers";
import { getObjectBytes } from "@/lib/storage";
import type { LlmEvent, MessageForModel } from "@/types/llm";

export {
  anthropicThinkingKind,
  buildAnthropicThinkingBits,
  type AnthropicThinkingKind,
} from "@/lib/anthropic-thinking";

let anthropic: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  // The SDK must not replay a paid request behind Juno's accounting boundary.
  // A streamed request may have consumed tokens before a transport error is
  // observed; retrying invisibly would duplicate spend or make the ledger lie.
  // The caller may start an explicit, separately metered attempt instead.
  //
  // The key goes through providerApiKey() rather than env.anthropicApiKey so it
  // gets the same normalization every other provider's key gets (trim, strip one
  // layer of surrounding quotes, drop stray CR/LF — see providers.ts readEnv).
  // env.anthropicApiKey is a raw process.env read, so a key pasted with quotes
  // or a trailing newline used to 401 here while reading as configured
  // everywhere else — and would make the health probe disagree with live
  // traffic, which is the one thing a probe must never do.
  if (!anthropic) {
    anthropic = new Anthropic({
      apiKey: providerApiKey("anthropic") ?? env.anthropicApiKey,
      maxRetries: 0,
    });
  }
  return anthropic;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

// Large binary attachments (images / PDFs) are only re-embedded for the most
// recent slice of the conversation. Older ones become a lightweight text
// placeholder so a long chat doesn't re-upload megabytes — and blow the context
// window — on every turn. Extracted document text (cheap) is always kept.
const BINARY_ATTACHMENT_LOOKBACK = 8;

export {
  buildSystemPrompt,
  buildSystemPromptSections,
  type SystemPromptOptions,
} from "@/lib/chat/system-prompt";

/** Per-request dynamic context (currently the date). Kept OUT of the cached
 *  prefix: each adapter appends it after its stable region. */
export function buildDynamicContext(): string {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return `Today is ${today}.`;
}

/** Convert persisted messages (+ their attachments) into Anthropic message params. */
export async function toAnthropicMessages(
  messages: MessageForModel[],
  /** Per-file text ceiling, from the model's own context window. */
  attachmentTextMaxChars?: number
): Promise<Anthropic.MessageParam[]> {
  const result: Anthropic.MessageParam[] = [];
  // Only the last few messages re-embed heavy binaries; older ones are
  // summarized. Block-anchored (see openai-compat.ts): aging images out
  // one-per-turn would move the cache_control-stable prefix every request.
  const binaryFrom = Math.max(
    0,
    Math.floor((messages.length - BINARY_ATTACHMENT_LOOKBACK) / BINARY_ATTACHMENT_LOOKBACK) * BINARY_ATTACHMENT_LOOKBACK
  );

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "SYSTEM") continue;
    const role = msg.role === "ASSISTANT" ? "assistant" : "user";

    if (role === "assistant" || msg.attachments.length === 0) {
      result.push({ role, content: msg.content || "(no content)" });
      continue;
    }

    const embedBinary = i >= binaryFrom;

    // User message with attachments → multimodal content blocks.
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (msg.content.trim()) blocks.push({ type: "text", text: msg.content });

    for (const att of msg.attachments) {
      try {
        if (att.kind === "IMAGE" && IMAGE_TYPES.includes(att.mimeType)) {
          if (!embedBinary) {
            blocks.push({ type: "text", text: `[Image "${att.fileName}" shared earlier in the conversation.]` });
          } else {
            const { bytes } = await getObjectBytes(att.storageKey);
            blocks.push({
              type: "image",
              source: {
                type: "base64",
                media_type: att.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                data: Buffer.from(bytes).toString("base64"),
              },
            });
          }
        } else if (isPdfAttachment(att)) {
          if (!embedBinary && att.extractedText) {
            blocks.push({ type: "text", text: attachedFileText(att.fileName, att.extractedText, { sharedEarlier: true, maxChars: attachmentTextMaxChars }) });
          } else if (!embedBinary) {
            blocks.push({ type: "text", text: `[PDF "${att.fileName}" shared earlier in the conversation.]` });
          } else {
            const { bytes } = await getObjectBytes(att.storageKey);
            // Base64 adds a third: a 40 MB PDF becomes ~53 MB of body and the
            // provider rejects the whole TURN, so the person loses the answer
            // and not merely the attachment. None of the four adapters used to
            // check.
            if (canInlineDocument(bytes.byteLength)) {
              blocks.push({
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: Buffer.from(bytes).toString("base64") },
              });
            } else {
              if (att.extractedText) {
                blocks.push({ type: "text", text: attachedFileText(att.fileName, att.extractedText, { maxChars: attachmentTextMaxChars }) });
              }
              blocks.push({ type: "text", text: oversizeDocumentNote(att.fileName, bytes.byteLength, !!att.extractedText) });
            }
          }
        } else if (att.extractedText) {
          blocks.push({ type: "text", text: attachedFileText(att.fileName, att.extractedText, { maxChars: attachmentTextMaxChars }) });
        } else {
          blocks.push({ type: "text", text: `[Attached file "${att.fileName}" (${att.mimeType}) — content not readable.]` });
        }
      } catch {
        blocks.push({ type: "text", text: `[Attachment "${att.fileName}" could not be loaded.]` });
      }
    }

    result.push({ role, content: blocks.length ? blocks : msg.content || "(no content)" });
  }

  return result;
}

/**
 * The SDK as the loop's transport: one streamed Messages request per call.
 *
 * `speed: "fast"` in the body is the loop asking for fast mode, which rides
 * behind the research-preview beta header. The first `next()` is where an HTTP
 * error surfaces, which is where the loop's fast-mode fallback listens for it.
 */
function sdkTransport(): ProviderTransport {
  return {
    async *request(body, signal) {
      const params = body as Anthropic.Messages.MessageCreateParamsStreaming & { speed?: string };
      const fast = params.speed === "fast";
      const stream = await getAnthropic().messages.create(params, {
        signal,
        ...(fast ? { headers: { "anthropic-beta": "fast-mode-2026-02-01" } } : {}),
      });
      yield* stream;
    },
  };
}

/**
 * Claude, through the shared loop (SPEC §5.0, §5.1). This module wires the
 * real client and the history conversion — which reads attachment bytes from
 * storage — into `anthropicLoop`, where everything that is sent is decided.
 */
export async function* streamAnthropic(req: AdapterRequest): AsyncGenerator<LlmEvent> {
  const messages = await toAnthropicMessages(req.history, attachmentTextBudget(getModelMetrics(req.model).contextTokens));
  yield* anthropicLoop(req, {
    transport: req.transport ?? sdkTransport(),
    messages,
    zdr: process.env.ANTHROPIC_ZDR === "1",
  });
}
