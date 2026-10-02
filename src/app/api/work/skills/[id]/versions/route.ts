import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import {
  SKILL_CONTRACT_VERSION,
  emptySkillContract,
  mintSkillVersionSchema,
  parseRequestedTools,
  parseSkillContract,
  serializeSkill,
  serializeSkillVersion,
  type WorkSkillVersionContent,
} from "@/lib/work/skills";
import { mintSkillVersion } from "@/lib/skills/store";
import { ownsEverySkillResource } from "@/app/api/work/skills/resources";

export const runtime = "nodejs";

const VERSION_LIST_DEFAULT_LIMIT = 50;
const VERSION_LIST_MAX_LIMIT = 200;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  // Version rows carry no owner column; ownership is the head row's, so the
  // head is loaded with `userId` in the WHERE before anything else is read.
  const skill = await prisma.workSkill.findFirst({
    where: { id, userId: user.id, deletedAt: null },
    select: { id: true, name: true, description: true },
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
    select: { id: true, name: true, description: true },
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
    //
    // Its file list comes with it, and is NOT re-checked against the attachment
    // library below. Those ids cleared the ownership check when the version
    // they come from was written, so they are this user's own files or they are
    // nothing; refusing over a file deleted since would make an old version
    // unrestorable, which is the one thing a restore exists to prevent. The
    // executor drops what it can no longer read and says so, which is where a
    // missing file belongs — in the run that needed it.
    content = {
      instructions: source.instructions,
      contract: parseSkillContract(source.contract),
      // THE SOURCE'S STAMP, not this build's. The stamp exists so a reader can
      // tell "a shape that had no resource field" from "an author who removed
      // every file" — `parseSkillContract` cannot tell those apart, and the
      // question gets asked exactly when somebody is working out why a version
      // stopped producing the document it used to. A restore copies a v1 row's
      // content verbatim and adds nothing to it, so stamping it 2 would record
      // a v1 contract as a v2 one with an empty file list, which is the second
      // answer to a question whose true answer is the first.
      contractVersion: source.contractVersion,
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

  // The files this version says it brings. Only a contract that came off the
  // wire is checked; see the note on the restore branch for why the other one
  // is not. Refused rather than pruned, for the reason the create route gives
  // at length: a version that silently brought fewer files than it names would
  // run and produce the wrong document.
  if (
    restoreVersion === undefined &&
    !(await ownsEverySkillResource(user.id, content.contract.resourceAttachmentIds))
  ) {
    return NextResponse.json(
      {
        error: "resource_not_found",
        message:
          "One of the files this version brings is not in your library, so nothing was saved. The version that was current still is.",
      },
      { status: 404 }
    );
  }

  // The gate itself is in `mintSkillVersion`, shared with the source update
  // route: every version is scanned (`scanSkillVersion`), compared with the
  // highest one before it (`permissionExpansion`) so a version asking for more
  // waits for consent, and a blocked version lands switched off. Nothing there
  // switches a skill back on that the reader turned off.
  // A restore restores the files that version kept; an edit carries the
  // current version's files over (the default), so changing the instructions
  // never drops the scripts they describe.
  const minted = await mintSkillVersion({
    userId: user.id,
    skill,
    content,
    actor: "web",
    ...(restoreVersion !== undefined ? { bundle: { fromVersion: restoreVersion } } : {}),
  });
  if (minted.ok) {
    return NextResponse.json(
      { skill: serializeSkill(minted.skill), version: serializeSkillVersion(minted.version) },
      { status: 201 }
    );
  }

  return NextResponse.json({ error: "version_conflict" }, { status: 409 });
}
