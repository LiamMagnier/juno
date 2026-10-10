import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { listPairsForController, listPairsForDevice } from "@/lib/code-v2/device-pairing";
import { controllerFor, prismaPairingStore } from "@/lib/code-v2/device-pairing-store";
import { NO_STORE, pairingError } from "@/lib/code-v2/pairing-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `?deviceId=<mac>`: the phones and browsers that Mac approved (its Remove
 * list). Without it: the Macs this phone or browser may control.
 */
export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const deviceId = new URL(req.url).searchParams.get("deviceId");
  if (deviceId) {
    const pairs = await listPairsForDevice(prismaPairingStore, user.id, deviceId);
    if (!Array.isArray(pairs)) return pairingError(pairs);
    return NextResponse.json({ pairs }, { headers: NO_STORE });
  }
  const pairs = await listPairsForController(prismaPairingStore, user.id, await controllerFor(req));
  return NextResponse.json({ pairs }, { headers: NO_STORE });
}
