import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { createNoteSchema } from "@/lib/agents/domain";
import { createAgentNote, findAgent, listAgentNotes } from "@/lib/agents/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** What it knows: every note, readable by the person it is about. */
export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const agent = await findAgent(user.id, id);
  if (!agent) return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404 });
  return NextResponse.json({ notes: await listAgentNotes(user, agent) });
}

export async function POST(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const agent = await findAgent(user.id, id);
  if (!agent) return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404 });
  const parsed = createNoteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "That note could not be read." }, { status: 400 });
  }
  const result = await createAgentNote(user, agent, parsed.data.content);
  return NextResponse.json(result.body, { status: result.status });
}
