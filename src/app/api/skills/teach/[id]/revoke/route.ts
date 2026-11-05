import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { revokeTaughtSkill } from "@/lib/skills/teach-store";

export const runtime = "nodejs";

/**
 * POST /api/skills/teach/[id]/revoke → { skill }: switched off and out of
 * automatic selection in one write, recorded as a withdrawn consent. Switching
 * it back on is a new decision, made on the Teach page or the skill's page.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const skill = await revokeTaughtSkill(user.id, id, "web");
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ skill });
}
