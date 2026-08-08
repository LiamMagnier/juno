import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import {
  patchSkillSchema,
  serializeSkill,
  serializeSkillVersion,
  trustPermitsAutoSelection,
} from "@/lib/work/skills";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const skill = await prisma.workSkill.findFirst({
    where: { id, userId: user.id, deletedAt: null },
  });
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Version rows have no owner column of their own — ownership is the skill's,
  // exactly as an Artifact's is its conversation's — so they are only ever
  // reached through a head row that has already been matched on `userId`.
  const version = await prisma.workSkillVersion.findFirst({
    where: { skillId: skill.id, version: skill.currentVersion },
  });

  return NextResponse.json({
    skill: serializeSkill(skill),
    // Null rather than a substitute when the pointer names a row that is not
    // there. Handing back the newest version instead would show the user
    // instructions they did not choose under the heading of the one they did.
    version: version ? serializeSkillVersion(version) : null,
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const parsed = patchSkillSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const existing = await prisma.workSkill.findFirst({
    where: { id, userId: user.id, deletedAt: null },
    select: { trust: true, autoSelect: true, securityStatus: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { name, description, enabled, trust } = parsed.data;
  if (enabled === true && existing.securityStatus === "blocked") {
    return NextResponse.json(
      { error: "security_blocked", message: "A skill blocked by its security scan cannot be enabled." },
      { status: 409 }
    );
  }

  // Trust and automatic selection are decided together, against the merged
  // state, not one at a time against the patch. Withdrawing trust has to switch
  // off the automatic selection that trust was what permitted — in the same
  // write. Otherwise the row reads `autoSelect: true, trust: "untrusted"`, and
  // every reader has to decide for itself which of the two columns wins.
  const effectiveTrust = trust ?? existing.trust;
  const requestedAutoSelect = parsed.data.autoSelect ?? existing.autoSelect;
  const effectiveAutoSelect = requestedAutoSelect && trustPermitsAutoSelection(effectiveTrust);

  const skill = await prisma.workSkill.update({
    where: { id, userId: user.id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(trust !== undefined ? { trust } : {}),
      autoSelect: effectiveAutoSelect,
    },
  });

  return NextResponse.json({ skill: serializeSkill(skill) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const skill = await prisma.workSkill.findFirst({
    where: { id, userId: user.id, deletedAt: null },
    select: { id: true },
  });
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Soft delete: a run from last month recorded one of this skill's versions as
  // the thing it followed, and "which skill ran" has to stay answerable after
  // the user has tidied their list. `enabled` and `autoSelect` are cleared in
  // the same write so that a reader which filters on those two and forgets
  // `deletedAt` still refuses to run it — the columns are cheap and the reader
  // that forgets is the one that runs a deleted skill on a schedule at 3am.
  await prisma.workSkill.updateMany({
    where: { id, userId: user.id, deletedAt: null },
    data: { deletedAt: new Date(), enabled: false, autoSelect: false },
  });

  return NextResponse.json({ ok: true });
}
