import { attachedFileText, pdfAttachmentFallbackNote } from "@/lib/attachment-context";
import { clampReasoningEffort, reasoningCaps } from "@/lib/model-metrics";
import { googleNativeBaseUrl, normalizeProviderKey, providerApiKey } from "@/lib/providers";
import type { ModelInfo } from "@/lib/models";
import type { ReasoningEffort } from "@/types/chat";
import type { ClientSource } from "@/types/chat";
import type { MessageForModel } from "@/types/llm";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/**
 * `thoughtSignature` is an opaque token Gemini 3 returns on the parts it
 * reasoned with (always on a `functionCall`, sometimes on text). It has to be
 * echoed back VERBATIM in history or the next request fails with
 * `400 INVALID_ARGUMENT … missing thought_signature`. The union could not even
 * represent the field before, so the tool loop dropped it on every replay.
 */
export type GeminiPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
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
            parts.push({ text: attachedFileText(att.fileName, att.extractedText, { sharedEarlier: true }) });
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
          parts.push({ text: attachedFileText(att.fileName, att.extractedText) });
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

export type GeminiThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

export type GeminiThinkingConfig =
  | { includeThoughts: true; thinkingLevel: GeminiThinkingLevel }
  | { includeThoughts: true; thinkingBudget: number }
  | { includeThoughts: true };

/** Gemini 3+ speaks `thinkingLevel`; 2.5 and earlier speak `thinkingBudget`. */
export function isGemini3OrLater(model: Pick<ModelInfo, "providerModel">): boolean {
  const providerModel = model.providerModel.replace(/^models\//, "");
  const match = /^gemini-(\d+)(?:[.\-]|$)/.exec(providerModel);
  return match !== null && Number(match[1]) >= 3;
}

/**
 * Map one clamped tier onto the level Google spells it with.
 *
 * Only tiers a model's `reasoningCaps` declares can arrive here —
 * `clampReasoningEffort` already reduces anything else to that model's declared
 * default — so the catalog stays the single per-model source of truth about
 * which levels exist. `xhigh`/`max` are not Gemini levels at all and collapse
 * to the deepest one that is.
 */
function geminiLevelFor(tier: Exclude<ReasoningEffort, null>): GeminiThinkingLevel {
  switch (tier) {
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    default:
      return "HIGH";
  }
}

/** The provider-native Gemini thinking object for Juno's GenerateContent path. */
export function geminiThinkingConfig(
  model: ModelInfo,
  effort?: ReasoningEffort | null,
): GeminiThinkingConfig | undefined {
  if (!model.reasoning) return undefined;
  const clamped = clampReasoningEffort(model, effort ?? null);

  // Gemini 3+ accepts provider-native thinking levels. Sending the legacy
  // token budget to these models can end a stream after thought tokens without
  // a final answer. Thought parts are omitted unless includeThoughts is true.
  if (isGemini3OrLater(model)) {
    // NO TIER MEANS NO TIER. The old `else` branch turned every unmapped value
    // — including `null`, i.e. "the catalog declares no ladder for this id" —
    // into MEDIUM, which (a) defeated the deliberate fail-closed
    // `caps([], false)` for discovered Gemini models (model-metrics.ts) and
    // (b) sent MEDIUM to ids that only accept low|high (Gemini 3 Pro answers
    // `400 INVALID_ARGUMENT Thinking level MEDIUM is not supported for this
    // model`). Omitting the level asks Google for its own per-model default,
    // which is the only correct request for "no preference".
    if (!clamped) return { includeThoughts: true };
    return { includeThoughts: true, thinkingLevel: geminiLevelFor(clamped) };
  }

  const thinkingBudget = geminiThinkingBudget(model, clamped);
  return thinkingBudget === undefined ? { includeThoughts: true } : { includeThoughts: true, thinkingBudget };
}

/**
 * Build the native GenerateContent configuration in one place. Gemini 3.x
 * rejects legacy sampling knobs and token budgets that older adapters often
 * sent by default, so keep its payload deliberately small and provider-native.
 */
export function geminiGenerationConfig(
  model: ModelInfo,
  maxOutputTokens: number,
  effort?: ReasoningEffort | null,
): Record<string, unknown> {
  const config: Record<string, unknown> = { maxOutputTokens };
  const thinkingConfig = geminiThinkingConfig(model, effort);
  if (thinkingConfig !== undefined) config.thinkingConfig = thinkingConfig;
  return config;
}

/** `models/<id>`, the path segment Google's REST surface addresses a model by. */
export function geminiModelPath(model: Pick<ModelInfo, "providerModel">): string {
  return model.providerModel.startsWith("models/") ? model.providerModel : `models/${model.providerModel}`;
}

/**
 * The native endpoint for one Gemini method.
 *
 * Built from `googleNativeBaseUrl()` rather than a hardcoded host so a regional
 * or proxied deployment cannot end up probing one host and chatting with
 * another — which is exactly what `GOOGLE_BASE_URL` did while the health probe,
 * discovery and the capability probe read it and this adapter did not.
 */
export function geminiEndpoint(
  model: Pick<ModelInfo, "providerModel">,
  method: "streamGenerateContent" | "generateContent",
  baseUrl: string = googleNativeBaseUrl(),
): string {
  const base = baseUrl.replace(/\/+$/, "");
  const query = method === "streamGenerateContent" ? "?alt=sse" : "";
  return `${base}/${geminiModelPath(model)}:${method}${query}`;
}

export type GeminiTool =
  | { functionDeclarations: Array<Record<string, unknown>> }
  | { google_search: Record<string, never> };

/**
 * Which tools ride on one request.
 *
 * Two bugs lived here. (1) `tools` used to be gated on `!isFinalRound`, and a
 * turn with no function tools runs exactly ONE round — which is the final one —
 * so `{google_search:{}}` was never sent at all on the private-chat, memory,
 * scheduled-task and preflight paths, while the UI announced "Google Search
 * grounding" for a search that never happened. Rounds are for the FUNCTION-CALL
 * loop; a server-side tool resolves inside a single request and belongs on
 * every round. (2) Gemini 3 supports combining built-in tools with function
 * declarations; Gemini 2.5 and earlier reject the combination outright
 * ("doesn't support combining search tools with non-search tools in the same
 * generateContent request"), and `gemini-2.5-pro` is still selectable. On that
 * older line grounding wins, because the user asked for search explicitly.
 */
export function geminiToolsPayload(input: {
  model: Pick<ModelInfo, "providerModel">;
  functionDeclarations?: Array<Record<string, unknown>>;
  webSearch?: boolean;
  /** The forced-answer round: function declarations are withheld, search is not. */
  isFinalRound?: boolean;
}): GeminiTool[] {
  const declarations = input.isFinalRound ? [] : input.functionDeclarations ?? [];
  const functionTools: GeminiTool[] = declarations.length > 0 ? [{ functionDeclarations: declarations }] : [];
  const searchTools: GeminiTool[] = input.webSearch ? [{ google_search: {} }] : [];
  if (functionTools.length === 0 || searchTools.length === 0) return [...functionTools, ...searchTools];
  return isGemini3OrLater(input.model) ? [...functionTools, ...searchTools] : searchTools;
}

/** The exact JSON body the native adapter POSTs. Pure, so a test can pin it. */
export function geminiRequestBody(input: {
  contents: GeminiContent[];
  generationConfig: Record<string, unknown>;
  system?: string;
  tools?: GeminiTool[];
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: input.contents,
    generationConfig: input.generationConfig,
  };
  if (input.system?.trim()) body.systemInstruction = { parts: [{ text: input.system }] };
  if (input.tools && input.tools.length > 0) body.tools = input.tools;
  return body;
}

/**
 * Every Google credential this deployment knows, most-canonical first.
 *
 * EVERY candidate is normalised the way `providers.ts` normalises the primary
 * one (trim, strip one layer of quotes, drop CR/LF). Reading the aliases raw
 * from `process.env` produced a SECOND, malformed variant of the same key that
 * `new Set` could not collapse — and `gemini-network.ts` rotates keys on an
 * auth failure, so a key stored with its quotes gave Juno two "different"
 * credentials, one of which could only ever 401.
 */
export function getGoogleApiKeys(): string[] {
  const candidates = [
    providerApiKey("google"),
    normalizeProviderKey(process.env.GOOGLE_API_KEY),
    normalizeProviderKey(process.env.GEMINI_LIVE_API_KEY),
    normalizeProviderKey(process.env.GEMINI_API_KEY),
  ].filter((k): k is string => typeof k === "string" && k.length > 0);
  return [...new Set(candidates)];
}
