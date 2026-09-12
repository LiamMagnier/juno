import { NextResponse } from "next/server";
import { consumeEmailToken, hashEmailToken } from "@/lib/account-security";
import { getCurrentUser } from "@/lib/session";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { env } from "@/lib/env";

export const runtime = "nodejs";

/*
 * The link in a verification email. Single-use, 24 hours (src/lib/account-security.ts).
 *
 * A GET that mutates, which is unusual here and deliberate: it is a link in an
 * email, and the only thing that can follow it is the recipient's browser.
 * Possession of a 256-bit token is the whole authorization, so this route
 * never consults the session to decide WHAT to verify — only where to send the
 * browser afterwards.
 */

const OUTCOMES = {
  verified: "verified",
  invalid: "invalid",
  expired: "expired",
} as const;

function redirectTo(signedIn: boolean, outcome: string): NextResponse {
  // Relative destinations only, and never the token: an absolute URL built
  // from a request header is a redirect the caller controls, and a token in a
  // Location header ends up in access logs on both sides.
  const path = signedIn ? "/chat" : "/sign-in";
  const url = new URL(path, env.appUrl);
  url.searchParams.set("verified", outcome);
  return NextResponse.redirect(url);
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  const user = await getCurrentUser();
  const signedIn = Boolean(user);

  if (!token || token.length < 20 || token.length > 300) {
    return redirectTo(signedIn, OUTCOMES.invalid);
  }

  // Per-token and per-IP, so a stolen-token guessing sweep is bounded even
  // though guessing 256 bits is not a realistic attack.
  const ip = await getClientIp();
  const checks = [rateLimit({ key: `verify-email:token:${hashEmailToken(token)}`, limit: 10, windowSec: 60 * 60 })];
  if (ip !== "unknown") {
    checks.push(rateLimit({ key: `verify-email:ip:${ip}`, limit: 60, windowSec: 60 * 60 }));
  }
  const limits = await Promise.all(checks);
  if (limits.some((limit) => !limit.success)) {
    return redirectTo(signedIn, OUTCOMES.invalid);
  }

  const result = await consumeEmailToken(token);
  if (!result.ok) {
    return redirectTo(signedIn, result.reason === "expired" ? OUTCOMES.expired : OUTCOMES.invalid);
  }

  // Sessions are left alone on purpose, for both purposes. They key on the
  // user id, not the address, so a confirmed change does not invalidate them —
  // and signing someone out for confirming their own email would read as a
  // failure. The change itself is already gated on the current password
  // (POST /api/account/email); "sign out everywhere" is one click away in
  // Settings for anyone who wants it.
  return redirectTo(signedIn, OUTCOMES.verified);
}
