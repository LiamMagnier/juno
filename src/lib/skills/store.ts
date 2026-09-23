/**
 * Writing skills, their versions and the sources they came from — once, for
 * every route that does it.
 *
 * `POST /api/work/skills` had skill creation inline, and the GitHub importer
 * needs the same thing for each skill it brings in; the versions route and the
 * source update route both mint versions. Copying either would have meant two
 * implementations of the rules that matter most and are easiest to get subtly
 * wrong: that trust is DERIVED from origin and never read from the request,
 * that `autoSelect` is clamped against trust rather than stored as asked, that
 * a scanner verdict of `blocked` lands the skill switched off, that a new
 * version asking for more than the last one waits for consent, and that a head
 * row and the version it points at are written in one transaction so a skill
 * can never exist pointing at a version that does not.
 *
 * The drift those copies produce is not hypothetical and is not loud: an
 * importer that forgot the `autoSelect` clamp writes a row saying
 * `autoSelect: true, trust: "untrusted"`, which every reader then has to
 * resolve for itself — and the one that resolves it the other way is the one
 * that matters.
 *
 * `server-only`: this writes to the database. The decisions it applies live in
 * `skills/sources.ts`, `work/skills.ts` and `skills/skill-md.ts`, where a test
 * can reach them.
 */

import "server-only";
import { Prisma, type WorkSkill, type WorkSkillSource, type WorkSkillVersion } from "@prisma/client";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import { recordWorkAudit } from "@/lib/work/audit";
import { permissionExpansion, permissionSurfaceFromScan, scanSkillVersion } from "@/lib/work/skill-security";
import {
  SKILL_CONTRACT_VERSION,
  emptySkillContract,
  nextSkillVersion,
  parseRequestedTools,
  parseSkillContract,
  skillContractToJson,
  trustForOrigin,
  trustPermitsAutoSelection,
  type WorkSkillContract,
  type WorkSkillOrigin,
  type WorkSkillVersionContent,
} from "@/lib/work/skills";
import type { GithubDiscovery } from "@/lib/skills/github";
import type { SkillLibrary } from "@/lib/skills/library-contract";
import {
  buildSkillLibrary,
  chooseImportSource,
  discoverySourceKey,
  enabledAfterMint,
  SWITCH_BEFORE_BLOCK_KEY,
  switchBeforeBlockAfterMint,
  switchBeforeBlockOf,
  type InstalledSourceSkill,
} from "@/lib/skills/sources";

type Actor = "web" | "macos" | "ios";

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

// ---------------------------------------------------------------------------
// Creating a skill
// ---------------------------------------------------------------------------

export interface CreateSkillInput {
  userId: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  projectId?: string | null;
  contract?: WorkSkillContract;
  requestedTools?: string[];
  /** Decides the starting trust. Never taken from a request body. */
  origin: WorkSkillOrigin;
  autoSelect?: boolean;
  /** The source it was installed from, and its `SKILL.md` path there. */
  sourceId?: string | null;
  sourcePath?: string | null;
  /** Which surface asked, for the audit log. */
  actor?: Actor;
}

export type CreateSkillResult =
  | {
      ok: true;
      skill: WorkSkill;
      version: WorkSkillVersion;
      /** The skill was created switched off because the scanner refused it. */
      blocked: boolean;
    }
  | { ok: false; reason: "slug_taken"; slug: string };

/**
 * Frees a slug held only by a deleted skill.
 *
 * `(userId, slug)` is unique across deleted rows too, because a deleted skill's
 * row survives for the runs that followed it. Without this, removing a source
 * and installing it again refused every skill in it as already taken, by
 * skills the reader can no longer see. The deleted row keeps its id, and a run
 * recorded the slug it ran under as text, so renaming the tombstone rewrites
 * nothing anybody reads. Returns whether a slug was freed.
 *
 * The tombstone's new name is itself a valid slug, so a live skill can already
 * hold it (somebody named one `pdf-deleted-1a2b3c4d`). That rename then trips
 * the same unique index; it is answered as "not freed", which the caller
 * reports as `slug_taken`, rather than thrown as a server error.
 */
async function releaseDeletedSlug(userId: string, slug: string): Promise<boolean> {
  const holder = await prisma.workSkill.findFirst({
    where: { userId, slug, deletedAt: { not: null } },
    select: { id: true },
  });
  if (!holder) return false;
  const stem = slug.slice(0, 40).replace(/-+$/, "");
  try {
    const freed = await prisma.workSkill.updateMany({
      where: { id: holder.id, userId, slug, deletedAt: { not: null } },
      data: { slug: `${stem}-deleted-${holder.id.slice(-8).toLowerCase()}` },
    });
    return freed.count > 0;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/**
 * Writes one skill and its version 1.
 *
 * Returns a refusal rather than throwing on the one failure a caller is
 * expected to handle: `(userId, slug)` is unique and a slug is frequently
 * derived from a name, so two skills called "Tidy Downloads" — or two
 * repositories both shipping `pdf` — collide without anybody having typed a
 * slug. An importer bringing twelve skills needs that per skill, not as a
 * failed request.
 */
export async function createSkillWithFirstVersion(input: CreateSkillInput): Promise<CreateSkillResult> {
  const contract = input.contract ?? emptySkillContract();
  const requestedTools = input.requestedTools ?? [];
  const trust = trustForOrigin(input.origin);

  const securityScan = scanSkillVersion({
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    requestedTools,
    contract,
  });
  const permissionDigest = createHash("sha256").update(securityScan.permissionFingerprint).digest("hex");

  const write = () =>
    prisma.$transaction(async (tx) => {
      const skill = await tx.workSkill.create({
        data: {
          userId: input.userId,
          projectId: input.projectId ?? null,
          slug: input.slug,
          name: input.name,
          description: input.description,
          currentVersion: 1,
          enabled: securityScan.status !== "blocked",
          trust,
          securityStatus: securityScan.status,
          securityUpdatedAt: new Date(),
          autoSelect: (input.autoSelect ?? false) && trustPermitsAutoSelection(trust),
          sourceId: input.sourceId ?? null,
          sourcePath: input.sourcePath ?? null,
        },
      });
      const version = await tx.workSkillVersion.create({
        data: {
          skillId: skill.id,
          version: 1,
          instructions: input.instructions,
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

  let created: { skill: WorkSkill; version: WorkSkillVersion };
  try {
    created = await write();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    if (!(await releaseDeletedSlug(input.userId, input.slug))) {
      return { ok: false, reason: "slug_taken", slug: input.slug };
    }
    try {
      created = await write();
    } catch (retryErr) {
      if (isUniqueViolation(retryErr)) return { ok: false, reason: "slug_taken", slug: input.slug };
      throw retryErr;
    }
  }

  await recordWorkAudit({
    userId: input.userId,
    kind: "skill_security_scanned",
    actor: input.actor ?? "web",
    severity:
      securityScan.status === "blocked" ? "refusal" : securityScan.status === "warning" ? "warning" : "info",
    detail: {
      skillId: created.skill.id,
      skillSlug: created.skill.slug,
      skillVersion: created.version.version,
      scanStatus: securityScan.status,
      findingCount: securityScan.findings.length,
    },
  });

  return {
    ok: true,
    skill: created.skill,
    version: created.version,
    blocked: securityScan.status === "blocked",
  };
}

// ---------------------------------------------------------------------------
// Minting a version
// ---------------------------------------------------------------------------

/**
 * How many times to re-derive the version number when another writer takes it
 * first. Two tabs saving the same skill at once is the realistic case and it
 * settles in one extra pass; anything past that is a bug worth surfacing rather
 * than a race worth looping on. The shape follows `createRun`'s attempt
 * allocation in `src/lib/work/store.ts`, for the same reason it exists there.
 */
const VERSION_ALLOCATION_TRIES = 4;

export interface MintSkillVersionInput {
  userId: string;
  /** The head row, already matched on `userId` by the caller. */
  skill: Pick<WorkSkill, "id" | "name" | "description">;
  content: WorkSkillVersionContent;
  /**
   * Head fields replaced in the same write. An update from upstream refreshes
   * the description and may withdraw trust; `autoSelect` is re-clamped against
   * whatever trust results, never set here.
   */
  head?: { description?: string; trust?: string };
  actor?: Actor;
}

export type MintSkillVersionResult =
  | {
      ok: true;
      skill: WorkSkill;
      version: WorkSkillVersion;
      /** The version asks for more than the last one and waits for the reader to approve it. */
      requiresConsent: boolean;
    }
  | { ok: false; reason: "version_conflict" };

/**
 * Mints a version and moves the pointer to it.
 *
 * Every version is scanned, and its permission surface is compared with the
 * highest version's: anything it asks for that the last one did not sets
 * `requiresConsent`, which chat and the Work runner both refuse until the
 * reader approves it on the skill's page.
 *
 * The head's switch follows `enabledAfterMint`: a blocked version lands off,
 * and nothing else here switches a skill back on that the reader turned off.
 * (This route used to write `enabled: status !== "blocked"`, so saving an edit
 * or restoring a version quietly re-enabled a switched-off skill.) A blocked
 * version records the switch it overrode, so the clean version after it
 * restores that switch rather than assuming it was on.
 */
export async function mintSkillVersion(input: MintSkillVersionInput): Promise<MintSkillVersionResult> {
  const { userId, content } = input;
  const description = input.head?.description ?? input.skill.description;
  const securityScan = scanSkillVersion({
    name: input.skill.name,
    description,
    instructions: content.instructions,
    requestedTools: content.requestedTools,
    contract: content.contract,
  });
  const permissionDigest = createHash("sha256").update(securityScan.permissionFingerprint).digest("hex");
  const previousVersion = await prisma.workSkillVersion.findFirst({
    where: { skillId: input.skill.id },
    orderBy: { version: "desc" },
    select: { securityScan: true },
  });
  const expansion = permissionExpansion(permissionSurfaceFromScan(previousVersion?.securityScan), securityScan.permissions);
  const requiresConsent = expansion.length > 0;

  for (let tries = 0; tries < VERSION_ALLOCATION_TRIES; tries++) {
    try {
      const minted = await prisma.$transaction(async (tx) => {
        // The highest version that exists, never `currentVersion`. The pointer
        // moves backwards on a restore, so a skill on five versions restored to
        // three would try to mint version 4 — a number already taken — and the
        // unique index would fail every subsequent edit of that skill.
        const highest = await tx.workSkillVersion.findFirst({
          where: { skillId: input.skill.id },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        const current = await tx.workSkill.findFirstOrThrow({
          where: { id: input.skill.id, userId },
          select: { enabled: true, securityStatus: true, trust: true, autoSelect: true, currentVersion: true },
        });
        // A blocked head reads off whoever switched it, so the switch the block
        // overrode is read off the blocked version it points at (see
        // `switchBeforeBlockOf`). Only then: every other mint keeps the head's.
        const blockedVersion =
          current.securityStatus === "blocked"
            ? await tx.workSkillVersion.findUnique({
                where: { skillId_version: { skillId: input.skill.id, version: current.currentVersion } },
                select: { securityScan: true },
              })
            : null;
        const switches = {
          enabled: current.enabled,
          previousStatus: current.securityStatus,
          nextStatus: securityScan.status,
          switchBeforeBlock: switchBeforeBlockOf(blockedVersion?.securityScan),
        };
        const heldSwitch = switchBeforeBlockAfterMint(switches);
        const version = await tx.workSkillVersion.create({
          data: {
            skillId: input.skill.id,
            version: nextSkillVersion(highest?.version ?? 0),
            instructions: content.instructions,
            contract: skillContractToJson(content.contract),
            contractVersion: content.contractVersion,
            requestedTools: content.requestedTools,
            securityStatus: securityScan.status,
            securityScan: (heldSwitch === null
              ? securityScan
              : { ...securityScan, [SWITCH_BEFORE_BLOCK_KEY]: heldSwitch }) as unknown as Prisma.InputJsonValue,
            permissionDigest,
            requiresConsent,
          },
        });
        const trust = input.head?.trust ?? current.trust;
        // The pointer moves in the same transaction as the row it points at,
        // so a failure between the two cannot leave a head naming a version
        // that was never written.
        const skill = await tx.workSkill.update({
          where: { id: input.skill.id, userId },
          data: {
            currentVersion: version.version,
            enabled: enabledAfterMint(switches),
            securityStatus: securityScan.status,
            securityUpdatedAt: new Date(),
            ...(input.head?.description !== undefined ? { description: input.head.description } : {}),
            ...(input.head?.trust !== undefined ? { trust } : {}),
            autoSelect: current.autoSelect && trustPermitsAutoSelection(trust),
          },
        });
        return { skill, version };
      });

      await recordWorkAudit({
        userId,
        kind: "skill_security_scanned",
        actor: input.actor ?? "web",
        severity: securityScan.status === "blocked" ? "refusal" : securityScan.status === "warning" ? "warning" : "info",
        detail: {
          skillId: minted.skill.id,
          skillSlug: minted.skill.slug,
          skillVersion: minted.version.version,
          scanStatus: securityScan.status,
          findingCount: securityScan.findings.length,
          requiresConsent,
          permissionAdditions: expansion,
        },
      });

      return { ok: true, skill: minted.skill, version: minted.version, requiresConsent };
    } catch (err) {
      // `(skillId, version)` is the only unique constraint this write can
      // violate, so a P2002 means another editor took the number between the
      // read and the insert. Re-deriving it is the whole recovery.
      if (!isUniqueViolation(err)) throw err;
    }
  }

  return { ok: false, reason: "version_conflict" };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * The user's GitHub token, when they have connected the account.
 *
 * Optional throughout. Unauthenticated GitHub allows 60 requests an hour per
 * IP, which one walk of a large repository can spend on its own, so a
 * connected account is the difference between "this works" and "this works
 * until somebody else on this deployment tries it". A user who has not
 * connected one still gets public repositories, and `rate_limited` says what
 * would fix it rather than reporting a generic failure.
 */
export async function githubTokenFor(userId: string): Promise<string | null> {
  try {
    const row = await prisma.connection.findUnique({
      where: { userId_provider: { userId, provider: "github" } },
      select: { accessToken: true },
    });
    if (!row?.accessToken) return null;
    return decryptSecret(row.accessToken);
  } catch {
    // A connection that cannot be decrypted is a connection this request does
    // not have. Failing the whole request over it would turn a broken row into
    // "GitHub is down".
    return null;
  }
}

/** One of the user's sources, or null. Every source route starts here. */
export function findUserSource(userId: string, id: string): Promise<WorkSkillSource | null> {
  return prisma.workSkillSource.findFirst({ where: { id, userId } });
}

/**
 * The source an import lands in: an installed one that already covers the
 * folder (see `chooseImportSource`), or a new one recorded at the commit the
 * import read. `created` lets the importer remove a source it made for nothing
 * when every skill in it was skipped.
 */
export async function sourceForImport(
  userId: string,
  discovery: Pick<GithubDiscovery, "owner" | "repo" | "ref" | "commit" | "scope">
): Promise<{ source: WorkSkillSource; created: boolean }> {
  const key = discoverySourceKey(discovery);
  const existing = await prisma.workSkillSource.findMany({ where: { userId, key } });
  const chosen = chooseImportSource(existing, { key, path: discovery.scope, ref: discovery.ref });
  if (chosen) return { source: chosen, created: false };
  try {
    const source = await prisma.workSkillSource.create({
      data: {
        userId,
        kind: "github",
        owner: discovery.owner,
        repo: discovery.repo,
        key,
        ref: discovery.ref,
        path: discovery.scope,
        commit: discovery.commit,
      },
    });
    return { source, created: true };
  } catch (err) {
    // Two imports of one repository at once: the other one made it first.
    if (!isUniqueViolation(err)) throw err;
    const raced = await prisma.workSkillSource.findFirst({ where: { userId, key, path: discovery.scope } });
    if (!raced) throw err;
    return { source: raced, created: false };
  }
}

/**
 * Deletes a source that no live skill belongs to any more. An import that
 * skipped everything, or a reader deleting a folder's skills one at a time,
 * should not leave an empty folder behind in the library.
 */
export async function removeSourceIfEmpty(userId: string, sourceId: string): Promise<boolean> {
  const remaining = await prisma.workSkill.count({
    where: { userId, sourceId, deletedAt: null },
  });
  if (remaining > 0) return false;
  const removed = await prisma.workSkillSource.deleteMany({ where: { id: sourceId, userId } });
  return removed.count > 0;
}

/**
 * How many skills the library returns at once. Past this the response says
 * `truncated` rather than pretending the library ends there.
 */
export const SKILL_LIBRARY_LIMIT = 500;

/** `GET /api/skills`: the reader's skills, grouped by where they came from. */
export async function loadSkillLibrary(userId: string): Promise<SkillLibrary> {
  // Assistants share the table and have a page of their own. Deleted skills
  // survive for the runs that followed them and are nobody's library.
  const where = { userId, deletedAt: null, kind: "skill" } satisfies Prisma.WorkSkillWhereInput;
  const [skills, total, sources, awaitingConsent] = await Promise.all([
    prisma.workSkill.findMany({ where, orderBy: [{ name: "asc" }, { slug: "asc" }], take: SKILL_LIBRARY_LIMIT }),
    prisma.workSkill.count({ where }),
    prisma.workSkillSource.findMany({ where: { userId } }),
    // Consent lives on the version, and the list draws a glyph for it. Every
    // flagged version of the reader's skills, which is a handful, rather than
    // the current version of all five hundred; `buildSkillLibrary` keeps the
    // ones that are current. Reached through the head row, the way every
    // version read here is, because a version has no owner column of its own.
    prisma.workSkillVersion.findMany({
      where: { requiresConsent: true, skill: where },
      select: { skillId: true, version: true },
    }),
  ]);
  return buildSkillLibrary({ skills, sources, awaitingConsent, total });
}

/**
 * A source's live skills, each with the version an update would replace.
 * Addressed by `(skillId, version)`, so this reads the unique index rather
 * than every version of every skill.
 */
export async function readInstalledSourceSkills(
  userId: string,
  sourceId: string
): Promise<{ rows: WorkSkill[]; installed: InstalledSourceSkill[] }> {
  const rows = await prisma.workSkill.findMany({
    where: { userId, sourceId, deletedAt: null, kind: "skill" },
  });
  const versions = rows.length
    ? await prisma.workSkillVersion.findMany({
        where: { OR: rows.map((row) => ({ skillId: row.id, version: row.currentVersion })) },
        select: { skillId: true, instructions: true, requestedTools: true, contract: true },
      })
    : [];
  const bySkill = new Map(versions.map((version) => [version.skillId, version]));
  const installed = rows.map((row) => {
    const version = bySkill.get(row.id);
    return {
      skillId: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      path: row.sourcePath,
      // A head pointing at a missing row has nothing to compare, so upstream
      // reads as a change and an update is what repairs it.
      instructions: version?.instructions ?? "",
      requestedTools: parseRequestedTools(version?.requestedTools),
      contract: parseSkillContract(version?.contract),
    } satisfies InstalledSourceSkill;
  });
  return { rows, installed };
}

/**
 * Paths of this repository already installed through its OTHER sources (a
 * folder imported on its own, beside the whole repository), so an update check
 * does not offer the same skill twice.
 */
export async function pathsInstalledElsewhere(
  userId: string,
  source: Pick<WorkSkillSource, "id" | "key">
): Promise<Set<string>> {
  const rows = await prisma.workSkill.findMany({
    where: {
      userId,
      deletedAt: null,
      kind: "skill",
      source: { is: { userId, key: source.key, id: { not: source.id } } },
    },
    select: { sourcePath: true },
  });
  return new Set(rows.map((row) => row.sourcePath).filter((path): path is string => !!path));
}

/** Slugs held by the reader's live rows (assistants included: they share the index). */
export async function takenSkillSlugs(userId: string): Promise<Set<string>> {
  const rows = await prisma.workSkill.findMany({
    where: { userId, deletedAt: null },
    select: { slug: true },
  });
  return new Set(rows.map((row) => row.slug));
}
