import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getUserPlan } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { signState } from "@/lib/crypto";
import { rateLimit } from "@/lib/rate-limit";
import { isOwnerEmail } from "@/lib/owner";
import { checkBudget, budgetExceededMessage } from "@/lib/spend";

export const runtime = "nodejs";

function resolveVoiceRelayURL(): string | null {
  const configured = process.env.NEXT_PUBLIC_VOICE_RELAY_URL || process.env.VOICE_RELAY_URL;
  if (configured?.trim()) return configured.trim().replace(/\/+$/, "");

  // The production deployment hosts the relay behind the same TLS origin at
  // `/voice-relay`. Keep the dedicated variables as the explicit override, but
  // derive this canonical same-host URL when an older environment forgot to add
  // them. This is particularly important for native clients: a missing
  // build-time NEXT_PUBLIC_* variable must not turn a healthy relay into a 503.
  const appURL = process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL;
  if (!appURL?.trim()) return null;
  try {
    const url = new URL(appURL.trim());
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    else return null;
    url.pathname = "/voice-relay";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Mints a short-lived token for the voice relay. The relay shares AUTH_SECRET
 * and verifies the same HMAC format (see relay/src/auth.ts) — no DB access on
 * the relay side. Token payload: {"uid", "exp"} (60s window to CONNECT; the
 * WebSocket session itself may run much longer).
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const owner = isOwnerEmail(user.email);
  const plan = await getUserPlan(user.id);
  // Owner/internal dogfooding bypasses plan/budget gates just like the other
  // owner-only usage paths. Previously the owner bypass happened *after* this
  // plan check, so an owner account on a plan without the `voice` entitlement
  // could never start mobile Voice even though the relay and provider were
  // correctly configured.
  if (!owner && !PLANS[plan].voice) {
    return NextResponse.json({ error: "Voice mode requires a paid plan." }, { status: 403 });
  }
  if (!owner) {
    const limit = await rateLimit({ key: `relay-token:${user.id}`, limit: 30, windowSec: 60 });
    if (!limit.success) return NextResponse.json({ error: "Slow down." }, { status: 429 });
    const budget = await checkBudget(user.id, plan);
    if (!budget.allowed) {
      return NextResponse.json({ error: "budget_exceeded", message: budgetExceededMessage(plan, budget.resetsAtMs) }, { status: 402 });
    }
  }

  const url = resolveVoiceRelayURL();
  if (!url) return NextResponse.json({ error: "Realtime voice is not configured." }, { status: 503 });

  const token = signState(JSON.stringify({ uid: user.id, exp: Math.floor(Date.now() / 1000) + 60 }));

  // Best-effort provider availability from the relay's /healthz — the client
  // uses it to pick a working default and grey out dead providers. Failure
  // here must never block token minting: the WebSocket handshake itself is the
  // authoritative availability check and gives the native client a typed error.
  let providers: Record<string, boolean> | null = null;
  try {
    const healthUrl = `${url.replace(/^ws/i, "http")}/healthz`;
    const health = await fetch(healthUrl, { cache: "no-store", signal: AbortSignal.timeout(1500) });
    if (health.ok) {
      const body = (await health.json()) as { providers?: Record<string, boolean> };
      if (body.providers && typeof body.providers === "object") providers = body.providers;
    }
  } catch {
    // Relay unreachable — the session start will surface the transport failure.
  }

  return NextResponse.json(providers ? { token, url, providers } : { token, url });
}
