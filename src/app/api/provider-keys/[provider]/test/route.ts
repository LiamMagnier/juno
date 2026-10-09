import { NextResponse } from "next/server";

import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/session";
import { isByokProvider, testProviderKey } from "@/lib/code-v2/byok";
import { readStoredProviderKey, recordKeyTest } from "@/lib/code-v2/byok-store";

export const runtime = "nodejs";

/**
 * Re-test a stored key with the lab's free model-list call. A refusal marks it
 * invalid (runs stop routing to it); an unreachable lab changes nothing but
 * the test time. Answers with the stored view, never the key.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { provider } = await ctx.params;
  if (!isByokProvider(provider)) return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
  const limit = await rateLimit({ key: `provider-keys:test:${user.id}`, limit: 30, windowSec: 600 });
  if (!limit.success) return NextResponse.json({ error: "Too many tests. Try again shortly." }, { status: 429 });
  const key = await readStoredProviderKey(user.id, provider);
  if (!key) return NextResponse.json({ error: "No key stored for this provider." }, { status: 404 });
  const outcome = await testProviderKey(provider, key);
  const view = await recordKeyTest(user.id, provider, outcome);
  return NextResponse.json(
    { result: outcome.status, detail: outcome.status === "valid" ? null : outcome.detail, key: view },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
