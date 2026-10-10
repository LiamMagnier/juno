import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { revokePair } from "@/lib/code-v2/device-pairing";
import { prismaPairingStore } from "@/lib/code-v2/device-pairing-store";
import { NO_STORE, pairingError } from "@/lib/code-v2/pairing-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Remove: the pair stops working on its next request (every remote command re-checks it). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ pairId: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { pairId } = await params;
  const revoked = await revokePair(prismaPairingStore, { userId: user.id, pairId });
  if (!revoked.ok) return pairingError(revoked);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
