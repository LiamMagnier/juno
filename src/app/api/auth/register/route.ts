import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureUserDefaults } from "@/lib/auth";
import { hashPassword } from "@/lib/password";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { isOwnerEmail } from "@/lib/owner";

const schema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  email: z.string().email().max(200),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

export async function POST(req: Request) {
  const ip = await getClientIp();
  // Per-IP limit plus a global cap so X-Forwarded-For spoofing can't fan out signups.
  const [perIp, global] = await Promise.all([
    rateLimit({ key: `register:${ip}`, limit: 5, windowSec: 3600 }),
    rateLimit({ key: "register:global", limit: 200, windowSec: 3600 }),
  ]);
  if (!perIp.success || !global.success) {
    return NextResponse.json({ error: "Too many sign-up attempts. Please try again later." }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input." }, { status: 400 });
  }

  const email = parsed.data.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing || isOwnerEmail(email)) {
    // Match the externally visible success path so registration cannot be used
    // as an account-membership oracle. Password hashing also narrows the timing
    // difference without mutating the existing account. Configured owner
    // addresses are also reserved: an unverified public registration can never
    // become the identity that receives OWNER capabilities.
    await hashPassword(parsed.data.password);
    return NextResponse.json({ ok: true }, { status: 201 });
  }

  const hashedPassword = await hashPassword(parsed.data.password);
  const user = await prisma.user.create({
    data: { email, name: parsed.data.name ?? null, hashedPassword },
  });
  await ensureUserDefaults(user.id);

  return NextResponse.json({ ok: true }, { status: 201 });
}
