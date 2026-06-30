import { prisma } from "@/lib/prisma";
import { serializeArtifact } from "@/lib/serializers";
import type { ParsedArtifact } from "@/lib/message-content";
import type { ClientArtifact } from "@/types/chat";

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
      const nextVersion = existing.currentVersion + 1;
      await prisma.artifactVersion.create({
        data: { artifactId: existing.id, version: nextVersion, content: a.content },
      });
      const updated = await prisma.artifact.update({
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
      });
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
          versions: { create: { version: 1, content: a.content } },
        },
        include: { versions: true },
      });
      out.push(serializeArtifact(created));
    }
  }

  return out;
}
