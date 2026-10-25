import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { taughtSkillSaveSchema } from "@/lib/skills/teach";
import { findTaughtSkillByKey, saveTaughtSkill } from "@/lib/skills/teach-store";

export const runtime = "nodejs";

/*
 * Teach Juno (src/lib/skills/teach.ts).
 *
 *   GET  /api/skills/teach?key=…   → { skill | null }   was this chat draft saved, and as what
 *   POST /api/skills/teach         TaughtSkillSave → 201 { outcome, skill, version, reason, message }
 *
 * A save creates the skill switched OFF unless the body says `enable: true`
 * AND carries the permission fingerprint the page showed when the person
 * confirmed it — the store checks the two match before anything runs.
 */

export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const key = new URL(req.url).searchParams.get("key")?.trim() ?? "";
  if (!key || key.length > 200) return NextResponse.json({ error: "Invalid input", parameter: "key" }, { status: 400 });
  const skill = await findTaughtSkillByKey(user.id, key);
  return NextResponse.json({
    skill: skill
      ? {
          id: skill.id,
          slug: skill.slug,
          name: skill.name,
          enabled: skill.enabled,
          currentVersion: skill.currentVersion,
          projectId: skill.projectId,
          securityStatus: skill.securityStatus,
        }
      : null,
  });
}

export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const parsed = taughtSkillSaveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", message: "Every skill needs a name and at least one step. Nothing was saved." },
      { status: 400 }
    );
  }
  const result = await saveTaughtSkill(user.id, parsed.data, { actor: "web" });
  if (!result.ok) return NextResponse.json({ error: result.error, message: result.message }, { status: result.status });
  const { ok: _ok, ...body } = result;
  return NextResponse.json(body, { status: result.outcome === "created" ? 201 : 200 });
}
