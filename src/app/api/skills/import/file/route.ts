import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { MAX_SKILL_MD_CHARS, parseSkillMd, SKILL_MD_REFUSAL_MESSAGES } from "@/lib/skills/skill-md";

export const runtime = "nodejs";

/** Preview only. Saving uses the normal scanned, versioned skills endpoint. */
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const input = z.object({ content: z.string().max(MAX_SKILL_MD_CHARS) }).safeParse(await req.json().catch(() => null));
  if (!input.success) return NextResponse.json({ error: "Invalid or oversized SKILL.md" }, { status: 400 });
  const parsed = parseSkillMd(input.data.content);
  if (!parsed.ok) return NextResponse.json({ error: SKILL_MD_REFUSAL_MESSAGES[parsed.reason] }, { status: 400 });
  return NextResponse.json({ skill: parsed.skill });
}
