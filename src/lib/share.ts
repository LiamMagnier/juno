import "server-only";
import { randomBytes } from "crypto";
import { cache } from "react";
import type { Share, ShareKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { decryptMessageTextSafe } from "@/lib/message-crypto";
import type { ArtifactType } from "@/lib/message-content";

/*
 * Public share links for chats and artifacts. A Share is a snapshot pointer:
 * `snapshotAt` freezes at creation and the public page only renders content
 * that existed at that instant — new messages and artifact edits stay private.
 * Revocation is a tombstone (`revokedAt`) rather than a delete, so links die
 * instantly while the owner keeps the view count. The token is the only
 * capability: 24 random bytes, base64url, never derived from the target id.
 */

export interface ClientShare {
  id: string;
  kind: ShareKind;
  token: string;
  url: string;
  title: string;
  snapshotAt: string;
  views: number;
  createdAt: string;
}

/** Absolute public URL for a share token. */
export function shareUrl(token: string): string {
  return `${env.appUrl.replace(/\/+$/, "")}/share/${token}`;
}

export function serializeShare(share: Share): ClientShare {
  return {
    id: share.id,
    kind: share.kind,
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
 * Create a share link for a conversation or artifact the user owns, or reuse
 * the newest active one for that target (repeat shares shouldn't mint a new
 * URL and orphan the old snapshot). Returns null when the target doesn't
 * exist or belongs to someone else — callers map that to 404.
 */
export async function createShare(userId: string, kind: ShareKind, targetId: string): Promise<Share | null> {
  if (kind === "CHAT") {
    const conversation = await prisma.conversation.findFirst({
      where: { id: targetId, userId },
      select: { id: true, title: true },
    });
    if (!conversation) return null;

    const existing = await prisma.share.findFirst({
      where: { userId, kind, conversationId: targetId, revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return existing;

    return prisma.share.create({
      data: {
        token: generateToken(),
        userId,
        kind,
        conversationId: targetId,
        title: conversation.title,
        snapshotAt: new Date(),
      },
    });
  }

  const artifact = await prisma.artifact.findFirst({
    where: { id: targetId, conversation: { userId } },
    select: { id: true, title: true },
  });
  if (!artifact) return null;

  const existing = await prisma.share.findFirst({
    where: { userId, kind, artifactId: targetId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing;

  return prisma.share.create({
    data: {
      token: generateToken(),
      userId,
      kind,
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

/** The user's active (non-revoked) shares, newest first. */
export async function listShares(userId: string): Promise<Share[]> {
  return prisma.share.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
}

// Request-scoped lookup so generateMetadata and the page share one query.
const findActiveShare = cache(async (token: string): Promise<Share | null> => {
  // Tokens are 32 chars; a cheap length gate skips the DB for junk URLs.
  if (token.length < 16 || token.length > 128) return null;
  const share = await prisma.share.findUnique({ where: { token } });
  if (!share || share.revokedAt) return null;
  return share;
});

/** Metadata-only lookup — same query as getPublicShare, no view-count side effect. */
export async function peekPublicShare(token: string): Promise<Share | null> {
  return findActiveShare(token);
}

/**
 * Resolve a public share by token: null when missing or revoked. Bumps the
 * view counter fire-and-forget — analytics must never block or fail a render.
 */
export async function getPublicShare(token: string): Promise<Share | null> {
  const share = await findActiveShare(token);
  if (!share) return null;
  void prisma.share
    .update({ where: { id: share.id }, data: { views: { increment: 1 } } })
    .catch(() => {});
  return share;
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
}

/**
 * The conversation as it stood at snapshotAt. Decrypts through the same
 * lenient read path the conversations API uses. Deliberately narrow:
 * no reasoning, no attachments, no SYSTEM rows — this payload is public.
 */
export async function getSharedChatSnapshot(share: Share): Promise<SharedChatSnapshot | null> {
  if (share.kind !== "CHAT" || !share.conversationId) return null;

  const [messages, artifacts] = await Promise.all([
    prisma.message.findMany({
      where: {
        conversationId: share.conversationId,
        createdAt: { lte: share.snapshotAt },
        role: { in: ["USER", "ASSISTANT"] },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, role: true, content: true, model: true, createdAt: true },
    }),
    prisma.artifact.findMany({
      where: { conversationId: share.conversationId, createdAt: { lte: share.snapshotAt } },
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

  const artifact = await prisma.artifact.findUnique({
    where: { id: share.artifactId },
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
