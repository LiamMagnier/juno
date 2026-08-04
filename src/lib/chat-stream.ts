import type { ClientActivityEvent, StreamChunk } from "@/types/chat";

const encoder = new TextEncoder();

/** Encode a chunk as a single SSE `data:` frame. */
export function encodeChunk(chunk: StreamChunk): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
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

/**
 * The server side of the SSE protocol, shared by both of the chat route's
 * streaming paths (they each had their own verbatim copy).
 *
 * `send` swallowing enqueue errors is deliberate and load-bearing: generation
 * is bound to a generation-scoped AbortController, not the request signal, so a
 * client that navigates away still gets its answer persisted. Letting a failed
 * enqueue throw would undo that.
 */
export function createSseSender(controller: ReadableStreamDefaultController<Uint8Array>): SseSender {
  const activityLog: ClientActivityEvent[] = [];
  let activityCounter = 0;

  const send = (chunk: StreamChunk) => {
    try {
      controller.enqueue(encodeChunk(chunk));
    } catch {
      /* client disconnected — keep going so the answer is still saved */
    }
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

/**
 * Client-side helper: read an SSE stream from fetch and invoke onChunk for each
 * parsed StreamChunk. Resolves when the stream ends.
 */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: StreamChunk) => void
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
      if (!frame.startsWith("data:")) continue;
      const json = frame.slice(5).trim();
      if (!json) continue;
      try {
        onChunk(JSON.parse(json) as StreamChunk);
      } catch {
        // ignore malformed frame
      }
    }
  }
}
