import "server-only";

import { randomUUID } from "node:crypto";
import { ingest, type IngestInput } from "@/lib/knowledge";
import { prismaUnguarded } from "@/lib/db";
import { deleteObject, getObjectBytes } from "@/lib/storage";

export const IMPORT_RUN_LEASE_MS = 15 * 60 * 1000;
export const IMPORT_RECOVERY_INTERVAL_MS = 60 * 1000;
export const IMPORT_INGEST_LEASE_MS = 15 * 60 * 1000;

const CLEANUP_STATES = ["staged", "uploaded", "delete_pending"] as const;

/**
 * Delete every object that is not attached to a committed library row.
 *
 * The status predicate is repeated on every update so a late cleanup cannot
 * race a successful import and delete an object after it became `attached`.
 * Failed deletes remain `delete_pending` for the recovery worker to retry.
 */
export async function cleanupImportRun(userId: string, importRunId: string, leaseToken?: string) {
  const objects = await prismaUnguarded.importObject.findMany({
    where: { userId, importRunId, ...(leaseToken ? { leaseToken } : {}), status: { in: [...CLEANUP_STATES] } },
    select: { id: true, storageKey: true },
  });
  let deleted = 0;
  let failed = 0;

  for (const object of objects) {
    const claimed = await prismaUnguarded.importObject.updateMany({
      where: { id: object.id, userId, importRunId, ...(leaseToken ? { leaseToken } : {}), status: { in: [...CLEANUP_STATES] } },
      data: { status: "delete_pending" },
    });
    if (claimed.count !== 1) continue;
    try {
      await deleteObject(object.storageKey);
      await prismaUnguarded.importObject.updateMany({
        where: { id: object.id, userId, importRunId, ...(leaseToken ? { leaseToken } : {}), status: "delete_pending" },
        data: { status: "deleted" },
      });
      deleted += 1;
    } catch (error) {
      failed += 1;
      console.error("[import-recovery] object deletion failed", {
        importRunId,
        objectId: object.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { deleted, failed };
}

/**
 * Reclaim expired in-flight imports. A completed run is never selected, and
 * `attached` objects are never selected by cleanup, so this is safe to run
 * concurrently with an import request or more than once after a restart.
 */
export async function sweepExpiredImportRuns(limit = 20) {
  const now = new Date();
  const runs = await prismaUnguarded.importRun.findMany({
    where: {
      OR: [
        { status: { in: ["applying", "failed"] }, leaseExpiresAt: { lt: now } },
        { status: "completed", objects: { some: { status: { in: [...CLEANUP_STATES] } } } },
      ],
    },
    select: { id: true, userId: true, status: true, leaseToken: true },
    orderBy: { leaseExpiresAt: "asc" },
    take: Math.max(1, Math.min(limit, 100)),
  });

  let runsRecovered = 0;
  let objectsDeleted = 0;
  let objectsFailed = 0;
  for (const run of runs) {
    const previousLeaseToken = run.leaseToken;
    let replacementLeaseToken = previousLeaseToken;
    if (run.status !== "completed") {
      replacementLeaseToken = randomUUID();
      const claimed = await prismaUnguarded.importRun.updateMany({
        where: {
          id: run.id,
          userId: run.userId,
          status: { in: ["applying", "failed"] },
          leaseToken: previousLeaseToken,
          leaseExpiresAt: { lt: now },
        },
        data: {
          status: "failed",
          error: "Import lease expired; object cleanup is in progress.",
          leaseToken: replacementLeaseToken,
          leaseExpiresAt: new Date(now.getTime() + IMPORT_RECOVERY_INTERVAL_MS),
        },
      });
      if (claimed.count !== 1) continue;
    }

    const cleanup = await cleanupImportRun(run.userId, run.id, previousLeaseToken);
    objectsDeleted += cleanup.deleted;
    objectsFailed += cleanup.failed;
    const remaining = await prismaUnguarded.importObject.count({
      where: { userId: run.userId, importRunId: run.id, leaseToken: previousLeaseToken, status: { in: [...CLEANUP_STATES] } },
    });
    if (run.status !== "completed") {
      await prismaUnguarded.importRun.updateMany({
        where: { id: run.id, userId: run.userId, status: "failed", leaseToken: replacementLeaseToken },
        data: { leaseExpiresAt: remaining > 0 ? new Date(now.getTime() + IMPORT_RECOVERY_INTERVAL_MS) : null },
      });
    }
    runsRecovered += 1;
  }

  return { runsRecovered, objectsDeleted, objectsFailed };
}

/**
 * Recover imported files whose post-response `after()` hook never ran or whose
 * indexing process died. The attachment state is the small durable outbox:
 * queued means not claimed, indexing means claimed, and an old indexing row is
 * reclaimable. The conditional update fences this worker against the normal
 * upload/import scheduler and makes a second PM2 instance harmless.
 */
export async function sweepQueuedImportIngests(limit = 2) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - IMPORT_INGEST_LEASE_MS);
  const candidates = await prismaUnguarded.attachment.findMany({
    where: {
      origin: "import",
      deletedAt: null,
      OR: [
        { parserState: "queued" },
        { parserState: "indexing", OR: [{ parserClaimedAt: null }, { parserClaimedAt: { lt: staleBefore } }] },
      ],
    },
    select: {
      id: true,
      userId: true,
      projectId: true,
      fileName: true,
      mimeType: true,
      storageKey: true,
      parserState: true,
      parserClaimedAt: true,
    },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(limit, 20)),
  });

  let claimed = 0;
  let recovered = 0;
  let failed = 0;
  for (const attachment of candidates) {
    const claimWhere =
      attachment.parserState === "queued"
        ? { id: attachment.id, userId: attachment.userId, origin: "import", parserState: "queued" }
        : {
            id: attachment.id,
            userId: attachment.userId,
            origin: "import",
            parserState: "indexing",
            OR: [{ parserClaimedAt: null }, { parserClaimedAt: { lt: staleBefore } }],
          };
    const didClaim = await prismaUnguarded.attachment.updateMany({
      where: claimWhere,
      data: { parserState: "indexing", parserClaimedAt: now },
    });
    if (didClaim.count !== 1) continue;
    claimed += 1;

    try {
      const stored = await getObjectBytes(attachment.storageKey);
      const input: IngestInput = {
        userId: attachment.userId,
        attachmentId: attachment.id,
        projectId: attachment.projectId,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        bytes: stored.bytes,
      };
      const outcome = await ingest(input);
      const parserState =
        outcome.status === "indexed"
          ? outcome.state
          : outcome.status === "reused"
            ? "ready"
            : outcome.status === "unavailable"
              ? "queued"
              : outcome.status;
      await prismaUnguarded.attachment.updateMany({
        where: { id: attachment.id, userId: attachment.userId, parserState: "indexing" },
        data: { parserState, parserClaimedAt: null },
      });
      if (parserState === "queued") failed += 1;
      else recovered += 1;
    } catch (error) {
      failed += 1;
      await prismaUnguarded.attachment
        .updateMany({
          where: { id: attachment.id, userId: attachment.userId, parserState: "indexing" },
          data: { parserState: "queued", parserClaimedAt: null },
        })
        .catch(() => undefined);
      console.error("[import-recovery] knowledge ingest failed", {
        attachmentId: attachment.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { claimed, recovered, failed };
}
