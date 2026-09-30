import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
// The cross-account client comes from `@/lib/db`, as the other sweep workers
// take it: route tests stand in for `@/lib/prisma` with a module that may
// export only `prisma`.
import { prismaUnguarded } from "@/lib/db";
import { artifactPurgeArmed } from "@/lib/artifact-flags";

/**
 * Recently deleted: an artifact the person deletes is hidden, not destroyed,
 * and is purged for good after ARTIFACT_TRASH_RETENTION_DAYS. Taken from
 * artifacts/r1-lifecycle (DECISIONS D-004), on the artifact's own owner rather
 * than R1's anchor conversation.
 *
 * Trash is one nullable column on the row (`deletedAt`) rather than a move to
 * another table, so everything the artifact owns — its versions, its draft,
 * its links, its place in its chat — stays exactly where it was and a restore
 * is one UPDATE. Every owner read filters `deletedAt: null`
 * (`ownedArtifactWhere`); a trashed artifact's public links and publication
 * answer "link gone" until it is restored, then serve again under the same
 * token.
 *
 * THIS MODULE HOLDS THE ONLY HARD DELETES OF AN ARTIFACT OR ITS VERSIONS.
 * tests/artifact-trash.test.ts reads every source file and fails any other
 * `artifact.delete(…)` / `artifactVersion.delete(…)`.
 */

/** How long a trashed artifact waits before the purge may remove it. */
export const ARTIFACT_TRASH_RETENTION_DAYS = 30;

/**
 * The shortest window the purge accepts. A typo in `--days` must not be able
 * to empty Recently deleted the same afternoon.
 */
export const MIN_TRASH_RETENTION_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** When a row trashed at `deletedAt` becomes eligible for the purge. */
export function purgeAtFor(deletedAt: Date, days: number = ARTIFACT_TRASH_RETENTION_DAYS): Date {
  return new Date(deletedAt.getTime() + days * DAY_MS);
}

/**
 * A JS Date as the value a `timestamp(3)` column holds, for raw SQL.
 *
 * Prisma stores `DateTime` as a zone-less timestamp in UTC but binds a Date in
 * raw SQL as `timestamptz`; Postgres converts through the SESSION time zone,
 * so on a server not set to UTC a bare `${date}` lands hours off. Converting to
 * UTC explicitly makes the SQL mean the same instant whatever the zone.
 */
function utcTimestamp(date: Date): Prisma.Sql {
  return Prisma.sql`(${date}::timestamptz AT TIME ZONE 'UTC')`;
}

export interface TrashedArtifact {
  deletedAt: Date;
  purgeAt: Date;
}

/**
 * Move one of the user's artifacts to Recently deleted. Null when it is not
 * theirs (or does not exist), which the route answers with 404.
 *
 * IDEMPOTENT, and the first stamp wins: the apps retry a delete that timed
 * out, and a retry must not push the purge date out.
 *
 * Raw SQL for `updatedAt`: Prisma stamps it on every client update, trashing
 * is not an edit, and an artifact that is trashed and restored should come
 * back in its own place in the Library. The change-capture trigger fires on
 * the UPDATE either way, which is what projects the row out of (and back
 * into) the sync feed.
 */
export async function trashArtifact(userId: string, artifactId: string, now: Date = new Date()): Promise<TrashedArtifact | null> {
  const owned = await prisma.artifact.findFirst({
    where: { id: artifactId, userId },
    select: { id: true, deletedAt: true },
  });
  if (!owned) return null;
  if (owned.deletedAt) return { deletedAt: owned.deletedAt, purgeAt: purgeAtFor(owned.deletedAt) };

  const stamped = await prisma.$executeRaw`
    UPDATE "Artifact" SET "deletedAt" = ${utcTimestamp(now)}
     WHERE "id" = ${owned.id} AND "userId" = ${userId} AND "deletedAt" IS NULL
  `;
  if (stamped === 1) return { deletedAt: now, purgeAt: purgeAtFor(now) };

  const raced = await prisma.artifact.findFirst({
    where: { id: owned.id, userId },
    select: { deletedAt: true },
  });
  return raced?.deletedAt ? { deletedAt: raced.deletedAt, purgeAt: purgeAtFor(raced.deletedAt) } : null;
}

/**
 * Bring one of the user's artifacts back from Recently deleted. False when it
 * is not theirs. Idempotent: restoring a live artifact changes nothing.
 * Nothing on its links changes, so they serve again under the same tokens.
 */
export async function restoreArtifact(userId: string, artifactId: string): Promise<boolean> {
  const owned = await prisma.artifact.findFirst({
    where: { id: artifactId, userId },
    select: { id: true, deletedAt: true },
  });
  if (!owned) return false;
  if (owned.deletedAt) {
    await prisma.$executeRaw`
      UPDATE "Artifact" SET "deletedAt" = NULL
       WHERE "id" = ${owned.id} AND "userId" = ${userId} AND "deletedAt" IS NOT NULL
    `;
  }
  return true;
}

type GuardedTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
export type ArtifactTrashTransaction = GuardedTransaction | Prisma.TransactionClient;

/**
 * Hard-delete artifacts inside the caller's transaction. Returns how many
 * artifact rows went.
 *
 * VERSIONS FIRST, while their artifact still exists, so every version's
 * change-capture tombstone resolves its owner through the artifact row rather
 * than through the revision fallback. The draft, proposals, shares and
 * publications then go with the row through their cascades.
 *
 * THE ROWS ARE LOCKED BEFORE ANYTHING IS DELETED, and the lock query decides
 * which ids are purged: with `requireTrashed`, a row restored a moment ago is
 * skipped whole, and the lock stops a version being appended between the two
 * deletes. `userId` scopes an owner's own purge; the sweep passes none.
 * `trashedBefore` narrows further for the sweep: a row restored and trashed
 * again since the sweep listed it has a fresh window.
 */
export async function purgeArtifacts(
  transaction: ArtifactTrashTransaction,
  ids: readonly string[],
  { requireTrashed, trashedBefore, userId }: { requireTrashed: boolean; trashedBefore?: Date; userId?: string },
): Promise<number> {
  if (ids.length === 0) return 0;
  const tx = transaction as Prisma.TransactionClient;
  const trashed = requireTrashed ? Prisma.sql`AND "deletedAt" IS NOT NULL` : Prisma.empty;
  const cutoff = trashedBefore ? Prisma.sql`AND "deletedAt" <= ${utcTimestamp(trashedBefore)}` : Prisma.empty;
  const owner = userId ? Prisma.sql`AND "userId" = ${userId}` : Prisma.empty;
  const locked = await tx.$queryRaw<Array<{ id: string; userId: string | null }>>`
    SELECT "id", "userId" FROM "Artifact"
     WHERE "id" IN (${Prisma.join([...ids])}) ${trashed} ${cutoff} ${owner}
     ORDER BY "id"
       FOR UPDATE
  `;
  if (locked.length === 0) return 0;
  const targets = locked.map((row) => row.id);

  await tx.artifactVersion.deleteMany({ where: { artifactId: { in: targets } } });
  // Grouped by owner so the guarded client (an owner's own "Delete now") sees
  // the owner in every where; the sweep runs on the unguarded client and the
  // grouping costs it nothing.
  const byOwner = new Map<string | null, string[]>();
  for (const row of locked) byOwner.set(row.userId, [...(byOwner.get(row.userId) ?? []), row.id]);
  let deleted = 0;
  for (const [ownerId, group] of byOwner) {
    const result = await tx.artifact.deleteMany({
      where: ownerId ? { id: { in: group }, userId: ownerId } : { id: { in: group }, userId: null },
    });
    deleted += result.count;
  }
  return deleted;
}

/**
 * The owner's "Delete now" on one trashed artifact. Refuses a live one (it
 * must go through Recently deleted first), answering `not_in_trash`.
 */
export async function purgeTrashedArtifact(
  userId: string,
  artifactId: string,
): Promise<{ ok: true } | { ok: false; error: "not_found" | "not_in_trash" }> {
  const owned = await prisma.artifact.findFirst({ where: { id: artifactId, userId }, select: { deletedAt: true } });
  if (!owned) return { ok: false, error: "not_found" };
  if (!owned.deletedAt) return { ok: false, error: "not_in_trash" };
  const removed = await prisma.$transaction((tx) => purgeArtifacts(tx, [artifactId], { requireTrashed: true, userId }));
  return removed === 1 ? { ok: true } : { ok: false, error: "not_in_trash" };
}

export interface PurgeReport {
  /** Trashed rows past the cutoff when the run started. */
  eligible: number;
  /** Rows actually removed; always 0 on a dry run. */
  purged: number;
  /** True when nothing was written: asked for, or the purge is not armed. */
  dryRun: boolean;
  /** Rows trashed at or before this instant were eligible. */
  cutoff: Date;
}

/**
 * The scheduled purge: remove every artifact that has been in Recently deleted
 * for `days` or longer, across all accounts. DRY UNLESS ARMED
 * (`JUNO_ARTIFACTS_PURGE=1`), whatever the caller asks. In batches, each its
 * own transaction, re-checking the cutoff under its lock.
 */
export async function purgeExpiredArtifacts({
  now = new Date(),
  days = ARTIFACT_TRASH_RETENTION_DAYS,
  dryRun = false,
  batchSize = 50,
}: { now?: Date; days?: number; dryRun?: boolean; batchSize?: number } = {}): Promise<PurgeReport> {
  if (!Number.isSafeInteger(days) || days < MIN_TRASH_RETENTION_DAYS) {
    throw new Error(`Trash retention must be a whole number of days, at least ${MIN_TRASH_RETENTION_DAYS} (got ${days}).`);
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error(`Batch size must be a positive whole number (got ${batchSize}).`);
  }
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const expired = { deletedAt: { not: null, lte: cutoff } } satisfies Prisma.ArtifactWhereInput;
  const dry = dryRun || !artifactPurgeArmed();

  const eligible = await prismaUnguarded.artifact.count({ where: expired });
  if (dry || eligible === 0) return { eligible, purged: 0, dryRun: dry, cutoff };

  let purged = 0;
  for (;;) {
    const batch = await prismaUnguarded.artifact.findMany({
      where: expired,
      select: { id: true },
      orderBy: [{ deletedAt: "asc" }, { id: "asc" }],
      take: batchSize,
    });
    if (batch.length === 0) break;
    const removed = await prismaUnguarded.$transaction((tx) =>
      purgeArtifacts(
        tx as unknown as Prisma.TransactionClient,
        batch.map((row) => row.id),
        { requireTrashed: true, trashedBefore: cutoff },
      ),
    );
    purged += removed;
    if (removed === 0) break;
  }
  return { eligible, purged, dryRun: false, cutoff };
}
