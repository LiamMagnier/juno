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

  try {
    if (env.voice.sttProvider === "openai") {
      const upstream = new FormData();
      upstream.append("file", file, "audio.webm");
      upstream.append("model", "whisper-1");
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.voice.openaiApiKey}` },
        body: upstream,
      });
      if (!res.ok) throw new Error(`OpenAI STT ${res.status}`);
      const data = await res.json();
      return NextResponse.json({ text: data.text ?? "" });
    } else {
      // Deepgram
      const buf = await file.arrayBuffer();
      const res = await fetch("https://api.deepgram.com/v1/listen?smart_format=true&punctuate=true", {
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
