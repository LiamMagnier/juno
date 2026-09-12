import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { verifyPasswordConstantTime } from "@/lib/password";
import { isEmailEnabled, sendEmailChangeVerification } from "@/lib/email";
import { issueEmailToken } from "@/lib/account-security";
import { isOwnerEmail } from "@/lib/owner";
import { env } from "@/lib/env";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().trim().email("That doesn't look like an email address.").max(200),
  // Absent for accounts that have no password (Google/Apple only).
  currentPassword: z.string().max(200).optional(),
});

/**
 * Request a change of the address this account signs in with.
 *
 * Nothing is written to the account here. The new address is only adopted when
 * the link sent to it is opened (src/lib/account-security.ts), so a typo costs
 * nothing and an attacker cannot move an account to an address they control
 * merely by reaching this endpoint.
 *
 * The current password is required when the account has one, for the same
 * reason the password change requires it: the address is the account's
 * recovery path, so changing it from a stolen session must not be possible.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isEmailEnabled()) {
    return NextResponse.json(
      { error: "Changing your email needs mail delivery, which isn't configured on this server." },
      { status: 503 }
    );
  }

  const limit = await rateLimit({ key: `email-change:${user.id}`, limit: 5, windowSec: 60 * 60 });
  if (!limit.success) {
    return NextResponse.json({ error: "Too many attempts — try again later." }, { status: 429 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input.", field: parsed.error.issues[0]?.path[0] ?? "email" },
      { status: 400 }
    );
  }

  const email = parsed.data.email.toLowerCase();
  const account = await prisma.user.findUnique({
    where: { id: user.id },
    select: { email: true, hashedPassword: true },
  });
  if (!account) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (account.hashedPassword) {
    const { ok } = await verifyPasswordConstantTime(parsed.data.currentPassword ?? "", account.hashedPassword);
    if (!ok) {
      return NextResponse.json({ error: "That isn't your current password.", field: "currentPassword" }, { status: 400 });
    }
  }

  if (email === account.email.toLowerCase()) {
    return NextResponse.json({ error: "That's already your email address.", field: "email" }, { status: 400 });
  }
  // Owner addresses are reserved exactly as they are at registration: an
  // ordinary account must never be able to become the identity that holds
  // OWNER capabilities by changing its address to a configured one.
  if (isOwnerEmail(email)) {
    return NextResponse.json({ error: "That address can't be used here.", field: "email" }, { status: 400 });
  }

  const taken = await prisma.user.findUnique({ where: { email }, select: { id: true } });

  // A token is issued (and a mail sent) only for a free address, but the
  // response is the same either way: answering "that's taken" here would turn
  // an authenticated form into a membership oracle for every address someone
  // cares to type. The owner of a taken address simply never gets a mail.
  if (!taken) {
    const token = await issueEmailToken("change", user.id, email);
    const url = new URL("/api/auth/verify-email", env.appUrl);
    url.searchParams.set("token", token);
    await sendEmailChangeVerification(email, url.toString());
  }

  return NextResponse.json({
    ok: true,
    message: `Check ${email} for a link confirming the change. Your current address keeps working until you do.`,
  });
}
