/**
 * Where a notification opens, as a path inside the app.
 *
 * Every surface that follows a notification — the web inbox's `router.push`,
 * the service worker's `clients.openWindow`, the native apps' route parser —
 * takes this one relative path. It is stored on the row (`actionData.path`)
 * and validated on the way out as well as on the way in, because `actionData`
 * is JSON a later writer could get wrong: an absolute URL, or `//host`, would
 * turn a notification into an open redirect.
 *
 * Pure (no `server-only`) so the web client, the tests and the server share it.
 */

/** The destinations a notification may open. Anything else is dropped to null. */
const ALLOWED_ROOTS = ["/agents", "/chat", "/work", "/settings", "/usage", "/code", "/research", "/projects"] as const;

const MAX_PATH_CHARS = 512;

/**
 * A same-origin, relative in-app path, or null. Accepts only a leading single
 * slash followed by a known destination; strips nothing silently except
 * surrounding whitespace.
 */
export function safeAppPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (!path || path.length > MAX_PATH_CHARS) return null;
  // One leading slash, never two (protocol-relative) and never a backslash
  // (browsers normalise `/\host` to `//host`).
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  if (path.split(/[?#]/)[0]!.split("/").some((segment) => segment === "..")) return null;
  const known = ALLOWED_ROOTS.some(
    (root) => path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}?`) || path.startsWith(`${root}#`)
  );
  return known ? path : null;
}

/**
 * The relative path out of an absolute app URL (the Work email's `taskUrl`,
 * written before paths existed), or null when it is not one of ours.
 */
export function pathFromAppUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return safeAppPath(`${url.pathname}${url.search}`);
  } catch {
    return safeAppPath(value);
  }
}

/** The path for an agent's page. */
export function agentPath(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}`;
}

/** The path for a chat thread. */
export function chatPath(conversationId: string): string {
  return `/chat/${encodeURIComponent(conversationId)}`;
}

/** The path for a Work task opened on its own. */
export function workSessionPath(sessionId: string): string {
  return `/work/${encodeURIComponent(sessionId)}`;
}

/**
 * Where a stored notification row opens: its `path`, else the path inside a
 * legacy absolute `taskUrl`, else null (the row is informational).
 */
export function notificationPath(actionData: Record<string, unknown> | null | undefined): string | null {
  if (!actionData) return null;
  return safeAppPath(actionData.path) ?? pathFromAppUrl(actionData.taskUrl);
}
