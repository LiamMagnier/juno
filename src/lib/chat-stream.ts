import type { ClientActivityEvent, StreamChunk } from "@/types/chat";
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
  /** Stamp an activity event, append it to the log, and stream it. */
  sendActivity(event: Omit<ClientActivityEvent, "id" | "createdAt">): ClientActivityEvent;
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
  let announcedUnavailable = false;

  const enqueue = (chunk: StreamChunk, id?: number) => {
    try {
      controller.enqueue(encodeChunk(chunk, id));
    } catch {
      /* client disconnected — keep going so the answer is still saved */
    }
  };

  const send = (chunk: StreamChunk) => {
    if (!log) {
      enqueue(chunk);
      return;
    }
    const seq = log.record(chunk);
    if (!log.available && !announcedUnavailable) {
      announcedUnavailable = true;
      enqueue({ type: "resume", available: false });
    }
    enqueue(chunk, seq ?? undefined);
  };

  return {
    send,
    sendActivity(event) {
      const entry: ClientActivityEvent = {
        ...event,
        id: `activity-${Date.now()}-${activityCounter++}`,
        createdAt: new Date().toISOString(),
      };
      activityLog.push(entry);
      send({ type: "activity", event: entry });
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      const parsed = parseSseFrame(frame);
      if (!parsed || !parsed.data.trim()) continue;
      try {
        onChunk(JSON.parse(parsed.data) as StreamChunk, parsed.id === undefined ? {} : { id: parsed.id });
      } catch {
        // ignore malformed frame
      }
    }
  }
}
