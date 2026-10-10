import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import {
  driveResearchInBackground,
  readResearchRun,
  researchEngine,
  reviseResearchPlanInBackground,
} from "@/lib/research/run";
import { RESEARCH_REFUSAL_COPY } from "@/lib/research/entitlement";
import { isAutoModelId } from "@/lib/auto-model";
import {
  RESEARCH_CONTROL_MESSAGE,
  decidePlanSchema,
  errorCodeForControlReason,
  statusForControlReason,
} from "@/app/api/research/protocol";

export const runtime = "nodejs";

/**
 * The scope card's three answers (SPEC §9.4): Start, discard, or revise.
 *
 * This is the gate the in-request pipeline never had. It planned, searched and
 * read in one breath, so the first thing a user saw was the bill. A run waits
 * at `awaiting_plan_confirmation` and does not spend another cent until this
 * route is called.
 *
 * - `confirm`: the questions as the reader left them become the objectives,
 *   the answers become constraints, and the envelope is computed NOW from
 *   that scope and frozen. The drive is nudged under the run's stable owner,
 *   which the gate's own drive released (B1).
 * - `revise`: the run stays at the gate, busy, while the planner reruns with
 *   the edits in the background — five per run, then 429.
 * - `cancel`: the plan is discarded, with no push (B19).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = decidePlanSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const decided = await researchEngine().decidePlan({
    runId: id,
    userId: user.id,
    decision: parsed.data.decision,
    steps: parsed.data.steps,
    queries: parsed.data.queries,
    constraints: parsed.data.constraints,
    pinnedSources: parsed.data.pinnedSources,
    questions: parsed.data.questions,
    answers: parsed.data.answers,
    sources: parsed.data.sources,
    preferredModel: isAutoModelId(parsed.data.preferredModel) ? null : parsed.data.preferredModel ?? null,
  });
  if (!decided.ok) {
    const refusal = decided.refusal;
    return NextResponse.json(
      {
        error: errorCodeForControlReason(decided.reason),
        message: refusal
          ? RESEARCH_REFUSAL_COPY.reasons[refusal.reason]
          : decided.reason
            ? RESEARCH_CONTROL_MESSAGE[decided.reason]
            : "That did not apply.",
        state: decided.state,
        ...(refusal ? { refusal: { reason: refusal.reason, params: refusal.params } } : {}),
      },
      { status: statusForControlReason(decided.reason) }
    );
  }

  // The drive starts only after the decision has committed. Kicking it first
  // would let the driver read the run before the confirmed plan was stored and
  // search the draft queries the user had just edited away.
  if (parsed.data.decision === "confirm") {
    driveResearchInBackground({ runId: id, userId: user.id });
  } else if (parsed.data.decision === "revise") {
    reviseResearchPlanInBackground({ runId: id, userId: user.id });
  }

  const view = await readResearchRun({ runId: id, userId: user.id, after: 0 });
  if (!view) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(view);
}
