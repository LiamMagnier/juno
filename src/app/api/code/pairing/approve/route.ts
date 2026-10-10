import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { approvePairingOffer, browserNameFrom, REMOTE_BROWSER_COOKIE, REMOTE_BROWSER_COOKIE_MAX_AGE } from "@/lib/code-v2/device-pairing";
import { controllerFor, prismaPairingStore } from "@/lib/code-v2/device-pairing-store";
import { NO_STORE, offerRefFrom, pairingAttemptAllowed, pairingError, pairingSecret } from "@/lib/code-v2/pairing-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Approves a pairing offer: consumes it exactly once and binds this phone (its
 * native sign-in) or this browser (a fresh `alevr_remote` cookie) to the Mac.
 */
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const ref = offerRefFrom(await req.json().catch(() => null));
  if (!ref) return NextResponse.json({ error: "Invalid input" }, { status: 400, headers: NO_STORE });
  if (!(await pairingAttemptAllowed(user.id))) return NextResponse.json({ error: "Too many tries. Wait a minute." }, { status: 429, headers: NO_STORE });
  const approved = await approvePairingOffer(prismaPairingStore, {
    userId: user.id,
    ref,
    controller: await controllerFor(req),
    secret: pairingSecret(),
    browser: browserNameFrom(req.headers.get("user-agent")),
  });
  if (!approved.ok) return pairingError(approved);
  const response = NextResponse.json({ pair: approved.pair }, { headers: NO_STORE });
  if (approved.browserKey) {
    response.cookies.set(REMOTE_BROWSER_COOKIE, approved.browserKey, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: REMOTE_BROWSER_COOKIE_MAX_AGE,
    });
  }
  return response;
}
