import "server-only";
import { normalizeFinishReason } from "@/lib/finish-reason";
import { getObjectBytes } from "@/lib/storage";
import { providerApiKey } from "@/lib/providers";
import type { ModelInfo } from "@/lib/models";
import type { LlmEvent, MessageForModel } from "@/types/llm";
import type { ClientSource } from "@/types/chat";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

async function toGeminiContents(history: MessageForModel[], vision: boolean): Promise<GeminiContent[]> {
  const contents: GeminiContent[] = [];
  for (const msg of history) {
    if (msg.role === "SYSTEM") continue;
    const role = msg.role === "ASSISTANT" ? "model" : "user";
    const parts: GeminiPart[] = [];
    if (msg.content.trim()) parts.push({ text: msg.content });
    for (const att of msg.attachments) {
      try {
        if (att.kind === "IMAGE" && IMAGE_TYPES.includes(att.mimeType) && vision) {
          const { bytes } = await getObjectBytes(att.storageKey);
          parts.push({ inlineData: { mimeType: att.mimeType, data: Buffer.from(bytes).toString("base64") } });
        } else if (att.extractedText) {
          parts.push({ text: `Attached file "${att.fileName}":\n\n${att.extractedText.slice(0, 100_000)}` });
        }
      } catch {
        /* skip unreadable attachment */
      }
    }
    if (parts.length === 0) parts.push({ text: "(no content)" });
    contents.push({ role, parts });
  }
  return contents;
}

/** Gemini with native Google Search grounding (real-time web results + citations). */
/** Gemini hands back `vertexaisearch.cloud.google.com/grounding-api-redirect/…`. */
const GROUNDING_REDIRECT = /^https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//i;

/**
 * Replace Gemini's grounding redirects with the publisher URLs they point at.
 *
 * Left raw, every source shares one host, which breaks three things at once: the
 * UI dedupes sources BY HOST, so a dozen distinct publishers collapse into a
 * single "google.com" entry; favicons resolve from the source's own origin, so
 * every citation shows Google's logo instead of the publisher's; and the favicon
 * fetch — meant to stay same-origin with a site the reader is already visiting —
 * would instead ping Google on every render, which is exactly the third-party
 * leak the same-origin design exists to avoid.
 *
 * Resolved SERVER-side (the user's browser never touches the redirect), in
 * parallel, time-boxed, and best-effort: a redirect that won't resolve keeps its
 * original URL, which still works when clicked.
 */
async function resolveGroundingUrls(list: ClientSource[]): Promise<ClientSource[]> {
  const needsResolving = list.some((s) => GROUNDING_REDIRECT.test(s.url));
  if (!needsResolving) return list;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6_000);
  try {
    return await Promise.all(
      list.map(async (s) => {
        if (!GROUNDING_REDIRECT.test(s.url)) return s;
        try {
          // `redirect: "follow"` + HEAD: we want res.url (the final hop), not a body.
          const res = await fetch(s.url, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
          const finalUrl = res.url;
          if (!finalUrl || GROUNDING_REDIRECT.test(finalUrl)) return s;
          // Gemini's title is often just the bare host; prefer it only if the
          // resolved URL gives us nothing better to show.
          return { ...s, url: finalUrl };
        } catch {
          return s; // aborted / blocked / dead link — the redirect still works
        }
      })
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function* streamGeminiSearch(
  model: ModelInfo,
  system: string,
  history: MessageForModel[],
  maxTokens: number,
  signal?: AbortSignal,
  dynamicContext?: string
): AsyncGenerator<LlmEvent> {
  const key = providerApiKey("google");
  if (!key) throw new Error("Google API key is not configured.");

  const contents = await toGeminiContents(history, model.vision);
  // Per-request dynamic context (the date) goes AFTER the frozen history so
  // Gemini's implicit prefix caching keeps matching system + past turns.
  // Two consecutive user turns are valid Gemini content.
  if (dynamicContext) {
    let lastUser = contents.length;
    for (let i = contents.length - 1; i >= 0; i--) {
      if (contents[i].role === "user") {
        lastUser = i;
        break;
      }
    }
    contents.splice(lastUser, 0, { role: "user", parts: [{ text: dynamicContext }] });
  }
  // The native endpoint needs a "models/<id>" path; discovery may give either form.
  const path = model.providerModel.startsWith("models/") ? model.providerModel : `models/${model.providerModel}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/${path}:streamGenerateContent?alt=sse`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: system }] },
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini search ${res.status}: ${text.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const sources = new Map<string, ClientSource>();
  let usageIn: number | undefined;
  let usageOut: number | undefined;
  let usageCached: number | undefined;
  let finishReason: string | undefined;

  const handle = (json: string) => {
    let data: {
      candidates?: {
        content?: { parts?: { text?: string; thought?: boolean }[] };
        finishReason?: string;
        groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
      }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
    };
    try {
      data = JSON.parse(json);
    } catch {
      return [] as LlmEvent[];
    }
    const events: LlmEvent[] = [];
    const cand = data.candidates?.[0];
    if (cand?.finishReason) {
      finishReason = cand.finishReason;
      events.push({ type: "finish", reason: normalizeFinishReason(cand.finishReason), raw: cand.finishReason });
    }
    for (const p of cand?.content?.parts ?? []) {
      if (!p.text) continue;
      events.push(p.thought ? { type: "reasoning", text: p.text } : { type: "text", text: p.text });
    }
    for (const ch of cand?.groundingMetadata?.groundingChunks ?? []) {
      const web = ch.web;
      if (web?.uri && !sources.has(web.uri)) {
        sources.set(web.uri, { title: web.title || web.uri, url: web.uri, snippet: "" });
      }
    }
    if (data.usageMetadata) {
      usageIn = data.usageMetadata.promptTokenCount;
      usageOut = data.usageMetadata.candidatesTokenCount;
      usageCached = data.usageMetadata.cachedContentTokenCount;
    }
    return events;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (json) for (const ev of handle(json)) yield ev;
    }
  }

  if (sources.size) yield { type: "sources", sources: await resolveGroundingUrls([...sources.values()]) };
  if (usageIn != null || usageOut != null) {
    yield { type: "usage", input: usageIn, output: usageOut, cacheRead: usageCached };
    // Cache hit-rate instrumentation (Gemini implicit caching).
    console.info("[llm:gemini-search] usage", { model: model.providerModel, promptTokens: usageIn ?? null, cachedTokens: usageCached ?? null });
  }
  if (!finishReason) yield { type: "finish", reason: "stop" };
}
