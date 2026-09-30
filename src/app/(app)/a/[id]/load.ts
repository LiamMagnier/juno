import "server-only";

import { prisma } from "@/lib/prisma";
import { ownedArtifactWhere } from "@/lib/artifact-access";

/**
 * The reads behind `/a/{id}`, split so the page never holds more than the one
 * body it draws.
 *
 * Ownership is the artifact's own (`Artifact.userId`, src/lib/artifact-access.ts),
 * the same `where` as `loadOwnedDesignArtifact` and `/api/artifacts/[id]`, so
 * this page is its owner's whether or not the artifact still has a chat, and
 * a signed-in reader who does not own it — or an artifact in Recently deleted
 * — gets the same 404 as an id that never existed. Saying "this exists, but
 * not for you" would tell a stranger which ids are real.
 *
 * The first read takes every version's NUMBER and no content, plus whether a
 * design has an unsealed working copy (its draft), which the page presents as
 * the version it will become: `currentVersion + 1`. The second read fetches
 * the one body the page draws.
 */
export async function loadOwnedArtifact(id: string, userId: string) {
  const artifact = await prisma.artifact.findFirst({
    where: ownedArtifactWhere(userId, { id }),
    select: {
      id: true,
      identifier: true,
      title: true,
      type: true,
      language: true,
      currentVersion: true,
      conversationId: true,
      versions: { select: { version: true }, orderBy: { version: "asc" } },
      draft: { select: { updatedAt: true } },
    },
  });
  if (!artifact) return null;
  const { draft, ...rest } = artifact;
  if (!draft) return { ...rest, headVersion: artifact.currentVersion, hasDraft: false };
  const working = artifact.currentVersion + 1;
  return {
    ...rest,
    currentVersion: working,
    headVersion: artifact.currentVersion,
    hasDraft: true,
    versions: [...artifact.versions, { version: working }],
  };
}

export type OwnedArtifactSummary = NonNullable<Awaited<ReturnType<typeof loadOwnedArtifact>>>;

/**
 * One version's body, or null if it went away between the two reads. The
 * working version of a design with a draft is the draft.
 */
export async function loadArtifactVersion(artifact: OwnedArtifactSummary, version: number, userId: string) {
  if (artifact.hasDraft && version === artifact.currentVersion) {
    const draft = await prisma.artifactDraft.findFirst({
      where: { artifactId: artifact.id, userId },
      select: { content: true, updatedAt: true },
    });
    if (draft) return { version, content: draft.content, createdAt: draft.updatedAt };
    // Sealed between the two reads: it is now exactly this version.
  }
  return prisma.artifactVersion.findUnique({
    where: { artifactId_version: { artifactId: artifact.id, version } },
    select: { version: true, content: true, createdAt: true },
  });
}
