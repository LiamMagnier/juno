import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { discoverModels } from "@/lib/model-discovery";
import { configuredProviders } from "@/lib/providers";
import { GEN_MODELS } from "@/lib/models";
import { isVideoGenSupported } from "@/lib/video-gen";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const configured = new Set(configuredProviders());
  const chat = await discoverModels();
  // Image/video models are curated (not discovered) — surface configured labs,
  // but keep unsupported video APIs out of the selector until an adapter exists.
  const gen = GEN_MODELS.filter((m) => configured.has(m.provider) && (m.modality !== "video" || isVideoGenSupported(m)));

  // Dedupe by id (a provider's fallback list could overlap a gen model).
  const byId = new Map<string, (typeof chat)[number]>();
  for (const m of [...chat, ...gen]) byId.set(m.id, m);

  return NextResponse.json({ models: [...byId.values()] });
}
