import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { NotifyChannel } from "@/lib/notify/types";
import { safeAppPath } from "@/lib/notify/paths";

export type NotificationType =
  | "work_completed"
  | "work_failed"
  | "work_approval"
  | "code_completed"
  | "code_approval"
  | "research_completed"
  | "trigger_fired"
  | "spend_warning"
  | "connector_expired"
  | "system_alert"
  /** A proactive agent raised ideas between visits (the reflection sweep). */
  | "agent_ideas"
  /** One agent handed a task to another; it is running in the teammate's thread. */
  | "agent_handoff";

export type NotificationPriority = "urgent" | "high" | "normal" | "low";

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  priority?: NotificationPriority;
  sourceType?: string;
  sourceId?: string;
  actionable?: boolean;
  actionData?: Record<string, unknown>;
}

export interface ListNotificationsOptions {
  limit?: number;
  unreadOnly?: boolean;
  before?: Date;
}

export interface NotificationItem {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  priority: string;
  sourceType: string | null;
  sourceId: string | null;
  actionable: boolean;
  actionData: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

/**
 * Creates a durable in-app notification.
 */
export async function createNotification(input: CreateNotificationInput): Promise<NotificationItem> {
  const row = await prisma.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      priority: input.priority ?? "normal",
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      actionable: input.actionable ?? false,
      actionData: (input.actionData ?? {}) as Prisma.InputJsonValue,
    },
  });

  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    title: row.title,
    body: row.body,
    priority: row.priority,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    actionable: row.actionable,
    actionData: (row.actionData as Record<string, unknown>) ?? {},
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Lists notifications for a user, ordered by creation date descending.
 */
export async function listNotifications(
  userId: string,
  options: ListNotificationsOptions = {}
): Promise<{ notifications: NotificationItem[]; unreadCount: number }> {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);

  const where: Prisma.NotificationWhereInput = { userId };
  if (options.unreadOnly) {
    where.readAt = null;
  }
  if (options.before) {
    where.createdAt = { lt: options.before };
  }

  const [rows, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.notification.count({
      where: { userId, readAt: null },
    }),
  ]);

  return {
    notifications: rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      type: r.type,
      title: r.title,
      body: r.body,
      priority: r.priority,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      actionable: r.actionable,
      actionData: (r.actionData as Record<string, unknown>) ?? {},
      readAt: r.readAt ? r.readAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
    unreadCount,
  };
}

/**
 * Marks a specific notification as read.
 */
export async function markNotificationRead(userId: string, notificationId: string): Promise<boolean> {
  const updated = await prisma.notification.updateMany({
    where: { id: notificationId, userId, readAt: null },
    data: { readAt: new Date() },
  });
  return updated.count > 0;
}

/**
 * Marks all unread notifications for a user as read.
 */
export async function markAllNotificationsRead(userId: string): Promise<number> {
  const updated = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return updated.count;
}

/**
 * Gets the number of unread notifications for a user.
 */
export async function getUnreadNotificationCount(userId: string): Promise<number> {
  return prisma.notification.count({
    where: { userId, readAt: null },
  });
}

// ---------------------------------------------------------------------------
// notifyUser — the one fan-out (docs/design/AGENTS.md §8)
// ---------------------------------------------------------------------------

/**
 * Everything that reaches a person goes through here: the durable in-app row
 * first (the inbox is never preference-gated), then a push to each of their
 * devices and browsers whose switch for `channel` is on. Email stays with its
 * callers — it has its own policy (the routine's notify setting) and template.
 */
export interface NotifyUserInput {
  userId: string;
  type: NotificationType;
  /** In-app title and body. May carry run detail the lock screen must not. */
  title: string;
  body: string;
  priority: NotificationPriority;
  sourceType: string;
  sourceId: string;
  actionable?: boolean;
  /** Extra ids for the row. `path`, `agent` and `collapseKey` are set from the fields below. */
  actionData?: Record<string, unknown>;
  /** Relative in-app path it opens (validated with `safeAppPath`); null when informational. */
  path: string | null;
  /** The agent it is about, so the inbox and the push can name it. */
  agent?: { id: string; name: string; avatar: unknown } | null;
  /** Which per-device switch governs the push. */
  channel: NotifyChannel;
  /**
   * When set, an UNREAD row carrying the same key is refreshed in place
   * (title, body, time) instead of a second row — "Quill has 3 ideas" once,
   * not three times.
   */
  collapseKey?: string | null;
  /** The push, or null for in-app only. Text here is what a lock screen shows. */
  push: null | {
    title: string;
    subtitle?: string | null;
    body: string;
    /** Groups a conversation's notifications on the device ("agent-<id>", "work-<sessionId>"). */
    threadId: string;
    /** ≤64 bytes. A later push with the same id replaces this one on the device. */
    collapseId?: string | null;
    interruption: "passive" | "active" | "time-sensitive";
    /** After this the push services stop trying (an approval that has expired). */
    expiresAt?: Date | null;
    /** String ids the apps route on: agentId, conversationId, sessionId, runId. */
    data?: Record<string, string>;
  };
}

export interface NotifyUserResult {
  notificationId: string | null;
  /** Devices and browsers the push was handed to. */
  pushed: number;
}

/**
 * Writes (or refreshes) the in-app row, then pushes. Never throws: a
 * notification that cannot be delivered must not fail the work it is about.
 */
export async function notifyUser(input: NotifyUserInput): Promise<NotifyUserResult> {
  let notificationId: string | null = null;
  try {
    notificationId = await writeInAppRow(input);
  } catch (error) {
    console.error("[notify] in-app row failed", { type: input.type, error: error instanceof Error ? error.message : String(error) });
  }
  // Push fan-out (APNs + Web Push) is added by the delivery layer below.
  return { notificationId, pushed: 0 };
}

async function writeInAppRow(input: NotifyUserInput): Promise<string> {
  const path = safeAppPath(input.path);
  const actionData: Record<string, unknown> = {
    ...(input.actionData ?? {}),
    path,
    ...(input.agent ? { agent: { id: input.agent.id, name: input.agent.name, avatar: input.agent.avatar } } : {}),
    ...(input.collapseKey ? { collapseKey: input.collapseKey } : {}),
  };
  if (input.collapseKey) {
    const existing = await prisma.notification.findFirst({
      where: { userId: input.userId, readAt: null, actionData: { path: ["collapseKey"], equals: input.collapseKey } },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      await prisma.notification.updateMany({
        where: { id: existing.id, userId: input.userId },
        data: {
          title: input.title,
          body: input.body,
          priority: input.priority,
          actionable: input.actionable ?? false,
          actionData: actionData as Prisma.InputJsonValue,
          createdAt: new Date(),
        },
      });
      return existing.id;
    }
  }
  const row = await createNotification({
    userId: input.userId,
    type: input.type,
    title: input.title,
    body: input.body,
    priority: input.priority,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    actionable: input.actionable,
    actionData,
  });
  return row.id;
}
