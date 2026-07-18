import { prisma } from "@/lib/prisma";
import { serializeArtifact } from "@/lib/serializers";
import type { ParsedArtifact } from "@/lib/message-content";
import type { ClientArtifact } from "@/types/chat";

export class ArtifactVersionConflictError extends Error {
  constructor() {
    super("The artifact changed while this edit was being prepared.");
    this.name = "ArtifactVersionConflictError";
  }
}

/**
 * Persist artifacts parsed from an assistant message. Reusing an existing
 * identifier within the conversation appends a new version.
 */
export async function persistArtifacts(
  conversationId: string,
  messageId: string,
  parsed: ParsedArtifact[]
): Promise<ClientArtifact[]> {
  const out: ClientArtifact[] = [];

  for (const a of parsed) {
    const existing = await prisma.artifact.findUnique({
      where: { conversationId_identifier: { conversationId, identifier: a.identifier } },
    });

    if (existing) {
      // Transaction: the version insert and the currentVersion bump must land
      // together, or a concurrent writer can leave currentVersion pointing past
      // (or behind) the real newest row.
      const nextVersion = existing.currentVersion + 1;
      const [, updated] = await prisma.$transaction([
        prisma.artifactVersion.create({
          data: { artifactId: existing.id, version: nextVersion, content: a.content, origin: "generated" },
        }),
        prisma.artifact.update({
          where: { id: existing.id },
          data: {
            title: a.title,
            type: a.type,
            language: a.language ?? null,
            currentVersion: nextVersion,
            // NOTE: messageId is intentionally NOT reassigned — it stays pinned to the
            // message that first created the artifact, so regenerating a later turn
            // never deletes an artifact authored in an earlier (still-present) turn.
          },
          include: { versions: true },
        }),
      ]);
      out.push(serializeArtifact(updated));
    } else {
      const created = await prisma.artifact.create({
        data: {
          conversationId,
          messageId,
          identifier: a.identifier,
          title: a.title,
          type: a.type,
          language: a.language ?? null,
          currentVersion: 1,
          versions: { create: { version: 1, content: a.content, origin: "generated" } },
        },
        include: { versions: true },
      });
      out.push(serializeArtifact(created));
    }
  }

  return out;
}

/**
 * Append a model-produced patch to one existing artifact without allowing the
 * model to choose an identifier or replace a newer version. The compare-and-
 * bump and version insert share one interactive transaction; throwing on a
 * stale base rolls both operations back.
 */
export async function persistTargetedArtifactEdit(
  artifactId: string,
  baseVersion: number,
  content: string
): Promise<ClientArtifact> {
  const nextVersion = baseVersion + 1;
  const updated = await prisma.$transaction(async (tx) => {
    const bumped = await tx.artifact.updateMany({
      where: { id: artifactId, currentVersion: baseVersion },
      data: { currentVersion: nextVersion },
    });
    if (bumped.count !== 1) throw new ArtifactVersionConflictError();

    await tx.artifactVersion.create({
      data: { artifactId, version: nextVersion, content, origin: "generated" },
    });
    const artifact = await tx.artifact.findUnique({
      where: { id: artifactId },
      include: { versions: true },
    });
    if (!artifact) throw new ArtifactVersionConflictError();
    return artifact;
  });
  return serializeArtifact(updated);
}
