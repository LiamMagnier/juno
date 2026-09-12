/**
 * The read side of a resumable stream: replay what a client missed, then tail
 * the log until the generation ends.
 *
 * Pure — the database and the clock are behind the port and the options — so
 * the rules a reconnecting client depends on can be pinned by tests:
 *
 *  - Only frames with `seq > after` are replayed. The client sends the last
 *    seq it rendered; sending it the same frame twice would double a delta.
 *  - A `done`/`error` frame is the end of the log. Nothing follows it, so the
 *    tail stops the moment one is replayed.
 *  - Between frames the generation's liveness decides whether to keep
 *    waiting. "running" waits; "terminal" — the receipt finished, or the
 *    process no longer has the generation registered — waits one short grace
 *    for the terminal frame's flush to land, then ends with `refetch`: the
 *    answer is (or is not) in the conversation, and the client should load
 *    it from there rather than trust an incomplete log.
 *  - A heartbeat is emitted after HEARTBEAT_MS without a frame, so proxies and
 *    the browser keep the connection open through a long silence.
 *  - Nothing tails forever: MAX_TAIL_MS bounds the wait for a generation that
 *    never reports an end.
 */

export interface ReplayEventRow {
  seq: number;
  kind: string;
  /** The frame's JSON, already decrypted by the port. */
  payload: string;
}

export type GenerationLiveness = "running" | "terminal";

export interface StreamReplayPort {
  /** Rows with `seq > after`, ascending, at most `limit`. */
  eventsAfter(generationId: string, after: number, limit: number): Promise<ReplayEventRow[]>;
  /** Whether the generation can still append to its log. */
  liveness(generationId: string): Promise<GenerationLiveness>;
}

export type ReplayEvent =
  | { type: "frame"; seq: number; kind: string; payload: string }
  | { type: "heartbeat" }
  | { type: "end"; reason: "terminal" | "refetch" | "timeout" | "aborted" };

export interface ReplayOptions {
  generationId: string;
  after: number;
  pollMs?: number;
  heartbeatMs?: number;
  /** How long to wait for a terminal frame once liveness says "terminal". */
  terminalGraceMs?: number;
  maxTailMs?: number;
  batchLimit?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export const REPLAY_POLL_MS = 400;
export const REPLAY_HEARTBEAT_MS = 15_000;
export const REPLAY_TERMINAL_GRACE_MS = 3_000;
/** Deep research runs up to an hour; a little past that is unreachable. */
export const REPLAY_MAX_TAIL_MS = 65 * 60_000;
export const REPLAY_BATCH_LIMIT = 500;

function isTerminal(kind: string): boolean {
  return kind === "done" || kind === "error";
}

export async function* replayStream(port: StreamReplayPort, options: ReplayOptions): AsyncGenerator<ReplayEvent> {
  const pollMs = options.pollMs ?? REPLAY_POLL_MS;
  const heartbeatMs = options.heartbeatMs ?? REPLAY_HEARTBEAT_MS;
  const terminalGraceMs = options.terminalGraceMs ?? REPLAY_TERMINAL_GRACE_MS;
  const maxTailMs = options.maxTailMs ?? REPLAY_MAX_TAIL_MS;
  const batchLimit = options.batchLimit ?? REPLAY_BATCH_LIMIT;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const startedAt = now();
  let cursor = options.after;
  let lastFrameAt = startedAt;
  let lastHeartbeatAt = startedAt;
  let terminalSeenAt: number | null = null;

  for (;;) {
    if (options.signal?.aborted) {
      yield { type: "end", reason: "aborted" };
      return;
    }
    const rows = await port.eventsAfter(options.generationId, cursor, batchLimit);
    for (const row of rows) {
      // Defensive: a port returning rows out of order or below the cursor must
      // not make the client render a frame twice.
      if (row.seq <= cursor) continue;
      cursor = row.seq;
      lastFrameAt = now();
      lastHeartbeatAt = lastFrameAt;
      yield { type: "frame", seq: row.seq, kind: row.kind, payload: row.payload };
      if (isTerminal(row.kind)) {
        yield { type: "end", reason: "terminal" };
        return;
      }
    }
    // A full batch means there may be more already waiting — read again
    // before deciding anything about liveness.
    if (rows.length >= batchLimit) continue;

    const liveness = await port.liveness(options.generationId);
    if (liveness === "terminal") {
      // The generation is over but its last frame has not been read. Either
      // the flush is still landing (grace covers it) or it never will — the
      // log was disabled, cleaned, or the process died mid-write.
      terminalSeenAt ??= now();
      if (now() - terminalSeenAt >= terminalGraceMs) {
        yield { type: "end", reason: "refetch" };
        return;
      }
    } else {
      terminalSeenAt = null;
    }

    if (now() - startedAt >= maxTailMs) {
      yield { type: "end", reason: "timeout" };
      return;
    }
    if (now() - lastHeartbeatAt >= heartbeatMs) {
      lastHeartbeatAt = now();
      yield { type: "heartbeat" };
    }
    await sleep(pollMs);
  }
}

/**
 * Client-side companion: decide which frames to apply when the initial stream
 * and one or more resumes are stitched together. Frames carry the log `seq`
 * as their SSE id; a frame at or below the last applied seq is a duplicate
 * (a resume that overlapped the drop, a retried reconnect) and is skipped.
 * Frames without an id — heartbeats, the `resume` notices, anything from a
 * generation that is not being logged — are always applied.
 */
export function createFrameSequencer(initialLastSeq = 0): {
  accept(id: number | undefined): boolean;
  readonly lastSeq: number;
} {
  let lastSeq = initialLastSeq;
  return {
    accept(id) {
      if (id === undefined || !Number.isFinite(id)) return true;
      if (id <= lastSeq) return false;
      lastSeq = id;
      return true;
    },
    get lastSeq() {
      return lastSeq;
    },
  };
}
