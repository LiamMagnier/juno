import "server-only";

import type { Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { PLANS } from "@/lib/plans";

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

export async function libraryUsageBytes(userId: string, excludeAttachmentId?: string): Promise<number> {
  const [attachments, versions] = await Promise.all([
    prisma.attachment.findMany({
      where: { userId, ...(excludeAttachmentId ? { id: { not: excludeAttachmentId } } : {}) },
      select: { storageKey: true, size: true },
    }),
    prisma.attachmentVersion.findMany({
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

export async function libraryCapacity(userId: string, plan: Plan, incomingBytes = 0, excludeAttachmentId?: string) {
  const usedBytes = await libraryUsageBytes(userId, excludeAttachmentId);
  const quotaBytes = libraryQuotaBytes(plan);
  return {
    usedBytes,
    quotaBytes,
    incomingBytes: Math.max(0, incomingBytes),
    allowed: usedBytes + Math.max(0, incomingBytes) <= quotaBytes,
    remainingBytes: Math.max(0, quotaBytes - usedBytes),
  };
}
