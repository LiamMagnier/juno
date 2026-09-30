import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { MAX_TRANSFER_REASON_CHARS } from "@/lib/work/ownership";
import { transferWorkSessionOwner } from "@/lib/work/ownership-store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * Hands a task to another crew member, or back to the person.
 *
 * The only way a task's owner changes after it is created. The body names the
 * member it goes to (`null` for the person) and why; the reason is required
 * because the move is recorded in the task's log and in both members' logs, and
 * a record nobody can explain later is the thing it exists to prevent. The task
 * has to be at a safe point (not mid-step); see `ownerTransferRefusal`.
 */
const transferSchema = z.object({
  toAgentId: z.string().trim().min(1).max(200).nullable(),
  reason: z.string().trim().min(1).max(MAX_TRANSFER_REASON_CHARS),
});

export async function POST(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;

  const limit = await rateLimit({ key: `work:transfer:${user.id}`, limit: 30, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many hand-overs this hour. Try again shortly." },
      { status: 429 }
    );
  }

  const parsed = transferSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", message: "Say who should take the task and why." },
      { status: 400 }
    );
  }

  const outcome = await transferWorkSessionOwner({
    userId: user.id,
    sessionId: id,
    toAgentId: parsed.data.toAgentId,
    reason: parsed.data.reason,
    by: { kind: "person" },
  });
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.code, message: outcome.message }, { status: outcome.status });
  }
  return NextResponse.json({
    sessionId: outcome.sessionId,
    fromAgentId: outcome.fromAgentId,
    toAgentId: outcome.toAgentId,
    summary: outcome.summary,
  });
}
