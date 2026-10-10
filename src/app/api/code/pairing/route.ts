import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { env } from "@/lib/env";
import { getCurrentDeviceSessionId } from "@/lib/session";
import { createPairingOffer } from "@/lib/code-v2/device-pairing";
import { prismaPairingStore } from "@/lib/code-v2/device-pairing-store";
import { NO_STORE, pairingError, pairingSecret } from "@/lib/code-v2/pairing-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ deviceId: z.string().min(1).max(200), kind: z.enum(["phone", "browser"]) });

/**
 * A Mac asks for a pairing offer (docs/code-v2/REMOTE-CONTROL.md): a signed,
 * two-minute, single-use token for its QR, or a URL plus code for a browser.
 * Only the Mac app may ask (a native sign-in), and only for a Mac this account
 * owns.
 */
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;
  if (!(await getCurrentDeviceSessionId())) {
    return NextResponse.json({ error: "Show pairing codes from Alevr on your Mac." }, { status: 403, headers: NO_STORE });
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400, headers: NO_STORE });
  const offer = await createPairingOffer(prismaPairingStore, {
    userId: user.id,
    deviceId: parsed.data.deviceId,
    kind: parsed.data.kind,
    secret: pairingSecret(),
    appUrl: env.appUrl,
  });
  if (!offer.ok) return pairingError(offer);
  const { ok: _ok, ...body } = offer;
  return NextResponse.json(body, { headers: NO_STORE });
}
