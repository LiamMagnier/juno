import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { isEmailEnabled, sendEmailVerification } from "@/lib/email";
import { issueEmailToken, markEmailVerified } from "@/lib/account-security";
import { env } from "@/lib/env";

export const runtime = "nodejs";

/*
 * Email-verification state for the signed-in account, and the resend.
 *
 * Scoped to the session on both verbs and takes no address in the body, so
 * neither one can be pointed at somebody else's account or used to find out
 * whether an address is registered.
 */

/** Status, for the banner that asks the user to check their inbox. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = await rateLimit({ key: `verification-status:${user.id}`, limit: 120, windowSec: 300 });
  if (!limit.success) return NextResponse.json({ error: "Too many requests." }, { status: 429 });

  const account = await prisma.user.findUnique({
    where: { id: user.id },
    select: { email: true, emailVerified: true },
  });
  return NextResponse.json({
    email: account?.email ?? null,
    verified: Boolean(account?.emailVerified),
    // False means the banner must not offer a "resend" button that cannot work.
    canResend: isEmailEnabled(),
  });
}

/** Send the verification link again. */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const ip = await getClientIp();
  const checks = [rateLimit({ key: `verification-resend:${user.id}`, limit: 5, windowSec: 60 * 60 })];
  if (ip !== "unknown") {
    checks.push(rateLimit({ key: `verification-resend:ip:${ip}`, limit: 20, windowSec: 60 * 60 }));
  }
  const limits = await Promise.all(checks);
  if (limits.some((limit) => !limit.success)) {
    return NextResponse.json({ error: "Too many requests — try again later." }, { status: 429 });
  }

  const account = await prisma.user.findUnique({
    where: { id: user.id },
    select: { email: true, emailVerified: true },
  });
  if (!account) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (account.emailVerified) return NextResponse.json({ ok: true, verified: true });

  if (!isEmailEnabled()) {
    // Same rule as registration: with no mail configured, an address that can
    // never be verified must not become an account that can never spend.
    await markEmailVerified(user.id);
    console.warn("[auth] email delivery is not configured — verifying an address without sending a link", {
      userId: user.id,
    });
    return NextResponse.json({ ok: true, verified: true, skipped: true });
  }

  const token = await issueEmailToken("verify", user.id, account.email);
  const url = new URL("/api/auth/verify-email", env.appUrl);
  url.searchParams.set("token", token);
  await sendEmailVerification(account.email, url.toString());

  return NextResponse.json({ ok: true, verified: false, message: `A new link is on its way to ${account.email}.` });
}
