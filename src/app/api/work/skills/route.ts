import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { recordWorkAudit } from "@/lib/work/audit";
import { requireUser } from "@/lib/code-remote";
import {
  SKILL_CONTRACT_VERSION,
  createSkillSchema,
  emptySkillContract,
  normalizeSkillSlug,
  parseSkillListQuery,
  serializeSkill,
  serializeSkillVersion,
  skillContractToJson,
  skillSlugFromName,
  trustForOrigin,
  trustPermitsAutoSelection,
} from "@/lib/work/skills";
import { scanSkillVersion } from "@/lib/work/skill-security";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const parsed = parseSkillListQuery(new URL(req.url).searchParams);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid input", parameter: parsed.parameter }, { status: 400 });
  }
  const { enabled, autoSelect, trust, projectId, limit } = parsed.query;

  const skills = await prisma.workSkill.findMany({
    where: {
      userId: user.id,
      // Soft-deleted skills are never listed. The row survives because a run
      // from last month still references one of its versions, and an audit
      // question about that run has to be answerable after the user has tidied
      // their skill list.
      deletedAt: null,
      ...(enabled !== undefined ? { enabled } : {}),
      ...(autoSelect !== undefined ? { autoSelect } : {}),
      ...(trust ? { trust } : {}),
      ...(projectId ? { projectId } : {}),
    },
    orderBy: [{ updatedAt: "desc" }],
    take: limit,
  });

  return NextResponse.json({ skills: skills.map(serializeSkill) });
}

export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const parsed = createSkillSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { name, description, instructions, projectId, origin, autoSelect } = parsed.data;

  const slug = normalizeSkillSlug(parsed.data.slug ?? "") ?? skillSlugFromName(name);
  if (!slug) return NextResponse.json({ error: "invalid_slug" }, { status: 400 });

  // A project id in a request is a claim; the row carrying this user's id is
  // what makes it true.
  if (projectId) {
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: user.id },
      select: { id: true },
    });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Trust is derived from where the skill came from and is never taken from the
  // body. An imported skill starts untrusted, which is what stops the planner
  // reaching for a set of instructions the user has not read; the user can
  // trust it afterwards, deliberately, through PATCH.
  const trust = trustForOrigin(origin);
  const contract = parsed.data.contract ?? emptySkillContract();
  const requestedTools = parsed.data.requestedTools ?? [];
  const securityScan = scanSkillVersion({
    name,
    description,
    instructions,
    requestedTools,
    contract,
  });
  const permissionDigest = createHash("sha256").update(securityScan.permissionFingerprint).digest("hex");

  try {
    const created = await prisma.$transaction(async (tx) => {
      const skill = await tx.workSkill.create({
        data: {
          userId: user.id,
          projectId: projectId ?? null,
          slug,
          name,
          description,
          currentVersion: 1,
          enabled: securityScan.status !== "blocked",
          trust,
          securityStatus: securityScan.status,
          securityUpdatedAt: new Date(),
          // Clamped rather than stored as asked. A row saying
          // `autoSelect: true, trust: "untrusted"` is a contradiction every
          // reader then has to resolve for itself, and the one that resolves it
          // the other way is the one that matters.
          autoSelect: autoSelect && trustPermitsAutoSelection(trust),
        },
      });
      // Version 1 is minted with the skill, in the same transaction. A head row
      // whose `currentVersion` points at nothing is a skill that cannot run and
      // cannot be fixed except by editing it, and a failure between two separate
      // writes is exactly how one gets created.
      const version = await tx.workSkillVersion.create({
        data: {
          skillId: skill.id,
          version: 1,
          instructions,
          contract: skillContractToJson(contract),
          contractVersion: SKILL_CONTRACT_VERSION,
          requestedTools,
          securityStatus: securityScan.status,
          securityScan: securityScan as unknown as Prisma.InputJsonValue,
          permissionDigest,
          requiresConsent: false,
        },
      });
      return { skill, version };
    });

    await recordWorkAudit({
      userId: user.id,
      kind: "skill_security_scanned",
      actor: "web",
      severity: securityScan.status === "blocked" ? "refusal" : securityScan.status === "warning" ? "warning" : "info",
      detail: {
        skillId: created.skill.id,
        skillSlug: created.skill.slug,
        skillVersion: created.version.version,
        scanStatus: securityScan.status,
        findingCount: securityScan.findings.length,
      },
    });

    return NextResponse.json(
      { skill: serializeSkill(created.skill), version: serializeSkillVersion(created.version) },
      { status: 201 }
    );
  } catch (err) {
    // `(userId, slug)` is unique, and the slug may have been derived from the
    // name rather than chosen — so a user creating "Tidy Downloads" twice hits
    // this without ever having typed a slug. Naming the conflict lets the client
    // say which name is taken instead of reporting a server error.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "slug_taken", slug }, { status: 409 });
    }
    throw err;
  }
}
