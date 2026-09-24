import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildNotifyApnsPayload, notifyApnsOptions, sendPushToUser } from "@/lib/apns";
import { encodeNotificationCursor, toClientNotification, type InboxQuery } from "@/lib/notify/inbox";
import { safeAppPath } from "@/lib/notify/paths";
import { pushIsLive, webPushText, type NotifyPush } from "@/lib/notify/push";
import type { NotificationsCount, NotificationsPage, NotifyChannel } from "@/lib/notify/types";
import { sendWebPushToUser } from "@/lib/notify/web-push";

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
 * One page of the inbox, newest first.
 *
 * Ordered by (createdAt, id) and paged strictly below the cursor on that pair,
 * so rows sharing a millisecond are neither skipped nor repeated across a page
 * boundary. One extra row is read to know whether there is an earlier page.
 */
export async function listNotifications(userId: string, query: InboxQuery): Promise<NotificationsPage> {
  const where: Prisma.NotificationWhereInput = { userId };
  if (query.unreadOnly) where.readAt = null;
  if (query.before) {
    where.OR = [
      { createdAt: { lt: query.before.createdAt } },
      { createdAt: query.before.createdAt, id: { lt: query.before.id } },
    ];
  }

  const [rows, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
    }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);

  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    notifications: page.map(toClientNotification),
    unreadCount,
    nextBefore: rows.length > query.limit && last ? encodeNotificationCursor(last) : null,
  };
}

/**
 * Marks one notification read. `found` is false only when the id is not this
 * account's; reading a row that is already read is a success that changed
 * nothing, so a client racing its own second tap never sees an error.
 */
export async function markNotificationRead(
  userId: string,
  notificationId: string
): Promise<{ found: boolean; changed: boolean }> {
  const updated = await prisma.notification.updateMany({
    where: { id: notificationId, userId, readAt: null },
    data: { readAt: new Date() },
  });
  if (updated.count > 0) return { found: true, changed: true };
  const existing = await prisma.notification.findFirst({
    where: { id: notificationId, userId },
    select: { id: true },
  });
  return { found: existing !== null, changed: false };
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
 * Marks a Work run's unread "needs you" rows read: the approval was decided,
 * or the run moved on to its next ask or its ending, so what they ask for is
 * answered or moot. Keyed on `actionData.runId`, which every Work row carries.
 */
export async function markRunNotificationsRead(userId: string, runId: string, now = new Date()): Promise<number> {
  const updated = await prisma.notification.updateMany({
    where: { userId, readAt: null, actionable: true, actionData: { path: ["runId"], equals: runId } },
    data: { readAt: now },
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

/** The inbox dot: how many are unread, and whether any of them is pressing. */
export async function countNotifications(userId: string): Promise<NotificationsCount> {
  const [unreadCount, pressing] = await Promise.all([
    getUnreadNotificationCount(userId),
    prisma.notification.findFirst({
      where: { userId, readAt: null, priority: { in: ["urgent", "high"] } },
      select: { id: true },
    }),
  ]);
  return { unreadCount, urgent: pressing !== null };
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
  push: NotifyPush | null;
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
  let pushed = 0;
  if (input.push) {
    try {
      pushed = await pushEverywhere(input, input.push, notificationId);
    } catch (error) {
      console.error("[notify] push failed", { type: input.type, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { notificationId, pushed };
}

/**
 * Hands the push to every phone, Mac and browser whose switch for the channel
 * is on, and counts the ones a push service accepted. Apple and the browsers'
 * push services are independent, so neither waits for the other and neither's
 * failure costs the other its delivery.
 */
async function pushEverywhere(input: NotifyUserInput, push: NotifyPush, notificationId: string | null): Promise<number> {
  if (!pushIsLive(push, new Date())) return 0;
  const path = safeAppPath(input.path);

  const apple = sendPushToUser(
    input.userId,
    buildNotifyApnsPayload({ notificationId, path, channel: input.channel, agentId: input.agent?.id ?? null, push }),
    notifyApnsOptions(push),
    { channel: input.channel }
  ).then((results) => results.filter((result) => result.success && !result.simulated).length);

  const text = webPushText(push);
  // Through a `then` so a sender that throws before its first await still
  // lands in `allSettled` rather than in the caller.
  const browsers = Promise.resolve().then(() =>
    sendWebPushToUser(
      input.userId,
      {
        title: text.title,
        body: text.body,
        path,
        tag: push.collapseId ?? notificationId ?? `${input.sourceType}:${input.sourceId}`,
        notificationId,
        // The push services stop holding it when the approval can no longer
        // be given, the way APNs does with `apns-expiration`.
        expiresAt: push.expiresAt ?? null,
      },
      input.channel
    )
  );

  const settled = await Promise.allSettled([apple, browsers]);
  let pushed = 0;
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      pushed += outcome.value;
    } else {
      console.error("[notify] push failed", {
        type: input.type,
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
    }
  }
  return pushed;
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
