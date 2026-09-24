import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { startAgentTaskSchema } from "@/lib/agents/domain";
import { findAgent, startAgentTask } from "@/lib/agents/store";

export const runtime = "nodejs";

/**
 * Starts a task as the agent, in its thread, under its autonomy.
 *
 * Answers 409 `confirm_expensive` with the estimate when the cost preflight
 * says a person should say yes first; the page asks and sends the same request
 * again with `confirmExpensive`, which lands on the same idempotency key.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const agent = await findAgent(user.id, id);
  if (!agent) return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404 });
  const parsed = startAgentTaskSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "That task could not be read." }, { status: 400 });
  }
  const outcome = await startAgentTask(user, agent, parsed.data);
  switch (outcome.kind) {
    case "started":
      return NextResponse.json(
        { sessionId: outcome.sessionId, conversationId: outcome.conversationId, replay: outcome.replay },
        { status: outcome.replay ? 200 : 201 }
      );
    case "confirm":
      return NextResponse.json(
        {
          error: "confirm_expensive",
          estimatedCostMicroUsd: outcome.estimatedCostMicroUsd,
          message: `This will cost about $${(outcome.estimatedCostMicroUsd / 1_000_000).toFixed(2)} of your usage window. Start it?`,
        },
        { status: 409 }
      );
    case "refused":
      return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
