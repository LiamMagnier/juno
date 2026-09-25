/**
 * Notification shapes shared by the server, the web inbox and the tests.
 * Pure (no `server-only`).
 */

import type { AgentAvatar } from "@/lib/agents/avatar";

/**
 * Which per-device switch governs a push. `needs_you` is blocking work — an
 * approval or a question a run is waiting on. `updates` is everything else:
 * a task finished or failed, an agent raised ideas, a handoff landed.
 */
export type NotifyChannel = "needs_you" | "updates";

/** The two switches every push destination (a phone, a Mac, a browser) carries. */
export interface PushPreferences {
  notifyNeedsYou: boolean;
  notifyUpdates: boolean;
}

/** A notification as the inbox renders it. */
export interface ClientNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  priority: "urgent" | "high" | "normal" | "low";
  sourceType: string | null;
  sourceId: string | null;
  actionable: boolean;
  /** Relative in-app path it opens (`safeAppPath`), or null when informational. */
  href: string | null;
  /** The agent it is about, drawn as its face in the row; null for Juno itself. */
  agent: { id: string; name: string; avatar: AgentAvatar } | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsPage {
  notifications: ClientNotification[];
  unreadCount: number;
  /** Cursor for "Show earlier": pass back as `?before=`. Null at the end. */
  nextBefore: string | null;
}

export interface NotificationsCount {
  unreadCount: number;
  /** Any unread notification is urgent or high — the dot takes the accent. */
  urgent: boolean;
}
