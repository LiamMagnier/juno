/**
 * One poll of a Work session's event log.
 *
 * ## The finding this module exists because of
 *
 * `GET /api/work/sessions/[id]/events` is the ONLY route that returns Work
 * events, and it is Server-Sent Events. There is no JSON events endpoint:
 * `GET /api/work/sessions/[id]` returns the session, the current run and the
 * pending approvals and no transcript at all, and `sessions/[id]/runs` is POST
 * only. So an app that polls JSON gets a status bar and an empty panel.
 *
 * `JunoTransport` cannot carry a stream — `#readBody` calls `response.text()`
 * and `JSON.parse` — and it should not be made to, because nothing else in this
 * app streams. What this module does instead is exploit the shape of that route:
 * **its first frame is always a complete `snapshot`**, carrying the session, the
 * run, the approvals, and every event after the supplied cursor. So one poll is
 * "open the stream, read one frame, hang up". No long-lived connection, no
 * missed events, and the cursor makes it a delta.
 *
 * That is a poll in every sense the freshness bar cares about: it happens on an
 * interval, it can fail, and `work:poll-state` reports when the last one landed.
 *
 * ## Why this holds the bearer directly
 *
 * It has to — the token is what makes the request authenticated and the
 * transport is not in the path. It mirrors `requestAuthenticated` exactly: ask
 * the session for a token, and on a 401 rotate ONCE and retry. One retry, never
 * a loop: a second 401 after a fresh token means the device session is gone, and
 * retrying against a rotating-refresh family is how a client burns its own token
 * chain.
 *
 * Two rules are load-bearing and non-obvious:
 *
 *  - **No `Origin` header, ever.** `src/middleware.ts` 403s a mutating `/api/`
 *    request whose Origin does not match the host and passes one that has none.
 *    No Origin is the native path. Node's fetch adds none; nothing here does
 *    either.
 *  - **Nothing from a frame is logged.** A frame contains the goal, the
 *    assistant's prose and every tool payload.
 */

import { z } from 'zod';
import {
  ApiError,
  CancelledError,
  NetworkError,
  UnauthorizedError,
  toApiError,
} from '../auth/transport.js';
import type { BearerFetcher } from './bearer.js';
import { WireStreamFrameSchema, type WireStreamFrame } from './wire.js';

/** One poll's worth of stream. Comfortably under the route's own 4-minute window. */
const DEFAULT_TIMEOUT_MS = 20_000;
/**
 * A frame is `data: {json}\n\n`. Bounded so a malformed or hostile response
 * cannot be read into memory without limit while we wait for a delimiter that
 * never comes; the route pages events at 500 per frame, which fits.
 */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface EventStreamOptions {
  readonly http: BearerFetcher;
  readonly timeoutMs?: number;
}

export interface SessionFrame {
  readonly frame: WireStreamFrame;
  /**
   * True when the events are a full replay rather than a delta — either no
   * cursor was supplied, or a newer attempt took over and the route re-based us.
   *
   * `seq` is unique per RUN, not per session, so appending a new attempt's
   * replay onto the previous attempt's log would silently interleave two
   * transcripts. This is the flag that stops it.
   */
  readonly replaced: boolean;
}

/**
 * Reads exactly one frame from a session's event stream.
 *
 * `sinceRunId`/`sinceSeq` ask for a delta. Both are needed and the route says
 * why: a cursor for a run that is no longer current is ignored and the client
 * gets a fresh snapshot.
 */
export class WorkEventStream {
  readonly #http: BearerFetcher;
  readonly #timeoutMs: number;

  constructor(options: EventStreamOptions) {
    this.#http = options.http;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async readSessionFrame(
    sessionId: string,
    sinceRunId: string | null,
    sinceSeq: number,
    signal?: AbortSignal,
  ): Promise<SessionFrame> {
    const url = this.#http.url(`/api/work/sessions/${encodeURIComponent(sessionId)}/events`);
    if (sinceRunId !== null && sinceSeq > 0) {
      url.searchParams.set('runId', sinceRunId);
      url.searchParams.set('after', String(sinceSeq));
    }

    const response = await this.#http.get({
      url,
      accept: 'text/event-stream',
      signal,
      timeoutMs: this.#timeoutMs,
    });

    if (!response.ok) {
      /* The error path IS JSON — `requireUser` and the 404 both answer with a
         body — so it is read and typed the same way the transport types one. */
      const body = await readJson(response);
      throw toApiError(response.status, body, response.headers.get('x-juno-request-id'));
    }

    const frame = await this.#readFirstFrame(response, signal);
    const requestedDelta = sinceRunId !== null && sinceSeq > 0;
    return {
      frame,
      replaced: !requestedDelta || frame.run?.id !== sinceRunId,
    };
  }

  /**
   * Reads until the first `data:` frame is complete, then hangs up.
   *
   * Comment lines (`: ping`) are skipped, which matters: the route sends a
   * heartbeat when nothing has moved, and treating one as a frame would report a
   * poll that carried no session at all.
   */
  async #readFirstFrame(response: Response, signal?: AbortSignal): Promise<WireStreamFrame> {
    const body = response.body;
    if (body === null) throw new NetworkError('Juno returned an empty event stream.');

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        if (signal?.aborted === true) throw new CancelledError('The refresh was cancelled.');
        const { done, value } = await reader.read();
        if (value !== undefined) buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseFrame(block);
          if (parsed !== null) return parsed;
          boundary = buffer.indexOf('\n\n');
        }

        if (buffer.length > MAX_FRAME_BYTES) {
          throw new NetworkError('Juno sent an event frame larger than this app will read.');
        }
        if (done) {
          throw new NetworkError('Juno closed the event stream before sending anything.');
        }
      }
    } finally {
      /* Cancel rather than await the rest: the route keeps the connection open
         for four minutes and this poll is finished with it. `req.signal` fires
         on the server, which ends its loop. */
      await reader.cancel().catch(() => undefined);
    }
  }
}

/** `data: {...}` → a frame, or null for a comment/keep-alive/unreadable block. */
function parseFrame(block: string): WireStreamFrame | null {
  const payload = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (payload.length === 0) return null;

  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = WireStreamFrameSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

const UnknownJsonSchema = z.unknown();

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (text.length === 0) return undefined;
  try {
    return UnknownJsonSchema.parse(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Re-exported so callers can narrow without importing the transport twice. */
export { ApiError, UnauthorizedError };
