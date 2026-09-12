import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { confirmTotpEnrolment } from "@/lib/account-security";

export const runtime = "nodejs";

const schema = z.object({ code: z.string().trim().min(6).max(10) });

const MESSAGES: Record<string, string> = {
  no_pending_enrolment: "Start setting up two-step verification before confirming a code.",
  already_enabled: "Two-step verification is already on for this account.",
  invalid_code: "That code isn't right. Check your authenticator app and try the current code.",
};

/**
 * Finish enrolment with a first valid code.
 *
 * Proving a code before anything is enforced is what stops someone locking
 * themselves out of their own account with a misconfigured app — the failure
 * mode this whole feature has to avoid.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Tight, because this accepts a six-digit code: 10 tries an hour makes
  // guessing one of a million values hopeless while leaving room for typos.
  const limit = await rateLimit({ key: `mfa-confirm:${user.id}`, limit: 10, windowSec: 60 * 60 });
  if (!limit.success) {
    return NextResponse.json({ error: "Too many attempts — try again later." }, { status: 429 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter the 6-digit code from your authenticator app." }, { status: 400 });
  }

  const result = await confirmTotpEnrolment(user.id, parsed.data.code);
  if (!result.ok) {
    return NextResponse.json(
      { error: MESSAGES[result.reason] ?? "Could not turn on two-step verification.", code: result.reason },
      { status: result.reason === "invalid_code" ? 400 : 409 }
    );
  }

  // The only time these are ever readable. They are hashed at rest, so this
  // response cannot be reproduced — the UI says so before it is dismissed.
  return NextResponse.json({ ok: true, recoveryCodes: result.recoveryCodes });
}
