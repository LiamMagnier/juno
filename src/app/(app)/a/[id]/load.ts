import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * The reads behind `/a/{id}`, split so the page never holds more than the one
 * body it draws.
 *
 * Ownership is the join every artifact route already uses — artifact →
 * conversation → user, the same `where` as `loadOwnedDesignArtifact` and
 * `/api/artifacts/[id]` — so this page is exactly as private as the chat the
 * artifact was made in, and a signed-in reader who does not own it gets the
 * same 404 as an id that never existed. Saying "this exists, but not for you"
 * would tell a stranger which ids are real.
 *
 * The first read takes every version's NUMBER and no content: an artifact can
 * hold dozens of versions of up to 200 000 characters each, and the page needs
 * the numbers for the stepper and exactly one body. The second read fetches
 * that body by the `(artifactId, version)` unique key, which is only ever
 * called with an id the first read has just proven the reader owns.
 */
export async function loadOwnedArtifact(id: string, userId: string) {
  return prisma.artifact.findFirst({
    where: { id, conversation: { userId } },
    select: {
      id: true,
      identifier: true,
      title: true,
      type: true,
      language: true,
      currentVersion: true,
      conversationId: true,
      versions: { select: { version: true }, orderBy: { version: "asc" } },
    },
  });
}

export type OwnedArtifactSummary = NonNullable<Awaited<ReturnType<typeof loadOwnedArtifact>>>;

/** One version's body, or null if it went away between the two reads. */
export async function loadArtifactVersion(artifactId: string, version: number) {
  return prisma.artifactVersion.findUnique({
    where: { artifactId_version: { artifactId, version } },
    select: { version: true, content: true, createdAt: true },
  });
}
