import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import {
  createSkillSchema,
  emptySkillContract,
  normalizeSkillSlug,
  parseSkillListQuery,
  serializeSkill,
  serializeSkillVersion,
  skillSlugFromName,
} from "@/lib/work/skills";
import { createSkillWithFirstVersion } from "@/lib/skills/store";
import {
  AVAILABLE_SKILL_WHERE,
  UNAVAILABLE_SKILL_WHERE,
  serializeLibrarySkill,
  serializeSkillSource,
} from "@/lib/skills/sources";
import { ownsEverySkillResource } from "@/app/api/work/skills/resources";

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
      // Assistants live in this table too and have their own page and API.
      kind: "skill",
      // `enabled` asks whether chat and tasks may use a skill, which is its own
      // switch AND its source's: the composer lists `?enabled=true`, and a
      // source switched off has to take its skills out of that menu.
      ...(enabled === true ? AVAILABLE_SKILL_WHERE : enabled === false ? UNAVAILABLE_SKILL_WHERE : {}),
      ...(autoSelect !== undefined ? { autoSelect } : {}),
      ...(trust ? { trust } : {}),
      ...(projectId ? { projectId } : {}),
    },
    orderBy: [{ updatedAt: "desc" }],
    take: limit,
  });

  // The sources these skills came from, so a menu can group them without a
  // second request. Each skill also carries `sourceId` and `sourcePath`; the
  // rest of its shape is `ClientWorkSkill` unchanged.
  const sourceIds = [...new Set(skills.map((skill) => skill.sourceId).filter((id): id is string => !!id))];
  const sources = sourceIds.length
    ? await prisma.workSkillSource.findMany({ where: { userId: user.id, id: { in: sourceIds } } })
    : [];

  return NextResponse.json({
    skills: skills.map(serializeLibrarySkill),
    sources: sources.map(serializeSkillSource),
  });
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
  // body — `createSkillWithFirstVersion` does that derivation, along with the
  // scan, the `autoSelect` clamp and the one transaction that mints the head row
  // and version 1 together. This route keeps only what is about THIS request:
  // who owns the project, and whose files the contract names.
  const contract = parsed.data.contract ?? emptySkillContract();
  const requestedTools = parsed.data.requestedTools ?? [];

  // The files the skill says it brings, checked before anything is written. An
  // imported contract can name any id its author felt like typing, and the only
  // thing that makes one of them a file this skill may carry is an `Attachment`
  // row with this user on it.
  //
  // Refused rather than quietly pruned, and the sentence says which way round
  // it is. A skill shared from another account names that account's files, and
  // importing it with the list silently emptied would hand the reader a skill
  // that looks complete, runs, and produces the wrong document — whereas a
  // refusal names the one thing they have to do, which is attach their own
  // copy. Missing and not-yours are answered identically, so this route is not
  // an oracle for which attachment ids exist.
  if (!(await ownsEverySkillResource(user.id, contract.resourceAttachmentIds))) {
    return NextResponse.json(
      {
        error: "resource_not_found",
        message:
          "One of the files this skill brings is not in your library, so nothing was saved. A skill can only carry files from the account it is saved in.",
      },
      { status: 404 }
    );
  }

  const created = await createSkillWithFirstVersion({
    userId: user.id,
    slug,
    name,
    description,
    instructions,
    projectId: projectId ?? null,
    contract,
    requestedTools,
    origin,
    autoSelect,
  });

  // `(userId, slug)` is unique, and the slug may have been derived from the
  // name rather than chosen — so a user creating "Tidy Downloads" twice reaches
  // here without ever having typed a slug. Naming the conflict lets the client
  // say which name is taken instead of reporting a server error.
  if (!created.ok) return NextResponse.json({ error: "slug_taken", slug: created.slug }, { status: 409 });

  return NextResponse.json(
    { skill: serializeSkill(created.skill), version: serializeSkillVersion(created.version) },
    { status: 201 }
  );
}
