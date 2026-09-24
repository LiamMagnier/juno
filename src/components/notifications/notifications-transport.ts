"use client";

/**
 * Every request the web inbox makes, in one file, answering the way
 * agents-transport.ts does: a value, or the server's own sentence.
 *
 * The routes are in src/app/api/notifications. They answer 404 for a row that
 * is not this account's and `changed: false` for one already read, so marking
 * read is safe to repeat: the tab that clicked a row and the phone that opened
 * its push are routinely the same person twice.
 */

import { safeAppPath } from "@/lib/notify/paths";
import type { ClientNotification, NotificationsCount, NotificationsPage } from "@/lib/notify/types";

export type InboxOutcome<T> = { kind: "ok"; value: T } | { kind: "failed"; status: number; message: string };

/**
 * Fired after anything changes what is unread, so every mounted inbox (the
 * sidebar is mounted twice: the column and the phone drawer) re-reads its dot.
 * The service worker posts a message of the same type when a push arrives.
 */
export const NOTIFICATIONS_CHANGED_EVENT = "juno:notifications-changed";

/** Asks the sidebar to open its notifications popover (the command palette sends it). */
export const OPEN_NOTIFICATIONS_EVENT = "juno:notifications";

export function announceNotificationsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
}

export function openNotifications(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(OPEN_NOTIFICATIONS_EVENT));
}

const API = "/api/notifications";

async function call<T>(
  url: string,
  init: { method?: "GET" | "POST" | "PATCH"; body?: unknown },
  pick: (data: Record<string, unknown>) => T | null
): Promise<InboxOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      // The dot is polled; a cached answer would be a dot that never clears.
      cache: "no-store",
      ...(init.body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) }),
    });
  } catch {
    return { kind: "failed", status: 0, message: "Juno could not be reached. Check your connection and try again." };
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // An empty or non-JSON body; the status still says what happened.
  }
  if (res.ok) {
    const value = pick(data);
    if (value !== null) return { kind: "ok", value };
    return { kind: "failed", status: res.status, message: "Juno answered with something this page can't read. Reload and try again." };
  }
  const message =
    typeof data.message === "string" && data.message.trim()
      ? data.message
      : res.status === 401
        ? "You have been signed out. Sign in again to continue."
        : "Something went wrong on Juno's side. Try again in a moment.";
  return { kind: "failed", status: res.status, message };
}

/**
 * A row as the server sent it, or null when it is not one. The path is checked
 * again here even though the server already did: it is the one field a click
 * hands to the router, and a stored absolute URL would make it an open redirect.
 */
function readNotification(value: unknown): ClientNotification | null {
  if (!value || typeof value !== "object") return null;
  const n = value as Partial<ClientNotification>;
  if (typeof n.id !== "string" || typeof n.title !== "string" || typeof n.createdAt !== "string") return null;
  return {
    ...(n as ClientNotification),
    body: typeof n.body === "string" ? n.body : "",
    href: safeAppPath(n.href),
    readAt: typeof n.readAt === "string" ? n.readAt : null,
    agent: n.agent && typeof n.agent === "object" && typeof n.agent.id === "string" ? n.agent : null,
  };
}

function readCount(data: Record<string, unknown>): NotificationsCount | null {
  const unreadCount = data.unreadCount;
  if (typeof unreadCount !== "number" || !Number.isFinite(unreadCount)) return null;
  return { unreadCount: Math.max(0, unreadCount), urgent: data.urgent === true };
}

export function fetchNotificationsCount(): Promise<InboxOutcome<NotificationsCount>> {
  return call(`${API}/count`, {}, readCount);
}

export function fetchNotifications(options: { before?: string | null; limit?: number } = {}): Promise<InboxOutcome<NotificationsPage>> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 20) });
  if (options.before) params.set("before", options.before);
  return call(`${API}?${params}`, {}, (data) => {
    if (!Array.isArray(data.notifications) || typeof data.unreadCount !== "number") return null;
    return {
      notifications: data.notifications.map(readNotification).filter((n): n is ClientNotification => n !== null),
      unreadCount: Math.max(0, data.unreadCount),
      nextBefore: typeof data.nextBefore === "string" && data.nextBefore ? data.nextBefore : null,
    };
  });
}

/**
 * Marks one row read. True when there is nothing left to mark: the route
 * answers 404 only for an id that is not this account's, and from a row this
 * page was shown that means the row no longer exists.
 */
export async function markNotificationRead(id: string): Promise<boolean> {
  const outcome = await call(`${API}/${encodeURIComponent(id)}`, { method: "PATCH" }, () => true);
  return outcome.kind === "ok" || outcome.status === 404;
}

export function markAllNotificationsRead(): Promise<InboxOutcome<number>> {
  return call(API, { method: "POST", body: { action: "mark_all_read" } }, (data) =>
    typeof data.markedCount === "number" ? data.markedCount : 0
  );
}
