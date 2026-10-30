import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { keepNoteSchema, patchNoteSchema } from "@/lib/agents/domain";
import { deleteAgentNote, findAgent, keepAgentNote, updateAgentNote } from "@/lib/agents/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; noteId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id, noteId } = await params;
  const agent = await findAgent(user.id, id);
  if (!agent) return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404 });
  const body = await req.json().catch(() => null);
  // `{ action: "keep" }` keeps a note the agent saved in a task and that waited
  // for review (src/lib/agents/note-review.ts); anything else is an edit.
  if (keepNoteSchema.safeParse(body).success) {
    const kept = await keepAgentNote(user, agent, noteId);
    return NextResponse.json(kept.body, { status: kept.status });
  }
  const parsed = patchNoteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "That note could not be read." }, { status: 400 });
  }
  const result = await updateAgentNote(user, agent, noteId, parsed.data.content);
  return NextResponse.json(result.body, { status: result.status });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id, noteId } = await params;
  const agent = await findAgent(user.id, id);
  if (!agent) return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404 });
  const result = await deleteAgentNote(user, agent, noteId);
  return NextResponse.json(result.body, { status: result.status });
}
