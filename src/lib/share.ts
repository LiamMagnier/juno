import "server-only";
import { randomBytes } from "crypto";
import { cache } from "react";
import type { Prisma, Share, ShareAudience, ShareKind } from "@prisma/client";
import { prisma, prismaUnguarded } from "@/lib/prisma";
import { decryptJsonField, encryptJsonField } from "@/lib/field-crypto";
import type { SharedTranscriptEntry } from "@/lib/share-transcript";
import { shareUrl } from "@/lib/share-url";
import { decryptMessageTextSafe } from "@/lib/message-crypto";
import type { ArtifactType } from "@/lib/message-content";
import { shareIsServable } from "@/lib/share-policy";
import { artifactLineageTakenDown } from "@/lib/artifact-takedown";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { ON_ACTIVE_PATH, pathIdsTo, shownLeafId } from "@/lib/chat/branches";

/*
 * Public share links for chats and artifacts. A Share is a snapshot pointer:
 * `snapshotAt` freezes at creation and the public page only renders content
 * that existed at that instant — new messages and artifact edits stay private.
 * Revocation is a tombstone (`revokedAt`) rather than a delete, so links die
 * instantly while the owner keeps the view count. The token is the only
 * capability: 24 random bytes, base64url, never derived from the target id.
 *
 * Juno can pull a link too, two ways (src/lib/share-policy.ts): an admin
 * takedown of one link (`takenDownAt`, src/lib/share-moderation.ts), and a ban
 * of its owner, which the lookup below reads on every request — so a banned
 * account's pages stop serving at once and come back if the ban is lifted.
 *
 * An artifact link also goes dark while its artifact is in Recently deleted
 * (`sharedArtifactIsTrashed`). That is read from the artifact, never written
 * onto the Share row, so a restore brings the same token back with nothing to
 * undo, and a purge takes the row with it through the cascade.
 *
 * Versions are immutable (src/lib/artifact-writes.ts), so "the newest version
 * created at or before snapshotAt" is exactly what existed when the link was
 * made: a later edit — including a design draft sealed after the link — is a
 * newer row and stays private. (Audit B1 leaked because a design checkpoint
 * used to be rewritten in place under its old timestamp.)
 *
 * Publishing an artifact (a stable URL pinned to a version) is a separate
 * thing: src/lib/artifact-publication.ts. The web no longer makes artifact
 * share links; POST /api/share still does, for the installed apps.
 *
 * A share with specific people (`audience: PEOPLE`, src/lib/share-people.ts)
 * is the same snapshot pointer under a token that opens nothing by itself:
 * every public lookup below (`peekPublicShare`, `getPublicShare`, and through
 * them the poster and the copy route) skips it, and the owner's list of links
 * (`listShares`) does not show it. Only `peekPeopleShare` returns one, for the
 * share page to check the viewer against its recipients.
 */

export interface ClientShare {
  id: string;
  kind: ShareKind;
  /** LINK: anyone with the URL. PEOPLE: only the people it was shared with. */
  audience: ShareAudience;
  token: string;
  url: string;
  title: string;
  snapshotAt: string;
  views: number;
  createdAt: string;
}

export { shareUrl };

export function serializeShare(share: Share): ClientShare {
  return {
    id: share.id,
    kind: share.kind,
    audience: share.audience,
    token: share.token,
    url: shareUrl(share.token),
    title: share.title,
    snapshotAt: share.snapshotAt.toISOString(),
    views: share.views,
    createdAt: share.createdAt.toISOString(),
  };
}

/** 32 URL-safe chars (24 random bytes) — unguessable, collision-free in practice. */
function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Thrown by createShare when Juno took a link to this target down: sharing it
 * again would put the same content back up under a fresh token.
 */
export class ShareTakenDownError extends Error {
  constructor() {
    super(`This was removed from public sharing for breaking ${PRODUCT_NAME}’s rules, so it can’t be shared again.`);
    this.name = "ShareTakenDownError";
  }
}

/**
 * A transcript sent with a link for anything but a Code session. Only a Code
 * session can run on the owner's Mac, where the server has no copy of what was
 * said; every other conversation's link is built from its own Message rows, and
 * a client must not be able to put words on a page the server can vouch for.
 */
export class ShareTranscriptRefusedError extends Error {
  constructor() {
    super("Only a Code session’s link can carry its transcript.");
    this.name = "ShareTranscriptRefusedError";
  }
}

/**
 * A Code session with nothing on the server to show and no transcript sent:
 * one that runs on the owner's Mac, shared from somewhere it is not open (its
 * sidebar row). A link made now would publish an empty page.
 */
export class ShareNeedsTranscriptError extends Error {
  constructor() {
    super("Open this session to share it. Its transcript is on your Mac.");
    this.name = "ShareNeedsTranscriptError";
  }
}

/**
 * Refuses a target that has a link Juno took down and has not restored — a
 * share, or for an artifact a publication of it, or a link to an artifact it
 * was duplicated from (src/lib/artifact-takedown.ts).
 */
async function assertNotTakenDown(where: { userId: string; conversationId?: string; artifactId?: string }) {
  if (where.artifactId) {
    if (await artifactLineageTakenDown(where.userId, where.artifactId)) throw new ShareTakenDownError();
    return;
  }
  const removed = await prisma.share.findFirst({
    where: { ...where, takenDownAt: { not: null } },
    select: { id: true },
  });
  if (removed) throw new ShareTakenDownError();
}

/**
 * Create a share link for a conversation or artifact the user owns, or reuse
 * the newest active one for that target (repeat shares shouldn't mint a new
 * URL and orphan the old snapshot). Returns null when the target doesn't
 * exist or belongs to someone else — callers map that to 404. Throws
 * ShareTakenDownError when a link to the target was taken down.
 *
 * `audience` keeps the two kinds of share apart: a target can have a public
 * link and a share with specific people at once, each reused only as its own
 * kind, so making one never hands back the other's token. A people share
 * takes no transcript (the dialog offers it only where the server holds the
 * conversation).
 */
export async function createShare(
  userId: string,
  kind: ShareKind,
  targetId: string,
  options: { transcript?: SharedTranscriptEntry[]; audience?: ShareAudience } = {},
): Promise<Share | null> {
  const audience = options.audience ?? "LINK";
  if (audience === "PEOPLE" && options.transcript) throw new ShareTranscriptRefusedError();
  if (kind === "CHAT") {
    const conversation = await prisma.conversation.findFirst({
      where: { id: targetId, userId },
      select: { id: true, title: true, kind: true },
    });
    if (!conversation) return null;
    if (options.transcript && conversation.kind !== "code") throw new ShareTranscriptRefusedError();
    await assertNotTakenDown({ userId, conversationId: targetId });

    // A client-supplied transcript (a Code session whose transcript lives on
    // the Mac), already sanitized and redacted by the route. Sealed at rest.
    const sealed = options.transcript ? encryptJsonField(options.transcript) : null;
    const transcript = sealed ? ({ enc: sealed.enc } satisfies Prisma.InputJsonObject) : undefined;

    const existing = await prisma.share.findFirst({
      where: { userId, kind, conversationId: targetId, audience, revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      // Re-sharing with a transcript refreshes what the same link shows: the
      // link stays the one people already have, and its snapshot is now.
      if (!transcript) return existing;
      return prisma.share.update({ where: { id: existing.id, userId }, data: { transcript, snapshotAt: new Date(), title: conversation.title } });
    }

    if (!transcript && conversation.kind === "code") {
      const said = await prisma.message.count({ where: { conversationId: targetId, role: { in: ["USER", "ASSISTANT"] } } });
      if (said === 0) throw new ShareNeedsTranscriptError();
    }

    return prisma.share.create({
      data: {
        token: generateToken(),
        userId,
        kind,
        audience,
        conversationId: targetId,
        title: conversation.title,
        snapshotAt: new Date(),
        // The branch being read now (src/lib/chat/branches.ts): an edit or a
        // branch switch after sharing never changes what the link shows.
        leafMessageId: await shownLeafId(prisma, targetId),
        ...(transcript ? { transcript } : {}),
      },
    });
  }

  // A trashed artifact is not shareable: its link must not come back by the
  // side door of sharing it again.
  const artifact = await prisma.artifact.findFirst({
    where: { id: targetId, userId, deletedAt: null },
    select: { id: true, title: true },
  });
  if (!artifact) return null;
  await assertNotTakenDown({ userId, artifactId: targetId });

  const existing = await prisma.share.findFirst({
    where: { userId, kind, artifactId: targetId, audience, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing;

  return prisma.share.create({
    data: {
      token: generateToken(),
      userId,
      kind,
      audience,
      artifactId: targetId,
      title: artifact.title,
      snapshotAt: new Date(),
    },
  });
}

/**
 * Revoke a share the user owns. Idempotent: revoking an already-revoked share
 * still reports success; only unknown/foreign ids return false.
 */
export async function revokeShare(userId: string, shareId: string): Promise<boolean> {
  const revoked = await prisma.share.updateMany({
    where: { id: shareId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (revoked.count > 0) return true;
  const owned = await prisma.share.findFirst({ where: { id: shareId, userId }, select: { id: true } });
  return !!owned;
}

/**
 * The user's active shares, newest first. A link Juno took down is not active
 * — it no longer opens — and the owner was told why in a notification
 * (src/lib/share-moderation.ts).
 *
 * Links only unless `audience` says otherwise: this is the list the installed
 * apps and Settings › Shared links read as "public links", and a share with
 * specific people is not one.
 */
export async function listShares(
  userId: string,
  target: { conversationId?: string; artifactId?: string; audience?: ShareAudience } = {}
): Promise<Share[]> {
  return prisma.share.findMany({
    where: {
      userId,
      ...(target.conversationId ? { conversationId: target.conversationId } : {}),
      ...(target.artifactId ? { artifactId: target.artifactId } : {}),
      audience: target.audience ?? "LINK",
      revokedAt: null,
      takenDownAt: null,
      // A link whose artifact is in Recently deleted is not live; it comes
      // back into the list with the artifact.
      OR: [{ artifactId: null }, { artifact: { deletedAt: null } }],
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * True when an ARTIFACT link's artifact is in Recently deleted: the page shows
 * "isn't shared any more" and the poster answers 410, until a restore. Read
 * through the unguarded client for the same reason as the lookup: the token is
 * the capability and the visitor has no account.
 */
export async function sharedArtifactIsTrashed(share: Share): Promise<boolean> {
  if (share.kind !== "ARTIFACT" || !share.artifactId) return false;
  const artifact = await prismaUnguarded.artifact.findUnique({
    where: { id: share.artifactId },
    select: { deletedAt: true },
  });
  return !!artifact?.deletedAt;
}

// Request-scoped lookup so generateMetadata and the page share one query.
const findActiveShare = cache(async (token: string): Promise<Share | null> => {
  // Tokens are 32 chars; a cheap length gate skips the DB for junk URLs.
  if (token.length < 16 || token.length > 128) return null;
  // Unguarded by design: the token IS the capability, and the public page has
  // no signed-in user to scope to.
  const row = await prismaUnguarded.share.findUnique({
    where: { token },
    include: { user: { select: { bannedAt: true } } },
  });
  if (!row) return null;
  const { user, ...share } = row;
  // Revoked, taken down, or its owner banned: gone, and a 404 says no more
  // than that — the reason is between Juno and the owner.
  if (!shareIsServable({ revokedAt: share.revokedAt, takenDownAt: share.takenDownAt, ownerBannedAt: user.bannedAt })) {
    return null;
  }
  return share;
});

/**
 * A link share, never a people share: a PEOPLE token is not a capability on
 * its own. Written as "not PEOPLE" rather than "is LINK" so a row read without
 * the column (a stand-in in a test) is the link every row was before it.
 */
function linkShareOnly(share: Share | null): Share | null {
  return share && share.audience !== "PEOPLE" ? share : null;
}

/** Metadata-only lookup — same query as getPublicShare, no view-count side effect. */
export async function peekPublicShare(token: string): Promise<Share | null> {
  return linkShareOnly(await findActiveShare(token));
}

/**
 * Resolve a public share by token: null when missing or revoked. Bumps the
 * view counter fire-and-forget — analytics must never block or fail a render.
 */
export async function getPublicShare(token: string): Promise<Share | null> {
  const share = linkShareOnly(await findActiveShare(token));
  if (!share) return null;
  countShareView(share.id);
  return share;
}

/**
 * A live share with specific people, by token — the same request-cached query
 * as the public lookup — or null. Says nothing about the viewer: the caller
 * (src/lib/share-people.ts) decides who may read it, and nothing from it may
 * be shown before that.
 */
export async function peekPeopleShare(token: string): Promise<Share | null> {
  const share = await findActiveShare(token);
  return share?.audience === "PEOPLE" ? share : null;
}

/** Count one view of a share the request already resolved. Fire-and-forget. */
export function countShareView(shareId: string): void {
  // Unguarded for the same reason as the lookup: the viewer may be a member of
  // the public, and the id being bumped is one this request resolved by token.
  void prismaUnguarded.share
    .update({ where: { id: shareId }, data: { views: { increment: 1 } } })
    .catch(() => {});
}

/**
 * The target's newest live share of one audience, scoped to its owner: not
 * revoked and not taken down. Null when there is none. Reads only.
 */
export async function findLiveShare(userId: string, kind: ShareKind, targetId: string, audience: ShareAudience): Promise<Share | null> {
  return prisma.share.findFirst({
    where: {
      userId,
      kind,
      audience,
      ...(kind === "CHAT" ? { conversationId: targetId } : { artifactId: targetId }),
      revokedAt: null,
      takenDownAt: null,
    },
    orderBy: { createdAt: "desc" },
  });
}

// ——— Snapshot payloads for the public page ———

export interface SharedChatMessage {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  model: string | null;
  createdAt: string;
}

/** Titles for artifact tags embedded in the transcript (rendered as inert cards). */
export interface SharedArtifactRef {
  identifier: string;
  title: string;
  type: ArtifactType;
}

export interface SharedChatSnapshot {
  title: string;
  sharedAt: string;
  messages: SharedChatMessage[];
  artifacts: SharedArtifactRef[];
  /**
   * The transcript came from the owner's device with the link (a Code session
   * that ran on their Mac), not from the server's own copy. The page says so.
   */
  fromDevice?: boolean;
}

/**
 * The conversation as it stood at snapshotAt. Decrypts through the same
 * lenient read path the conversations API uses. Deliberately narrow:
 * no reasoning, no attachments, no SYSTEM rows — this payload is public.
 */
export async function getSharedChatSnapshot(share: Share): Promise<SharedChatSnapshot | null> {
  if (share.kind !== "CHAT" || !share.conversationId) return null;

  // A link made with a transcript (a Mac-hosted Code session) shows exactly
  // that transcript: it was redacted when it was stored, and the Message rows,
  // if any, are not what the owner looked at when they shared.
  const supplied = sharedTranscriptOf(share);
  if (supplied) {
    return {
      title: share.title,
      sharedAt: share.snapshotAt.toISOString(),
      messages: supplied.map((entry, i) => ({
        id: `${share.id}-${i}`,
        role: entry.role === "user" ? ("USER" as const) : ("ASSISTANT" as const),
        content: entry.content,
        model: null,
        createdAt: share.snapshotAt.toISOString(),
      })),
      artifacts: [],
      fromDevice: true,
    };
  }

  // The branch the link was made on: the shared leaf's ancestors. A link
  // made before branches (no leaf) reads the shown branch; the first branch
  // operation in its chat pins it to the leaf it showed. A pinned leaf that
  // was deleted since falls back the same way.
  const path = share.leafMessageId ? await pathIdsTo(prisma, share.conversationId, share.leafMessageId) : null;
  const [messages, artifacts] = await Promise.all([
    prisma.message.findMany({
      where: {
        conversationId: share.conversationId,
        createdAt: { lte: share.snapshotAt },
        role: { in: ["USER", "ASSISTANT"] },
        ...(path ? { id: { in: path } } : ON_ACTIVE_PATH),
      },
      orderBy: { createdAt: "asc" },
      // `activity` IS DELIBERATELY ABSENT, and must stay absent. It carries the
      // thought-process panel's connector payloads — the arguments Juno sent
      // each tool and the text each tool sent back, which is the user's own
      // Gmail / Linear / Notion content. Everything else in this projection is
      // the answer itself, which is what the person chose to publish; the
      // activity log is the machinery behind it and was never part of that
      // choice. This omission is the only reason a public share link cannot
      // leak tool payloads. Do not "complete" this select.
      select: { id: true, role: true, content: true, model: true, createdAt: true },
    }),
    prisma.artifact.findMany({
      where: {
        conversationId: share.conversationId,
        userId: share.userId,
        deletedAt: null,
        createdAt: { lte: share.snapshotAt },
      },
      select: { identifier: true, title: true, type: true },
    }),
  ]);

  return {
    title: share.title,
    sharedAt: share.snapshotAt.toISOString(),
    messages: messages
      .map((m) => ({
        id: m.id,
        role: m.role as "USER" | "ASSISTANT",
        content: decryptMessageTextSafe(m.content),
        model: m.model,
        createdAt: m.createdAt.toISOString(),
      }))
      .filter((m) => m.content.trim().length > 0),
    artifacts: artifacts.map((a) => ({ identifier: a.identifier, title: a.title, type: a.type as ArtifactType })),
  };
}

/** The stored client transcript of a share, or null (an ordinary chat link, or one that cannot be read). */
export function sharedTranscriptOf(share: Pick<Share, "transcript">): SharedTranscriptEntry[] | null {
  if (share.transcript == null) return null;
  const value = decryptJsonField(share.transcript);
  if (!Array.isArray(value)) return null;
  const entries = value.filter(
    (e): e is SharedTranscriptEntry => !!e && typeof e === "object" && ((e as SharedTranscriptEntry).role === "user" || (e as SharedTranscriptEntry).role === "assistant") && typeof (e as SharedTranscriptEntry).content === "string",
  );
  return entries.length ? entries : null;
}

export interface SharedArtifactSnapshot {
  title: string;
  type: ArtifactType;
  language: string | null;
  content: string;
  version: number;
  sharedAt: string;
}

/**
 * The artifact version current at snapshotAt. Versions created after the
 * share stay private; if none predates it (created in the same instant),
 * fall back to the earliest version rather than 404ing a fresh share.
 */
export async function getSharedArtifactSnapshot(share: Share): Promise<SharedArtifactSnapshot | null> {
  if (share.kind !== "ARTIFACT" || !share.artifactId) return null;

  const artifact = await prisma.artifact.findFirst({
    where: { id: share.artifactId, userId: share.userId, deletedAt: null },
    select: { title: true, type: true, language: true },
  });
  if (!artifact) return null;

  const version =
    (await prisma.artifactVersion.findFirst({
      where: { artifactId: share.artifactId, createdAt: { lte: share.snapshotAt } },
      orderBy: { version: "desc" },
    })) ??
    (await prisma.artifactVersion.findFirst({
      where: { artifactId: share.artifactId },
      orderBy: { version: "asc" },
    }));
  if (!version) return null;

  return {
    title: artifact.title,
    type: artifact.type as ArtifactType,
    language: artifact.language,
    content: version.content,
    version: version.version,
    sharedAt: share.snapshotAt.toISOString(),
  };
}
