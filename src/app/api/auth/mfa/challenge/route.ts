import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyPasswordConstantTime } from "@/lib/password";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { equalizeResponseTime } from "@/lib/account-security";

export const runtime = "nodejs";

/*
 * Sign-in pre-flight: "will this account ask me for a code?"
 *
 * The sign-in form cannot show a code field before it knows one is needed, and
 * it must not show one to everybody — a code box on an account with no second
 * factor is a dead end that people type their password into. So it asks first.
 *
 * Everything about this endpoint is shaped by not becoming an oracle:
 *
 *  - It shares the SIGN-IN rate-limit buckets, not buckets of its own, so a
 *    pre-flight costs an attacker exactly what a sign-in attempt costs. This is
 *    the point: without it the pre-flight would hand out a second, free tranche
 *    of password guesses against the very accounts that have two-step on.
 *  - A password is always verified, against a dummy hash when there is no
 *    account, so "no such user" and "wrong password" take the same work.
 *  - Every refusal — unknown account, wrong password, banned, throttled,
 *    malformed — answers the identical `{ mfaRequired: false }`. The form then
 *    submits to sign-in and gets the same generic failure it always did.
 *  - A floor on the response time hides what little is left.
 *
 * `true` is therefore only ever returned to someone who already holds the
 * correct password for an account that has two-step enabled — which tells them
 * nothing they could not learn by submitting the sign-in form itself.
 */

const schema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

// Identical to src/lib/auth.ts. Kept in step by hand because the two are
// deliberately the SAME buckets: changing one without the other reopens the
// free-guesses hole described above.
const SIGNIN_WINDOW_SEC = 15 * 60;
const SIGNIN_MAX_PER_PAIR = 10;
const SIGNIN_MAX_PER_IP = 30;

const MIN_RESPONSE_MS = 650;

function noChallenge(startedAt: number): Promise<NextResponse> {
  return equalizeResponseTime(startedAt, MIN_RESPONSE_MS).then(() =>
    NextResponse.json({ mfaRequired: false })
  );
}

export async function POST(req: Request) {
  const startedAt = Date.now();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return noChallenge(startedAt);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return noChallenge(startedAt);

  const email = parsed.data.email.toLowerCase();
  const ip = await getClientIp();
  const checks = [
    rateLimit({ key: `signin:pair:${ip}:${email}`, limit: SIGNIN_MAX_PER_PAIR, windowSec: SIGNIN_WINDOW_SEC }),
  ];
  if (ip !== "unknown") {
    checks.push(rateLimit({ key: `signin:ip:${ip}`, limit: SIGNIN_MAX_PER_IP, windowSec: SIGNIN_WINDOW_SEC }));
  }
  const results = await Promise.all(checks);
  if (results.some((r) => !r.success)) return noChallenge(startedAt);

  const user = await prisma.user.findUnique({
    where: { email },
    select: { hashedPassword: true, bannedAt: true, totpEnabledAt: true },
  });
  const { ok } = await verifyPasswordConstantTime(parsed.data.password, user?.hashedPassword);
  if (!user?.hashedPassword || !ok || user.bannedAt || !user.totpEnabledAt) {
    return noChallenge(startedAt);
  }

  await equalizeResponseTime(startedAt, MIN_RESPONSE_MS);
  return NextResponse.json({ mfaRequired: true });
}
