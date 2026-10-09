import { NextResponse } from "next/server";

import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/session";
import { BYOK_PROVIDER_INFO, BYOK_PROVIDER_VALUES, checkKeyShape, isByokProvider, testProviderKey } from "@/lib/code-v2/byok";
import { byokUsageSummary, listProviderKeys, saveProviderKey } from "@/lib/code-v2/byok-store";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * Bring your own key (Alevr Code v2 SPEC §2). GET lists the user's stored
 * keys (hint only, never the key), the labs a key can be added for and the
 * last 30 days of usage on them.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [keys, usage] = await Promise.all([listProviderKeys(user.id), byokUsageSummary(user.id)]);
  const providers = BYOK_PROVIDER_VALUES.map((id) => ({ id, ...BYOK_PROVIDER_INFO[id] }));
  return NextResponse.json({ keys, providers, usage }, { headers: NO_STORE });
}

/**
 * Add or replace a key: `{provider, key}`. The key is checked with the lab's
 * free model-list call first and stored only when the lab accepts it; the
 * response carries the stored view (hint only). A lab that cannot be reached
 * is a 502 and stores nothing, so a key nobody has seen work never routes a run.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limit = await rateLimit({ key: `provider-keys:add:${user.id}`, limit: 20, windowSec: 3600 });
  if (!limit.success) return NextResponse.json({ error: "Too many keys added in an hour." }, { status: 429 });
  const body = (await req.json().catch(() => null)) as { provider?: unknown; key?: unknown } | null;
  if (!body || !isByokProvider(body.provider)) {
    return NextResponse.json({ error: "Choose a supported provider." }, { status: 400 });
  }
  const shape = checkKeyShape(body.key);
  if (!shape.ok) return NextResponse.json({ error: shape.error }, { status: 400 });

  const outcome = await testProviderKey(body.provider, shape.key);
  if (outcome.status === "invalid") {
    return NextResponse.json({ error: "The provider refused this key.", detail: outcome.detail, code: "KEY_REJECTED" }, { status: 422 });
  }
  if (outcome.status === "unreachable") {
    return NextResponse.json({ error: "Couldn't reach the provider to check this key. Try again.", detail: outcome.detail, code: "PROVIDER_UNREACHABLE" }, { status: 502 });
  }
  const key = await saveProviderKey(user.id, body.provider, shape.key);
  return NextResponse.json({ key }, { status: 201, headers: NO_STORE });
}
