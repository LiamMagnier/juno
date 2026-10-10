import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { pairingOfferStatus } from "@/lib/code-v2/device-pairing";
import { prismaPairingStore } from "@/lib/code-v2/device-pairing-store";
import { NO_STORE, pairingError } from "@/lib/code-v2/pairing-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Mac's sheet polls its offer: pending, approved (with the new pair), denied or expired. */
export async function GET(_req: Request, { params }: { params: Promise<{ offerId: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { offerId } = await params;
  const status = await pairingOfferStatus(prismaPairingStore, { userId: user.id, tokenId: offerId });
  if (!status.ok) return pairingError(status);
  const { ok: _ok, ...body } = status;
  return NextResponse.json(body, { headers: NO_STORE });
}
