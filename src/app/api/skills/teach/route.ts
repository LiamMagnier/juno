import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { taughtSaveRefusal, taughtSkillSaveSchema } from "@/lib/skills/teach";
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
 * ticked "I've reviewed it", equal to the fingerprint of what is being saved.
 * That catches a page gone stale (the list changed after the box was ticked);
 * it does not prove a person read anything, since any client can compute the
 * fingerprint of its own payload. See `teachEnableDecision`.
 *
 * A body the schema refuses gets a sentence naming what was wrong
 * (`taughtSaveRefusal`), never one fixed sentence for every field.
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
    const { field, message } = taughtSaveRefusal(parsed.error.issues);
    return NextResponse.json({ error: "Invalid input", ...(field ? { field } : {}), message }, { status: 400 });
  }
  const result = await saveTaughtSkill(user.id, parsed.data, { actor: "web" });
  if (!result.ok) return NextResponse.json({ error: result.error, message: result.message }, { status: result.status });
  const { ok: _ok, ...body } = result;
  return NextResponse.json(body, { status: result.outcome === "created" ? 201 : 200 });
}
