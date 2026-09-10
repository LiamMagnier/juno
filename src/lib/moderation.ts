import { prisma } from "@/lib/prisma";
import { prismaUnguarded } from "@/lib/db";
import { deleteAccountPermanently } from "@/app/api/account/delete-account";

/**
 * Moderation core — the single authoritative place that bans, unbans, deletes,
 * and records flags/strikes. Both the admin routes and the automatic content
 * pipeline call these so policy stays consistent and auditable.
 *
 * Enforcement lives elsewhere: a set `User.bannedAt` blocks sign-in
 * (src/lib/auth.ts) and kills active sessions on the next request
 * (src/lib/session.ts). These functions only mutate state + write the audit row.
 */

import {
  decideFlagAction,
  isSevere,
  STRIKE_LIMIT,
  type FlagSeverity,
  type FlagSource,
} from "@/lib/moderation-policy";

export { STRIKE_LIMIT, type FlagSeverity, type FlagSource };

export interface FlagInput {
  userId: string;
  severity: FlagSeverity;
  category: string;
  detail: string;
  source?: FlagSource;
  messagePreview?: string | null;
  /** Who is recording a manual flag (admin email). "system" for automatic. */
  by?: string;
}

export interface FlagOutcome {
  flagId: string;
  action: "flagged" | "strike" | "banned";
  strikes: number;
  banned: boolean;
}

/**
 * Record a moderation flag and apply the strike/auto-ban policy. Never throws
 * into a caller's request path — a moderation write failing must not break chat.
 *
 * The decision itself is `decideFlagAction` (moderation-policy.ts). What this
 * function adds is the state the decision needs: the account's strikes, and
 * whether an earlier automatic severe flag is still sitting unreviewed —
 * which is what turns a first regex hit into a review item and a second into
 * a ban. Reviewing is the owner's `PATCH /api/admin/moderation/[id]`; banning
 * by hand is `banUser` below.
 */
export async function recordFlag(input: FlagInput): Promise<FlagOutcome | null> {
  try {
    const source = input.source ?? "auto";

    // Read current state (skip if already banned — nothing more to do).
    const user = await prismaUnguarded.user.findUnique({
      where: { id: input.userId },
      select: { bannedAt: true, strikes: true },
    });
    if (!user) return null;
    if (user.bannedAt) {
      const flag = await prismaUnguarded.moderationFlag.create({
        data: {
          userId: input.userId,
          source,
          severity: input.severity,
          category: input.category,
          detail: input.detail,
          messagePreview: input.messagePreview ?? null,
          action: "flagged",
        },
        select: { id: true },
      });
      return { flagId: flag.id, action: "flagged", strikes: user.strikes, banned: true };
    }

    // Only consulted for a severe automatic hit; one cheap indexed count.
    const pendingSevereAutoFlags =
      source === "auto" && isSevere(input.severity)
        ? await prismaUnguarded.moderationFlag.count({
            where: {
              userId: input.userId,
              source: "auto",
              severity: { in: ["high", "critical"] },
              action: "flagged",
              reviewedAt: null,
            },
          })
        : 0;

    const decision = decideFlagAction({
      severity: input.severity,
      source,
      category: input.category,
      strikes: user.strikes,
      pendingSevereAutoFlags,
    });
    const strikeAccrued = decision.strikes !== user.strikes;

    const [flag] = await prismaUnguarded.$transaction([
      prismaUnguarded.moderationFlag.create({
        data: {
          userId: input.userId,
          source,
          severity: input.severity,
          category: input.category,
          detail: input.detail,
          messagePreview: input.messagePreview ?? null,
          action: decision.action,
          // `reviewedAt: null` is the review queue's definition of pending
          // (admin/moderation lists `{ reviewedAt: null }`), so an awaiting
          // flag needs nothing more than the default.
        },
        select: { id: true },
      }),
      prismaUnguarded.user.update({
        where: { id: input.userId },
        data: {
          strikes: strikeAccrued ? { increment: 1 } : user.strikes,
          ...(decision.banned
            ? {
                bannedAt: new Date(),
                banReason:
                  input.by && input.by !== "system"
                    ? `${input.category}: ${input.detail}`.slice(0, 500)
                    : `Automatic: ${input.category} (${input.severity})`.slice(0, 500),
                bannedBy: input.by ?? "system",
              }
            : {}),
        },
      }),
    ]);

    return { flagId: flag.id, action: decision.action, strikes: decision.strikes, banned: decision.banned };
  } catch (err) {
    console.error("[moderation] recordFlag failed", {
      userId: input.userId,
      category: input.category,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Manually ban a user (admin action). Idempotent. */
export async function banUser(userId: string, reason: string, by: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { bannedAt: new Date(), banReason: reason.slice(0, 500), bannedBy: by },
  });
  await prismaUnguarded.moderationFlag.create({
    data: {
      userId,
      source: "manual",
      severity: "high",
      category: "manual_ban",
      detail: reason.slice(0, 500),
      action: "banned",
      reviewedAt: new Date(),
      reviewedBy: by,
    },
  });
}

/** Lift a ban and reset strikes so the user starts fresh. */
export async function unbanUser(userId: string, by: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { bannedAt: null, banReason: null, bannedBy: null, strikes: 0 },
  });
  await prismaUnguarded.moderationFlag.create({
    data: {
      userId,
      source: "manual",
      severity: "low",
      category: "unban",
      detail: "Ban lifted; strikes reset.",
      action: "flagged",
      reviewedAt: new Date(),
      reviewedBy: by,
    },
  });
}

/**
 * Permanently delete a user and all their data (reuses the GDPR cascade). Used
 * by the admin "delete user" action — the audit reason is logged to the server.
 */
export async function deleteUserByAdmin(
  target: { id: string; email?: string | null; image?: string | null },
  by: string,
  reason?: string,
): Promise<void> {
  console.log("[moderation] admin delete", { actor: by, targetId: target.id, targetEmail: target.email, reason });
  await deleteAccountPermanently(target);
}
