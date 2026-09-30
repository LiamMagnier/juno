import "server-only";
import { randomBytes } from "crypto";
import { cache } from "react";
import type { ArtifactPublication } from "@prisma/client";
import { prisma, prismaUnguarded } from "@/lib/prisma";
import { shareUrl } from "@/lib/share-url";
import { shareIsServable } from "@/lib/share-policy";
import { lockArtifact, sealDraftLocked } from "@/lib/artifact-writes";
import { artifactLineageTakenDown } from "@/lib/artifact-takedown";
import type { ArtifactType } from "@/lib/message-content";

/*
 * PUBLISH (PRODUCT_REFOUNDATION §10, DECISIONS D-013).
 *
 * Publishing is separate from sharing. A Share is the legacy frozen snapshot
 * link (and, later, private access for people); a PUBLICATION is the artifact's
 * stable public URL, serving a version the owner chose:
 *
 *   Publish          → the page goes up, pinned to a version (by default the
 *                      one the owner is looking at) or, only when asked for,
 *                      to "latest".
 *   Update           → move the pin forward (a newer version, or latest).
 *   Roll back        → move the pin to an older version.
 *   Unpublish        → the page comes down; the token is kept, so publishing
 *                      again brings back the same URL.
 *   Reset link       → the old token is retired for good (it answers "link
 *                      gone") and a new token takes over, same pin and state.
 *
 * Nothing here runs on a dialog opening: every function below is an explicit
 * action the owner took. At most one live (unretired) publication per artifact;
 * every mutation takes the artifact's row lock (`lockArtifact`) first, which
 * serializes publishers and makes the invariant hold without a partial unique
 * index (which the drift check cannot express).
 *
 * The public page serves the pinned VERSION, and versions are immutable, so
 * what the public sees is exactly what the owner pinned: later edits, drafts
 * and suggestions never reach it until the owner moves the pin (or it follows
 * latest, which serves only SEALED versions).
 *
 * Following latest carries the OWNER's saves to the page, never Juno's: a
 * version Juno writes on its own (a chat re-emit, a targeted edit) first pins
 * the page to what it serves (holdPublicationForModelWrite in
 * src/lib/artifact-writes.ts), and goes public only when the owner publishes
 * it. Publishing is on the always-confirm floor, and a model turn may have read
 * text written to steer it. Content is shown statically: the
 * scripted `public` sandbox profile stays behind JUNO_PREVIEW_ORIGIN_PUBLIC and
 * publish-time screening (src/lib/sandbox-policy.ts), which this module does
 * not change.
 *
 * Governance matches Share: a Juno takedown (src/lib/share-moderation.ts) takes
 * the page down and blocks publishing the artifact again until an admin
 * restores it; a banned owner's publications stop serving on the next request
 * (read at request time); the Report link on the page reports a publication.
 */

export class PublicationTakenDownError extends Error {
  constructor() {
    super("This was removed from public sharing for breaking Juno’s rules, so it can’t be published again.");
    this.name = "PublicationTakenDownError";
  }
}

export class PublicationVersionError extends Error {
  constructor() {
    super("That version does not exist.");
    this.name = "PublicationVersionError";
  }
}

export interface ClientPublication {
  id: string;
  token: string;
  url: string;
  /** "live" while the page is up, "unpublished" while it is down. */
  state: "live" | "unpublished";
  /** The pinned version, or null when it follows the latest version. */
  pinnedVersion: number | null;
  /** The version the page serves now (the pin, or the latest sealed version). */
  servedVersion: number;
  views: number;
  publishedAt: string | null;
  unpublishedAt: string | null;
  createdAt: string;
}

export function serializePublication(row: ArtifactPublication, currentVersion: number): ClientPublication {
  return {
    id: row.id,
    token: row.token,
    url: shareUrl(row.token),
    state: row.publishedAt ? "live" : "unpublished",
    pinnedVersion: row.pinnedVersion,
    servedVersion: row.pinnedVersion ?? currentVersion,
    views: row.views,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    unpublishedAt: row.unpublishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 32 URL-safe chars (24 random bytes), the same capability shape as a share. */
function newToken(): string {
  return randomBytes(24).toString("base64url");
}

/** The artifact's live (unretired) publication, or null. */
async function livePublication(db: Pick<typeof prisma, "artifactPublication">, userId: string, artifactId: string) {
  return db.artifactPublication.findFirst({
    where: { artifactId, userId, retiredAt: null },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * The owner's publication of one artifact, as the Publish panel reads it. No
 * side effect: opening the panel never creates anything. Null for an artifact
 * that is not theirs, trashed, or never published.
 */
export async function getPublication(
  userId: string,
  artifactId: string
): Promise<{ publication: ClientPublication | null; currentVersion: number } | null> {
  const artifact = await prisma.artifact.findFirst({
    where: { id: artifactId, userId, deletedAt: null },
    select: { currentVersion: true },
  });
  if (!artifact) return null;
  const row = await livePublication(prisma, userId, artifactId);
  return {
    publication: row && !row.takenDownAt ? serializePublication(row, artifact.currentVersion) : null,
    currentVersion: artifact.currentVersion,
  };
}

/**
 * A takedown of this artifact's content on either kind of link blocks a new
 * publication: publishing again would put the same content back up. So does
 * one on an artifact this one was duplicated from (src/lib/artifact-takedown.ts),
 * or Duplicate would walk straight around it.
 */
async function assertPublishable(userId: string, artifactId: string) {
  if (await artifactLineageTakenDown(userId, artifactId)) throw new PublicationTakenDownError();
}

/**
 * A version number, "current" (pin the head as it stands once any design
 * draft is sealed: what the owner is looking at), or "latest" (follow every
 * later save of the owner's). "current" is the default: a later edit reaches
 * the page only through Update, unless the owner chose to follow latest.
 */
export type PublishTarget = number | "current" | "latest";

/**
 * Publish, Update or Roll back: put the page up (or keep it up) serving
 * `version`, the current head when "current", or the latest version when
 * "latest". Creates the publication on first use; reuses its token ever after.
 * Publishing is an explicit checkpoint: an unsealed design draft is sealed
 * first, so "current" and "latest" are what the owner is looking at. Null when
 * the artifact is not theirs or trashed.
 */
export async function publishArtifact(
  userId: string,
  artifactId: string,
  target: PublishTarget,
  now: Date = new Date()
): Promise<ClientPublication | null> {
  await assertPublishable(userId, artifactId);
  return prisma.$transaction(async (tx) => {
    const locked = await lockArtifact(tx, artifactId, { userId });
    if (!locked) return null;
    await sealDraftLocked(tx, locked);
    const pinnedVersion = target === "latest" ? null : target === "current" ? locked.currentVersion : target;
    if (pinnedVersion !== null) {
      const exists = await tx.artifactVersion.findUnique({
        where: { artifactId_version: { artifactId, version: pinnedVersion } },
        select: { id: true },
      });
      if (!exists) throw new PublicationVersionError();
    }
    // The title as the owner sees it now: a pinned page keeps it, so a rename
    // after publishing is as private as any other later edit.
    const title = (await tx.artifact.findFirst({ where: { id: artifactId, userId }, select: { title: true } }))?.title ?? "";
    const existing = await livePublication(tx, userId, artifactId);
    const row = existing
      ? await tx.artifactPublication.update({
          where: { id: existing.id, userId },
          data: {
            pinnedVersion,
            title,
            publishedAt: existing.publishedAt ?? now,
            unpublishedAt: null,
          },
        })
      : await tx.artifactPublication.create({
          data: { artifactId, userId, token: newToken(), pinnedVersion, title, publishedAt: now },
        });
    return serializePublication(row, locked.currentVersion);
  });
}

/** Take the page down; keep the token for the next Publish. Idempotent. */
export async function unpublishArtifact(
  userId: string,
  artifactId: string,
  now: Date = new Date()
): Promise<ClientPublication | null> {
  return prisma.$transaction(async (tx) => {
    const locked = await lockArtifact(tx, artifactId, { userId, includeTrashed: true });
    if (!locked) return null;
    const existing = await livePublication(tx, userId, artifactId);
    if (!existing) return null;
    const row = existing.publishedAt
      ? await tx.artifactPublication.update({
          where: { id: existing.id, userId },
          data: { publishedAt: null, unpublishedAt: now },
        })
      : existing;
    return serializePublication(row, locked.currentVersion);
  });
}

/**
 * Reset the link: retire the current token (it answers "link gone" for good)
 * and give the publication a new one, with the same pin and the same
 * published or unpublished state. Null when there is nothing to reset.
 */
export async function resetPublicationLink(
  userId: string,
  artifactId: string,
  now: Date = new Date()
): Promise<{ publication: ClientPublication; retiredToken: string } | null> {
  await assertPublishable(userId, artifactId);
  return prisma.$transaction(async (tx) => {
    const locked = await lockArtifact(tx, artifactId, { userId });
    if (!locked) return null;
    const existing = await livePublication(tx, userId, artifactId);
    if (!existing) return null;
    await tx.artifactPublication.update({ where: { id: existing.id, userId }, data: { retiredAt: now } });
    const row = await tx.artifactPublication.create({
      data: {
        artifactId,
        userId,
        token: newToken(),
        pinnedVersion: existing.pinnedVersion,
        title: existing.title,
        publishedAt: existing.publishedAt,
        unpublishedAt: existing.unpublishedAt,
      },
    });
    return { publication: serializePublication(row, locked.currentVersion), retiredToken: existing.token };
  });
}

// ─── The public side ────────────────────────────────────────────────────────

export interface PublishedArtifactSnapshot {
  title: string;
  type: ArtifactType;
  language: string | null;
  content: string;
  version: number;
  publishedAt: string;
}

export type PublicPublication =
  | { state: "live"; publication: ArtifactPublication; snapshot: PublishedArtifactSnapshot }
  /** A real token that no longer serves: reset, unpublished, or its artifact is in Recently deleted. */
  | { state: "gone" };

/**
 * Resolve a public token as a publication: null when it is not one, or when
 * Juno pulled it (takedown, banned owner) — the same 404 a pulled share gives,
 * because the reason is between Juno and the owner. Unguarded by design: the
 * token IS the capability and the visitor has no account to scope to.
 * Request-scoped, so the page, its metadata and its poster share one read.
 */
export const findPublicPublication = cache(async (token: string): Promise<PublicPublication | null> => {
  if (token.length < 16 || token.length > 128) return null;
  const row = await prismaUnguarded.artifactPublication.findUnique({
    where: { token },
    include: {
      user: { select: { bannedAt: true } },
      artifact: { select: { title: true, type: true, language: true, currentVersion: true, deletedAt: true } },
    },
  });
  if (!row) return null;
  const { user, artifact, ...publication } = row;
  if (!shareIsServable({ revokedAt: null, takenDownAt: publication.takenDownAt, ownerBannedAt: user.bannedAt })) {
    return null;
  }
  if (publication.retiredAt || !publication.publishedAt || artifact.deletedAt) return { state: "gone" };
  const version = publication.pinnedVersion ?? artifact.currentVersion;
  const body = await prismaUnguarded.artifactVersion.findUnique({
    where: { artifactId_version: { artifactId: publication.artifactId, version } },
    select: { content: true, version: true },
  });
  if (!body) return { state: "gone" };
  return {
    state: "live",
    publication,
    snapshot: {
      // Pinned: the title it was published under. Following latest: the live
      // one, with the live content.
      title: publication.pinnedVersion === null ? artifact.title : publication.title || artifact.title,
      type: artifact.type as ArtifactType,
      language: artifact.language,
      content: body.content,
      version: body.version,
      publishedAt: publication.publishedAt.toISOString(),
    },
  };
});

/** Count a view, fire-and-forget: analytics must never block or fail a render. */
export function countPublicationView(publicationId: string): void {
  void prismaUnguarded.artifactPublication
    .update({ where: { id: publicationId }, data: { views: { increment: 1 } } })
    .catch(() => {});
}
