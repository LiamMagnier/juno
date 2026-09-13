import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { driveResearchInBackground, readResearchRun, researchEngine } from "@/lib/research/run";
import {
  RESEARCH_CONTROL_MESSAGE,
  answerClarificationsSchema,
  statusForControlReason,
} from "@/app/api/research/protocol";

export const runtime = "nodejs";

/**
 * Answering what the run asked before it planned.
 *
 * The gate this serves is the one ChatGPT's deep research opens with and Juno
 * did not have: a one-line request under-determines a week of work, and a
 * planner handed the ambiguity resolves it by guessing. The guess then
 * propagates into every sub-question, every worker brief and the report, where
 * it is expensive to notice and impossible to undo.
 *
 * ANSWERING IS OPTIONAL, which is why there is no decision field. An empty
 * `answers` object is a valid submission meaning "research it as I wrote it" —
 * the run unblocks either way, and the only difference is how much the planner
 * has to go on. There is nothing here to decline.
 *
 * The engine drops any answer whose id the run did not ask, so a crafted body
 * cannot write arbitrary constraints into somebody's plan.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = answerClarificationsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const answered = await researchEngine().answerClarifications({
    runId: id,
    userId: user.id,
    answers: parsed.data.answers,
  });
  if (!answered.ok) {
    return NextResponse.json(
      {
        error: answered.reason,
        message: answered.reason ? RESEARCH_CONTROL_MESSAGE[answered.reason] : "That did not apply.",
        state: answered.state,
      },
      { status: statusForControlReason(answered.reason) },
    );
  }

  // Planning is cheap and the user is watching, so the run is driven onward
  // here rather than waiting for a poll — the same shape the plan gate uses.
  driveResearchInBackground({ runId: id, userId: user.id });
  return NextResponse.json({ run: await readResearchRun({ runId: id, userId: user.id }) });
}
