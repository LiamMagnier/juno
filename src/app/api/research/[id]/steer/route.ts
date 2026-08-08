import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { driveResearchInBackground, readResearchRun, researchEngine } from "@/lib/research/run";
import {
  RESEARCH_CONTROL_MESSAGE,
  statusForControlReason,
  steerResearchSchema,
} from "@/app/api/research/protocol";

export const runtime = "nodejs";

/**
 * Steering a run that is already going.
 *
 * The point is that neither a new constraint nor a new source costs the user
 * the work already done. A constraint is written into the plan, so it reaches
 * synthesis however late it arrives; a pinned source sends a run that has moved
 * past gathering back to fetch it, because a source nobody read is a citation
 * the report cannot honour. The engine decides which — see `steer` there.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = steerResearchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const steered = await researchEngine().steer({
    runId: id,
    userId: user.id,
    constraint: parsed.data.constraint,
    sourceUrl: parsed.data.sourceUrl,
  });
  if (!steered.ok) {
    return NextResponse.json(
      {
        error: steered.reason,
        message: steered.reason
          ? RESEARCH_CONTROL_MESSAGE[steered.reason]
          : "That could not be applied.",
        state: steered.state,
      },
      { status: statusForControlReason(steered.reason) }
    );
  }

  // Steering a paused run must not restart it: the user stopped it on purpose,
  // and the constraint is stored either way. Only a run that was already
  // running gets nudged, in case the steer sent it back a stage.
  if (steered.state !== "paused") {
    driveResearchInBackground({ runId: id, userId: user.id });
  }

  const view = await readResearchRun({ runId: id, userId: user.id, after: 0 });
  if (!view) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(view);
}
