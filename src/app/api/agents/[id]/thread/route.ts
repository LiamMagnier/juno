import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { ensureAgentThread, findAgent } from "@/lib/agents/store";

export const runtime = "nodejs";

/**
 * The agent's thread, created the first time anything asks for it.
 *
 * POST rather than GET because the first call writes a conversation, and a
 * prefetching browser must not be able to create one by following a link.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const agent = await findAgent(user.id, id);
  if (!agent) return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404 });
  const conversationId = await ensureAgentThread(user.id, agent);
  return NextResponse.json({ conversationId });
}
