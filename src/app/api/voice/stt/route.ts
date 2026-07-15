import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { env, isServerSttConfigured } from "@/lib/env";
import { isOwnerEmail } from "@/lib/owner";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const plan = await getUserPlan(user.id);
  if (!PLANS[plan].voice) return NextResponse.json({ error: "Voice is not available on your plan." }, { status: 403 });

  if (!isServerSttConfigured()) {
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
  // OpenAI's transcription endpoint caps uploads at 25 MB.
  if (file.size > 25 * 1024 * 1024) return NextResponse.json({ error: "That clip is too long." }, { status: 413 });

  // An ISO-639-1 hint ("fr") is the single biggest accuracy win for non-English
  // speech: without it the model has to guess the language from the first
  // syllables and often settles on English, mangling French words.
  const language = normalizeLanguage(form?.get("language"));

  try {
    if (env.voice.sttProvider === "openai") {
      const text = await openaiTranscribe(file, language, env.voice.sttModel, env.voice.openaiApiKey!);
      return NextResponse.json({ text });
    } else {
      // Deepgram
      const buf = await file.arrayBuffer();
      const url = new URL("https://api.deepgram.com/v1/listen");
      url.searchParams.set("smart_format", "true");
      url.searchParams.set("punctuate", "true");
      url.searchParams.set("model", "nova-3");
      if (language) url.searchParams.set("language", language);
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Token ${env.voice.deepgramApiKey}`, "Content-Type": file.type || "audio/webm" },
        body: buf,
      });
      if (!res.ok) throw new Error(`Deepgram STT ${res.status}`);
      const data = await res.json();
      const text = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
      return NextResponse.json({ text });
    }
  } catch (err) {
    console.error("[stt]", err);
    return NextResponse.json({ error: "Transcription failed." }, { status: 502 });
  }
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

async function postTranscription(file: File, language: string | undefined, model: string, apiKey: string): Promise<string> {
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
  const data = (await res.json()) as { text?: string };
  return data.text ?? "";
}

/** Transcribe with the configured model, falling back to whisper-1 — which is
 *  available on every account — if the newer model is rejected (404/400). */
async function openaiTranscribe(file: File, language: string | undefined, model: string, apiKey: string): Promise<string> {
  try {
    return await postTranscription(file, language, model, apiKey);
  } catch (err) {
    if (model === "whisper-1") throw err;
    console.error(`[stt] ${model} failed, retrying on whisper-1:`, err);
    return postTranscription(file, language, "whisper-1", apiKey);
  }
}
