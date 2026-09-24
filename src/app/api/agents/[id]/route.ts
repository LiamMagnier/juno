import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { patchAgentSchema } from "@/lib/agents/domain";
import { loadAgentDetail, retireAgentForUser, updateAgentForUser } from "@/lib/agents/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** Everything the agent's page draws: the agent, its goals, ideas, notes, routines and recent tasks. */
export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const detail = await loadAgentDetail(user.id, id);
  if (!detail) return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404 });
  return NextResponse.json(detail);
}

/** Edits the profile, the autonomy and the apps, or pauses and resumes it. */
export async function PATCH(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const parsed = patchAgentSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "That change could not be read." }, { status: 400 });
  }
  const result = await updateAgentForUser(user, id, parsed.data);
  return NextResponse.json(result.body, { status: result.status });
}

/** Retires it. Its routines stop; its thread and its tasks stay, as ordinary chats and tasks. */
export async function DELETE(_req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const result = await retireAgentForUser(user, id);
  return NextResponse.json(result.body, { status: result.status });
}
