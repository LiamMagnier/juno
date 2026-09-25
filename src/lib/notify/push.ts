/**
 * The push half of a notification, as data.
 *
 * `notifyUser` (src/lib/notifications.ts) hands one of these to every push
 * destination the person has: the APNs builder in src/lib/apns.ts shapes it for
 * a phone or a Mac, and the Web Push sender takes the browser's cut of it here.
 * The text in it is what a lock screen shows, so it is built by callers that
 * have already dropped anything the run's sensitivity keeps inside the account.
 *
 * Pure (no `server-only`, no Prisma) so the tests can read every decision here
 * without a database.
 */

import type { NotifyChannel, PushPreferences } from "@/lib/notify/types";

export interface NotifyPush {
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
}

/**
 * Whether a push is still worth sending. An approval that has already expired
 * cannot be answered, and a lock-screen card asking for it would be a lie.
 */
export function pushIsLive(push: Pick<NotifyPush, "expiresAt">, now: Date): boolean {
  return !push.expiresAt || push.expiresAt.getTime() > now.getTime();
}

/**
 * Which per-device switch has to be on for a push on this channel. Spread into
 * the `where` of a DevicePushToken or WebPushSubscription query.
 */
export function pushSwitchFilter(channel: NotifyChannel): Partial<PushPreferences> {
  return channel === "needs_you" ? { notifyNeedsYou: true } : { notifyUpdates: true };
}

/** The ids a push may carry for the apps to route on (the C2 payload keys). */
export const PUSH_ROUTE_KEYS = ["agentId", "conversationId", "sessionId", "runId"] as const;
export type PushRouteKey = (typeof PUSH_ROUTE_KEYS)[number];

const ROUTE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The route ids out of `push.data`, and nothing else. A caller that put a
 * sentence in `data` by mistake must not have it ride to a lock screen, so
 * only the known keys pass, and only when they look like an id.
 */
export function pushRouteIds(data: Record<string, string> | null | undefined): Partial<Record<PushRouteKey, string>> {
  const ids: Partial<Record<PushRouteKey, string>> = {};
  if (!data) return ids;
  for (const key of PUSH_ROUTE_KEYS) {
    const value = data[key];
    if (typeof value === "string" && ROUTE_ID.test(value)) ids[key] = value;
  }
  return ids;
}

/**
 * Cut to `max` characters on a word where one is near, with an ellipsis. A
 * lock screen truncates on its own, but an APNs payload over 4 KB is refused
 * outright, so the server never relies on the device to do it.
 */
export function clampPushText(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * What a browser notification shows. It has no subtitle line, so a subtitle
 * (the task, under an agent's name) leads the body instead of being lost.
 */
export function webPushText(push: Pick<NotifyPush, "title" | "subtitle" | "body">): { title: string; body: string } {
  const subtitle = push.subtitle?.trim();
  const lead = subtitle ? `${subtitle}${/[.!?…]$/.test(subtitle) ? "" : "."} ` : "";
  return {
    title: clampPushText(push.title, 120),
    body: clampPushText(`${lead}${push.body}`, 300),
  };
}
