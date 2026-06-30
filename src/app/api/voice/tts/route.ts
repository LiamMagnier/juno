import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { env, isServerTtsConfigured } from "@/lib/env";
import { isOwnerEmail } from "@/lib/owner";

export const runtime = "nodejs";

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

  // Try the configured provider first, then fall back to the other if its key is
  // set — so read-aloud still works (and stays multilingual) when one provider is
  // rate-limited or out of credit.
  const attempts: Array<() => Promise<ArrayBuffer>> = [];
  const addOpenAI = () => env.voice.openaiApiKey && attempts.push(() => openaiTts(text, voiceId, env.voice.openaiApiKey!));
  const addEleven = () =>
    env.voice.elevenlabsApiKey && attempts.push(() => elevenTts(text, voiceId, env.voice.elevenlabsApiKey!, env.voice.elevenlabsVoiceId));

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

// gpt-4o-mini-tts: high quality, reads text in its own language (not an English accent).
async function openaiTts(text: string, voiceId: string | undefined, apiKey: string): Promise<ArrayBuffer> {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: voiceId || "alloy",
      input: text,
      response_format: "mp3",
      instructions: "Read naturally and clearly, in the same language as the text.",
    }),
  });
  if (!res.ok) throw new Error(`OpenAI TTS ${res.status}`);
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
