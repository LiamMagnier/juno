import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { discoverModels } from "@/lib/model-discovery";
import { configuredProviders } from "@/lib/providers";
import { GEN_MODELS } from "@/lib/models";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const configured = new Set(configuredProviders());
  const chat = await discoverModels();
  // Image/video models are curated (not discovered) — surface the ones whose lab key is set.
  const gen = GEN_MODELS.filter((m) => configured.has(m.provider));

  // Dedupe by id (a provider's fallback list could overlap a gen model).
  const byId = new Map<string, (typeof chat)[number]>();
  for (const m of [...chat, ...gen]) byId.set(m.id, m);

  return NextResponse.json({ models: [...byId.values()] });
}
