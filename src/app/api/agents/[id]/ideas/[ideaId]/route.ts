import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { patchIdeaSchema } from "@/lib/agents/domain";
import { decideAgentIdea, findAgent } from "@/lib/agents/store";

export const runtime = "nodejs";

/** Start or dismiss an idea. Start answers 409 `confirm_expensive` with the estimate when a person has to say yes first. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; ideaId: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id, ideaId } = await params;
  const agent = await findAgent(user.id, id);
  if (!agent) return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404 });
  const parsed = patchIdeaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "That could not be read." }, { status: 400 });
  }
  const result = await decideAgentIdea(user, agent, ideaId, parsed.data);
  return NextResponse.json(result.body, { status: result.status });
}
