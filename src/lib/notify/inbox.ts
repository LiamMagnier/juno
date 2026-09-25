/**
 * The inbox's wire format: the page cursor, the query a client may send, and
 * the row as a client sees it (`ClientNotification`).
 *
 * The cursor is opaque on purpose. It is `createdAt|id` underneath because two
 * rows can share a millisecond — a run that finishes and the agent that noticed
 * it — and a timestamp alone would skip one of them or show it twice across a
 * page boundary. Clients pass back what `nextBefore` gave them and never build
 * one, so the shape can change without a client release.
 *
 * Pure (no `server-only`, no Prisma): the routes use it and the tests read it.
 */

import { normalizeAgentAvatar } from "@/lib/agents/avatar";
import { notificationPath } from "@/lib/notify/paths";
import type { ClientNotification } from "@/lib/notify/types";

export const INBOX_DEFAULT_LIMIT = 20;
export const INBOX_MAX_LIMIT = 50;

/** Where the next page starts: strictly older than this row. */
export interface NotificationCursor {
  createdAt: Date;
  id: string;
}

const CURSOR_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CURSOR_TEXT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([A-Za-z0-9_-]{1,64})$/;
const MAX_CURSOR_CHARS = 160;

// btoa/atob rather than Buffer so this stays importable from anywhere; the
// cursor is ASCII by construction (an ISO time and a cuid), which is all btoa
// accepts.
function toBase64Url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  try {
    return atob(padded);
  } catch {
    return null;
  }
}

export function encodeNotificationCursor(cursor: NotificationCursor): string {
  if (!CURSOR_ID.test(cursor.id)) throw new Error("A notification cursor needs a plain id.");
  return toBase64Url(`${cursor.createdAt.toISOString()}|${cursor.id}`);
}

/** The cursor a client sent back, or null when it is not one of ours. */
export function decodeNotificationCursor(value: string): NotificationCursor | null {
  if (!value || value.length > MAX_CURSOR_CHARS) return null;
  const text = fromBase64Url(value);
  const match = text ? CURSOR_TEXT.exec(text) : null;
  if (!match) return null;
  const createdAt = new Date(match[1]!);
  // Round-tripped, so "2026-02-31" does not quietly become March the 3rd.
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== match[1]) return null;
  return { createdAt, id: match[2]! };
}

export interface InboxQuery {
  limit: number;
  unreadOnly: boolean;
  before: NotificationCursor | null;
}

/**
 * `?limit=1..50&before=<cursor>&unread=true`, or the reason it is not. A bad
 * value is the client's mistake and answers 400 — it used to reach Prisma as
 * `take: NaN` and come back as a 500.
 */
export function parseInboxQuery(params: URLSearchParams): { ok: true; query: InboxQuery } | { ok: false; error: string } {
  let limit = INBOX_DEFAULT_LIMIT;
  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    if (!/^\d{1,3}$/.test(rawLimit)) return { ok: false, error: "limit must be a whole number." };
    limit = Number(rawLimit);
    if (limit < 1 || limit > INBOX_MAX_LIMIT) {
      return { ok: false, error: `limit must be between 1 and ${INBOX_MAX_LIMIT}.` };
    }
  }
  let before: NotificationCursor | null = null;
  const rawBefore = params.get("before");
  if (rawBefore !== null && rawBefore !== "") {
    before = decodeNotificationCursor(rawBefore);
    if (!before) return { ok: false, error: "before is not a cursor this server issued." };
  }
  return { ok: true, query: { limit, unreadOnly: params.get("unread") === "true", before } };
}

/** The Notification columns the inbox reads. */
export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  priority: string;
  sourceType: string | null;
  sourceId: string | null;
  actionable: boolean;
  actionData: unknown;
  readAt: Date | null;
  createdAt: Date;
}

const PRIORITIES: readonly ClientNotification["priority"][] = ["urgent", "high", "normal", "low"];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * A row as the inbox renders it. `actionData` stays on the server: the client
 * gets the path it opens (validated again here, not trusted from the row) and
 * the agent's face, and nothing else a later writer happened to store.
 */
export function toClientNotification(row: NotificationRow): ClientNotification {
  const data = record(row.actionData);
  const agent = record(data?.agent);
  const agentId = typeof agent?.id === "string" && agent.id ? agent.id : null;
  const agentName = typeof agent?.name === "string" && agent.name.trim() ? agent.name.trim() : null;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    priority: (PRIORITIES as readonly string[]).includes(row.priority)
      ? (row.priority as ClientNotification["priority"])
      : "normal",
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    actionable: row.actionable,
    href: notificationPath(data),
    agent: agentId && agentName ? { id: agentId, name: agentName, avatar: normalizeAgentAvatar(agent?.avatar, agentId) } : null,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
