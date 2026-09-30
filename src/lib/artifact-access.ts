import type { Prisma } from "@prisma/client";

/*
 * How an artifact is owned and scoped (PRODUCT_REFOUNDATION §10, D-013).
 *
 * An artifact belongs to a PERSON (`Artifact.userId`), not to the chat it was
 * made in. The chat is a nullable pointer: it is null for an artifact made
 * outside a chat (New design, Duplicate) and once that chat is deleted, which
 * detaches the artifact instead of deleting it. Every owner read goes through
 * `ownedArtifactWhere`, which is also what satisfies the ownership guard
 * (`OWNER_COLUMN` in src/lib/db.ts): a query that forgets the owner is flagged
 * in development and logged in production.
 *
 * Pure: no database, so the route tests and the native projection can use it.
 */

/**
 * The owner's live artifacts. A trashed row is absent from every owner read
 * except Recently deleted, which asks for it explicitly.
 */
export function ownedArtifactWhere(
  userId: string,
  extra: Prisma.ArtifactWhereInput = {},
  opts: { trashed?: boolean } = {}
): Prisma.ArtifactWhereInput {
  return { ...extra, userId, deletedAt: opts.trashed ? { not: null } : null };
}

/**
 * How many versions a client-facing read carries with their bodies.
 *
 * A read used to include EVERY version body (up to 200 000 characters each),
 * so an artifact with a long history cost its whole history on every open and
 * every chat load (audit X-30/X-33). Reads now carry the newest window and set
 * `hasOlderVersions`; the rest page in from GET /api/artifacts/[id]/versions.
 * The installed Mac and iPhone decoders need only the current version to be in
 * the list, which the window always holds.
 */
export const ARTIFACT_VERSION_WINDOW = 50;

/** Page size bounds for GET /api/artifacts/[id]/versions. */
export const ARTIFACT_VERSION_PAGE_DEFAULT = 20;
export const ARTIFACT_VERSION_PAGE_MAX = 100;

/**
 * The newest `ARTIFACT_VERSION_WINDOW` versions, newest first. Serializers sort
 * them back into ascending order.
 */
export const artifactVersionWindow = {
  orderBy: { version: "desc" },
  take: ARTIFACT_VERSION_WINDOW,
} satisfies Prisma.Artifact$versionsArgs;

/**
 * The value sync sends as `conversationId` for an artifact that has no chat.
 *
 * The installed Mac and iPhone builds decode `conversationId` as a required,
 * non-empty string and fail the WHOLE artifact library on a record that lacks
 * one (NativeArtifactStore.decodeArtifact, audit X-09). A detached artifact
 * therefore carries a stable, non-empty placeholder that names no real chat:
 * those builds label it "Conversation", and a chat lookup for it finds
 * nothing. The truth travels beside it as `detached: true` and
 * `ownerConversationId: null` for builds that know to read them.
 */
export const DETACHED_CONVERSATION_PREFIX = "library:";

export function syncConversationIdFor(artifact: { id: string; conversationId: string | null }): string {
  return artifact.conversationId ?? `${DETACHED_CONVERSATION_PREFIX}${artifact.id}`;
}

/** The artifact's project as Library, Projects and Duplicate read it. */
export function artifactProjectId(artifact: {
  projectId: string | null;
  conversation?: { projectId: string | null } | null;
}): string | null {
  return artifact.projectId ?? artifact.conversation?.projectId ?? null;
}

/**
 * Scope to one project: the artifact's own project, or — for a row the
 * previous release wrote without one during a deploy — its chat's.
 */
export function artifactInProjectWhere(projectId: string): Prisma.ArtifactWhereInput {
  return { OR: [{ projectId }, { projectId: null, conversation: { projectId } }] };
}
