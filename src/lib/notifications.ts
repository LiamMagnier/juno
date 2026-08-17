import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

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
  | "system_alert";

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
