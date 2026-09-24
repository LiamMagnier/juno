import { prisma } from "@/lib/prisma";
import { serializeArtifact } from "@/lib/serializers";
import { normalizeDesignArtifact } from "@/lib/design/authoring";
import { CHAT_ARTIFACT_MAX_CHARS } from "@/lib/chat-artifact-verification";
import { DesignValidationError } from "@/lib/design/schema";
import type { ParsedArtifact } from "@/lib/message-content";
import type { ClientArtifact } from "@/types/chat";

/**
 * A DESIGN artifact is stored as a full `DesignDocument`, but the model writes
 * the compact authoring form — so it is expanded here, once, on the way in.
 *
 * A body that cannot be expanded is dropped rather than stored: an artifact the
 * editor cannot open is worse than no artifact, because it reads as data loss.
 * The failure is logged with its reason so it is diagnosable rather than silent.
 */
function normalizeForStorage(artifact: ParsedArtifact): ParsedArtifact | null {
  if (artifact.type !== "DESIGN") return artifact;
  try {
    const content = normalizeDesignArtifact(artifact.content, artifact.identifier);
    // Checked again after expansion, for callers that skip chat verification:
    // an over-limit row is refused by every later edit and blanks the native
    // libraries, so it is worse than no row.
    if (content.length > CHAT_ARTIFACT_MAX_CHARS) {
      console.warn(
        `[artifacts] dropped design artifact "${artifact.identifier}": ${content.length} characters once expanded, above ${CHAT_ARTIFACT_MAX_CHARS}`
      );
      return null;
    }
    return { ...artifact, content };
  } catch (error) {
    const detail = error instanceof DesignValidationError ? error.issues.join("; ") : String(error);
    console.warn(`[artifacts] dropped an unreadable design artifact "${artifact.identifier}": ${detail}`);
    return null;
  }
}

export class ArtifactVersionConflictError extends Error {
  constructor() {
    super("The artifact changed while this edit was being prepared.");
    this.name = "ArtifactVersionConflictError";
  }
}

/**
 * Let go of the artifacts a message first emitted, without deleting them.
 *
 * An artifact outlives the answer that made it: by the time that answer is
 * edited away or regenerated, the row can carry hand edits, design
 * checkpoints and public share links, all of which cascade from it. So
 * `messageId` is never a delete key. The row stays, with every version and
 * share, and is detached; the next emission of its identifier appends to it
 * (see `persistArtifacts`). A deleted message detaches its artifacts on its
 * own through the foreign key's `SetNull`; an answer overwritten in place by
 * a regenerate has to be let go of explicitly, which is this.
 *
 * Returned unawaited so it can join a batch `$transaction`.
 */
export function detachArtifactsFromMessage(messageId: string) {
  return prisma.artifact.updateMany({ where: { messageId }, data: { messageId: null } });
}

/**
 * Persist artifacts parsed from an assistant message. Reusing an existing
 * identifier within the conversation appends a new version to the same row,
 * so an artifact keeps its id, history and share links across edits and
 * regenerates.
 */
export async function persistArtifacts(
  conversationId: string,
  messageId: string,
  parsed: ParsedArtifact[]
): Promise<ClientArtifact[]> {
  const out: ClientArtifact[] = [];

  for (const raw of parsed) {
    const a = normalizeForStorage(raw);
    if (!a) continue;
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
            // messageId stays pinned to the message that first created the
            // artifact while that message is still there, so the inline card
            // in a later turn reads as an update. A detached row (its message
            // was edited away or regenerated) is claimed by this message.
            ...(existing.messageId ? {} : { messageId }),
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
