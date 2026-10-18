import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { sessionCommandRateLimit } from "@/lib/code-session-command-route";
import { runApprovalSchema } from "@/lib/runs/protocol";
import { decideRunApproval } from "@/lib/runs/remote-control";
import { prismaRunControlDeps, remoteActorFor } from "@/lib/runs/remote-control-prisma";

export const runtime = "nodejs";

/**
 * Answer one pending approval on a live run. A Code answer is queued for the
 * Mac that asked, which still applies its own ladder and floor; a Work answer
 * goes through the Work decision route, digest and policy checks included.
 * Nothing here can approve what the run did not ask, or approve in a mode
 * that forbids acting. The rules are in src/lib/runs/remote-control.ts.
 */
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const limited = await sessionCommandRateLimit(user.id);
  if (limited) return limited;
  const parsed = runApprovalSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "That answer could not be read." }, { status: 400 });
  }
  const result = await decideRunApproval(prismaRunControlDeps(req), {
    userId: user.id,
    actor: await remoteActorFor(req),
    ref: parsed.data.run,
    approvalId: parsed.data.approvalId,
    approve: parsed.data.approve,
    actionDigest: parsed.data.actionDigest ?? null,
  });
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
