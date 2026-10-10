import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { CROSS_MESSAGE_LIMITS } from "@/lib/cross-conversation/policy";
import { sendCrossMessage } from "@/lib/cross-conversation/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * POST /api/cross-messages — one of the user's conversations sends another a
 * message (src/lib/cross-conversation). Called by Code engines that reach the
 * backend: the Mac's Alevr engine (JunoCodeBridge) and env servers (their
 * Chat-bound sends). A Chat turn's own tools call the store directly.
 *
 * Both ends must be the caller's own conversations; the store answers
 * not_found for anything else. Hop, per-turn, hourly and duplicate limits are
 * the store's (policy.ts); this route adds a plain request ceiling.
 */
const schema = z.object({
  from: z.object({
    ref: z.string().max(300).optional(),
    title: z.string().max(300).optional(),
    code: z.object({ deviceId: z.string().min(1).max(128), sessionId: z.string().min(1).max(128) }).optional(),
  }),
  to: z.string().min(3).max(300),
  message: z.string().min(1).max(CROSS_MESSAGE_LIMITS.maxChars + 200),
  notifyWhenIdle: z.boolean().optional(),
  chain: z.object({ chainId: z.string().min(1).max(128), hop: z.number().int().min(0).max(100) }).nullable().optional(),
  sentThisTurn: z.number().int().min(0).max(100).optional(),
});

const STATUS: Record<string, number> = { not_found: 404, offline: 503, rate_limited: 429 };

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limit = await rateLimit({ key: `cross-messages:${user.id}`, limit: 120, windowSec: 60 * 60 });
  if (!limit.success) return NextResponse.json({ error: "Too many messages this hour.", reason: "rate_limited" }, { status: 429 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const outcome = await sendCrossMessage(user.id, parsed.data);
  if (!outcome.ok) return NextResponse.json({ error: outcome.message, reason: outcome.reason }, { status: STATUS[outcome.reason] ?? 422 });
  return NextResponse.json(outcome);
}
