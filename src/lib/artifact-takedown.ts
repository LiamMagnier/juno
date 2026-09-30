import "server-only";
import { prisma } from "@/lib/prisma";

/*
 * Whether Juno's takedown of an artifact's public link still stands against
 * putting that artifact's content up again.
 *
 * A takedown (src/lib/share-moderation.ts) blocks sharing or publishing the
 * artifact again until an admin restores it. Duplicate (src/lib/artifact-
 * duplicate.ts) makes a new artifact with the same content, so a check that
 * looked only at the artifact itself was one click from being walked around:
 * duplicate the removed page, publish the copy. So the check walks the chain
 * of Duplicates back through `derivedFromId` and refuses when any ancestor's
 * link was taken down.
 *
 * An ancestor purged from Recently deleted took its links, and their takedown
 * columns, with it; the moderation record survives it (ModerationFlag keeps
 * plain ids), so for that ancestor the newest takedown-or-restore record
 * decides.
 */

/** How many Duplicates back the check follows. A chain is one owner's own copies. */
export const TAKEDOWN_LINEAGE_DEPTH = 16;

/**
 * The artifact and the ones it was duplicated from, nearest first, all the
 * owner's. `purged` is the first ancestor that no longer exists, if any: the
 * walk cannot go past it.
 */
export async function artifactLineage(
  userId: string,
  artifactId: string
): Promise<{ ids: string[]; purged: string | null }> {
  const ids: string[] = [];
  let next: string | null = artifactId;
  while (next && ids.length < TAKEDOWN_LINEAGE_DEPTH && !ids.includes(next)) {
    // Trashed ancestors count: a removed page does not become publishable by
    // moving its original to Recently deleted.
    const row: { id: string; derivedFromId: string | null } | null = await prisma.artifact.findFirst({
      where: { id: next, userId },
      select: { id: true, derivedFromId: true },
    });
    if (!row) return { ids, purged: ids.length > 0 ? next : null };
    ids.push(row.id);
    next = row.derivedFromId;
  }
  return { ids, purged: null };
}

/**
 * True when a link to this artifact, or to one it was duplicated from, was
 * taken down by Juno and not restored.
 */
export async function artifactLineageTakenDown(userId: string, artifactId: string): Promise<boolean> {
  const { ids, purged } = await artifactLineage(userId, artifactId);
  if (ids.length === 0) return false;
  const [share, publication] = await Promise.all([
    prisma.share.findFirst({ where: { userId, artifactId: { in: ids }, takenDownAt: { not: null } }, select: { id: true } }),
    prisma.artifactPublication.findFirst({
      where: { userId, artifactId: { in: ids }, takenDownAt: { not: null } },
      select: { id: true },
    }),
  ]);
  if (share || publication) return true;
  if (!purged) return false;
  const newest = await prisma.moderationFlag.findFirst({
    where: { userId, artifactId: purged, category: { in: ["share_takedown", "share_restore"] } },
    orderBy: { createdAt: "desc" },
    select: { category: true },
  });
  return newest?.category === "share_takedown";
}
