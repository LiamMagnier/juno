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

export type FlagSeverity = "low" | "medium" | "high" | "critical";
export type FlagSource = "auto" | "manual";

/** Soft strikes at or above this count trigger an automatic ban. */
export const STRIKE_LIMIT = 3;

/** Severities that ban immediately (no strike accrual, no second chance). */
const IMMEDIATE_BAN: FlagSeverity[] = ["critical", "high"];

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
 */
export async function recordFlag(input: FlagInput): Promise<FlagOutcome | null> {
  try {
    const source = input.source ?? "auto";
    const immediate = IMMEDIATE_BAN.includes(input.severity);

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

    const nextStrikes = immediate ? user.strikes : user.strikes + 1;
    const shouldBan = immediate || nextStrikes >= STRIKE_LIMIT;
    const action: FlagOutcome["action"] = shouldBan ? "banned" : "strike";

    const [flag] = await prismaUnguarded.$transaction([
      prismaUnguarded.moderationFlag.create({
        data: {
          userId: input.userId,
          source,
          severity: input.severity,
          category: input.category,
          detail: input.detail,
          messagePreview: input.messagePreview ?? null,
          action,
        },
        select: { id: true },
      }),
      prismaUnguarded.user.update({
        where: { id: input.userId },
        data: {
          strikes: immediate ? user.strikes : { increment: 1 },
          ...(shouldBan
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

    return { flagId: flag.id, action, strikes: nextStrikes, banned: shouldBan };
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
