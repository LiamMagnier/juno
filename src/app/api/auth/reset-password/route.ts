import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import {
  hashPasswordResetToken,
  userIdFromPasswordResetIdentifier,
} from "@/lib/password-reset";
import { getClientIp, rateLimit } from "@/lib/rate-limit";

const resetSchema = z.object({
  token: z.string().min(20).max(300),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

const INVALID_LINK = "This reset link is invalid or has expired. Request a new one.";

export async function POST(req: Request) {
  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const parsed = resetSchema.safeParse(input);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input." }, { status: 400 });
  }

  const tokenHash = hashPasswordResetToken(parsed.data.token);
  const ip = await getClientIp();
  const checks = [rateLimit({ key: `password-reset:token:${tokenHash}`, limit: 5, windowSec: 60 * 60 })];
  if (ip !== "unknown") {
    checks.push(rateLimit({ key: `password-reset:complete-ip:${ip}`, limit: 15, windowSec: 60 * 60 }));
  }
  const limits = await Promise.all(checks);
  if (limits.some((limit) => !limit.success)) {
    return NextResponse.json({ error: "Too many attempts. Please request a new reset link." }, { status: 429 });
  }

  const resetToken = await prisma.verificationToken.findUnique({ where: { token: tokenHash } });
  const userId = resetToken ? userIdFromPasswordResetIdentifier(resetToken.identifier) : null;
  if (!resetToken || !userId || resetToken.expires <= new Date()) {
    if (resetToken) {
      await prisma.verificationToken.deleteMany({ where: { token: tokenHash } });
    }
    return NextResponse.json({ error: INVALID_LINK }, { status: 400 });
  }

  const hashedPassword = await hashPassword(parsed.data.password);

  try {
    await prisma.$transaction(async (tx) => {
      // Consuming the token first inside the transaction makes two concurrent
      // submissions race safely: only one can update the password.
      const consumed = await tx.verificationToken.deleteMany({
        where: {
          token: tokenHash,
          identifier: resetToken.identifier,
          expires: { gt: new Date() },
        },
      });
      if (consumed.count !== 1) throw new Error("RESET_TOKEN_ALREADY_CONSUMED");

      await tx.user.update({
        where: { id: userId },
        data: {
          hashedPassword,
          sessionVersion: { increment: 1 },
        },
      });

      // JWT sessions are invalidated by sessionVersion; remove any legacy
      // database sessions as well in case the strategy changes later.
      await tx.session.deleteMany({ where: { userId } });

      // Invalidate reset emails that may have been requested concurrently.
      await tx.verificationToken.deleteMany({ where: { identifier: resetToken.identifier } });
    });
  } catch {
    return NextResponse.json({ error: INVALID_LINK }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
