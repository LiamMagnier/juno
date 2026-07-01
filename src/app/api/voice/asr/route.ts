import { NextResponse } from "next/server";
import OpenAI from "openai";
import { getCurrentUser } from "@/lib/session";
import { getUserPlan } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { rateLimit } from "@/lib/rate-limit";
import { isOwnerEmail } from "@/lib/owner";
import { resolveVoiceInput } from "@/lib/models";
import { providerApiKey, providerBaseUrl, isProviderConfigured, PROVIDERS } from "@/lib/providers";
import { providerErrorMessage } from "@/lib/llm";

export const runtime = "nodejs";

// Server-side speech-to-text for voice mode. Accepts multipart form-data with an
// `audio` blob + a `model` id (e.g. "zhipu:glm-asr-2512"), transcribes it via the
// provider's OpenAI-compatible /audio/transcriptions endpoint, and returns text.
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const plan = await getUserPlan(user.id);
  if (!PLANS[plan].voice) return NextResponse.json({ error: "Voice is not available on your plan." }, { status: 403 });

  if (!isOwnerEmail(user.email)) {
    const limit = await rateLimit({ key: `asr:${user.id}`, limit: 120, windowSec: 60 });
    if (!limit.success) return NextResponse.json({ error: "You're talking too fast — give it a second." }, { status: 429 });
  }

  const form = await req.formData().catch(() => null);
  const audio = form?.get("audio");
  const modelId = typeof form?.get("model") === "string" ? (form!.get("model") as string) : "zhipu:glm-asr-2512";

  if (!(audio instanceof File) || audio.size === 0) {
    return NextResponse.json({ error: "No audio was provided." }, { status: 400 });
  }
  if (audio.size > 25 * 1024 * 1024) {
    return NextResponse.json({ error: "That clip is too long — keep it under ~25 MB." }, { status: 413 });
  }

  const vm = resolveVoiceInput(modelId);
  if (!vm.provider || !vm.providerModel) {
    return NextResponse.json({ error: "That voice option uses on-device recognition." }, { status: 400 });
  }
  if (!isProviderConfigured(vm.provider)) {
    return NextResponse.json(
      { error: `${PROVIDERS[vm.provider].label} isn't configured for transcription.` },
      { status: 501 }
    );
  }

  try {
    const client = new OpenAI({
      apiKey: providerApiKey(vm.provider),
      baseURL: providerBaseUrl(vm.provider),
      maxRetries: 1,
    });
    const file = await OpenAI.toFile(Buffer.from(await audio.arrayBuffer()), audio.name || "audio.webm", {
      type: audio.type || "audio/webm",
    });
    const result = await client.audio.transcriptions.create({ file, model: vm.providerModel });
    const text = (typeof result === "string" ? result : result.text) ?? "";
    return NextResponse.json({ text: text.trim() });
  } catch (err) {
    console.error("[asr]", err);
    return NextResponse.json({ error: providerErrorMessage(err, PROVIDERS[vm.provider].label) }, { status: 502 });
  }
}
