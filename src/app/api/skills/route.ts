/**
 * The skills library: the reader's own skills, and one folder per source a
 * group of skills was installed from. The shape is `SkillLibrary` in
 * `src/lib/skills/library-contract.ts`.
 *
 * `GET /api/work/skills` stays what it was, a flat filtered list for the
 * composer and the native clients; this is the view that knows about sources.
 */

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { loadSkillLibrary } from "@/lib/skills/store";

export const runtime = "nodejs";

export async function GET() {
  const { user, error } = await requireUser();
  if (!user) return error;
  return NextResponse.json(await loadSkillLibrary(user.id));
}
