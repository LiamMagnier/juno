import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { env } from "@/lib/env";
import { geminiTranscribe, sttProviders, type SttProvider } from "@/lib/stt";
import { isOwnerEmail } from "@/lib/owner";
import { recordSpend } from "@/lib/spend";
import { admitMeteredCall } from "@/lib/metering/admit";
import { estimateAudioSeconds, sttCostMicroUsd } from "@/lib/metering/unit-prices";

/** Token counts a provider reported for one transcription, when it did. */
type SttUsage = { inputTokens?: number; outputTokens?: number };

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const plan = await getUserPlan(user.id);
  if (!PLANS[plan].voice) return NextResponse.json({ error: "Voice is not available on your plan." }, { status: 403 });

  const providers = sttProviders();
  if (providers.length === 0) {
    // Client falls back to the browser SpeechRecognition API.
    return NextResponse.json({ error: "Server STT not configured." }, { status: 501 });
  }

  if (!isOwnerEmail(user.email)) {
    const limit = await rateLimit({ key: `stt:${user.id}`, limit: 120, windowSec: 60 });
    if (!limit.success) return NextResponse.json({ error: "Slow down." }, { status: 429 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("audio");
  if (!(file instanceof File)) return NextResponse.json({ error: "No audio provided." }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "Empty audio." }, { status: 400 });
  // OpenAI's transcription endpoint caps uploads at 25 MB (Gemini's inline
  // audio at 20 MB, about ten minutes of the 16 kHz WAV dictation records).
  if (file.size > 20 * 1024 * 1024) return NextResponse.json({ error: "That clip is too long." }, { status: 413 });

  // An ISO-639-1 hint ("fr") is the single biggest accuracy win for non-English
  // speech: without it the model has to guess the language from the first
  // syllables and often settles on English, mangling French words.
  const language = normalizeLanguage(form?.get("language"));

  // Metered (docs/pricing/USAGE_METERING_AUDIT.md). Dictation was plan-gated
  // and rate-limited but billed nothing. The clip's length is estimated from
  // its size, high for compressed audio, and that estimate must fit what is
  // left before any provider hears it.
  const audioSeconds = estimateAudioSeconds(file.size, file.type);
  if (plan !== "OWNER") {
    const admitted = await admitMeteredCall({
      userId: user.id,
      plan,
      estimateMicroUsd: Math.max(...providers.map((p) => sttCostMicroUsd(p, { audioSeconds }))),
    });
    if (!admitted.allowed) return NextResponse.json(admitted.body, { status: admitted.status });
  }

  // No language hint means the model detects it (dictation sends none). The
  // configured provider runs first; Gemini catches its failures, so an
  // exhausted OpenAI balance degrades to Gemini instead of to nothing.
  let lastError: unknown = null;
  for (const provider of providers) {
    const usage: SttUsage = {};
    try {
      const text = await transcribeWith(provider, file, language, usage);
      await recordSpend({
        userId: user.id,
        model: `stt:${provider}`,
        kind: "voice",
        costUsd:
          sttCostMicroUsd(provider, {
            audioSeconds,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            outputChars: text.length,
          }) / 1_000_000,
      });
      return NextResponse.json({ text, provider });
    } catch (err) {
      lastError = err;
      console.error(`[stt] ${provider} failed`, err);
    }
  }
  console.error("[stt] every provider failed", lastError);
  return NextResponse.json({ error: "Transcription failed." }, { status: 502 });
}

async function transcribeWith(
  provider: SttProvider,
  file: File,
  language: string | undefined,
  usage: SttUsage
): Promise<string> {
  if (provider === "gemini") return geminiTranscribe(file, undefined, (u) => Object.assign(usage, u));
  if (provider === "openai") return openaiTranscribe(file, language, env.voice.sttModel, env.voice.openaiApiKey!, usage);
  const buf = await file.arrayBuffer();
  const url = new URL("https://api.deepgram.com/v1/listen");
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("punctuate", "true");
  url.searchParams.set("model", "nova-3");
  // nova-3's "multi" detects and code-switches between its languages.
  url.searchParams.set("language", language ?? "multi");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Token ${env.voice.deepgramApiKey}`, "Content-Type": file.type || "audio/wav" },
    body: buf,
  });
  if (!res.ok) throw new Error(`Deepgram STT ${res.status}`);
  const data = await res.json();
  return data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
}

/** Accept "fr", "fr-FR", "FR-fr" → "fr". Anything else → undefined (auto-detect). */
function normalizeLanguage(value: FormDataEntryValue | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/.test(code) ? code : undefined;
}

/** OpenAI infers the container from the filename extension, so send a real one. */
function audioFilename(file: File): string {
  const fromName = file.name?.match(/\.(webm|mp3|mp4|mpga|m4a|wav|ogg|oga|flac)$/i)?.[1];
  if (fromName) return `audio.${fromName.toLowerCase()}`;
  const subtype = (file.type.split(";")[0]?.split("/")[1] ?? "").toLowerCase();
  const byMime: Record<string, string> = {
    webm: "webm", ogg: "ogg", mpeg: "mp3", mp4: "mp4", "x-m4a": "m4a", m4a: "m4a", wav: "wav", "x-wav": "wav", flac: "flac",
  };
  return `audio.${byMime[subtype] ?? "webm"}`;
}

async function postTranscription(
  file: File,
  language: string | undefined,
  model: string,
  apiKey: string,
  usage?: SttUsage
): Promise<string> {
  const upstream = new FormData();
  upstream.append("file", file, audioFilename(file));
  upstream.append("model", model);
  if (language) upstream.append("language", language);
  // gpt-4o-transcribe only supports json/text; whisper-1 also allows verbose_json.
  upstream.append("response_format", "json");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: upstream,
  });
  if (!res.ok) throw new Error(`OpenAI STT ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = (await res.json()) as {
    text?: string;
    usage?: { type?: string; input_tokens?: number; output_tokens?: number };
  };
  // gpt-4o-transcribe reports token usage; whisper-1 is billed by duration.
  if (usage && data.usage?.type === "tokens") {
    usage.inputTokens = data.usage.input_tokens;
    usage.outputTokens = data.usage.output_tokens;
  }
  return data.text ?? "";
}

/** Transcribe with the configured model, falling back to whisper-1 — which is
 *  available on every account — if the newer model is rejected (404/400). */
async function openaiTranscribe(
  file: File,
  language: string | undefined,
  model: string,
  apiKey: string,
  usage?: SttUsage
): Promise<string> {
  try {
    return await postTranscription(file, language, model, apiKey, usage);
  } catch (err) {
    if (model === "whisper-1") throw err;
    console.error(`[stt] ${model} failed, retrying on whisper-1:`, err);
    return postTranscription(file, language, "whisper-1", apiKey, usage);
  }
}
