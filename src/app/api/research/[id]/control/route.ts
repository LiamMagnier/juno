import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { driveResearchInBackground, readResearchRun, researchEngine } from "@/lib/research/run";
import {
  RESEARCH_CONTROL_MESSAGE,
  errorCodeForControlReason,
  researchControlSchema,
  statusForControlReason,
} from "@/app/api/research/protocol";

export const runtime = "nodejs";

/**
 * Pause, resume, finish, cancel (SPEC §9.4, §9.7).
 *
 * Each refusal is a 409 carrying the run's actual state rather than a silent
 * success, because the client asked to stop a run that had already stopped for
 * another reason and telling it otherwise would have it report the wrong cause
 * to the user. The engine's conditional state write is what decides: exactly
 * one caller wins, and a cancel racing the driver's own completion cannot
 * rewrite why the run ended.
 *
 * `finish` ("Finish now") marks the plan; the engine stops launching rounds
 * and writes at the next round boundary, which can be minutes away — the
 * response carries `finishRequested` so the panel can say so. On a run that
 * is already writing it is a no-op 200.
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
      : action === "finish"
      ? await engine.requestFinish({ runId: id, userId: user.id })
      : await engine.cancel({ runId: id, userId: user.id });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: errorCodeForControlReason(result.reason),
        message: result.reason ? RESEARCH_CONTROL_MESSAGE[result.reason] : "That did not apply.",
        state: result.state,
      },
      { status: statusForControlReason(result.reason) }
    );
  }

  // A resume needs a driver, and so does a finish on a working run that may
  // have lost its own (B1: the gate endpoints nudge). A pause has nothing to
  // drive, and a cancel is terminal — starting one after either would be a job
  // racing the decision that just stopped it.
  if (action === "resume" || (action === "finish" && result.state !== "paused")) {
    driveResearchInBackground({ runId: id, userId: user.id });
  }

  const view = await readResearchRun({ runId: id, userId: user.id, after: 0 });
  if (!view) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(view);
}
