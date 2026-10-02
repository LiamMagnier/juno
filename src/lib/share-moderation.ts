import "server-only";
import type { ArtifactPublication, Share } from "@prisma/client";
import { prismaUnguarded } from "@/lib/prisma";
import { banUser } from "@/lib/moderation";
import { createNotification } from "@/lib/notifications";
import { shareUrl } from "@/lib/share";
import { parseShareToken, shareStatus, type ShareStatus } from "@/lib/share-policy";
import type { ShareReportInput } from "@/lib/share-schemas";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * Taking a public link down, and hearing about one that should be.
 *
 * Moving previews to their own origin (audit X-01) means a shared page's
 * scripts run again, and a public link is a stranger's page shown under Juno's
 * name. So these ship together (audit §12.8):
 *
 *   - Ban propagation: in src/lib/share.ts, which reads the owner's ban on
 *     every request. Nothing here.
 *   - Takedown: one link, by an admin, with a reason. The owner gets a
 *     notification saying which link and why (a statement of reasons, not a
 *     silent 404), the link drops out of their list, and createShare refuses the
 *     same target until an admin restores it. Optionally bans the owner too.
 *   - Reports: what a visitor sends from the Report link. They queue for an
 *     admin; nothing is taken down automatically, because a report button that
 *     removes pages is a button for removing other people's pages.
 *
 * Every read and write here is cross-account by nature — an admin acting on
 * someone else's link, or an anonymous visitor's report — so it goes through
 * prismaUnguarded and the routes that call it gate on the owner (admin) or on
 * the share token (report).
 *
 * Published artifacts (ArtifactPublication, src/lib/artifact-publication.ts)
 * are public links too, under the same `/share/{token}` path, so every
 * function here covers them: a lookup finds them by token or owner, a
 * takedown or restore by id falls through to them, and a report on one is
 * filed with `publicationId`. They appear to the admin tools as ARTIFACT rows
 * with `publication: true`.
 */

export interface AdminShareRow {
  id: string;
  token: string;
  url: string;
  kind: Share["kind"];
  title: string;
  status: ShareStatus;
  views: number;
  createdAt: string;
  snapshotAt: string;
  revokedAt: string | null;
  takenDownAt: string | null;
  takenDownBy: string | null;
  takedownReason: string | null;
  owner: { id: string; email: string; name: string | null; bannedAt: string | null };
  openReports: number;
  /** Set for a published artifact (ArtifactPublication) rather than a share. */
  publication?: true;
}

const ADMIN_SHARE_INCLUDE = {
  user: { select: { id: true, email: true, name: true, bannedAt: true } },
  _count: { select: { reports: { where: { status: "open" } } } },
} as const;

type ShareWithOwner = Share & {
  user: { id: string; email: string; name: string | null; bannedAt: Date | null };
  _count: { reports: number };
};

function toAdminRow(share: ShareWithOwner): AdminShareRow {
  return {
    id: share.id,
    token: share.token,
    url: shareUrl(share.token),
    kind: share.kind,
    title: share.title,
    status: shareStatus({
      revokedAt: share.revokedAt,
      takenDownAt: share.takenDownAt,
      ownerBannedAt: share.user.bannedAt,
    }),
    views: share.views,
    createdAt: share.createdAt.toISOString(),
    snapshotAt: share.snapshotAt.toISOString(),
    revokedAt: share.revokedAt?.toISOString() ?? null,
    takenDownAt: share.takenDownAt?.toISOString() ?? null,
    takenDownBy: share.takenDownBy,
    takedownReason: share.takedownReason,
    owner: {
      id: share.user.id,
      email: share.user.email,
      name: share.user.name,
      bannedAt: share.user.bannedAt?.toISOString() ?? null,
    },
    openReports: share._count.reports,
  };
}

const ADMIN_PUBLICATION_INCLUDE = {
  user: { select: { id: true, email: true, name: true, bannedAt: true } },
  artifact: { select: { title: true } },
  _count: { select: { reports: { where: { status: "open" } } } },
} as const;

type PublicationWithOwner = ArtifactPublication & {
  user: { id: string; email: string; name: string | null; bannedAt: Date | null };
  artifact: { title: string };
  _count: { reports: number };
};

/**
 * A publication as the admin tools read a link. Unpublishing and a reset link
 * are the owner's own ways of taking it down, so both read as "revoked".
 */
function publicationToAdminRow(row: PublicationWithOwner): AdminShareRow {
  const revokedAt = row.retiredAt ?? (row.publishedAt ? null : row.unpublishedAt ?? row.createdAt);
  return {
    id: row.id,
    token: row.token,
    url: shareUrl(row.token),
    kind: "ARTIFACT",
    title: row.artifact.title,
    status: shareStatus({ revokedAt, takenDownAt: row.takenDownAt, ownerBannedAt: row.user.bannedAt }),
    views: row.views,
    createdAt: row.createdAt.toISOString(),
    snapshotAt: (row.publishedAt ?? row.createdAt).toISOString(),
    revokedAt: revokedAt?.toISOString() ?? null,
    takenDownAt: row.takenDownAt?.toISOString() ?? null,
    takenDownBy: row.takenDownBy,
    takedownReason: row.takedownReason,
    owner: {
      id: row.user.id,
      email: row.user.email,
      name: row.user.name,
      bannedAt: row.user.bannedAt?.toISOString() ?? null,
    },
    openReports: row._count.reports,
    publication: true,
  };
}

/**
 * Find links by what an admin has in hand: a share URL or token, an account's
 * email, or an account id. Newest first, capped — this is a lookup, not a list
 * of everything.
 */
export async function findSharesForAdmin(query: string): Promise<AdminShareRow[]> {
  const q = query.trim();
  if (!q) return [];
  const token = parseShareToken(q);
  if (token) {
    const share = await prismaUnguarded.share.findUnique({ where: { token }, include: ADMIN_SHARE_INCLUDE });
    if (share) return [toAdminRow(share)];
    const publication = await prismaUnguarded.artifactPublication.findUnique({
      where: { token },
      include: ADMIN_PUBLICATION_INCLUDE,
    });
    if (publication) return [publicationToAdminRow(publication)];
  }
  const user = await prismaUnguarded.user.findFirst({
    where: q.includes("@") ? { email: { equals: q, mode: "insensitive" } } : { id: q },
    select: { id: true },
  });
  if (!user) return [];
  const [shares, publications] = await Promise.all([
    prismaUnguarded.share.findMany({
      where: { userId: user.id },
      include: ADMIN_SHARE_INCLUDE,
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prismaUnguarded.artifactPublication.findMany({
      where: { userId: user.id },
      include: ADMIN_PUBLICATION_INCLUDE,
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);
  return [...shares.map(toAdminRow), ...publications.map(publicationToAdminRow)]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 100);
}

export type TakedownResult = { ok: true; share: AdminShareRow } | { ok: false; error: "not_found" | "owner_protected" };

/**
 * Take one link down. Idempotent: taking down a link that is already down
 * keeps the first reason and time. Resolves the link's open reports as
 * actioned, records a reviewed flag against the owner that names the link, and
 * tells the owner.
 */
export async function takeDownShare({
  shareId,
  reason,
  by,
  banOwner = false,
  isProtectedOwner,
}: {
  shareId: string;
  reason: string;
  /** The admin's email, for the audit trail. */
  by: string;
  banOwner?: boolean;
  /** Owners cannot be banned from here; the caller knows who they are. */
  isProtectedOwner: (owner: { id: string; email: string }) => boolean;
}): Promise<TakedownResult> {
  const share = await prismaUnguarded.share.findUnique({
    where: { id: shareId },
    include: { user: { select: { id: true, email: true } } },
  });
  if (!share) return takeDownPublication({ publicationId: shareId, reason, by, banOwner, isProtectedOwner });
  if (banOwner && isProtectedOwner(share.user)) return { ok: false, error: "owner_protected" };

  const now = new Date();
  const firstTime = !share.takenDownAt;
  if (firstTime) {
    await prismaUnguarded.$transaction([
      prismaUnguarded.share.update({
        where: { id: share.id },
        data: { takenDownAt: now, takenDownBy: by, takedownReason: reason },
      }),
      prismaUnguarded.shareReport.updateMany({
        where: { shareId: share.id, status: "open" },
        data: { status: "actioned", resolvedAt: now, resolvedBy: by },
      }),
      prismaUnguarded.moderationFlag.create({
        data: {
          userId: share.userId,
          source: "manual",
          severity: "high",
          category: "share_takedown",
          detail: reason.slice(0, 500),
          messagePreview: share.title.slice(0, 200) || null,
          shareId: share.id,
          artifactId: share.artifactId,
          action: "flagged",
          reviewedAt: now,
          reviewedBy: by,
        },
      }),
    ]);

    // The owner is told which link and why. Best effort: a failed notification
    // must not leave a harmful page up.
    const why = reason.trim().replace(/[.!?]+$/, "");
    try {
      await createNotification({
        userId: share.userId,
        type: "system_alert",
        priority: "high",
        title: "A shared link was removed",
        body:
          `${PRODUCT_NAME} removed your public link to “${share.title || "Untitled"}”. ` +
          `Reason: ${why}. The link no longer opens, and this item can’t be shared again. ` +
          `If you think this is a mistake, contact ${PRODUCT_NAME} support.`,
        sourceType: "share",
        sourceId: share.id,
      });
    } catch (err) {
      console.error("[share-moderation] takedown notification failed", {
        shareId: share.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (banOwner) await banUser(share.userId, `Public link taken down: ${reason}`, by);

  const row = await prismaUnguarded.share.findUniqueOrThrow({ where: { id: share.id }, include: ADMIN_SHARE_INCLUDE });
  return { ok: true, share: toAdminRow(row) };
}

/**
 * Take one publication down: the same record, notification and optional ban
 * as a share. The page stops serving, and the artifact cannot be published
 * again until an admin restores it (`assertPublishable`).
 */
async function takeDownPublication({
  publicationId,
  reason,
  by,
  banOwner = false,
  isProtectedOwner,
}: {
  publicationId: string;
  reason: string;
  by: string;
  banOwner?: boolean;
  isProtectedOwner: (owner: { id: string; email: string }) => boolean;
}): Promise<TakedownResult> {
  const publication = await prismaUnguarded.artifactPublication.findUnique({
    where: { id: publicationId },
    include: { user: { select: { id: true, email: true } }, artifact: { select: { title: true } } },
  });
  if (!publication) return { ok: false, error: "not_found" };
  if (banOwner && isProtectedOwner(publication.user)) return { ok: false, error: "owner_protected" };

  const now = new Date();
  if (!publication.takenDownAt) {
    await prismaUnguarded.$transaction([
      prismaUnguarded.artifactPublication.update({
        where: { id: publication.id },
        data: { takenDownAt: now, takenDownBy: by, takedownReason: reason },
      }),
      prismaUnguarded.shareReport.updateMany({
        where: { publicationId: publication.id, status: "open" },
        data: { status: "actioned", resolvedAt: now, resolvedBy: by },
      }),
      prismaUnguarded.moderationFlag.create({
        data: {
          userId: publication.userId,
          source: "manual",
          severity: "high",
          category: "share_takedown",
          detail: reason.slice(0, 500),
          messagePreview: publication.artifact.title.slice(0, 200) || null,
          artifactId: publication.artifactId,
          action: "flagged",
          reviewedAt: now,
          reviewedBy: by,
        },
      }),
    ]);
    const why = reason.trim().replace(/[.!?]+$/, "");
    try {
      await createNotification({
        userId: publication.userId,
        type: "system_alert",
        priority: "high",
        title: "A published page was removed",
        body:
          `${PRODUCT_NAME} removed your published page for “${publication.artifact.title || "Untitled"}”. ` +
          `Reason: ${why}. The page no longer opens, and this item can’t be published again. ` +
          `If you think this is a mistake, contact ${PRODUCT_NAME} support.`,
        sourceType: "share",
        sourceId: publication.id,
      });
    } catch (err) {
      console.error("[share-moderation] publication takedown notification failed", {
        publicationId: publication.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (banOwner) await banUser(publication.userId, `Published page taken down: ${reason}`, by);

  const row = await prismaUnguarded.artifactPublication.findUniqueOrThrow({
    where: { id: publication.id },
    include: ADMIN_PUBLICATION_INCLUDE,
  });
  return { ok: true, share: publicationToAdminRow(row) };
}

/** Undo a publication takedown. */
async function restorePublication({ publicationId, by }: { publicationId: string; by: string }): Promise<AdminShareRow | null> {
  const publication = await prismaUnguarded.artifactPublication.findUnique({ where: { id: publicationId } });
  if (!publication) return null;
  if (publication.takenDownAt) {
    await prismaUnguarded.$transaction([
      prismaUnguarded.artifactPublication.update({
        where: { id: publication.id },
        data: { takenDownAt: null, takenDownBy: null, takedownReason: null },
      }),
      prismaUnguarded.moderationFlag.create({
        data: {
          userId: publication.userId,
          source: "manual",
          severity: "low",
          category: "share_restore",
          detail: `Takedown lifted (was: ${publication.takedownReason ?? "no reason recorded"}).`.slice(0, 500),
          artifactId: publication.artifactId,
          action: "flagged",
          reviewedAt: new Date(),
          reviewedBy: by,
        },
      }),
    ]);
  }
  const row = await prismaUnguarded.artifactPublication.findUniqueOrThrow({
    where: { id: publication.id },
    include: ADMIN_PUBLICATION_INCLUDE,
  });
  return publicationToAdminRow(row);
}

/** Undo a takedown. The link opens again unless its owner is banned or revoked it. */
export async function restoreShare({ shareId, by }: { shareId: string; by: string }): Promise<AdminShareRow | null> {
  const share = await prismaUnguarded.share.findUnique({ where: { id: shareId } });
  if (!share) return restorePublication({ publicationId: shareId, by });
  if (share.takenDownAt) {
    await prismaUnguarded.$transaction([
      prismaUnguarded.share.update({
        where: { id: share.id },
        data: { takenDownAt: null, takenDownBy: null, takedownReason: null },
      }),
      prismaUnguarded.moderationFlag.create({
        data: {
          userId: share.userId,
          source: "manual",
          severity: "low",
          category: "share_restore",
          detail: `Takedown lifted (was: ${share.takedownReason ?? "no reason recorded"}).`.slice(0, 500),
          shareId: share.id,
          artifactId: share.artifactId,
          action: "flagged",
          reviewedAt: new Date(),
          reviewedBy: by,
        },
      }),
    ]);
  }
  const row = await prismaUnguarded.share.findUniqueOrThrow({ where: { id: share.id }, include: ADMIN_SHARE_INCLUDE });
  return toAdminRow(row);
}

export type CreateReportResult = { ok: true } | { ok: false; error: "not_found" };

/**
 * Record a visitor's report. Only a link that is currently live can be
 * reported — a dead token reveals nothing, and a report of it would be noise.
 */
export async function createShareReport(input: ShareReportInput): Promise<CreateReportResult> {
  const share = await prismaUnguarded.share.findUnique({
    where: { token: input.token },
    include: { user: { select: { bannedAt: true } } },
  });
  if (!share) return createPublicationReport(input);
  if (shareStatus({ revokedAt: share.revokedAt, takenDownAt: share.takenDownAt, ownerBannedAt: share.user.bannedAt }) !== "live") {
    return { ok: false, error: "not_found" };
  }
  await prismaUnguarded.shareReport.create({
    data: {
      shareId: share.id,
      shareToken: share.token,
      shareTitle: share.title,
      shareOwnerId: share.userId,
      reason: input.reason,
      detail: input.detail,
      contact: input.contact ?? null,
    },
  });
  console.log(`[share-report] ${input.reason} on share ${share.id}`);
  return { ok: true };
}

/** A report on a published artifact's page. Only a page that is up can be reported. */
async function createPublicationReport(input: ShareReportInput): Promise<CreateReportResult> {
  const publication = await prismaUnguarded.artifactPublication.findUnique({
    where: { token: input.token },
    include: { user: { select: { bannedAt: true } }, artifact: { select: { title: true, deletedAt: true } } },
  });
  const live =
    publication &&
    !publication.retiredAt &&
    publication.publishedAt &&
    !publication.artifact.deletedAt &&
    shareStatus({ revokedAt: null, takenDownAt: publication.takenDownAt, ownerBannedAt: publication.user.bannedAt }) === "live";
  if (!publication || !live) return { ok: false, error: "not_found" };
  await prismaUnguarded.shareReport.create({
    data: {
      publicationId: publication.id,
      shareToken: publication.token,
      // What the reporter saw: a pinned page shows the title it was published under.
      shareTitle: publication.pinnedVersion === null ? publication.artifact.title : publication.title || publication.artifact.title,
      shareOwnerId: publication.userId,
      reason: input.reason,
      detail: input.detail,
      contact: input.contact ?? null,
    },
  });
  console.log(`[share-report] ${input.reason} on publication ${publication.id}`);
  return { ok: true };
}

export interface AdminShareReport {
  id: string;
  reason: string;
  detail: string;
  contact: string | null;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  shareToken: string;
  shareTitle: string;
  /** Null once the link itself is gone (account or chat deleted). */
  share: AdminShareRow | null;
}

export async function listShareReports({
  status = "open",
  page = 1,
  pageSize = 25,
}: {
  status?: "open" | "all";
  page?: number;
  pageSize?: number;
}): Promise<{ reports: AdminShareReport[]; total: number; page: number; pageSize: number }> {
  const where = status === "open" ? { status: "open" } : {};
  const [rows, total] = await Promise.all([
    prismaUnguarded.shareReport.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { share: { include: ADMIN_SHARE_INCLUDE }, publication: { include: ADMIN_PUBLICATION_INCLUDE } },
    }),
    prismaUnguarded.shareReport.count({ where }),
  ]);
  return {
    reports: rows.map((r) => ({
      id: r.id,
      reason: r.reason,
      detail: r.detail,
      contact: r.contact,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      resolvedBy: r.resolvedBy,
      shareToken: r.shareToken,
      shareTitle: r.shareTitle,
      share: r.share ? toAdminRow(r.share) : r.publication ? publicationToAdminRow(r.publication) : null,
    })),
    total,
    page,
    pageSize,
  };
}

/** Close a report without acting on the link. */
export async function dismissShareReport({ reportId, by }: { reportId: string; by: string }): Promise<boolean> {
  const result = await prismaUnguarded.shareReport.updateMany({
    where: { id: reportId, status: "open" },
    data: { status: "dismissed", resolvedAt: new Date(), resolvedBy: by },
  });
  if (result.count > 0) return true;
  return !!(await prismaUnguarded.shareReport.findUnique({ where: { id: reportId }, select: { id: true } }));
}
