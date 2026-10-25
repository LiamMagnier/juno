import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { loadTeachContext } from "@/lib/skills/teach-store";

export const runtime = "nodejs";

/** GET /api/skills/teach/context → { projects, apps }: where a taught skill can apply, and the apps it can name. */
export async function GET() {
  const { user, error } = await requireUser();
  if (!user) return error;
  return NextResponse.json(await loadTeachContext(user.id));
}
