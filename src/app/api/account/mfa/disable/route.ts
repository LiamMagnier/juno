import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { disableTotp } from "@/lib/account-security";
import { isOwnerEmail } from "@/lib/owner";

export const runtime = "nodejs";

const schema = z.object({ code: z.string().trim().min(6).max(20) });

/**
 * Turn two-step verification off.
 *
 * Requires a current code or an unused recovery code, not just the session:
 * an attacker riding a stolen cookie must not be able to remove the control
 * that would stop them coming back tomorrow.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = await rateLimit({ key: `mfa-disable:${user.id}`, limit: 10, windowSec: 60 * 60 });
  if (!limit.success) {
    return NextResponse.json({ error: "Too many attempts — try again later." }, { status: 429 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a current code or one of your recovery codes." }, { status: 400 });
  }

  const result = await disableTotp(user.id, parsed.data.code);
  if (!result.ok) {
    return NextResponse.json(
      {
        error:
          result.reason === "not_enabled"
            ? "Two-step verification isn't on for this account."
            : "That code isn't right. Use a current code or an unused recovery code.",
        code: result.reason,
      },
      { status: result.reason === "not_enabled" ? 409 : 400 }
    );
  }

  // An owner who turns two-step off has just locked themselves out of Admin
  // (src/lib/admin.ts) rather than quietly regaining it. Saying so here is the
  // difference between an informed choice and a confusing 404 later.
  return NextResponse.json({ ok: true, ownerAdminLocked: isOwnerEmail(user.email) });
}
