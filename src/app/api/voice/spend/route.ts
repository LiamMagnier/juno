import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyState } from "@/lib/crypto";
import { checkBudget, recordSpend } from "@/lib/spend";
import { getUserPlan } from "@/lib/usage";

export const runtime = "nodejs";

/**
 * The relay reporting what a voice call has cost, while it is still running.
 *
 * Voice used to be checked for budget exactly once — when the connect token was
 * minted, before the WebSocket existed — and then billed nothing at all. The
 * relay measured cost accurately and kept it in memory, where it died with the
 * process. A call could run to the provider's session cap without moving the
 * account's spend by a cent, which meant it was invisible to the monthly
 * ceiling, to the usage gauge, and to the platform-wide kill switch.
 *
 * WHY A SEPARATE ROUTE. /api/agent/usage is cookie-authenticated; the relay has
 * no cookie and no database. It does share `AUTH_SECRET`, and already proves
 * Juno's identity to itself with an HMAC token in the other direction, so this
 * is the same construction reversed. The relay asserts only "this is me,
 * reporting for this user"; every figure it sends is still re-costed here.
 *
 * The response carries the budget verdict, which is the second half of the
 * point: the relay polls this every five seconds anyway, so `allowed:false` is
 * what finally lets a voice call be STOPPED mid-session instead of merely
 * regretted afterwards.
 */

const schema = z.object({
  sessionId: z.string().min(1).max(200),
  /** Monotonic per session. With sessionId it makes a retry idempotent. */
  seq: z.number().int().min(1).max(100_000),
  provider: z.string().min(1).max(60),
  /** The DELTA since the relay's last acknowledged report, in USD. */
  costUsd: z.number().min(0).max(1_000),
  audioInSec: z.number().min(0).max(86_400).optional(),
  audioOutSec: z.number().min(0).max(86_400).optional(),
  final: z.boolean().optional(),
});

/** Same shape the relay mints, and the same shared secret — see relay/src/auth.ts. */
function relayCaller(header: string | null): { userId: string } | null {
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const body = verifyState(token);
  if (!body) return null;
  try {
    const payload = JSON.parse(body) as { uid?: unknown; exp?: unknown; aud?: unknown };
    // `aud` pins the direction. Without it, a session token the relay was given
    // to authenticate a USER would also authenticate a spend report.
    if (payload.aud !== "juno.voice.spend") return null;
    if (typeof payload.uid !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return { userId: payload.uid };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const caller = relayCaller(req.headers.get("authorization"));
  if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { sessionId, seq, provider, costUsd } = parsed.data;

  // Existence check only. The plan comes from getUserPlan, which is the one
  // place that resolves subscription state into an effective plan — reading a
  // column here would be a second, quietly divergent answer.
  const user = await prisma.user.findUnique({ where: { id: caller.userId }, select: { id: true } });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  /*
   * Idempotency. The relay retries a delta it could not deliver, so the same
   * (session, seq) can legitimately arrive twice. `idempotencyKey` on ApiSpend
   * is what stops the retry from billing twice; a duplicate is not an error,
   * it is the protocol working, so it answers with the current verdict rather
   * than a failure the relay would have to interpret.
   */
  const idempotencyKey = `voice:${sessionId}:${seq}`;
  const already = await prisma.apiSpend.findFirst({
    where: { userId: user.id, idempotencyKey },
    select: { id: true },
  });

  if (!already && costUsd > 0) {
    // recordSpend is fire-and-forget by design and re-costs from its own
    // pricing table, taking the higher of that and the caller's figure — so a
    // relay that under-reports cannot under-bill, and one that over-reports is
    // believed only because it is the party that actually measured the audio.
    await recordSpend({
      userId: user.id,
      model: `voice:${provider}`,
      kind: "voice",
      source: "web",
      costUsd,
      idempotencyKey,
    });
  }

  const budget = await checkBudget(user.id, await getUserPlan(user.id));
  return NextResponse.json({
    allowed: budget.allowed,
    remainingMicroUsd: budget.remainingMicroUsd,
    duplicate: !!already,
  });
}
