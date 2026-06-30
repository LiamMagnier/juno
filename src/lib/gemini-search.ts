import "server-only";
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
export async function* streamGeminiSearch(
  model: ModelInfo,
  system: string,
  history: MessageForModel[],
  maxTokens: number,
  signal?: AbortSignal
): AsyncGenerator<LlmEvent> {
  const key = providerApiKey("google");
  if (!key) throw new Error("Google API key is not configured.");

  const contents = await toGeminiContents(history, model.vision);
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

  const handle = (json: string) => {
    let data: {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    try {
      data = JSON.parse(json);
    } catch {
      return [] as LlmEvent[];
    }
    const events: LlmEvent[] = [];
    const cand = data.candidates?.[0];
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

  if (sources.size) yield { type: "sources", sources: [...sources.values()] };
  if (usageIn != null || usageOut != null) yield { type: "usage", input: usageIn, output: usageOut };
}
