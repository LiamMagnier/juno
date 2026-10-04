import "server-only";
import { env, isServerSttConfigured } from "@/lib/env";
import { getGoogleApiKeys } from "@/lib/gemini-core";
import { googleNativeBaseUrl } from "@/lib/providers";

/**
 * Server speech-to-text.
 *
 * The configured provider (STT_PROVIDER: openai | deepgram) runs first. Gemini
 * is the fallback, and the default when nothing is configured: every
 * deployment that can chat with Gemini can transcribe with it, and it detects
 * the language itself, including a sentence that switches between two. That
 * is what lets dictation have no language picker at all.
 */

export type SttProvider = "openai" | "deepgram" | "gemini";

/** Override with STT_GEMINI_MODEL; the lite flash model is fast and cheap enough to run every few seconds. */
const GEMINI_STT_MODEL = process.env.STT_GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite";

const TRANSCRIBE_PROMPT =
  "Transcribe this audio exactly as spoken. Detect the language automatically and keep every word in the language it was said in, " +
  "including sentences that switch languages. Add natural punctuation and capitalisation. " +
  "Output only the transcript: no quotes, no labels, no translation, no commentary. If there is no speech, output nothing.";

export function sttProviders(): SttProvider[] {
  const out: SttProvider[] = [];
  if (isServerSttConfigured()) out.push(env.voice.sttProvider as SttProvider);
  if (getGoogleApiKeys().length > 0 && !out.includes("gemini")) out.push("gemini");
  return out;
}

export function isAnySttAvailable(): boolean {
  return sttProviders().length > 0;
}

export async function geminiTranscribe(
  file: File,
  signal?: AbortSignal,
  onUsage?: (usage: { inputTokens?: number; outputTokens?: number }) => void
): Promise<string> {
  const keys = getGoogleApiKeys();
  if (keys.length === 0) throw new Error("Gemini STT: no Google API key.");
  const data = Buffer.from(await file.arrayBuffer()).toString("base64");
  const mimeType = (file.type.split(";")[0] || "audio/wav").toLowerCase();
  let lastError: unknown = null;
  for (const key of keys) {
    const res = await fetch(`${googleNativeBaseUrl()}/models/${GEMINI_STT_MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ inlineData: { mimeType, data } }, { text: TRANSCRIBE_PROMPT }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 4096 },
      }),
      signal: signal ?? AbortSignal.timeout(25_000),
    });
    if (res.ok) {
      const json = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
      };
      // The provider's own counts, for the ledger (src/app/api/voice/stt).
      onUsage?.({
        inputTokens: json.usageMetadata?.promptTokenCount,
        outputTokens:
          json.usageMetadata?.candidatesTokenCount != null || json.usageMetadata?.thoughtsTokenCount != null
            ? (json.usageMetadata?.candidatesTokenCount ?? 0) + (json.usageMetadata?.thoughtsTokenCount ?? 0)
            : undefined,
      });
      const text = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
      return text;
    }
    lastError = new Error(`Gemini STT ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    // Rotate keys only on auth failures; anything else is the same for every key.
    if (res.status !== 401 && res.status !== 403) break;
  }
  throw lastError ?? new Error("Gemini STT failed.");
}
