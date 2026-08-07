import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { decideActionApproval, type ActionDecisionResult } from "@/lib/action-approval-store";

export const runtime = "nodejs";

const schema = z.object({
  decision: z.enum(["allow_once", "allow_scope", "deny"]),
  // Not optional, and never defaulted from the row being decided. The digest is
  // what binds this answer to the exact bytes the person was shown; letting the
  // server supply it would turn "I approved sending this message to Dana" into
  // "I approved whatever is currently sitting under that id".
  receiptDigest: z.string().min(1).max(200),
});

type RefusalCode = Exclude<ActionDecisionResult, { ok: true }>["code"];

/**
 * How each typed refusal reaches the network.
 *
 * These are split rather than collapsed into 400 because the client behaves
 * differently for each: 409 means re-read the card and ask again, 410 means the
 * request is gone and the UI should retire it, 403 means the account's own
 * permissions refuse it and asking again will not help. A single status would
 * make all of them look like a client bug.
 *
 * `digest_mismatch` is a conflict, not a validation error: the body is
 * well-formed, it simply describes a different action than the row does.
 */
const REFUSAL_STATUS: Record<RefusalCode, number> = {
  not_found: 404,
  digest_mismatch: 409,
  policy_changed: 409,
  expired: 410,
  already_decided: 409,
  not_scope_allowable: 400,
  blocked: 403,
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  // The store owns every check that matters — digest, expiry, current policy,
  // whether this risk class may be allowed for the whole scope — and answers
  // with a typed code. This route deliberately adds none of its own: a second
  // copy of those rules here would be the copy that drifts.
  const result = await decideActionApproval({
    userId: user.id,
    id,
    decision: parsed.data.decision,
    receiptDigest: parsed.data.receiptDigest,
    decidedVia: "web",
  });

  if (!result.ok) {
    // The code travels beside the message so the client can act on it, and the
    // message travels beside the code so a client that has not learned this one
    // yet still has something true to show the person.
    return NextResponse.json(
      { error: result.message, code: result.code },
      { status: REFUSAL_STATUS[result.code] }
    );
  }

  return NextResponse.json({ approval: result.approval });
}
