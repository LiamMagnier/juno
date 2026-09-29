import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { pendingAgentStarter, findAgent } from "@/lib/agents/store";
export const runtime = "nodejs";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const detail = await findAgent(user.id, id);
  if (!detail) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ message: await pendingAgentStarter(user.id, id) }, { headers: { "Cache-Control": "no-store" } });
}
