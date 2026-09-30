import "server-only";

import { Prisma } from "@prisma/client";
import { prisma, prismaUnguarded } from "@/lib/prisma";

/*
 * THE ONE WRITE PATH FOR ARTIFACT VERSIONS (PRODUCT_REFOUNDATION §10).
 *
 * Two rules hold everything else up:
 *
 *   1. A version is immutable. Every writer appends `currentVersion + 1`; none
 *      rewrites a row (the database refuses it too: the
 *      juno_artifact_version_immutable trigger). So "version N" means the same
 *      bytes to the canvas, the public page, a legacy share and a Mac that
 *      synced it last week.
 *
 *   2. Work in progress is a draft, not a version. The design editor writes at
 *      gesture rate; those writes go to `ArtifactDraft`, one working copy per
 *      artifact. The draft is SEALED — appended as the next version — on an
 *      explicit checkpoint, after the edit run goes idle, and before ANY other
 *      write to the artifact. That last rule is what keeps a draft from ever
 *      going stale behind the head: whoever writes next first turns the
 *      person's unsaved edits into a version of their own, so nothing is lost
 *      and nothing is silently merged.
 *
 * Every write takes the artifact's row lock first (`lockArtifact`), so all
 * writers to one artifact — a design gesture, a native save, a chat re-emit, a
 * restore, a seal — are serialized and none has to reason about another
 * landing between its read and its insert.
 *
 * Callers pass a transaction client. `prisma.$transaction(async (tx) => …)` on
 * the guarded client and a plain `Prisma.TransactionClient` answer every call
 * here identically; `asTx` names the shape they share.
 */

type GuardedTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
export type ArtifactTx = GuardedTransaction | Prisma.TransactionClient;
type Db = Prisma.TransactionClient;

export function asTx(tx: ArtifactTx): Db {
  return tx as Db;
}

export type VersionOrigin = "generated" | "edit" | "restore";

export class ArtifactVersionConflictError extends Error {
  constructor(readonly currentVersion?: number) {
    super("The artifact changed while this edit was being prepared.");
    this.name = "ArtifactVersionConflictError";
  }
}

export class ArtifactNotFoundError extends Error {
  constructor() {
    super("Not found");
    this.name = "ArtifactNotFoundError";
  }
}

export interface LockedArtifact {
  id: string;
  userId: string | null;
  type: string;
  currentVersion: number;
  deletedAt: Date | null;
}

/**
 * Take the artifact's row lock for the rest of the transaction.
 *
 * Scoped to the owner when `userId` is given; a trashed row is refused unless
 * `includeTrashed` (restore and purge are the only callers that want one).
 * Returns null for a row that does not exist, is someone else's, or is in the
 * trash — the caller's 404.
 */
export async function lockArtifact(
  tx: ArtifactTx,
  artifactId: string,
  opts: { userId?: string; includeTrashed?: boolean } = {}
): Promise<LockedArtifact | null> {
  const db = asTx(tx);
  const rows = await db.$queryRaw<LockedArtifact[]>(Prisma.sql`
    SELECT "id", "userId", "type"::text AS "type", "currentVersion", "deletedAt"
      FROM "Artifact"
     WHERE "id" = ${artifactId}
       ${opts.userId ? Prisma.sql`AND "userId" = ${opts.userId}` : Prisma.empty}
     FOR UPDATE
  `);
  const row = rows[0];
  if (!row) return null;
  if (row.deletedAt && !opts.includeTrashed) return null;
  return row;
}

/**
 * Append one version on a LOCKED artifact and move the head to it.
 *
 * The insert goes first, the order every writer has always used, so a writer
 * that did not take the lock (the previous release, during a deploy) trips the
 * `(artifactId, version)` key rather than deadlocking.
 */
export async function appendLocked(
  tx: ArtifactTx,
  locked: LockedArtifact,
  input: { content: string; origin: VersionOrigin; createdAt?: Date },
  data: Prisma.ArtifactUpdateInput = {}
): Promise<number> {
  const db = asTx(tx);
  const next = locked.currentVersion + 1;
  await db.artifactVersion.create({
    data: {
      artifactId: locked.id,
      version: next,
      content: input.content,
      origin: input.origin,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });
  await db.artifact.update({
    where: { id: locked.id, ...(locked.userId ? { userId: locked.userId } : {}) },
    data: { ...data, currentVersion: next },
  });
  locked.currentVersion = next;
  return next;
}

/**
 * THE PUBLISH FLOOR FOR JUNO'S OWN WRITES. Call on a LOCKED artifact right
 * before appending a version Juno wrote without the person reviewing it (a
 * chat re-emit, a targeted edit).
 *
 * A publication that follows the latest version (src/lib/artifact-publication.ts)
 * would otherwise put that version on the public URL the moment it is written:
 * Juno publishing on the person's behalf, with no approval, and on a turn that
 * may have read a web page or a connector result written to steer it. So the
 * publication is pinned to the version it serves now, and the new one stays
 * private until the person publishes it (Update, in the Publish panel). The
 * person's own saves, restores and Applies are not held: those are theirs, and
 * following latest is what they chose for them.
 *
 * Returns how many publications were pinned (0 or 1).
 */
export async function holdPublicationForModelWrite(tx: ArtifactTx, locked: LockedArtifact): Promise<number> {
  const db = asTx(tx);
  const held = await db.artifactPublication.updateMany({
    where: {
      artifactId: locked.id,
      ...(locked.userId ? { userId: locked.userId } : {}),
      retiredAt: null,
      publishedAt: { not: null },
      pinnedVersion: null,
    },
    data: { pinnedVersion: locked.currentVersion },
  });
  return held.count;
}

/**
 * Seal the artifact's draft, if it has one, into the next version (origin
 * "edit": a draft is only ever the person's own editing). Returns the new
 * version number, or null when there was no draft.
 */
export async function sealDraftLocked(tx: ArtifactTx, locked: LockedArtifact): Promise<number | null> {
  const db = asTx(tx);
  const draft = await db.artifactDraft.findFirst({
    where: { artifactId: locked.id, ...(locked.userId ? { userId: locked.userId } : {}) },
    select: { content: true, userId: true },
  });
  if (!draft) return null;
  const version = await appendLocked(db, locked, { content: draft.content, origin: "edit" });
  await db.artifactDraft.deleteMany({ where: { artifactId: locked.id, userId: draft.userId } });
  return version;
}

/**
 * Append a version the way every save does: lock, seal the draft, check the
 * caller's base, append.
 *
 * `baseVersion` is the version the caller was editing. When it is given and
 * the head (after sealing any draft) is not it, nothing is written and
 * `ArtifactVersionConflictError` carries the head — the 409 every client
 * handles. When it is absent (a client too old to send one) the write is
 * last-writer-wins, which here still means a NEW row on top: no existing
 * version is ever overwritten.
 *
 * The draft is sealed in its own transaction first, so a refused save still
 * leaves the person's unsaved edits as a version the 409 can show, and then
 * again inside the append (in case another gesture landed in between).
 */
export async function saveArtifactVersion(input: {
  artifactId: string;
  userId: string;
  content: string;
  origin: VersionOrigin;
  baseVersion?: number | null;
  data?: Prisma.ArtifactUpdateInput;
}): Promise<number> {
  await sealArtifactDraft(input.artifactId, input.userId);
  return prisma.$transaction(async (tx) => {
    const locked = await lockArtifact(tx, input.artifactId, { userId: input.userId });
    if (!locked) throw new ArtifactNotFoundError();
    await sealDraftLocked(tx, locked);
    if (input.baseVersion != null && input.baseVersion !== locked.currentVersion) {
      throw new ArtifactVersionConflictError(locked.currentVersion);
    }
    return appendLocked(tx, locked, { content: input.content, origin: input.origin }, input.data ?? {});
  });
}

/**
 * Seal the draft now: the explicit checkpoint ("Save version"), the editor
 * leaving the page, and every write path's first step. Idempotent: no draft,
 * no version. Returns the sealed version or null.
 */
export async function sealArtifactDraft(artifactId: string, userId: string): Promise<number | null> {
  return prisma.$transaction(async (tx) => {
    const locked = await lockArtifact(tx, artifactId, { userId });
    if (!locked) return null;
    return sealDraftLocked(tx, locked);
  });
}

/** Throw the working copy away. The head is untouched. */
export async function discardArtifactDraft(artifactId: string, userId: string): Promise<boolean> {
  const removed = await prisma.artifactDraft.deleteMany({ where: { artifactId, userId } });
  return removed.count > 0;
}

/**
 * How long a draft may sit untouched before the sweeper seals it
 * (`sealIdleDrafts`, run by scripts/artifact-maintenance.ts). Longer than the
 * editor's own fold window (CHECKPOINT_WINDOW_MS, which seals on the next
 * gesture after a pause), because the sweeper is for the edit run that simply
 * stopped: the person closed the tab without the page's own seal reaching us.
 */
export const ARTIFACT_DRAFT_IDLE_MS = 2 * 60_000;

/**
 * Seal every draft idle for at least `idleMs`. Cross-account by nature (a
 * sweep), so it lists through the unguarded client and seals each one under
 * its owner.
 */
export async function sealIdleDrafts(opts: { now?: Date; idleMs?: number; limit?: number } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - (opts.idleMs ?? ARTIFACT_DRAFT_IDLE_MS));
  // Only live artifacts: a trashed one's draft was sealed when it was trashed,
  // and one that is not could never be sealed here (the lock refuses a
  // trashed row), so listing it would starve every other draft behind it.
  const idle = await prismaUnguarded.artifactDraft.findMany({
    where: { updatedAt: { lte: cutoff }, artifact: { deletedAt: null } },
    select: { artifactId: true, userId: true },
    orderBy: { updatedAt: "asc" },
    take: opts.limit ?? 200,
  });
  let sealed = 0;
  for (const draft of idle) {
    try {
      if ((await sealArtifactDraft(draft.artifactId, draft.userId)) !== null) sealed++;
    } catch (error) {
      console.error("[artifact-drafts] seal failed", {
        artifactId: draft.artifactId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return sealed;
}

/** True for the unique-key race a writer that skipped the lock can still cause. */
export function isVersionRace(error: unknown): boolean {
  const code = typeof error === "object" && error ? (error as { code?: unknown }).code : undefined;
  return code === "P2002" || code === "P2025";
}
