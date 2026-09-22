/**
 * The pure half of the provider proxy at /api/agent/<provider>/<path>.
 *
 * Everything here is free of Prisma, sessions and provider keys so a test can
 * drive it by hand: the request body limit and the deadlines on the upstream
 * call. The route does the I/O around it — auth, budget and the fetch.
 */

/**
 * Provider requests are usually small JSON bodies, but Code can also carry
 * image content. Keep a generous ceiling without allowing an authenticated
 * client to make the Next.js process buffer an arbitrary request in memory.
 */
export const MAX_AGENT_BODY_BYTES = 16 * 1024 * 1024;

export type LimitedBodyResult =
  | { ok: true; body: string }
  | { ok: false; reason: "too_large" | "unreadable" };

/** Read a request body with a hard byte limit, including streamed bodies whose
 * Content-Length header is absent or deliberately inaccurate. */
export async function readLimitedRequestBody(
  req: Request,
  maxBytes = MAX_AGENT_BODY_BYTES,
): Promise<LimitedBodyResult> {
  const declared = req.headers.get("content-length");
  if (declared) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      return { ok: false, reason: "too_large" };
    }
  }

  if (!req.body) return { ok: true, body: "" };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("agent request body too large").catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: new TextDecoder().decode(bytes) };
}

// ---------------------------------------------------------------------------
// Deadlines on the upstream call
// ---------------------------------------------------------------------------

/**
 * Three deadlines where there used to be one.
 *
 * The proxy aborted every upstream call 240 seconds after it started, whatever
 * the provider was doing. That is the right bound for a provider that has gone
 * quiet and the wrong one for a provider that is working: an extended-thinking
 * turn or a long file write streams steadily for five, ten, twenty minutes, and
 * was cut mid-sentence at four with the tokens already paid for. Liveness and
 * duration are different questions, so they get different timers.
 */
export interface UpstreamTimeouts {
  /** From sending the request until the provider's response headers arrive. */
  headersMs: number;
  /** The longest the provider may stay silent while a read is waiting on it. */
  idleMs: number;
  /** The whole exchange, however busy it is. */
  ceilingMs: number;
}

/**
 * A streaming provider answers with headers as soon as it has accepted the
 * request; the wait is queueing and prompt prefill, not generation. Two minutes
 * is four times the Mac client's own 30-second connection limit, so the server
 * never gives up on a request its caller is still prepared to wait for.
 */
export const UPSTREAM_HEADERS_TIMEOUT_MS = 120_000;

/**
 * Silence, measured only while a read is waiting on the provider: a slow client
 * that has stopped pulling is not the provider going quiet. Anthropic pings and
 * streams thinking; OpenAI reasoning can go silent for minutes before the first
 * token, which is why this is not tighter. It must stay below Node's own fetch
 * limits (undici's `headersTimeout` and `bodyTimeout`, 300 seconds each): above
 * them, undici tears the socket down first and the caller gets an opaque
 * "terminated" instead of a timeout this code can name.
 */
export const UPSTREAM_IDLE_TIMEOUT_MS = 240_000;

/**
 * The absolute bound, for a stream that never stops producing bytes. A 128K
 * output at a slow 40 tokens a second is under an hour; nothing legitimate runs
 * longer, and nginx's `proxy_read_timeout` in deploy/nginx.conf.template is the
 * same hour between reads.
 */
export const UPSTREAM_CEILING_MS = 60 * 60_000;

/**
 * The deadlines for one request. A request that does not stream receives its
 * whole answer as the response, so the wait for headers IS the generation and
 * is bounded by the idle limit instead of the short streaming one.
 */
export function upstreamTimeoutsFor(streamed: boolean): UpstreamTimeouts {
  return {
    headersMs: streamed ? UPSTREAM_HEADERS_TIMEOUT_MS : UPSTREAM_IDLE_TIMEOUT_MS,
    idleMs: UPSTREAM_IDLE_TIMEOUT_MS,
    ceilingMs: UPSTREAM_CEILING_MS,
  };
}

export type UpstreamTimeoutKind = "headers" | "idle" | "ceiling";

const TIMEOUT_REASONS: Record<UpstreamTimeoutKind, string> = {
  headers: "upstream_headers_timeout",
  idle: "upstream_idle_timeout",
  ceiling: "upstream_ceiling",
};

/** The timer primitives, injectable so a test can count what is still armed. */
export interface UpstreamTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const SYSTEM_TIMERS: UpstreamTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface UpstreamAbort {
  signal: AbortSignal;
  /** The response headers arrived: the headers deadline no longer applies. */
  headersReceived(): void;
  /**
   * Wait for the next body chunk under the idle deadline. Each read arms a
   * fresh idle window, so every chunk the provider sends resets it.
   */
  read<T>(next: () => Promise<T>): Promise<T>;
  /** Abort the upstream call now (the client went away) and disarm everything. */
  abort(reason: unknown): void;
  /** The exchange is over: clear every timer and the client listener. */
  cancel(): void;
}

/**
 * Bound an upstream provider call by the client's request lifetime and by the
 * three deadlines above. Without them, a provider that accepts a request but
 * never answers can pin a Next.js worker indefinitely.
 */
export function createUpstreamAbort(
  parent: AbortSignal,
  timeouts: UpstreamTimeouts,
  timers: UpstreamTimers = SYSTEM_TIMERS,
): UpstreamAbort {
  const controller = new AbortController();
  let settled = false;
  let headersTimer: unknown = null;
  let idleTimer: unknown = null;
  let ceilingTimer: unknown = null;

  const disarm = (handle: unknown) => {
    if (handle !== null) timers.clear(handle);
    return null;
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    headersTimer = disarm(headersTimer);
    idleTimer = disarm(idleTimer);
    ceilingTimer = disarm(ceilingTimer);
    parent.removeEventListener("abort", onParentAbort);
  };
  const abort = (reason: unknown) => {
    cancel();
    if (!controller.signal.aborted) controller.abort(reason);
  };
  function onParentAbort() {
    abort(parent.reason);
  }

  if (parent.aborted) {
    abort(parent.reason);
  } else {
    parent.addEventListener("abort", onParentAbort, { once: true });
    headersTimer = timers.set(() => abort(TIMEOUT_REASONS.headers), timeouts.headersMs);
    ceilingTimer = timers.set(() => abort(TIMEOUT_REASONS.ceiling), timeouts.ceilingMs);
  }

  return {
    signal: controller.signal,
    headersReceived() {
      headersTimer = disarm(headersTimer);
    },
    async read<T>(next: () => Promise<T>): Promise<T> {
      // After cancel() nothing may re-arm a timer: a read on a finished
      // exchange runs without a deadline rather than leaving one behind.
      if (settled) return next();
      idleTimer = disarm(idleTimer);
      idleTimer = timers.set(() => abort(TIMEOUT_REASONS.idle), timeouts.idleMs);
      try {
        return await next();
      } finally {
        idleTimer = disarm(idleTimer);
      }
    },
    abort,
    cancel,
  };
}

/** Which deadline aborted this signal, or null when none did. */
export function upstreamTimeoutKind(signal: AbortSignal): UpstreamTimeoutKind | null {
  if (!signal.aborted) return null;
  for (const kind of Object.keys(TIMEOUT_REASONS) as UpstreamTimeoutKind[]) {
    if (signal.reason === TIMEOUT_REASONS[kind]) return kind;
  }
  return null;
}

export function isUpstreamTimeout(signal: AbortSignal): boolean {
  return upstreamTimeoutKind(signal) !== null;
}

/**
 * Whether the body asks the provider to stream. It decides the headers
 * deadline (see `upstreamTimeoutsFor`); a body that is not JSON is treated as
 * not streaming, and the provider will refuse it anyway.
 */
export function requestStreams(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && (parsed as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
}
