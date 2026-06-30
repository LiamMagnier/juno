import type { StreamChunk } from "@/types/chat";

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
