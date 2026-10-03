import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { isServerTtsConfigured } from "@/lib/env";
import { isOwnerEmail } from "@/lib/owner";
import { synthesizeSpeech } from "@/lib/tts";

export const runtime = "nodejs";

// voiceId stays a loose string: ElevenLabs ids are arbitrary account-specific
// hashes, so there is no shape to validate here. It's narrowed per provider in
// synthesizeSpeech (lib/tts.ts).
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

  // Gemini 3.8 Flash TTS first when the Google key is set, then OpenAI, then
  // ElevenLabs — so read-aloud still works (and stays multilingual) when one
  // provider is rate-limited or out of credit. TTS_PROVIDER can force another
  // to the front. Each attempt vets the voice id for its own provider.
  const spoken = await synthesizeSpeech(text, voiceId);
  if (!spoken) return NextResponse.json({ error: "Text-to-speech failed." }, { status: 502 });
  // The real type: Gemini answers with WAV, the fallbacks with MP3. Every
  // client plays from the bytes (blob URL / AVAudioPlayer), so either works.
  return new Response(spoken.audio, {
    headers: { "Content-Type": spoken.contentType, "Cache-Control": "no-store", "X-TTS-Provider": spoken.provider },
  });
}
