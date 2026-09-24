import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { findAgent, listAgentActivity } from "@/lib/agents/store";

export const runtime = "nodejs";

/** The log: what happened to the agent and what its tasks did, newest first. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const agent = await findAgent(user.id, id);
  if (!agent) return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404 });
  const requested = Number(new URL(req.url).searchParams.get("limit"));
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 200) : 60;
  return NextResponse.json({ activity: await listAgentActivity(user.id, agent.id, limit) });
}
