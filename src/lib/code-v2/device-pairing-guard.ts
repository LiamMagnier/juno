/**
 * The remote-command guard the routes call (docs/code-v2/REMOTE-CONTROL.md
 * §Security model), and who is asking.
 */
import { NextResponse } from "next/server";
import { getCurrentDeviceSessionId } from "@/lib/session";
import { browserKeyFromCookie, checkRemotePair, type Controller } from "@/lib/code-v2/device-pairing";
import { prismaPairingStore } from "@/lib/code-v2/device-pairing-store";

/** This request's controller: the phone behind a native bearer, else the browser's cookie key. */
export async function controllerFor(req: Request): Promise<Controller> {
  const deviceSessionId = req.headers.get("authorization") ? await getCurrentDeviceSessionId() : null;
  if (deviceSessionId) return { kind: "phone", deviceSessionId };
  return { kind: "browser", browserKey: browserKeyFromCookie(req.headers.get("cookie")) };
}

/**
 * The remote-command guard: null when this phone or browser holds a live pair
 * with `deviceId`, else the 403 to return. Call it after the ownership check.
 */
export async function requireRemotePair(req: Request, userId: string, deviceId: string): Promise<NextResponse | null> {
  const result = await checkRemotePair(prismaPairingStore, { userId, deviceId, controller: await controllerFor(req) });
  if (result.ok) return null;
  return NextResponse.json({ error: result.message, message: result.message, code: result.code }, { status: result.status });
}
