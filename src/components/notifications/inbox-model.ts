/**
 * The inbox's small decisions, apart from React and the network: what the
 * sidebar's dot says, and how a list changes when something in it is read.
 *
 * Pure (no `"use client"`, no fetch) so a test can hold these still without a
 * browser, the same way src/lib/notify/inbox.ts holds the server's half.
 */

import type { ClientNotification, NotificationsCount, NotificationsPage } from "@/lib/notify/types";

/**
 * Whether a notification is worth the accent. Urgent and high are the rows a
 * person is being asked to act on (an approval, a question); everything else
 * is news, and news in the accent would teach the accent to mean nothing.
 */
export function isPressing(notification: Pick<ClientNotification, "priority">): boolean {
  return notification.priority === "urgent" || notification.priority === "high";
}

/**
 * The sidebar's one trailing signal: nothing when all is read, the accent dot
 * when something unread is pressing, a muted dot otherwise. Never a number
 * (docs/design/FLAT_UI.md): the number rides the accessible name instead.
 */
export function dotTone(count: NotificationsCount | null): "accent" | "muted" | null {
  if (!count || count.unreadCount <= 0) return null;
  return count.urgent ? "accent" : "muted";
}

/** "3 unread", for the accessible name and the rail's tooltip; null at zero. */
export function unreadDetail(count: NotificationsCount | null): string | null {
  if (!count || count.unreadCount <= 0) return null;
  return `${count.unreadCount} unread`;
}

/** The list with one row read. The same array when there was nothing to change. */
export function withRead(items: ClientNotification[], id: string, readAt: string): ClientNotification[] {
  if (!items.some((n) => n.id === id && !n.readAt)) return items;
  return items.map((n) => (n.id === id && !n.readAt ? { ...n, readAt } : n));
}

/** The list with one row unread again, when marking it read did not stick. */
export function withUnread(items: ClientNotification[], id: string): ClientNotification[] {
  return items.map((n) => (n.id === id ? { ...n, readAt: null } : n));
}

/** The list with every row read. */
export function withAllRead(items: ClientNotification[], readAt: string): ClientNotification[] {
  return items.some((n) => !n.readAt) ? items.map((n) => (n.readAt ? n : { ...n, readAt })) : items;
}

/** The count once one unread row has been read here, ahead of the server saying so. */
export function countAfterRead(count: NotificationsCount | null): NotificationsCount | null {
  if (!count) return count;
  const unreadCount = Math.max(0, count.unreadCount - 1);
  return { unreadCount, urgent: unreadCount > 0 && count.urgent };
}

/**
 * The count a freshly loaded page implies. The page's `unreadCount` is the
 * account's, so it replaces the dot's number; whether any of it is pressing is
 * only known for the rows on the page, so an accent the last count carried is
 * kept until the next count says otherwise, rather than dropped on a guess.
 */
export function countFromPage(previous: NotificationsCount | null, page: NotificationsPage): NotificationsCount {
  const unreadCount = Math.max(0, page.unreadCount);
  const pressingHere = page.notifications.some((n) => !n.readAt && isPressing(n));
  return { unreadCount, urgent: unreadCount > 0 && (pressingHere || (previous?.urgent ?? false)) };
}

/**
 * Appends an earlier page. The cursor is strictly-older, so pages do not
 * overlap today; the ids are still checked because a repeated row would be a
 * repeated React key, and that breaks the whole list rather than one row.
 */
export function appendPage(items: ClientNotification[], earlier: ClientNotification[]): ClientNotification[] {
  const seen = new Set(items.map((n) => n.id));
  return [...items, ...earlier.filter((n) => !seen.has(n.id))];
}
