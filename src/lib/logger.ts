import "server-only";
import { headers } from "next/headers";

/**
 * Structured logging with a request id.
 *
 * There were ~100 bare `console.*` calls across the server, each with its own
 * shape, and nothing tying the lines from one request together. When something
 * failed mid-generation the operator got a handful of unrelated-looking lines
 * in `logs/err.log` and no way to know they belonged to the same turn.
 *
 * `X-Juno-Request-Id` already existed but only on `/api/v1` responses, minted
 * per response and never logged — so it correlated nothing. Middleware now
 * stamps one on every request, this reads it back, and every line carries it.
 *
 * Output stays plain `console.*`, deliberately: PM2 captures stdout/stderr and
 * there is no log shipper to satisfy. What changes is that a line is one JSON
 * object with a stable shape, so `grep`-then-`jq` works and a future shipper
 * needs no rewrite.
 */

export const REQUEST_ID_HEADER = "x-juno-request-id";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Read the current request's id, or null outside a request scope. */
async function currentRequestId(): Promise<string | null> {
  try {
    return (await headers()).get(REQUEST_ID_HEADER);
  } catch {
    // Not in a request scope — a background job, the scheduler, module init.
    return null;
  }
}

function emit(level: LogLevel, event: string, fields: Record<string, unknown>, requestId: string | null) {
  const line = {
    level,
    event,
    ...(requestId ? { requestId } : {}),
    ...fields,
  };
  // debug goes to stdout like info; Node has no separate channel for it, and
  // pretending otherwise just doubles the volume PM2 captures.
  if (level === "error") console.error(JSON.stringify(line));
  else if (level === "warn") console.warn(JSON.stringify(line));
  else console.log(JSON.stringify(line));
}

/**
 * Log with the current request's id attached.
 *
 * Async because reading the request scope is. Where that is inconvenient —
 * inside a hot streaming loop, or in code that also runs outside a request —
 * use `logSync`, which simply omits the id rather than blocking.
 */
export async function log(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {}
): Promise<void> {
  emit(level, event, fields, await currentRequestId());
}

/** Fire-and-forget: never awaited, never throws into a request path. */
export function logAsync(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  void log(level, event, fields).catch(() => {
    /* logging must never be the reason a request fails */
  });
}

/** Structured, but without the request id. For background jobs and hot loops. */
export function logSync(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  emit(level, event, fields, null);
}

/**
 * Only when JUNO_DEBUG is set — in any environment, production included.
 *
 * The per-turn auto-routing line was `console.info` on every single message —
 * useful while building the router, pure volume in production, where it is the
 * chattiest thing in the log. Setting JUNO_DEBUG on the VM to chase an incident
 * turns all of that back on, deliberately; it is off by default because the
 * variable is unset, not because production is special-cased.
 */
export function logDebug(event: string, fields: Record<string, unknown> = {}): void {
  if (!process.env.JUNO_DEBUG) return;
  emit("debug", event, fields, null);
}
