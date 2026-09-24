import type { ClientActivityEvent, StreamChunk } from "@/types/chat";
import type { ClientFeatureSet } from "@/lib/chat/client-features";
import type { StreamLog } from "@/lib/chat/stream-log";

const encoder = new TextEncoder();

/**
 * Encode a chunk as one SSE frame. With `id`, the frame carries an `id:` line
 * first — the position of this frame in the generation's log (see
 * chat/stream-log.ts) — which is what a client hands back as `after` when it
 * reconnects. A frame without an id is not resumable-from: heartbeats, the
 * private path, a log that has been disabled.
 */
export function encodeChunk(chunk: StreamChunk, id?: number): Uint8Array {
  return encodeSseFrame(JSON.stringify(chunk), id);
}

/** The same frame from an already-serialised payload — what a replay sends. */
export function encodeSseFrame(json: string, id?: number): Uint8Array {
  const data = `data: ${json}\n\n`;
  return encoder.encode(id === undefined ? data : `id: ${id}\n${data}`);
}

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

export interface SseSender {
  /** Enqueue a chunk. Never throws — a disconnected client must not abort the
   *  generation, which continues server-side so the answer is still saved. */
  send(chunk: StreamChunk): void;
  /**
   * Stamp an activity event — `id`, `createdAt` and `seq` (SPEC §2.10) —
   * append it to the log, and stream it. The returned object IS the logged
   * entry: mutate it and `send` it again to update the row in place, and it
   * keeps all three stamps.
   *
   * `stream: false` records the row without sending it. That is how a
   * timeline-only row (a reasoning segment, commentary, the offered-tools
   * fact) reaches the persisted log of a turn whose client never declared
   * `timeline` (SPEC §2.4): iOS draws its progress block for ANY activity row.
   */
  sendActivity(
    event: Omit<ClientActivityEvent, "id" | "createdAt">,
    options?: { stream?: boolean }
  ): ClientActivityEvent;
  /** The events emitted so far, in order — persisted onto the message. */
  readonly activityLog: ClientActivityEvent[];
}

export interface SseSenderOptions {
  /**
   * The generation's frame log. Every stateful frame sent through this sender
   * is recorded there and goes out with its log position as the SSE `id:`.
   * Absent for the private path, which must log nothing.
   */
  log?: StreamLog;
  /**
   * What the client declared (SPEC §2.2). With it, the `resume` notice goes
   * out only to a client that declared `resume` (INV-1): a shipped native
   * build throws on the frame type and loses the whole answer. Absent keeps the
   * behaviour every caller had before the rework, until the route passes the
   * turn's set.
   */
  features?: ClientFeatureSet;
  /** The clock behind `id` and `createdAt`. Tests and the `/dev/run` player pass script time. */
  now?: () => number;
}

// ── Frame bounds (INV-4) ─────────────────────────────────────────────────────

/** `delta.text` and `reasoning.text`: at most this many UTF-8 bytes per frame. */
export const MAX_TEXT_FRAME_BYTES = 64 * 1_024;
/** `error.message`: one line, at most this many UTF-8 bytes. */
export const MAX_ERROR_MESSAGE_BYTES = 32 * 1_024;
/**
 * The whole serialised `done` frame. Native refuses an SSE event over 5 MiB
 * (`ChatSSEParser.maximumEventBytes`), and on `done` that event is the answer.
 */
export const MAX_DONE_FRAME_BYTES = 4.5 * 1_024 * 1_024;

/** `text` cut into pieces of at most `maxBytes` UTF-8 bytes, on code point boundaries. */
export function splitUtf8(text: string, maxBytes: number): string[] {
  if (text.length * 3 <= maxBytes || encoder.encode(text).length <= maxBytes) return [text];
  const pieces: string[] = [];
  let start = 0;
  let bytes = 0;
  let index = 0;
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;
    const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) {
      pieces.push(text.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += size;
    index += char.length;
  }
  pieces.push(text.slice(start));
  return pieces;
}

/**
 * One line native's `validText` accepts: no control (Cc) or format (Cf)
 * character, no line separator, within `maxBytes`.
 */
function clampLineBytes(value: string, maxBytes: number): string {
  const line = value
    .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return splitUtf8(line, maxBytes)[0] ?? "";
}

/**
 * INV-4 on the `done` frame: when the serialised frame would pass
 * `MAX_DONE_FRAME_BYTES`, `message.activity` is dropped from the FRAME first
 * (the persisted row keeps it, and native never decodes it), then
 * `artifacts`. Every reserved key keeps its JSON type (INV-2): `artifacts`
 * becomes an empty array, never absent.
 */
export function boundDoneFrame<T extends Extract<StreamChunk, { type: "done" }>>(chunk: T): T {
  const size = (candidate: T) => encoder.encode(JSON.stringify(candidate)).length;
  if (size(chunk) <= MAX_DONE_FRAME_BYTES) return chunk;
  const message = { ...chunk.message };
  delete message.activity;
  const withoutActivity = { ...chunk, message } as T;
  if (size(withoutActivity) <= MAX_DONE_FRAME_BYTES) return withoutActivity;
  return { ...withoutActivity, artifacts: [] };
}

/** Every frame the sender emits for one chunk, each inside the INV-4 bounds. */
export function boundFrames(chunk: StreamChunk): StreamChunk[] {
  switch (chunk.type) {
    case "delta":
    case "reasoning": {
      const pieces = splitUtf8(chunk.text, MAX_TEXT_FRAME_BYTES);
      return pieces.length === 1 ? [chunk] : pieces.map((text) => ({ ...chunk, text }));
    }
    case "error": {
      const message = clampLineBytes(chunk.message, MAX_ERROR_MESSAGE_BYTES);
      return message === chunk.message ? [chunk] : [{ ...chunk, message }];
    }
    case "done":
      return [boundDoneFrame(chunk)];
    default:
      return [chunk];
  }
}

/**
 * The server side of the SSE protocol, shared by both of the chat route's
 * streaming paths (they each had their own verbatim copy).
 *
 * `send` swallowing enqueue errors is deliberate and load-bearing: generation
 * is bound to a generation-scoped AbortController, not the request signal, so a
 * client that navigates away still gets its answer persisted. Letting a failed
 * enqueue throw would undo that.
 *
 * With a `log`, the same `send` is also where the frame is appended to the
 * generation's log — recording is synchronous and buffered, so it costs the
 * stream nothing. If the log stops (a failed flush, the cap), the next frame
 * is preceded by a `resume` notice so the client knows a reconnect would find
 * a hole, and frames from then on carry no id.
 */
export function createSseSender(
  controller: ReadableStreamDefaultController<Uint8Array>,
  options: SseSenderOptions = {}
): SseSender {
  const activityLog: ClientActivityEvent[] = [];
  let activityCounter = 0;
  const log = options.log;
  const now = options.now ?? Date.now;
  // Without a declared set every caller keeps the notice it always got; with
  // one, only a client that said it understands `resume` receives it (INV-1).
  const announcesResume = !options.features || options.features.has("resume");
  let announcedUnavailable = false;

  const enqueue = (chunk: StreamChunk, id?: number) => {
    try {
      controller.enqueue(encodeChunk(chunk, id));
    } catch {
      /* client disconnected — keep going so the answer is still saved */
    }
  };

  const sendOne = (chunk: StreamChunk) => {
    if (!log) {
      enqueue(chunk);
      return;
    }
    const seq = log.record(chunk);
    if (!log.available && !announcedUnavailable) {
      // Logged silently either way: the stop is a fact about the log, and a
      // client that cannot read the frame must not be sent it.
      announcedUnavailable = true;
      if (announcesResume) enqueue({ type: "resume", available: false });
    }
    enqueue(chunk, seq ?? undefined);
  };

  const send = (chunk: StreamChunk) => {
    for (const frame of boundFrames(chunk)) sendOne(frame);
  };

  return {
    send,
    sendActivity(event, sendOptions) {
      const at = now();
      const counter = activityCounter++;
      const entry: ClientActivityEvent = {
        ...event,
        id: `activity-${at}-${counter}`,
        createdAt: new Date(at).toISOString(),
        // 1-based, fixed at first emission (INV-6). Re-sending the same object
        // keeps it, which is what lets a client replace a row in place.
        seq: counter + 1,
      };
      activityLog.push(entry);
      if (sendOptions?.stream !== false) send({ type: "activity", event: entry });
      return entry;
    },
    activityLog,
  };
}

/** Per-frame metadata handed to `readChatStream`'s callback. */
export interface StreamFrameInfo {
  /** The frame's SSE `id:` — its position in the generation's log — if any. */
  id?: number;
}

/**
 * Parse one SSE frame (the text between blank lines) into its data payload and
 * id. Line-based, as the SSE grammar is: a frame may carry `id:` and `data:`
 * lines in any order, and lines with other field names are ignored. The old
 * reader took the whole frame as one `data:` line, which is why an `id:` line
 * in front of it would have made every frame vanish.
 */
export function parseSseFrame(frame: string): { data: string; id?: number } | null {
  let id: number | undefined;
  const data: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    } else if (line.startsWith("id:")) {
      const parsed = Number.parseInt(line.slice(3).trim(), 10);
      if (Number.isFinite(parsed)) id = parsed;
    }
  }
  if (data.length === 0) return null;
  return { data: data.join("\n"), ...(id === undefined ? {} : { id }) };
}

/**
 * Client-side helper: read an SSE stream from fetch and invoke onChunk for each
 * parsed StreamChunk. Resolves when the stream ends.
 */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: StreamChunk, frame: StreamFrameInfo) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let handedOff = false;

  const emit = (frame: string) => {
    const parsed = parseSseFrame(frame.trim());
    if (!parsed || !parsed.data.trim()) return;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(parsed.data) as StreamChunk;
    } catch {
      return; // ignore malformed frame
    }
    try {
      onChunk(chunk, parsed.id === undefined ? {} : { id: parsed.id });
    } catch {
      // a throwing consumer must not stop the read
    }
    // `handoff` ends the request like `done` (SPEC §2.3 rule 6): the turn now
    // lives in a research run, so nothing after it is read and the reader
    // never tries to resume this generation.
    if (chunk?.type === "handoff") handedOff = true;
  };

  while (!handedOff) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while (!handedOff && (idx = buffer.indexOf("\n\n")) !== -1) {
      emit(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  if (handedOff) {
    await reader.cancel().catch(() => {});
    return;
  }

  /*
   * Flush the tail. A frame is only complete once its blank line has arrived,
   * which is right for every read but the last one — after `done` there is no
   * next read to bring the terminator, so a final frame sent without one is
   * held back for ever.
   *
   * This is the same defect that was live in the Gemini reader, where the
   * stranded frame was the one carrying `finishReason` and the loss rendered
   * as "Gemini is temporarily unavailable". Here both ends are Juno's, and the
   * route does terminate its frames — so this is insurance rather than a fix
   * for an observed failure. It costs one parse of a buffer that is almost
   * always empty, and the failure it prevents is a silently dropped final
   * chunk, which is the hardest kind of bug to see.
   */
  buffer += decoder.decode();
  if (buffer.trim()) emit(buffer);
}
