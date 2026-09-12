/**
 * The write side of a resumable stream: an append-only log of one
 * generation's SSE frames, numbered by `seq`.
 *
 * Why it exists. Generation lives inside the HTTP request; when the SSE
 * connection drops the server keeps generating and persists the answer, but
 * the browser has nothing to reconnect to. It polled the conversation for 12
 * seconds, then stamped "Try again" — a regenerate, and a second charge for
 * an answer that was already being written. With every frame logged under a
 * monotonic `seq`, a dropped client can ask `GET /api/chat/stream/:id?after=N`
 * for everything it missed and keep rendering the same turn.
 *
 * Pure: the database is behind `write`, and the clock behind `schedule`, so
 * batching, the cap and the failure rule are all testable. The store that
 * encrypts and inserts rows is `chat-stream-log-store.ts`.
 *
 * Rules:
 *  - Never on the stream's critical path. `record` is synchronous and only
 *    buffers; rows reach the database on a timer (STREAM_LOG_FLUSH_MS) or once
 *    STREAM_LOG_FLUSH_EVERY are waiting, whichever comes first. Writes are
 *    serialised so two flushes cannot interleave.
 *  - A failed write disables the log for the rest of the generation. Half a
 *    log is worse than none: a client that replays past the gap renders an
 *    answer with a hole in it and believes it complete. The sender announces
 *    the loss with a `resume` frame so the client falls back to polling.
 *  - Capped at STREAM_LOG_MAX_EVENTS per generation, for the same reason a
 *    runaway tool loop is capped: the log must not be the thing that fills
 *    the disk. Past the cap logging stops and resume is unavailable.
 *  - `ping` frames are never logged; they carry no state.
 */
import type { StreamChunk } from "@/types/chat";

export const STREAM_LOG_FLUSH_MS = 250;
export const STREAM_LOG_FLUSH_EVERY = 32;
export const STREAM_LOG_MAX_EVENTS = 20_000;

/** Frame kinds whose last occurrence ends a generation's log. */
export const TERMINAL_FRAME_KINDS: readonly string[] = ["done", "error"];

export function isTerminalFrameKind(kind: string): boolean {
  return TERMINAL_FRAME_KINDS.includes(kind);
}

/** Everything but the heartbeat carries state the client needs to rebuild the turn. */
export function isLoggedFrame(chunk: StreamChunk): boolean {
  return chunk.type !== "ping";
}

/**
 * Which turns may open a frame log.
 *
 * A private chat persists nothing — no conversation row, no message row — and
 * the frames ARE the transcript: a logged `delta` is the answer's text and a
 * logged `done` carries the whole message. Writing them would put an incognito
 * turn in a table, which is the single promise that mode makes. So the private
 * path never opens a log, every private frame goes out without an `id:`, and a
 * resume of a private generation is a 404 by construction rather than by a
 * check somewhere downstream remembering to make it one.
 */
export type StreamLogSource = "saved" | "private";

export function streamLogSource(input: { privateMode?: boolean | null }): StreamLogSource {
  return input.privateMode ? "private" : "saved";
}

export function shouldLogStream(input: { privateMode?: boolean | null }): boolean {
  return streamLogSource(input) === "saved";
}

export interface StreamLogRow {
  generationId: string;
  seq: number;
  kind: string;
  /** The frame's JSON, in the clear; the store encrypts it. */
  payload: string;
}

export type StreamLogDisabledReason = "write_failed" | "cap";

export interface StreamLogOptions {
  generationId: string;
  /** Persist a batch. Rejecting disables the log for the generation. */
  write: (rows: StreamLogRow[]) => Promise<void>;
  flushIntervalMs?: number;
  flushEvery?: number;
  maxEvents?: number;
  onDisabled?: (reason: StreamLogDisabledReason, error?: unknown) => void;
  /** Injectable timer for tests. Must return something `clearTimer` accepts. */
  schedule?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface StreamLog {
  /**
   * Buffer a frame. Returns its `seq`, or null when the frame is not logged —
   * a heartbeat, or a log that has been disabled.
   */
  record(chunk: StreamChunk): number | null;
  /** Force the buffer out now. Resolves once the write has settled. */
  flush(): Promise<void>;
  /** Flush what is left and stop the timer. Idempotent. */
  close(): Promise<void>;
  /** False once a write failed or the cap was reached. */
  readonly available: boolean;
  /** Why the log stopped, if it did. */
  readonly disabledReason: StreamLogDisabledReason | null;
  /** The last seq handed out. */
  readonly lastSeq: number;
}

export function createStreamLog(options: StreamLogOptions): StreamLog {
  const flushIntervalMs = options.flushIntervalMs ?? STREAM_LOG_FLUSH_MS;
  const flushEvery = Math.max(1, options.flushEvery ?? STREAM_LOG_FLUSH_EVERY);
  const maxEvents = Math.max(1, options.maxEvents ?? STREAM_LOG_MAX_EVENTS);
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      // Never hold the process open for a log flush alone.
      (handle as { unref?: () => void }).unref?.();
      return handle;
    });
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let buffer: StreamLogRow[] = [];
  let timer: unknown = null;
  let seq = 0;
  let disabled: StreamLogDisabledReason | null = null;
  let closed = false;
  // Writes form a chain so a slow insert and the next flush cannot overlap.
  let chain: Promise<void> = Promise.resolve();

  const disable = (reason: StreamLogDisabledReason, error?: unknown) => {
    if (disabled) return;
    disabled = reason;
    buffer = [];
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    options.onDisabled?.(reason, error);
  };

  const flushNow = (): Promise<void> => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (buffer.length === 0 || disabled) return chain;
    const rows = buffer;
    buffer = [];
    chain = chain
      .then(() => options.write(rows))
      .catch((error: unknown) => disable("write_failed", error));
    return chain;
  };

  return {
    record(chunk) {
      if (disabled || closed || !isLoggedFrame(chunk)) return null;
      if (seq >= maxEvents) {
        disable("cap");
        return null;
      }
      seq += 1;
      buffer.push({ generationId: options.generationId, seq, kind: chunk.type, payload: JSON.stringify(chunk) });
      if (buffer.length >= flushEvery) {
        void flushNow();
      } else if (timer === null) {
        timer = schedule(() => {
          timer = null;
          void flushNow();
        }, flushIntervalMs);
      }
      return seq;
    },
    flush: () => flushNow(),
    async close() {
      closed = true;
      await flushNow();
    },
    get available() {
      return disabled === null;
    },
    get disabledReason() {
      return disabled;
    },
    get lastSeq() {
      return seq;
    },
  };
}
