import type { Prisma } from "@prisma/client";
import type { ClientArtifact } from "@/types/chat";

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

/**
 * Whether a request comes from an installed Mac or iPhone build: those
 * authenticate with a device bearer token (src/lib/session.ts), the website
 * with its session cookie.
 */
export function isInstalledAppRequest(req: Pick<Request, "headers">): boolean {
  return !!req.headers.get("authorization");
}

/**
 * The chat artifacts an installed Mac or iPhone build is sent: a chat read
 * (GET /api/conversations/[id]) and a turn's `done` frame.
 *
 * Those builds merge every artifact they are handed into their library as a
 * row that stays until sync delivers the same version or a newer one
 * (NativeArtifactModel.merge(streamed:)). So:
 *
 *   - a TRASHED artifact is left out. Sync tombstones it; handed over here, it
 *     would be laid back over the library and never leave, because sync never
 *     delivers it again. (The website keeps it, so a card can offer Restore.)
 *   - a design's unsealed web DRAFT is taken off. It is presented to the
 *     website as `currentVersion + 1`, and a build that cached it would keep a
 *     body under a version number whose sealed body can still differ. The
 *     sealed head goes instead.
 *
 * A live artifact with no draft passes through as the same object.
 */
export function artifactsForInstalledApps(artifacts: readonly ClientArtifact[]): ClientArtifact[] {
  const out: ClientArtifact[] = [];
  for (const artifact of artifacts) {
    if (artifact.deletedAt) continue;
    if (!artifact.versions.some((version) => version.draft)) {
      out.push(artifact);
      continue;
    }
    const versions = artifact.versions.filter((version) => !version.draft);
    const head = versions.reduce<(typeof versions)[number] | null>(
      (best, version) => (best === null || version.version > best.version ? version : best),
      null
    );
    // A design is born with version 1, so a draft always has a sealed head
    // under it; one that somehow has none has nothing an app could show.
    if (!head) continue;
    out.push({ ...artifact, versions, currentVersion: head.version, content: head.content });
  }
  return out;
}
