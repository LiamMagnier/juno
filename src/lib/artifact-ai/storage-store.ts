import "server-only";
import { prisma } from "@/lib/prisma";
import type { ArtifactStorageStore } from "@/lib/artifact-ai/storage";

/**
 * `ArtifactStorageEntry` behind `window.alevr.storage` (src/lib/artifact-ai/storage.ts
 * holds the rules). Every query names the viewer (`userId`), which is both the
 * scope and what the ownership guard (OWNER_COLUMN in src/lib/db.ts) checks.
 *
 * A write takes a transaction-scoped advisory lock on the viewer before it
 * reads their usage, so the caps hold under concurrent writes from several
 * frames or tabs: two writes that each fit alone but not together are
 * serialized, and the second one sees the first.
 */
export const prismaArtifactStorageStore: ArtifactStorageStore = {
  async get({ artifactId, userId }, key) {
    const row = await prisma.artifactStorageEntry.findFirst({
      where: { artifactId, userId, key },
      select: { value: true },
    });
    return row ? { stored: row.value } : null;
  },

  async list({ artifactId, userId }, prefix, limit) {
    const rows = await prisma.artifactStorageEntry.findMany({
      where: { artifactId, userId, ...(prefix ? { key: { startsWith: prefix } } : {}) },
      select: { key: true },
      orderBy: { key: "asc" },
      take: limit,
    });
    return rows.map((row) => row.key);
  },

  async put({ artifactId, userId }, entry, decide) {
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`artifact-storage:${userId}`}, 0))::text`;
      const [existing, inArtifact, inAccount] = await Promise.all([
        tx.artifactStorageEntry.findFirst({ where: { artifactId, userId, key: entry.key }, select: { bytes: true } }),
        tx.artifactStorageEntry.aggregate({ where: { artifactId, userId }, _sum: { bytes: true }, _count: { _all: true } }),
        tx.artifactStorageEntry.aggregate({ where: { userId }, _sum: { bytes: true } }),
      ]);
      const verdict = decide({
        existingKey: !!existing,
        existingBytes: existing?.bytes ?? 0,
        artifactBytes: inArtifact._sum.bytes ?? 0,
        artifactKeys: inArtifact._count._all,
        accountBytes: inAccount._sum.bytes ?? 0,
      });
      if (!verdict.ok) return verdict;
      await tx.artifactStorageEntry.upsert({
        where: { artifactId_userId_key: { artifactId, userId, key: entry.key } },
        create: { artifactId, userId, key: entry.key, value: entry.stored, bytes: entry.bytes },
        update: { value: entry.stored, bytes: entry.bytes },
      });
      return verdict;
    });
  },

  async delete({ artifactId, userId }, key) {
    const removed = await prisma.artifactStorageEntry.deleteMany({ where: { artifactId, userId, key } });
    return removed.count > 0;
  },
};
