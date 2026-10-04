import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { REFERRAL_COOKIE, REFERRAL_COOKIE_MAX_AGE_SEC, normalizeReferralCode } from "@/lib/credits";

/**
 * A referral link: /r/<code>. Remembers the code in a first-party cookie for
 * thirty days and lands on sign-up. The cookie is read once the account
 * exists (register route, OAuth createUser event) and the Referral row is
 * written then; a malformed code sets nothing.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code: raw } = await ctx.params;
  const code = normalizeReferralCode(raw);
  const target = new URL("/sign-up", env.appUrl);
  if (code) target.searchParams.set("ref", code);
  const res = NextResponse.redirect(target, 307);
  if (code) {
    res.cookies.set(REFERRAL_COOKIE, code, {
      httpOnly: true,
      sameSite: "lax",
      secure: env.appUrl.startsWith("https://"),
      path: "/",
      maxAge: REFERRAL_COOKIE_MAX_AGE_SEC,
    });
  }
  return res;
}
