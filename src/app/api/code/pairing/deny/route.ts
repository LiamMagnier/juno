import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { denyPairingOffer } from "@/lib/code-v2/device-pairing";
import { prismaPairingStore } from "@/lib/code-v2/device-pairing-store";
import { controllerFor } from "@/lib/code-v2/device-pairing-guard";
import { NO_STORE, offerRefFrom, pairingError, pairingSecret } from "@/lib/code-v2/pairing-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Denies a pairing offer: consumed, so it can no longer be approved. The Mac's sheet says so. */
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const ref = offerRefFrom(await req.json().catch(() => null));
  if (!ref) return NextResponse.json({ error: "Invalid input" }, { status: 400, headers: NO_STORE });
  const denied = await denyPairingOffer(prismaPairingStore, { userId: user.id, ref, controller: await controllerFor(req), secret: pairingSecret() });
  if (!denied.ok) return pairingError(denied);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
