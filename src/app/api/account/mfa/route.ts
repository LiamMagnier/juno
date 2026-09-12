import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { getMfaStatus } from "@/lib/account-security";

export const runtime = "nodejs";

/**
 * What the Settings → Account security panel needs to draw itself.
 *
 * `hasPassword` rides along because the same panel decides whether to ask for
 * a current password: an account that only ever signed in with Google has none
 * to ask for, and a form that demands one would be unusable rather than
 * strict. It says whether a password exists, never anything about it.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = await rateLimit({ key: `mfa-status:${user.id}`, limit: 120, windowSec: 300 });
  if (!limit.success) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  // Never returns the secret or any code — only the shape of the enrolment.
  const [status, account] = await Promise.all([
    getMfaStatus(user.id),
    prisma.user.findUnique({ where: { id: user.id }, select: { hashedPassword: true } }),
  ]);
  return NextResponse.json({
    enabled: status.enabled,
    pending: status.pending,
    enabledAt: status.enabledAt?.toISOString() ?? null,
    recoveryCodesRemaining: status.recoveryCodesRemaining,
    hasPassword: Boolean(account?.hashedPassword),
  });
}
