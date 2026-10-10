import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { inspectPairingOffer } from "@/lib/code-v2/device-pairing";
import { prismaPairingStore } from "@/lib/code-v2/device-pairing-store";
import { controllerFor } from "@/lib/code-v2/device-pairing-guard";
import { NO_STORE, offerRefFrom, pairingAttemptAllowed, pairingError, pairingSecret } from "@/lib/code-v2/pairing-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the approve screen shows ("Allow this iPhone to control Alevr on
 * <Mac>?") for a scanned token or a typed code. Does not consume the offer.
 */
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const ref = offerRefFrom(await req.json().catch(() => null));
  if (!ref) return NextResponse.json({ error: "Invalid input" }, { status: 400, headers: NO_STORE });
  if (!(await pairingAttemptAllowed(user.id))) return NextResponse.json({ error: "Too many tries. Wait a minute." }, { status: 429, headers: NO_STORE });
  const summary = await inspectPairingOffer(prismaPairingStore, { userId: user.id, ref, controller: await controllerFor(req), secret: pairingSecret() });
  if (!summary.ok) return pairingError(summary);
  const { ok: _ok, ...body } = summary;
  return NextResponse.json(body, { headers: NO_STORE });
}
