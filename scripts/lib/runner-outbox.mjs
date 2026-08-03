/**
 * The cloud runner's durable event outbox.
 *
 * What it replaces: `EventSink.post()` removed a batch from the queue, posted
 * it, and on a network error or a non-OK response simply logged and returned.
 * The batch was already gone. A thirty-second backend blip during a ten-minute
 * run silently dropped that slice of the transcript — the tool calls, the file
 * changes, the reasoning — and nothing anywhere recorded that it had happened.
 *
 * Three properties, in the order they matter:
 *
 *  - durable   — events stay in the buffer until the server acknowledges them,
 *                so a failed POST is retried rather than lost;
 *  - idempotent— every event carries a stable key derived from the run and its
 *                sequence, so a POST that succeeded server-side but whose
 *                response was lost does not duplicate on retry;
 *  - bounded   — an outage that outlives the run must not turn into unbounded
 *                memory. The buffer has a ceiling and drops from the MIDDLE,
 *                keeping the beginning and the end, which are the two parts a
 *                reader actually needs.
 *
 * Pure and dependency-free so the policy is unit-testable without a network,
 * a clock, or a GitHub runner.
 */

/** Default ceiling on buffered events during an outage. */
export const DEFAULT_MAX_BUFFERED = 2_000;

/**
 * Backoff for a failed flush.
 *
 * Exponential with full jitter. Jitter matters more than it looks here: every
 * cloud runner for a given deploy fails at the same instant when the backend
 * restarts, and a fixed schedule would bring them all back simultaneously —
 * turning one blip into a thundering herd against a server that has just come
 * up.
 *
 * `Retry-After` from the server wins outright when present: it is the only
 * party that knows how long it needs.
 *
 * @param {number} attempt 1-based failure count.
 * @param {{ retryAfterSeconds?: number|null, random?: () => number, baseMs?: number, maxMs?: number }} [opts]
 */
export function backoffDelayMs(attempt, opts = {}) {
  const { retryAfterSeconds = null, random = Math.random, baseMs = 500, maxMs = 30_000 } = opts;

  if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(Math.round(retryAfterSeconds * 1000), maxMs);
  }
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
  return Math.round(random() * exponential);
}

/** Parses a `Retry-After` header, which may be seconds or an HTTP date. */
export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, (at - now) / 1000);
}

/**
 * Whether a failed POST is worth retrying.
 *
 * A 4xx other than 408/429 means the request itself is wrong — a malformed
 * body, a revoked token, a task that no longer exists. Retrying that forever
 * keeps a dead runner hammering the backend until its job times out, so it is
 * dropped and reported instead.
 */
export function isRetryableStatus(status) {
  if (status === null || status === undefined) return true; // network error
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

/** A stable per-event key: the same event retried yields the same key. */
export function eventKey(runId, sequence) {
  return `${runId}:${sequence}`;
}

export class DurableOutbox {
  /**
   * @param {{ runId: string, maxBuffered?: number }} opts
   */
  constructor({ runId, maxBuffered = DEFAULT_MAX_BUFFERED }) {
    this.runId = runId;
    this.maxBuffered = maxBuffered;
    /** @type {{key:string, kind:string, payload:Record<string,unknown>}[]} */
    this.pending = [];
    this.sequence = 0;
    /** Events dropped to stay inside the ceiling, reported so the gap is visible. */
    this.dropped = 0;
  }

  get size() {
    return this.pending.length;
  }

  /** Adds an event, assigning it a stable idempotency key. */
  add(kind, payload) {
    this.sequence += 1;
    this.pending.push({ key: eventKey(this.runId, this.sequence), kind, payload });
    this.trim();
  }

  /**
   * Enforces the ceiling by dropping from the middle.
   *
   * The start of a run says what it was asked to do and the end says how it
   * finished; the middle is the part a reader can most afford to lose. Dropping
   * the oldest instead would lose the prompt, and dropping the newest would
   * lose the outcome — which is the one thing that must survive.
   */
  trim() {
    if (this.pending.length <= this.maxBuffered) return;
    const excess = this.pending.length - this.maxBuffered;
    const keepHead = Math.floor(this.maxBuffered / 2);
    this.pending.splice(keepHead, excess);
    this.dropped += excess;
  }

  /** The next batch to send. Nothing is removed until `acknowledge`. */
  peek(limit = this.pending.length) {
    return this.pending.slice(0, limit);
  }

  /**
   * Removes acknowledged events.
   *
   * By key, not by count: a concurrent `add` during an in-flight POST must not
   * cause the acknowledgement to remove the wrong rows.
   */
  acknowledge(batch) {
    const keys = new Set(batch.map((event) => event.key));
    this.pending = this.pending.filter((event) => !keys.has(event.key));
  }

  /** A note for the transcript when the ceiling has actually bitten. */
  dropNotice() {
    if (this.dropped === 0) return null;
    return {
      kind: "error",
      payload: {
        message:
          `${this.dropped} event(s) were dropped while the backend was unreachable. ` +
          "The start and end of this run are intact; some of the middle is missing.",
      },
    };
  }
}
