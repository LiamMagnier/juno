/**
 * Approval notices by text.
 *
 * When something waits on the person's approval, `notifyUser` also texts the
 * linked number: who is waiting, and a link to the card. Never what is being
 * approved (a text sits on a lock screen and in a provider's logs), and never
 * a way to answer: the text says that replying approves nothing, and nothing
 * on the inbound path can approve (inbound.ts). The card, in the app, is the
 * only place a press counts.
 *
 * Pure, so the tests read every decision here without a database.
 */

import type { NotificationType } from "@/lib/notifications";

/** The notification types that are an approval waiting on the person. */
const APPROVAL_TYPES: ReadonlySet<NotificationType> = new Set(["work_approval", "code_approval"]);

/** Approval texts per account per hour; past it the in-app card and push still arrive. */
export const APPROVAL_NOTICE_LIMIT = 20;

export const APPROVAL_NOTICE_COPY = {
  text: (who: string, url: string) =>
    `${who} is waiting for you. Open it here: ${url}\nReplying to this text does not approve or answer anything.`,
} as const;

/** Whether a notification is one to text: an actionable approval with somewhere to open. */
export function isApprovalNotice(input: {
  type: NotificationType;
  channel: string;
  actionable?: boolean;
  path: string | null;
}): boolean {
  return input.channel === "needs_you" && input.actionable === true && APPROVAL_TYPES.has(input.type) && Boolean(input.path);
}

/**
 * The absolute link for a relative in-app path, or null. The path has been
 * through `safeAppPath` already; this still refuses to build a link that
 * leaves the app's own origin.
 */
export function absoluteAppUrl(appUrl: string, path: string): string | null {
  try {
    const base = new URL(appUrl);
    const url = new URL(path, base);
    return url.origin === base.origin ? url.toString() : null;
  } catch {
    return null;
  }
}
