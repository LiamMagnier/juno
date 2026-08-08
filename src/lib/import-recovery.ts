import "server-only";

import { prismaUnguarded } from "@/lib/db";
import { deleteObject } from "@/lib/storage";

export const IMPORT_RUN_LEASE_MS = 15 * 60 * 1000;
export const IMPORT_RECOVERY_INTERVAL_MS = 60 * 1000;

const CLEANUP_STATES = ["staged", "uploaded", "delete_pending"] as const;

/**
 * Delete every object that is not attached to a committed library row.
 *
 * The status predicate is repeated on every update so a late cleanup cannot
 * race a successful import and delete an object after it became `attached`.
 * Failed deletes remain `delete_pending` for the recovery worker to retry.
 */
export async function cleanupImportRun(userId: string, importRunId: string) {
  const objects = await prismaUnguarded.importObject.findMany({
    where: { userId, importRunId, status: { in: [...CLEANUP_STATES] } },
    select: { id: true, storageKey: true },
  });
  let deleted = 0;
  let failed = 0;

  for (const object of objects) {
    const claimed = await prismaUnguarded.importObject.updateMany({
      where: { id: object.id, userId, importRunId, status: { in: [...CLEANUP_STATES] } },
      data: { status: "delete_pending" },
    });
    if (claimed.count !== 1) continue;
    try {
      await deleteObject(object.storageKey);
      await prismaUnguarded.importObject.updateMany({
        where: { id: object.id, userId, importRunId, status: "delete_pending" },
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
    select: { id: true, userId: true, status: true },
    orderBy: { leaseExpiresAt: "asc" },
    take: Math.max(1, Math.min(limit, 100)),
  });

  let runsRecovered = 0;
  let objectsDeleted = 0;
  let objectsFailed = 0;
  for (const run of runs) {
    if (run.status !== "completed") {
      const claimed = await prismaUnguarded.importRun.updateMany({
        where: {
          id: run.id,
          userId: run.userId,
          status: { in: ["applying", "failed"] },
          leaseExpiresAt: { lt: now },
        },
        data: {
          status: "failed",
          error: "Import lease expired; object cleanup is in progress.",
          leaseExpiresAt: new Date(now.getTime() + IMPORT_RECOVERY_INTERVAL_MS),
        },
      });
      if (claimed.count !== 1) continue;
    }

    const cleanup = await cleanupImportRun(run.userId, run.id);
    objectsDeleted += cleanup.deleted;
    objectsFailed += cleanup.failed;
    const remaining = await prismaUnguarded.importObject.count({
      where: { userId: run.userId, importRunId: run.id, status: { in: [...CLEANUP_STATES] } },
    });
    if (run.status !== "completed") {
      await prismaUnguarded.importRun.updateMany({
        where: { id: run.id, userId: run.userId, status: "failed" },
        data: { leaseExpiresAt: remaining > 0 ? new Date(now.getTime() + IMPORT_RECOVERY_INTERVAL_MS) : null },
      });
    }
    runsRecovered += 1;
  }

  return { runsRecovered, objectsDeleted, objectsFailed };
}
