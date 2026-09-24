import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
// The cross-account client comes from `@/lib/db`, as the other sweep workers
// take it (sweep-stuck-code-tasks.ts). The routes that import this module are
// tested against stand-ins for `@/lib/prisma` that export only `prisma`, and a
// named import the stand-in lacks would fail to link before any test ran.
import { prismaUnguarded } from "@/lib/db";
import { artifactPurgeArmed } from "@/lib/artifact-flags";

/**
 * Recently deleted: an artifact the person deletes is hidden, not destroyed,
 * and is purged for good 30 days later (04-MERGE-PLAN §2.6; R1 spec §3B).
 *
 * Trash is two nullable columns on the row, `deletedAt` and `deletedReason`,
 * rather than a move to another table, so everything the artifact owns — its
 * versions, its public links, its place in its chat — stays exactly where it
 * was and a restore is one UPDATE. Every read that lists, searches, syncs or
 * edits filters `deletedAt: null`; the ones that deliberately still see a
 * trashed row are the owner's poster and export, the chat thread (so a card
 * can say "In Recently deleted") and the trash list itself.
 *
 * THIS MODULE HOLDS THE ONLY HARD DELETES OF AN ARTIFACT OR ITS VERSIONS.
 * tests/artifact-trash.test.ts reads every source file and fails any other
 * `artifact.delete(…)` / `artifactVersion.delete(…)`. That is what stands in
 * for the deletion ledger until it lands (§3.4): there is one place to audit,
 * and the purge job that calls it stays unarmed until then.
 */

/** How long a trashed artifact waits before the purge job may remove it. */
export const TRASH_RETENTION_DAYS = 30;

/**
 * The shortest window the purge job accepts. A typo in `--days` must not be
 * able to empty Recently deleted the same afternoon; a week is still far
 * shorter than anyone would configure on purpose.
 */
export const MIN_TRASH_RETENTION_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** When a row trashed at `deletedAt` becomes eligible for the purge. */
export function purgeAtFor(deletedAt: Date, days: number = TRASH_RETENTION_DAYS): Date {
  return new Date(deletedAt.getTime() + days * DAY_MS);
}

/**
 * A JS Date as the value a `timestamp(3)` column holds, for raw SQL.
 *
 * Prisma stores `DateTime` as a zone-less timestamp in UTC, but binds a Date in
 * raw SQL as `timestamptz`. Postgres converts between the two through the
 * SESSION time zone, so on a server not set to UTC a bare `${date}` is written,
 * or compared, hours off, and Prisma then reads it back as a different instant.
 * Converting to UTC explicitly makes the SQL mean the same instant whatever
 * the server's zone. (Found by the database test on a laptop in Paris.)
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
 * IDEMPOTENT, and the first stamp wins. The Mac and iPhone retry a delete that
 * timed out, and a retry that re-stamped `deletedAt` would quietly push the
 * purge date out by however long the retry took; an already-trashed row
 * answers with the date it already has.
 *
 * Raw SQL for one reason: `updatedAt`. Prisma stamps `@updatedAt` on every
 * client update, and trashing is not an edit. `updatedAt` is what the
 * Artifacts home and the apps sort by and what "Edited 3 days ago" reads, so an
 * artifact that is trashed and restored comes back in its own place, not at
 * the top of the library looking freshly worked on. The change-capture
 * trigger fires on the UPDATE either way, which is what projects the row out
 * of (and back into) the sync feed.
 */
export async function trashArtifact(userId: string, artifactId: string, now: Date = new Date()): Promise<TrashedArtifact | null> {
  const owned = await prisma.artifact.findFirst({
    where: { id: artifactId, conversation: { userId } },
    select: { id: true, deletedAt: true },
  });
  if (!owned) return null;
  if (owned.deletedAt) return { deletedAt: owned.deletedAt, purgeAt: purgeAtFor(owned.deletedAt) };

  const stamped = await prisma.$executeRaw`
    UPDATE "Artifact" SET "deletedAt" = ${utcTimestamp(now)}, "deletedReason" = 'user'
     WHERE "id" = ${owned.id} AND "deletedAt" IS NULL
  `;
  if (stamped === 1) return { deletedAt: now, purgeAt: purgeAtFor(now) };

  // Zero rows: a concurrent delete of the same artifact stamped it first (its
  // time stands), or it was purged in between (gone, so not found).
  const raced = await prisma.artifact.findFirst({
    where: { id: owned.id, conversation: { userId } },
    select: { deletedAt: true },
  });
  return raced?.deletedAt ? { deletedAt: raced.deletedAt, purgeAt: purgeAtFor(raced.deletedAt) } : null;
}

/**
 * Bring one of the user's artifacts back from Recently deleted. False when it
 * is not theirs. Idempotent: restoring a live artifact changes nothing.
 *
 * Nothing on its Share rows changes, so a public link that went dark on trash
 * serves again under the same token. Raw SQL for the same `updatedAt` reason
 * as `trashArtifact`.
 *
 * The identifier needs no check: a trashed row keeps its identifier until a
 * chat re-emits it, and that re-emit retires the trashed row's identifier
 * before making a new artifact (artifacts-store.ts), so the row being restored
 * never collides with a live one.
 */
export async function restoreArtifact(userId: string, artifactId: string): Promise<boolean> {
  const owned = await prisma.artifact.findFirst({
    where: { id: artifactId, conversation: { userId } },
    select: { id: true, deletedAt: true },
  });
  if (!owned) return false;
  if (owned.deletedAt) {
    await prisma.$executeRaw`
      UPDATE "Artifact" SET "deletedAt" = NULL, "deletedReason" = NULL
       WHERE "id" = ${owned.id} AND "deletedAt" IS NOT NULL
    `;
  }
  return true;
}

/**
 * The client inside `prisma.$transaction(async (tx) => …)` on the guarded
 * client (the routes), or a plain `Prisma.TransactionClient` (the purge job's,
 * on `prismaUnguarded`). They answer every call made here identically and
 * differ only in how TypeScript spells their generics, which is enough to make
 * a method call on the union ambiguous; the one cast below names the shape they
 * share. The same arrangement as artifacts-store.ts and artifact-home.ts.
 */
type GuardedTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
export type ArtifactTrashTransaction = GuardedTransaction | Prisma.TransactionClient;

/**
 * Hard-delete artifacts, inside the caller's transaction. Returns how many
 * artifact rows went.
 *
 * VERSIONS FIRST, while their artifact still exists. The artifact_version
 * change trigger finds the owning account by joining the version's artifact to
 * its conversation; deleted by the artifact's cascade instead, the versions
 * would be removed in the same statement as the row that join needs, and
 * whether each tombstone still found its account would depend on the revision
 * fallback. Deleted first, every version tombstone lands under the owner's
 * account, so the apps drop the history as well as the artifact. Proposals
 * and shares then go with the row through their cascades (shares with their
 * own tombstones).
 *
 * THE ROWS ARE LOCKED BEFORE ANYTHING IS DELETED, and the lock query is what
 * decides which ids are purged. With `requireTrashed`, a row restored a moment
 * ago must lose nothing; checking `deletedAt` only on the final artifact delete
 * would leave a restored artifact with its versions already gone. `FOR UPDATE`
 * makes a concurrent restore wait for this transaction (and then find nothing
 * to restore), and a restore that got there first means the row no longer
 * matches and is skipped whole. The same lock stops a version being appended
 * between the two deletes. Ids are locked in order so two purges cannot
 * deadlock each other.
 *
 * `trashedBefore` narrows further, for the purge job: a row restored and
 * trashed again since the job listed it has a fresh `deletedAt` and a fresh
 * 30 days.
 */
export async function purgeArtifacts(
  transaction: ArtifactTrashTransaction,
  ids: readonly string[],
  { requireTrashed, trashedBefore }: { requireTrashed: boolean; trashedBefore?: Date },
): Promise<number> {
  if (ids.length === 0) return 0;
  const tx = transaction as Prisma.TransactionClient;
  const trashed = requireTrashed ? Prisma.sql`AND "deletedAt" IS NOT NULL` : Prisma.empty;
  const cutoff = trashedBefore ? Prisma.sql`AND "deletedAt" <= ${utcTimestamp(trashedBefore)}` : Prisma.empty;
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Artifact"
     WHERE "id" IN (${Prisma.join([...ids])}) ${trashed} ${cutoff}
     ORDER BY "id"
       FOR UPDATE
  `;
  const targets = locked.map((row) => row.id);
  if (targets.length === 0) return 0;

  await tx.artifactVersion.deleteMany({ where: { artifactId: { in: targets } } });
  const deleted = await tx.artifact.deleteMany({ where: { id: { in: targets } } });
  return deleted.count;
}

export interface PurgeReport {
  /** Trashed rows past the cutoff when the run started. */
  eligible: number;
  /** Rows actually removed; always 0 on a dry run. */
  purged: number;
  /** True when nothing was written: asked for, or the job is not armed. */
  dryRun: boolean;
  /** Rows trashed at or before this instant were eligible. */
  cutoff: Date;
}

/**
 * The purge job: remove every artifact that has been in Recently deleted for
 * `days` or longer, across all accounts.
 *
 * DRY UNLESS ARMED. Even when the caller does not ask for a dry run, nothing is
 * deleted unless `JUNO_ARTIFACTS_PURGE=1`, because the gate has to hold for any
 * caller, not just the script. It stays unarmed until the deletion ledger
 * lands (04-MERGE-PLAN §3.4, §13.5); nothing becomes eligible before R1 plus
 * 30 days anyway.
 *
 * `prismaUnguarded` because this is the one legitimately cross-account sweep
 * over artifacts, and a cross-account query has to say so.
 *
 * In batches, each its own transaction: a backlog of thousands never becomes
 * one long transaction holding thousands of row locks and writing thousands of
 * version tombstones at once. Each batch re-checks the cutoff under its lock
 * (see `purgeArtifacts`), so a row restored between listing and deleting
 * survives.
 */
export async function purgeExpiredArtifacts({
  now = new Date(),
  days = TRASH_RETENTION_DAYS,
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
        tx,
        batch.map((row) => row.id),
        { requireTrashed: true, trashedBefore: cutoff },
      ),
    );
    purged += removed;
    // Every row in the batch was restored or re-trashed under us. They no
    // longer match, so the next listing would skip them anyway; stopping here
    // just guarantees the loop cannot spin on a batch it can never delete.
    if (removed === 0) break;
  }
  return { eligible, purged, dryRun: false, cutoff };
}
