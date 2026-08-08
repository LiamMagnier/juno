import "server-only";

import type { Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { PLANS } from "@/lib/plans";

export interface LibraryCapacity {
  usedBytes: number;
  quotaBytes: number;
  incomingBytes: number;
  allowed: boolean;
  remainingBytes: number;
}

type LibraryRow = { storageKey: string; size: number };

type LibraryDb = {
  attachment: {
    findMany(args: {
      where: { userId: string; id?: { not: string } };
      select: { storageKey: true; size: true };
    }): Promise<LibraryRow[]>;
  };
  attachmentVersion: {
    findMany(args: {
      where: { attachment: { userId: string } };
      select: { storageKey: true; size: true };
    }): Promise<LibraryRow[]>;
  };
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
};

/** Raised only after a transaction re-checks the quota under the account lock. */
export class LibraryQuotaExceededError extends Error {
  constructor(public readonly capacity: LibraryCapacity) {
    super("Library storage limit reached.");
    this.name = "LibraryQuotaExceededError";
  }
}

/**
 * Storage quota is account-wide and counts unique stored objects, not library
 * clones that point at the same object. The env override gives an operator a
 * deployment-specific ceiling without changing plan code; the fallback keeps
 * the limit proportional to the plan's single-file allowance.
 */
export function libraryQuotaBytes(plan: Plan): number {
  const configuredMb = Number(process.env.JUNO_LIBRARY_QUOTA_MB ?? "");
  const quotaMb = Number.isFinite(configuredMb) && configuredMb > 0 ? configuredMb : PLANS[plan].maxUploadMb * 100;
  return Math.round(quotaMb * 1024 * 1024);
}

export async function libraryUsageBytes(
  userId: string,
  excludeAttachmentId?: string,
  db: LibraryDb = prisma,
): Promise<number> {
  const [attachments, versions] = await Promise.all([
    db.attachment.findMany({
      where: { userId, ...(excludeAttachmentId ? { id: { not: excludeAttachmentId } } : {}) },
      select: { storageKey: true, size: true },
    }),
    db.attachmentVersion.findMany({
      where: { attachment: { userId } },
      select: { storageKey: true, size: true },
    }),
  ]);
  // Deleted rows and immutable revisions still retain their object bytes and
  // therefore consume quota. Count by object key so a current row and its
  // snapshot do not double-charge the same object.
  const unique = new Map<string, number>();
  for (const row of [...attachments, ...versions]) {
    unique.set(row.storageKey, Math.max(unique.get(row.storageKey) ?? 0, Math.max(0, row.size)));
  }
  return [...unique.values()].reduce((sum, size) => sum + Math.max(0, size), 0);
}

export async function libraryCapacity(
  userId: string,
  plan: Plan,
  incomingBytes = 0,
  excludeAttachmentId?: string,
  db: LibraryDb = prisma,
): Promise<LibraryCapacity> {
  const usedBytes = await libraryUsageBytes(userId, excludeAttachmentId, db);
  const quotaBytes = libraryQuotaBytes(plan);
  return {
    usedBytes,
    quotaBytes,
    incomingBytes: Math.max(0, incomingBytes),
    allowed: usedBytes + Math.max(0, incomingBytes) <= quotaBytes,
    remainingBytes: Math.max(0, quotaBytes - usedBytes),
  };
}

/**
 * Serialize all quota-bearing library writes for one account. PostgreSQL row
 * locks are held until the surrounding transaction commits, so the usage read
 * and the attachment/version insert see a single authoritative reservation.
 */
export async function lockedLibraryCapacity(
  tx: LibraryDb,
  userId: string,
  plan: Plan,
  incomingBytes = 0,
  excludeAttachmentId?: string,
): Promise<LibraryCapacity> {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
  return libraryCapacity(userId, plan, incomingBytes, excludeAttachmentId, tx);
}

export function assertLibraryCapacity(capacity: LibraryCapacity): void {
  if (!capacity.allowed) throw new LibraryQuotaExceededError(capacity);
}
