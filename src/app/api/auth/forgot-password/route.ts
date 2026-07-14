import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { isEmailEnabled, sendEmail } from "@/lib/email";
import { passwordReset } from "@/lib/email-templates";
import { env } from "@/lib/env";
import {
  createPasswordResetToken,
  hashPasswordResetToken,
  PASSWORD_RESET_TTL_MS,
  passwordResetIdentifier,
} from "@/lib/password-reset";

const requestSchema = z.object({
  email: z.string().trim().email().max(200),
});

const GENERIC_MESSAGE = "If an account exists for that email, a password-reset link is on its way.";
const MIN_RESPONSE_MS = 650;

async function accepted(startedAt: number) {
  // Smooth the large timing difference between a database-only miss and an
  // email-provider call, reducing another account-discovery signal.
  const remaining = MIN_RESPONSE_MS - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  return NextResponse.json({ ok: true, message: GENERIC_MESSAGE });
}

export async function POST(req: Request) {
  if (!isEmailEnabled()) {
    return NextResponse.json({ error: "Password-reset email is not configured." }, { status: 503 });
  }
  const startedAt = Date.now();

  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return accepted(startedAt);
  }

  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return accepted(startedAt);

  const email = parsed.data.email.toLowerCase();
  const emailKey = createHash("sha256").update(email, "utf8").digest("hex");
  const ip = await getClientIp();

  // Keep every response identical so this endpoint cannot be used to discover
  // registered addresses. The global bucket also limits proxy-header spoofing.
  const [perEmail, global, perIp] = await Promise.all([
    rateLimit({ key: `password-reset:email:${emailKey}`, limit: 3, windowSec: 60 * 60 }),
    rateLimit({ key: "password-reset:global", limit: 300, windowSec: 60 * 60 }),
    ...(ip === "unknown"
      ? []
      : [rateLimit({ key: `password-reset:ip:${ip}`, limit: 10, windowSec: 60 * 60 })]),
  ]);
  if (!perEmail.success || !global.success || (perIp && !perIp.success)) return accepted(startedAt);

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, hashedPassword: true },
  });
  // OAuth-only accounts do not have a password to replace.
  if (!user?.hashedPassword) return accepted(startedAt);

  const token = createPasswordResetToken();
  const identifier = passwordResetIdentifier(user.id);
  const expires = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

  // A newer email invalidates every older reset link for the account.
  await prisma.$transaction([
    prisma.verificationToken.deleteMany({ where: { identifier } }),
    prisma.verificationToken.create({
      data: { identifier, token: hashPasswordResetToken(token), expires },
    }),
  ]);

  const resetUrl = new URL("/reset-password", env.appUrl);
  // Keep the secret in the URL fragment: browsers do not send fragments to
  // servers or in Referer headers, so access logs never receive the token.
  resetUrl.hash = new URLSearchParams({ token }).toString();
  const template = passwordReset(resetUrl.toString());
  await sendEmail({
    to: user.email,
    subject: template.subject,
    html: template.html,
    text: template.text,
  });

  return accepted(startedAt);
}
