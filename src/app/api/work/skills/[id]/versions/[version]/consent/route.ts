import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { recordWorkAudit } from "@/lib/work/audit";
import { serializeSkillVersion } from "@/lib/work/skills";

export const runtime = "nodejs";

/**
 * Explicitly accepts what a version waits for: a widened permission surface,
 * and (for an imported skill) the scripts in its bundle. The audit row carries
 * the bundle's digest, so "which scripts did I approve" has an answer that
 * cannot drift: the digest names the exact bytes the sandbox will mount.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; version: string }> }
) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id, version: rawVersion } = await params;
  const version = Number(rawVersion);
  if (!Number.isSafeInteger(version) || version < 1) {
    return NextResponse.json({ error: "invalid_version" }, { status: 400 });
  }

  const skill = await prisma.workSkill.findFirst({
    where: { id, userId: user.id, deletedAt: null },
    select: { id: true, slug: true },
  });
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const current = await prisma.workSkillVersion.findFirst({
    where: { skillId: skill.id, skill: { userId: user.id }, version },
    select: { id: true, version: true, securityStatus: true, requiresConsent: true, bundleDigest: true },
  });
  if (!current) return NextResponse.json({ error: "version_not_found" }, { status: 404 });
  if (current.securityStatus === "blocked") {
    return NextResponse.json(
      { error: "security_blocked", message: "This version contains a blocked security finding." },
      { status: 409 }
    );
  }

  const updated = await prisma.workSkillVersion.updateMany({
    where: {
      id: current.id,
      skillId: skill.id,
      skill: { userId: user.id },
      requiresConsent: true,
    },
    data: { requiresConsent: false },
  });
  if (updated.count === 1) {
    await recordWorkAudit({
      userId: user.id,
      kind: "skill_permission_consent",
      actor: "web",
      detail: {
        skillId: skill.id,
        skillSlug: skill.slug,
        skillVersion: version,
        requiresConsent: false,
        ...(current.bundleDigest ? { contentHash: current.bundleDigest } : {}),
      },
    });
  }

  const result = await prisma.workSkillVersion.findFirst({
    where: { id: current.id, skillId: skill.id, skill: { userId: user.id } },
  });
  return NextResponse.json({ version: result ? serializeSkillVersion(result) : null });
}
