import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { getMfaStatus, startTotpEnrolment } from "@/lib/account-security";

export const runtime = "nodejs";

/**
 * Begin two-step enrolment: mint a secret and return what the authenticator
 * app needs to hold it.
 *
 * The QR is rendered here rather than in the browser so the secret never has
 * to be handed to a third-party script, and it comes back as a data URL so the
 * page's CSP does not have to allow an image host for it.
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = await rateLimit({ key: `mfa-start:${user.id}`, limit: 10, windowSec: 60 * 60 });
  if (!limit.success) {
    return NextResponse.json({ error: "Too many attempts — try again later." }, { status: 429 });
  }

  const status = await getMfaStatus(user.id);
  if (status.enabled) {
    // Re-enrolling silently would replace a working second factor with an
    // unconfirmed one; turning it off first is a deliberate, code-gated act.
    return NextResponse.json(
      { error: "Two-step verification is already on. Turn it off first to enrol a new device." },
      { status: 409 }
    );
  }

  const email = user.email ?? user.id;
  const enrolment = await startTotpEnrolment(user.id, email);
  const qrDataUrl = await QRCode.toDataURL(enrolment.otpauthUrl, { margin: 1, width: 240 });

  return NextResponse.json({
    // The secret is returned once, to this user's own authenticated session,
    // so a device without a camera can be set up by typing it. It is never
    // logged and never returned again after enrolment completes.
    secret: enrolment.secret,
    otpauthUrl: enrolment.otpauthUrl,
    qrDataUrl,
  });
}
