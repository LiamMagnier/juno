/**
 * One installed source: switch it on or off, or remove it with its skills.
 *
 * Both act on the source as a unit, which is the reason sources exist: a
 * repository of seventeen skills is switched off or removed in one press, not
 * seventeen.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { recordWorkAudit } from "@/lib/work/audit";
import { findUserSource } from "@/lib/skills/store";
import { serializeSkillSource } from "@/lib/skills/sources";
import type { SkillSourceRemoval } from "@/lib/skills/library-contract";
import { editRateLimited, sourceNotFound } from "@/app/api/skills/sources/shared";

export const runtime = "nodejs";

const patchSchema = z.object({ enabled: z.boolean() }).strict();

/**
 * The source's own switch. Each skill's switch is left exactly as it was, so
 * turning the source back on restores what was on before; chat and tasks read
 * the two together (`AVAILABLE_SKILL_WHERE`).
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const refused = await editRateLimited(user.id);
  if (refused) return refused;

  const { id } = await params;
  const existing = await findUserSource(user.id, id);
  if (!existing) return sourceNotFound();

  const source = await prisma.workSkillSource.update({
    where: { id: existing.id, userId: user.id },
    data: { enabled: parsed.data.enabled },
  });

  if (existing.enabled !== source.enabled) {
    const count = await prisma.workSkill.count({
      where: { userId: user.id, sourceId: source.id, deletedAt: null },
    });
    await recordWorkAudit({
      userId: user.id,
      kind: "skill_applied",
      actor: "web",
      detail: {
        action: source.enabled ? "source_enabled" : "source_disabled",
        enabled: source.enabled,
        count,
        requestId: source.id,
      },
    });
  }

  return NextResponse.json({ source: serializeSkillSource(source) });
}

/**
 * Removes a source and every skill installed from it.
 *
 * The skills are soft-deleted the way a single skill is (`deletedAt`, and
 * `enabled`/`autoSelect` cleared in the same write, so a reader that forgets
 * `deletedAt` still refuses them): a run from last month followed one of their
 * versions, and "which skill ran" has to stay answerable. The source row goes,
 * and the foreign key clears the pointers. Their slugs are freed again the
 * next time something is installed under the same name.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const refused = await editRateLimited(user.id);
  if (refused) return refused;

  const { id } = await params;
  const source = await findUserSource(user.id, id);
  if (!source) return sourceNotFound();

  const removed = await prisma.$transaction(async (tx) => {
    const skills = await tx.workSkill.updateMany({
      where: { userId: user.id, sourceId: source.id, deletedAt: null },
      data: { deletedAt: new Date(), enabled: false, autoSelect: false },
    });
    await tx.workSkillSource.deleteMany({ where: { id: source.id, userId: user.id } });
    return skills.count;
  });

  await recordWorkAudit({
    userId: user.id,
    kind: "skill_applied",
    actor: "web",
    detail: { action: "source_removed", count: removed, requestId: source.id },
  });

  return NextResponse.json({ removed } satisfies SkillSourceRemoval);
}
