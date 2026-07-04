import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getUserPlan } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { signState } from "@/lib/crypto";
import { rateLimit } from "@/lib/rate-limit";
import { isOwnerEmail } from "@/lib/owner";

export const runtime = "nodejs";

/**
 * Mints a short-lived token for the voice relay. The relay shares AUTH_SECRET
 * and verifies the same HMAC format (see relay/src/auth.ts) — no DB access on
 * the relay side. Token payload: {"uid", "exp"} (60s window to CONNECT; the
 * WebSocket session itself may run much longer).
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const plan = await getUserPlan(user.id);
  if (!PLANS[plan].voice) {
    return NextResponse.json({ error: "Voice mode requires a paid plan." }, { status: 403 });
  }
  if (!isOwnerEmail(user.email)) {
    const limit = await rateLimit({ key: `relay-token:${user.id}`, limit: 30, windowSec: 60 });
    if (!limit.success) return NextResponse.json({ error: "Slow down." }, { status: 429 });
  }

  const url = process.env.NEXT_PUBLIC_VOICE_RELAY_URL || process.env.VOICE_RELAY_URL || null;
  if (!url) return NextResponse.json({ error: "Realtime voice is not configured." }, { status: 503 });

  const token = signState(JSON.stringify({ uid: user.id, exp: Math.floor(Date.now() / 1000) + 60 }));
  return NextResponse.json({ token, url });
}
