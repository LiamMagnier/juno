import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import {
  SKILL_CONTRACT_VERSION,
  emptySkillContract,
  mintSkillVersionSchema,
  nextSkillVersion,
  parseRequestedTools,
  parseSkillContract,
  serializeSkill,
  serializeSkillVersion,
  skillContractToJson,
  type WorkSkillVersionContent,
} from "@/lib/work/skills";

export const runtime = "nodejs";

const VERSION_LIST_DEFAULT_LIMIT = 50;
const VERSION_LIST_MAX_LIMIT = 200;

/**
 * How many times to re-derive the version number when another writer takes it
 * first. Two tabs saving the same skill at once is the realistic case and it
 * settles in one extra pass; anything past that is a bug worth surfacing rather
 * than a race worth looping on. The shape follows `createRun`'s attempt
 * allocation in `src/lib/work/store.ts`, for the same reason it exists there.
 */
const VERSION_ALLOCATION_TRIES = 4;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  // Version rows carry no owner column; ownership is the head row's, so the
  // head is loaded with `userId` in the WHERE before anything else is read.
  const skill = await prisma.workSkill.findFirst({
    where: { id, userId: user.id, deletedAt: null },
    select: { id: true },
  });
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rawLimit = Number(
    new URL(req.url).searchParams.get("limit") ?? String(VERSION_LIST_DEFAULT_LIMIT)
  );
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), VERSION_LIST_MAX_LIMIT)
    : VERSION_LIST_DEFAULT_LIMIT;

  const versions = await prisma.workSkillVersion.findMany({
    where: { skillId: skill.id },
    orderBy: { version: "desc" },
    take: limit,
  });

  return NextResponse.json({ versions: versions.map(serializeSkillVersion) });
}

/**
 * Mints a version and moves the pointer to it.
 *
 * Nothing here checks the version's `requestedTools` against anything the user
 * has granted, and that is deliberate rather than an omission. A declaration is
 * a request: `resolveSkillPermissions` intersects it with the account, project
 * and host grants at the moment the skill runs, so asking for a tool that has
 * never been granted is harmless. Refusing the declaration at write time would
 * instead make a skill undeclarable on the machine that happens to lack the
 * connector today, and would tempt whoever hit that into inverting the check
 * into an allowance.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const parsed = mintSkillVersionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const skill = await prisma.workSkill.findFirst({
    where: { id, userId: user.id, deletedAt: null },
    select: { id: true },
  });
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { restoreVersion } = parsed.data;
  let content: WorkSkillVersionContent;

  if (restoreVersion !== undefined) {
    const source = await prisma.workSkillVersion.findFirst({
      where: { skillId: skill.id, version: restoreVersion },
    });
    if (!source) return NextResponse.json({ error: "version_not_found" }, { status: 404 });
    // A restore copies the old content into a new version rather than moving
    // `currentVersion` backwards. History stays append-only, so "what was this
    // skill doing on the 3rd" keeps its answer, and the restore is itself a
    // dated row rather than an invisible pointer move.
    content = {
      instructions: source.instructions,
      contract: parseSkillContract(source.contract),
      contractVersion: SKILL_CONTRACT_VERSION,
      requestedTools: parseRequestedTools(source.requestedTools),
    };
  } else {
    content = {
      // `instructions` is present whenever `restoreVersion` is absent — the
      // schema's refine enforces exactly one of the two — but the type does not
      // know that, and asserting it here would be the assertion that is wrong
      // the day the refine is edited.
      instructions: parsed.data.instructions ?? "",
      contract: parsed.data.contract ?? emptySkillContract(),
      contractVersion: SKILL_CONTRACT_VERSION,
      requestedTools: parsed.data.requestedTools ?? [],
    };
  }
  if (content.instructions.length === 0) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  for (let tries = 0; tries < VERSION_ALLOCATION_TRIES; tries++) {
    try {
      const minted = await prisma.$transaction(async (tx) => {
        // The highest version that exists, never `currentVersion`. The pointer
        // moves backwards on a restore, so a skill on five versions restored to
        // three would try to mint version 4 — a number already taken — and the
        // unique index would fail every subsequent edit of that skill.
        const highest = await tx.workSkillVersion.findFirst({
          where: { skillId: skill.id },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        const version = await tx.workSkillVersion.create({
          data: {
            skillId: skill.id,
            version: nextSkillVersion(highest?.version ?? 0),
            instructions: content.instructions,
            contract: skillContractToJson(content.contract),
            contractVersion: content.contractVersion,
            requestedTools: content.requestedTools,
          },
        });
        // The pointer moves in the same transaction as the row it points at,
        // so a failure between the two cannot leave a head naming a version
        // that was never written.
        const updated = await tx.workSkill.update({
          where: { id: skill.id, userId: user.id },
          data: { currentVersion: version.version },
        });
        return { skill: updated, version };
      });

      return NextResponse.json(
        { skill: serializeSkill(minted.skill), version: serializeSkillVersion(minted.version) },
        { status: 201 }
      );
    } catch (err) {
      // `(skillId, version)` is the only unique constraint this write can
      // violate, so a P2002 means another editor took the number between the
      // read and the insert. Re-deriving it is the whole recovery.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
    }
  }

  return NextResponse.json({ error: "version_conflict" }, { status: 409 });
}
