import { NextResponse } from "next/server";

import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/session";
import { OPENROUTER_MODELS_URL, openRouterPickerModels, type OpenRouterModelRow } from "@/lib/code-v2/openrouter";
import type { ProviderModel } from "@/lib/code-v2/contracts";

export const runtime = "nodejs";

const TTL_MS = 10 * 60_000;
let cache: { at: number; models: ProviderModel[] } | null = null;

/**
 * The models a BYOK-only lab offers the picker (today: OpenRouter). Read from
 * OpenRouter's public list, so no key leaves the store for it; cached for ten
 * minutes per process. Answers `{ models }` in the picker's shape
 * (`openrouter:<slug>`, one context tier with the per-million prices).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { provider } = await ctx.params;
  if (provider !== "openrouter") return NextResponse.json({ error: "This lab's models come from the Alevr catalogue." }, { status: 400 });
  const limit = await rateLimit({ key: `provider-keys:models:${user.id}`, limit: 60, windowSec: 600 });
  if (!limit.success) return NextResponse.json({ error: "Too many requests. Try again shortly." }, { status: 429 });

  if (!cache || Date.now() - cache.at > TTL_MS) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10_000);
    try {
      const res = await fetch(OPENROUTER_MODELS_URL, { signal: abort.signal, cache: "no-store", headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { data?: OpenRouterModelRow[] };
      cache = { at: Date.now(), models: openRouterPickerModels(Array.isArray(body.data) ? body.data : []) };
    } catch {
      if (!cache) return NextResponse.json({ error: "OpenRouter's model list could not be reached." }, { status: 502 });
    } finally {
      clearTimeout(timer);
    }
  }
  return NextResponse.json({ models: cache.models }, { headers: { "Cache-Control": "private, max-age=300" } });
}
