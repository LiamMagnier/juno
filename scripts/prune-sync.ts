/**
 * Sync-log retention pruner — deletes AccountChange rows and MutationReceipts
 * older than the retention window and advances the compaction floor so the
 * change-feed protocol stays honest: bootstrap/changes serve the floor, and a
 * client whose cursor predates it gets 410 (it must resync) instead of a
 * silently incomplete catch-up.
 *
 *   npm run sync:prune             # apply (default 30-day window)
 *   npm run sync:prune -- --dry    # report what would be pruned, write nothing
 *   npm run sync:prune -- --days 90
 *
 * Floor consistency: everything up to the highest cursor older than the
 * cutoff is deleted — including the handful of newer-cursor rows that got an
 * earlier changedAt through clock interleaving — so no change below the floor
 * can survive. The floor only ever moves forward. Run it from cron or by hand
 * (see the maintenance note in deploy/VM_SETUP_GUIDE.md); EntityRevision rows
 * are current-state and are never pruned.
 */
import { prismaUnguarded } from "@/lib/db";

const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 7;

const DRY = process.argv.includes("--dry") || process.argv.includes("--dry-run");

function retentionDays(): number {
  const flagIndex = process.argv.indexOf("--days");
  const raw = flagIndex !== -1 ? process.argv[flagIndex + 1] : process.env.SYNC_RETENTION_DAYS;
  if (raw === undefined) return DEFAULT_RETENTION_DAYS;
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days < MIN_RETENTION_DAYS) {
    throw new Error(`Retention must be an integer ≥ ${MIN_RETENTION_DAYS} days (got "${raw}").`);
  }
  return days;
}

async function main() {
  const days = retentionDays();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  console.log(`[prune-sync] retention ${days}d — pruning sync history older than ${cutoff.toISOString()}${DRY ? " (dry run)" : ""}`);

  // Highest cursor older than the cutoff = the new compaction floor candidate.
  const aggregate = await prismaUnguarded.accountChange.aggregate({
    where: { changedAt: { lt: cutoff } },
    _max: { cursor: true },
  });
  const floorCandidate = aggregate._max.cursor;

  if (floorCandidate === null) {
    console.log("[prune-sync] no AccountChange rows older than the cutoff — floor unchanged.");
  } else if (DRY) {
    const count = await prismaUnguarded.accountChange.count({ where: { cursor: { lte: floorCandidate } } });
    console.log(`[prune-sync] would delete ${count} AccountChange rows (cursor ≤ ${floorCandidate}) and raise the floor to ${floorCandidate}.`);
  } else {
    const deleted = await prismaUnguarded.$transaction(async (tx) => {
      const removed = await tx.accountChange.deleteMany({ where: { cursor: { lte: floorCandidate } } });
      const existing = await tx.syncCompaction.findUnique({ where: { id: "global" } });
      // Monotonic: a concurrent or replayed run must never lower the floor.
      const floor = existing && existing.floorCursor > floorCandidate ? existing.floorCursor : floorCandidate;
      await tx.syncCompaction.upsert({
        where: { id: "global" },
        create: { id: "global", floorCursor: floor },
        update: { floorCursor: floor, prunedAt: new Date() },
      });
      return removed.count;
    });
    console.log(`[prune-sync] deleted ${deleted} AccountChange rows; compaction floor is now ${floorCandidate}.`);
  }

  if (DRY) {
    const receipts = await prismaUnguarded.mutationReceipt.count({ where: { createdAt: { lt: cutoff } } });
    console.log(`[prune-sync] would delete ${receipts} MutationReceipt rows.`);
  } else {
    const receipts = await prismaUnguarded.mutationReceipt.deleteMany({ where: { createdAt: { lt: cutoff } } });
    console.log(`[prune-sync] deleted ${receipts.count} MutationReceipt rows.`);
  }
}

main()
  .then(() => prismaUnguarded.$disconnect())
  .catch(async (error) => {
    console.error("[prune-sync] failed:", error);
    await prismaUnguarded.$disconnect();
    process.exit(1);
  });
