import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { env, isServerTtsConfigured } from "@/lib/env";
import { isOwnerEmail } from "@/lib/owner";
import { isOpenAiVoice } from "@/lib/voices";

export const runtime = "nodejs";

// voiceId stays a loose string: ElevenLabs ids are arbitrary account-specific
// hashes, so there is no shape to validate here. It's narrowed per provider below.
const schema = z.object({ text: z.string().min(1).max(4000), voiceId: z.string().max(100).optional() });

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const plan = await getUserPlan(user.id);
  if (!PLANS[plan].voice) return NextResponse.json({ error: "Voice is not available on your plan." }, { status: 403 });

  if (!isServerTtsConfigured()) {
    // Client falls back to the browser SpeechSynthesis API.
    return NextResponse.json({ error: "Server TTS not configured." }, { status: 501 });
  }

  if (!isOwnerEmail(user.email)) {
    const limit = await rateLimit({ key: `tts:${user.id}`, limit: 120, windowSec: 60 });
    if (!limit.success) return NextResponse.json({ error: "Slow down." }, { status: 429 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input." }, { status: 400 });
  const { text, voiceId } = parsed.data;

  // A saved voiceId is only ever as good as the moment it was stored: it can be
  // stale (a voice OpenAI retired), hand-edited, or belong to the OTHER provider
  // now that the fallback chain below can cross over. Feeding either provider an
  // id it doesn't own is a guaranteed 400/404, so each keeps only what it can
  // actually use and falls back to its own configured default.
  const openaiVoice = isOpenAiVoice(voiceId) ? voiceId : undefined;
  // ElevenLabs ids can't be validated (arbitrary hashes) — but a known OpenAI
  // voice name is definitely not one of them, so drop those and keep the rest.
  const elevenVoice = isOpenAiVoice(voiceId) ? undefined : voiceId;

  // Try the configured provider first, then fall back to the other if its key is
  // set — so read-aloud still works (and stays multilingual) when one provider is
  // rate-limited or out of credit.
  const attempts: Array<() => Promise<ArrayBuffer>> = [];
  const addOpenAI = () => env.voice.openaiApiKey && attempts.push(() => openaiTts(text, openaiVoice, env.voice.openaiApiKey!));
  const addEleven = () =>
    env.voice.elevenlabsApiKey && attempts.push(() => elevenTts(text, elevenVoice, env.voice.elevenlabsApiKey!, env.voice.elevenlabsVoiceId));

  if (env.voice.ttsProvider === "elevenlabs") {
    addEleven();
    addOpenAI();
  } else {
    addOpenAI();
    addEleven();
  }

  let audio: ArrayBuffer | null = null;
  for (const attempt of attempts) {
    try {
      audio = await attempt();
      break;
    } catch (err) {
      console.error("[tts]", err);
    }
  }

  if (!audio) return NextResponse.json({ error: "Text-to-speech failed." }, { status: 502 });
  return new Response(audio, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
}

// gpt-4o-mini-tts: high quality, and it reads text in the text's OWN language
// with a native accent — unlike the browser's SpeechSynthesis fallback, which
// applies the OS voice's accent (e.g. French read with an English accent).
async function openaiTts(text: string, voiceId: string | undefined, apiKey: string): Promise<ArrayBuffer> {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.voice.ttsModel,
      // Caller-supplied ids are vetted against the known list before they get
      // here; TTS_VOICE deliberately is NOT, so an operator can adopt a voice
      // OpenAI ships before this code learns about it.
      voice: voiceId || env.voice.ttsVoice,
      input: text,
      response_format: "mp3",
      // `instructions` is only accepted by the gpt-4o*-tts line; the older
      // tts-1/tts-1-hd models reject it.
      ...(/^gpt-4o.*-tts$/.test(env.voice.ttsModel)
        ? {
            instructions:
              "Detect the language of the text and read it as a native speaker of that language would, " +
              "with that language's natural accent, rhythm and pronunciation. Never read it with an English accent " +
              "unless the text itself is English. Speak naturally and clearly at a conversational pace.",
          }
        : {}),
    }),
  });
  if (!res.ok) throw new Error(`OpenAI TTS ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.arrayBuffer();
}

// eleven_multilingual_v2: strong across ~30 languages.
async function elevenTts(
  text: string,
  voiceId: string | undefined,
  apiKey: string,
  defaultVoice?: string
): Promise<ArrayBuffer> {
  const vid = voiceId || defaultVoice || "21m00Tcm4TlvDq8ikWAM";
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}`);
  return res.arrayBuffer();
}
