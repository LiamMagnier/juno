/**
 * The device link's push stream (docs/code-v2/DEVICE-LINK.md, "Stream"): the
 * phone keeps one response open and the hub writes each batch of events into
 * it the moment the Mac pushes them, instead of the phone asking again after
 * every batch (a long-poll costs a request, its sign-in and pair lookups, and
 * a round trip per batch; a stream costs none of those after it opens).
 *
 * Framing is Server-Sent Events: one `data:` line of JSON per frame, a blank
 * line after it, and a `:` comment as a heartbeat so proxies keep it open.
 *
 *   data: {"events":[...]}        events after the stream's cursors
 *   data: {"offline":true,...}    the Mac went offline (the stream ends)
 *   : ping                        nothing new for `heartbeatMs`
 *
 * The cursors advance inside the stream as events go out, so the phone never
 * re-sends them. It reopens the stream when it follows another session, when
 * the window ends (`windowMs`, under the route's maxDuration), or on an error.
 */
import type { ServerEventEnvelope } from "./contracts";
import type { LinkEndpoint, LinkReply } from "./env-link-hub";

export const LINK_STREAM_LIMITS = {
  /** A stream ends after this long; the phone reopens it at once. */
  windowMs: 55_000,
  /** A heartbeat after this long without events. */
  heartbeatMs: 15_000,
  /** The pair is checked again before events go out when the last check is older than this. */
  pairRecheckMs: 5_000,
} as const;

export interface LinkStreamOptions {
  cursors: Record<string, number>;
  globalCursor?: number;
  signal?: AbortSignal;
  /** Null while the phone still holds a live pair with the Mac; a reason ends the stream. */
  checkPair?: () => Promise<string | null>;
  windowMs?: number;
  heartbeatMs?: number;
  pairRecheckMs?: number;
  now?: () => number;
}

/** Moves the cursors past the events just sent. */
export function advanceCursors(cursors: Record<string, number>, globalCursor: number, events: readonly ServerEventEnvelope[]): number {
  let global = globalCursor;
  for (const e of events) {
    if (e.stream === "global") global = Math.max(global, e.sequence);
    else if (e.sessionId && e.sessionId in cursors) cursors[e.sessionId] = Math.max(cursors[e.sessionId], e.sequence);
  }
  return global;
}

/** One SSE frame. */
export function sseFrame(payload: LinkReply | { error: string }): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * The frames of one stream, in order. Each wait on the hub wakes the moment
 * the Mac pushes, so an event leaves within the hub's own handling time.
 */
export async function* linkStreamFrames(link: LinkEndpoint, options: LinkStreamOptions): AsyncGenerator<string> {
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? LINK_STREAM_LIMITS.windowMs;
  const heartbeatMs = options.heartbeatMs ?? LINK_STREAM_LIMITS.heartbeatMs;
  const recheckMs = options.pairRecheckMs ?? LINK_STREAM_LIMITS.pairRecheckMs;
  const cursors = { ...options.cursors };
  let global = options.globalCursor ?? -1;
  const started = now();
  let checkedAt = started;
  while (!options.signal?.aborted) {
    const left = windowMs - (now() - started);
    if (left <= 0) return;
    const reply = await link.poll(cursors, global, Math.min(heartbeatMs, left), options.signal);
    if (options.signal?.aborted) return;
    if (reply.offline) {
      yield sseFrame({ offline: true, ...(reply.message ? { message: reply.message } : {}) });
      return;
    }
    const events = reply.events ?? [];
    if (events.length === 0) {
      yield ": ping\n\n";
      continue;
    }
    // A pair removed on the Mac stops delivery: checked again before events
    // leave, at most every `pairRecheckMs` (not per batch, which would put
    // two database lookups in front of every streamed delta).
    if (options.checkPair && now() - checkedAt >= recheckMs) {
      const refused = await options.checkPair();
      checkedAt = now();
      if (refused) {
        yield sseFrame({ error: refused });
        return;
      }
    }
    global = advanceCursors(cursors, global, events);
    yield sseFrame({ events });
  }
}
