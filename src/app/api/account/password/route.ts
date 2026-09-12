import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { hashPassword, verifyPasswordConstantTime } from "@/lib/password";

export const runtime = "nodejs";

const schema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8, "Use at least 8 characters.").max(200),
});

/**
 * Change the password from inside the app.
 *
 * Until now the only way to change a password was the emailed reset link,
 * which meant a user who simply wanted a stronger password had to prove they
 * could read their inbox, and a deployment with no mail configured had no way
 * at all.
 *
 * The current password is required — a session alone is not enough, because a
 * stolen session would otherwise become a permanent one — and every other
 * session is invalidated on success, which is the entire point of changing it.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = await rateLimit({ key: `password-change:${user.id}`, limit: 10, windowSec: 60 * 60 });
  if (!limit.success) {
    return NextResponse.json({ error: "Too many attempts — try again later." }, { status: 429 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input.", field: parsed.error.issues[0]?.path[0] ?? null },
      { status: 400 }
    );
  }

  const account = await prisma.user.findUnique({
    where: { id: user.id },
    select: { hashedPassword: true },
  });
  const { ok } = await verifyPasswordConstantTime(parsed.data.currentPassword, account?.hashedPassword);
  if (!account?.hashedPassword) {
    return NextResponse.json(
      { error: "This account signs in with Google or Apple and has no password to change.", field: "currentPassword" },
      { status: 409 }
    );
  }
  if (!ok) {
    return NextResponse.json({ error: "That isn't your current password.", field: "currentPassword" }, { status: 400 });
  }
  if (parsed.data.newPassword === parsed.data.currentPassword) {
    return NextResponse.json({ error: "Choose a password you aren't already using.", field: "newPassword" }, { status: 400 });
  }

  const hashedPassword = await hashPassword(parsed.data.newPassword);
  await prisma.$transaction([
    // sessionVersion rides in the JWT and is re-checked on every session read,
    // so the increment is what actually signs the other devices out. Done in
    // the same transaction as the new hash: a password changed but sessions
    // left alive is the state a user changing their password is trying to end.
    prisma.user.update({
      where: { id: user.id },
      data: { hashedPassword, sessionVersion: { increment: 1 } },
    }),
    prisma.session.deleteMany({ where: { userId: user.id } }),
  ]);

  // The caller's own JWT is now stale too, so the client re-authenticates.
  return NextResponse.json({ ok: true, signedOutEverywhere: true });
}
