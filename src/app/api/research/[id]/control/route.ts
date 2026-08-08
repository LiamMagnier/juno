import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { driveResearchInBackground, readResearchRun, researchEngine } from "@/lib/research/run";
import {
  RESEARCH_CONTROL_MESSAGE,
  researchControlSchema,
  statusForControlReason,
} from "@/app/api/research/protocol";

export const runtime = "nodejs";

/**
 * Pause, resume, cancel.
 *
 * Each refusal is a 409 carrying the run's actual state rather than a silent
 * success, because the client asked to stop a run that had already stopped for
 * another reason and telling it otherwise would have it report the wrong cause
 * to the user. The engine's conditional state write is what decides: exactly
 * one caller wins, and a cancel racing the driver's own completion cannot
 * rewrite why the run ended.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = researchControlSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const engine = researchEngine();
  const action = parsed.data.action;
  const result =
    action === "pause"
      ? await engine.pause({ runId: id, userId: user.id })
      : action === "resume"
      ? await engine.resume({ runId: id, userId: user.id })
      : await engine.cancel({ runId: id, userId: user.id });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.reason,
        message: result.reason ? RESEARCH_CONTROL_MESSAGE[result.reason] : "That did not apply.",
        state: result.state,
      },
      { status: statusForControlReason(result.reason) }
    );
  }

  // Only a resume needs a driver. A pause has nothing to drive, and a cancel
  // is terminal — starting one after either would be a job racing the decision
  // that just stopped it.
  if (action === "resume") {
    driveResearchInBackground({ runId: id, userId: user.id });
  }

  const view = await readResearchRun({ runId: id, userId: user.id, after: 0 });
  if (!view) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(view);
}
