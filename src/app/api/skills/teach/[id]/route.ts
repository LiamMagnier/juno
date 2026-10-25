import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { loadTaughtSkillForEdit } from "@/lib/skills/teach-store";

export const runtime = "nodejs";

/**
 * GET /api/skills/teach/[id] → the skill, its current version and its steps as
 * editable fields (null when the instructions are free-form), for re-teaching.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const loaded = await loadTaughtSkillForEdit(user.id, id);
  if (!loaded) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(loaded);
}
