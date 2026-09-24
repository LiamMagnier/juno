import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { patchGoalSchema } from "@/lib/agents/domain";
import { deleteAgentGoal, findAgent, updateAgentGoal } from "@/lib/agents/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; goalId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id, goalId } = await params;
  const agent = await findAgent(user.id, id);
  if (!agent) return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404 });
  const parsed = patchGoalSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "That change could not be read." }, { status: 400 });
  }
  const result = await updateAgentGoal(user, agent, goalId, parsed.data);
  return NextResponse.json(result.body, { status: result.status });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id, goalId } = await params;
  const agent = await findAgent(user.id, id);
  if (!agent) return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404 });
  const result = await deleteAgentGoal(user, agent, goalId);
  return NextResponse.json(result.body, { status: result.status });
}
