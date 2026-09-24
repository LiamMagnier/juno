import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { createGoalSchema } from "@/lib/agents/domain";
import { createAgentGoal, findAgent } from "@/lib/agents/store";
import { serializeGoal } from "@/lib/agents/types";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const agent = await findAgent(user.id, id);
  if (!agent) return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404 });
  const goals = await prisma.agentGoal.findMany({
    where: { userId: user.id, agentId: agent.id },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  return NextResponse.json({ goals: goals.map(serializeGoal) });
}

export async function POST(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const agent = await findAgent(user.id, id);
  if (!agent) return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404 });
  const parsed = createGoalSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "That goal could not be read." }, { status: 400 });
  }
  const result = await createAgentGoal(user, agent, parsed.data);
  return NextResponse.json(result.body, { status: result.status });
}
