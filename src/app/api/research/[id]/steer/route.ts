import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { driveResearchInBackground, readResearchRun, researchEngine } from "@/lib/research/run";
import {
  RESEARCH_CONTROL_MESSAGE,
  errorCodeForControlReason,
  statusForControlReason,
  steerResearchSchema,
} from "@/app/api/research/protocol";

export const runtime = "nodejs";

/**
 * Steering a run that is already going.
 *
 * Guidance ("Guide the research", SPEC §9.7) is queued on the plan and takes
 * effect at the next round boundary, where it becomes a constraint every
 * later brief, the lead's review and the writer read; the response says so
 * (`queued`, `appliesAt: "next_round"`). A constraint or a pinned source keeps
 * its old immediate path: a constraint is written into the plan, and a source
 * sends a run that moved past gathering back to fetch it — the engine decides
 * which, see `steer` there.
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
    guidance: parsed.data.guidance,
  });
  if (!steered.ok) {
    return NextResponse.json(
      {
        error: errorCodeForControlReason(steered.reason),
        message: steered.reason
          ? RESEARCH_CONTROL_MESSAGE[steered.reason]
          : "That could not be applied.",
        state: steered.state,
      },
      { status: statusForControlReason(steered.reason) }
    );
  }

  // Steering a paused run must not restart it: the user stopped it on purpose,
  // and the guidance is stored either way. Only a run that was already
  // running gets nudged, in case the steer sent it back a stage.
  if (steered.state !== "paused") {
    driveResearchInBackground({ runId: id, userId: user.id });
  }

  const view = await readResearchRun({ runId: id, userId: user.id, after: 0 });
  if (!view) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(
    steered.queued ? { ...view, queued: true, appliesAt: "next_round" as const } : view
  );
}
