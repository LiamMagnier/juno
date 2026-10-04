/** Scope-bound lifecycle changes that can invalidate an already-written summary. */
import type { Prisma } from "@prisma/client";

export interface MemorySummaryChanges {
  newestRetirementAt: Date | null;
  newestExpiryAt: Date | null;
}

export type MemorySummaryChangeReader = (args: {
  where: Prisma.MemoryEntryWhereInput;
  orderBy: Prisma.MemoryEntryOrderByWithRelationInput;
  select: { updatedAt?: true; expiresAt?: true };
}) => Promise<{ updatedAt?: Date; expiresAt?: Date | null } | null>;

/**
 * Retiring an old belief can leave the row count unchanged (moving back to a
 * previously remembered city reinstates its row). A summary still describes
 * the retired belief until rebuilt. Read only timestamps, in the summary's
 * exact account/project scope, and never load another person's fact content.
 * An elapsed expiry invalidates prose even before the asynchronous sweep runs.
 */
export async function readMemorySummaryChanges(
  input: { userId: string; projectId: string | null; now: Date },
  read: MemorySummaryChangeReader,
): Promise<MemorySummaryChanges> {
  const scope = { userId: input.userId, projectId: input.projectId, kind: "FACT" as const };
  const [retired, expired] = await Promise.all([
    read({
      where: { ...scope, status: { in: ["superseded", "suppressed", "expired"] } },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
    read({
      where: { ...scope, expiresAt: { not: null, lte: input.now } },
      orderBy: { expiresAt: "desc" },
      select: { expiresAt: true },
    }),
  ]);
  return { newestRetirementAt: retired?.updatedAt ?? null, newestExpiryAt: expired?.expiresAt ?? null };
}
