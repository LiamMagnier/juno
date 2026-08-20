import { pdfAttachmentFallbackNote } from "@/lib/attachment-context";
import { reasoningCaps } from "@/lib/model-metrics";
import type { ModelInfo } from "@/lib/models";
import type { ReasoningEffort } from "@/types/chat";
import type { ClientSource } from "@/types/chat";
import type { MessageForModel } from "@/types/llm";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

export type GeminiPart =
  | { text: string }
  | { thought?: boolean; text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

const BINARY_ATTACHMENT_LOOKBACK = 8;
export const MAX_GEMINI_TOOL_ROUNDS = 6;

export type AttachmentBytesFetcher = (storageKey: string) => Promise<{ bytes: Uint8Array }>;

async function defaultStorageFetcher(storageKey: string): Promise<{ bytes: Uint8Array }> {
  const { getObjectBytes } = await import("@/lib/storage");
  return getObjectBytes(storageKey);
}

/** Convert persisted messages (+ attachments) into Gemini contents payload. */
export async function toGeminiContents(
  history: MessageForModel[],
  vision: boolean,
  fetchBytes: AttachmentBytesFetcher = defaultStorageFetcher
): Promise<GeminiContent[]> {
  const contents: GeminiContent[] = [];
  const binaryFrom = Math.max(
    0,
    Math.floor((history.length - BINARY_ATTACHMENT_LOOKBACK) / BINARY_ATTACHMENT_LOOKBACK) *
      BINARY_ATTACHMENT_LOOKBACK
  );

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role === "SYSTEM") continue;
    const role = msg.role === "ASSISTANT" ? "model" : "user";
    const parts: GeminiPart[] = [];

    if (msg.content.trim()) {
      parts.push({ text: msg.content });
    }

    const embedBinary = i >= binaryFrom;

    for (const att of msg.attachments) {
      try {
        if (att.kind === "IMAGE" && IMAGE_TYPES.includes(att.mimeType)) {
          if (!vision) {
            parts.push({ text: `[Image "${att.fileName}" shared — this model cannot view images.]` });
          } else if (!embedBinary) {
            parts.push({ text: `[Image "${att.fileName}" shared earlier in the conversation.]` });
          } else {
            const { bytes } = await fetchBytes(att.storageKey);
            parts.push({
              inlineData: {
                mimeType: att.mimeType,
                data: Buffer.from(bytes).toString("base64"),
              },
            });
          }
        } else if (att.mimeType === "application/pdf") {
          if (!embedBinary && att.extractedText) {
            parts.push({
              text: `Attached file "${att.fileName}" (shared earlier):\n\n${att.extractedText.slice(0, 100_000)}`,
            });
          } else if (!embedBinary) {
            parts.push({ text: `[PDF "${att.fileName}" shared earlier in the conversation.]` });
          } else {
            const { bytes } = await fetchBytes(att.storageKey);
            parts.push({
              inlineData: {
                mimeType: "application/pdf",
                data: Buffer.from(bytes).toString("base64"),
              },
            });
          }
        } else if (att.extractedText) {
          parts.push({
            text: `Attached file "${att.fileName}":\n\n${att.extractedText.slice(0, 100_000)}`,
          });
        } else {
          const note =
            att.mimeType === "application/pdf"
              ? ` ${pdfAttachmentFallbackNote(att.parserState)}`
              : att.kind === "IMAGE" && !vision
              ? " This model cannot view images."
              : " This attachment has no extracted text.";
          parts.push({ text: `[Attached file "${att.fileName}" (${att.mimeType}).${note}]` });
        }
      } catch {
        parts.push({ text: `[Attachment "${att.fileName}" could not be loaded.]` });
      }
    }

    if (parts.length === 0) {
      parts.push({ text: "(no content)" });
    }
    contents.push({ role, parts });
  }

  return contents;
}

const GROUNDING_REDIRECT = /^https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//i;

/** Resolve Gemini vertex search redirects to final publisher URLs. */
export async function resolveGroundingUrls(list: ClientSource[]): Promise<ClientSource[]> {
  const needsResolving = list.some((s) => GROUNDING_REDIRECT.test(s.url));
  if (!needsResolving) return list;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6_000);
  try {
    return await Promise.all(
      list.map(async (s) => {
        if (!GROUNDING_REDIRECT.test(s.url)) return s;
        try {
          const res = await fetch(s.url, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
          const finalUrl = res.url;
          if (!finalUrl || GROUNDING_REDIRECT.test(finalUrl)) return s;
          return { ...s, url: finalUrl };
        } catch {
          return s;
        }
      })
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Map reasoning effort to Gemini thinkingBudget tokens. */
export function geminiThinkingBudget(
  model: ModelInfo,
  effort?: ReasoningEffort | null
): number | undefined {
  if (!model.reasoning) return undefined;
  const caps = reasoningCaps(model);
  if (!effort) {
    if (caps.canDisable) return 0;
    return undefined;
  }
  switch (effort) {
    case "minimal":
      return 1024;
    case "low":
      return 2048;
    case "medium":
      return 8192;
    case "high":
      return 16384;
    case "xhigh":
      return 24576;
    case "max":
      return 32768;
    default:
      return undefined;
  }
}
