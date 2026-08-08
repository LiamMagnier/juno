import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { driveResearchInBackground, readResearchRun, researchEngine } from "@/lib/research/run";
import {
  RESEARCH_CONTROL_MESSAGE,
  decidePlanSchema,
  statusForControlReason,
} from "@/app/api/research/protocol";

export const runtime = "nodejs";

/**
 * Confirming — or rejecting — the plan before the expensive stages run.
 *
 * This is the gate the in-request pipeline never had. It planned, searched and
 * read in one breath, so the first thing a user saw was the bill. A run started
 * from the research surface stops at `awaiting_plan_confirmation` and does not
 * spend another cent until this route is called, and the queries the user edits
 * here are the queries that actually get issued.
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
    queries: parsed.data.queries,
    constraints: parsed.data.constraints,
    pinnedSources: parsed.data.pinnedSources,
  });
  if (!decided.ok) {
    return NextResponse.json(
      {
        error: decided.reason,
        message: decided.reason ? RESEARCH_CONTROL_MESSAGE[decided.reason] : "That did not apply.",
        state: decided.state,
      },
      { status: statusForControlReason(decided.reason) }
    );
  }

  // The drive starts only after the decision has committed. Kicking it first
  // would let the driver read the run before the confirmed plan was stored and
  // search the draft queries the user had just edited away.
  if (parsed.data.decision === "confirm") {
    driveResearchInBackground({ runId: id, userId: user.id });
  }

  const view = await readResearchRun({ runId: id, userId: user.id, after: 0 });
  if (!view) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(view);
}
