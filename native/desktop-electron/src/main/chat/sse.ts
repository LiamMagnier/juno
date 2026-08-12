/**
 * The reader for Juno's **anonymous** SSE dialect.
 *
 * ## Two dialects, one protocol
 *
 * Juno's backend speaks Server-Sent Events in two different accents, and code
 * written for one silently reads nothing from the other:
 *
 * - `/api/v1/changes/stream` uses **named** events — `event: wakeup` followed by
 *   `data: {...}`. `src/main/sync/client.ts` reads that one.
 * - `/api/chat` uses **anonymous** frames — `data: {...}` with the discriminator
 *   *inside* the JSON as a `type` field. `src/lib/chat-stream.ts` in the Next
 *   app is the encoder (`data: ${JSON.stringify(chunk)}\n\n`), and the web
 *   client's `readChatStream` is the reference decoder.
 *
 * This module implements the second. A reader for the first would see no
 * `event:` line, never assemble an event, and report a perfectly healthy stream
 * as empty — which is why these are separate functions rather than one
 * "SSE parser" with a flag.
 *
 * ## Why it is a class with a `push` method
 *
 * A `fetch` body arrives in arbitrary chunks. One chunk routinely contains six
 * whole frames and the first half of a seventh; the next contains the rest of
 * that frame and nothing else. Every property worth having — that a frame split
 * across two reads still parses, that six frames in one read produce six
 * results in order, that a malformed frame does not eat the frames after it —
 * is a property of *sequences of pushes*, so the parser has to be a value a
 * test can drive directly rather than a loop buried inside a network method.
 *
 * ## Deliberate leniencies, and one strictness
 *
 * - Multi-line `data:` fields are joined with `\n`, per the SSE spec. The chat
 *   encoder never emits one (`JSON.stringify` cannot contain a raw newline),
 *   but a proxy that re-wraps long lines would, and dropping the tail of a JSON
 *   payload is a far worse failure than handling a case that may not occur.
 * - `:`-prefixed comment lines and unknown fields (`id`, `retry`, `event`) are
 *   discarded. `/api/chat` sends none of them today.
 * - A frame whose payload is not JSON is **counted and dropped**, never thrown.
 *   One corrupted frame in the middle of a long answer must not destroy the
 *   answer; the count is what lets the caller notice a stream that is entirely
 *   garbage.
 *
 * The strictness: `pending` is exposed so the caller can bound it. A server (or
 * a proxy) that streams megabytes without ever emitting a blank line would
 * otherwise grow this buffer without limit, and "the parser is holding the
 * whole response in a string" is not a failure mode that announces itself.
 */

/** What one `push` produced. */
export interface SseParseResult {
  /** Parsed JSON payloads from every complete frame in order. */
  readonly values: readonly unknown[];
  /**
   * Complete frames whose payload would not parse as JSON.
   *
   * A count, not the text: the payload is a chat message and must not be
   * copied anywhere it could be logged.
   */
  readonly malformed: number;
}

const EMPTY: SseParseResult = { values: [], malformed: 0 };

export class AnonymousSseReader {
  #pending = '';
  #malformed = 0;

  /**
   * Feed decoded text. Returns whatever complete frames it produced.
   *
   * Text, not bytes: the caller owns the `TextDecoder` because a multi-byte
   * character can straddle two reads and only a streaming decoder
   * (`decode(value, {stream: true})`) reassembles it. A parser that took bytes
   * and decoded them per-chunk would corrupt any non-ASCII answer at a chunk
   * boundary — which, in an app that streams prose, means an em dash.
   */
  push(text: string): SseParseResult {
    if (text.length === 0) return EMPTY;
    this.#pending += text;

    const values: unknown[] = [];
    let malformed = 0;

    for (;;) {
      const boundary = findFrameBoundary(this.#pending);
      if (boundary === null) break;

      const frame = this.#pending.slice(0, boundary.index);
      this.#pending = this.#pending.slice(boundary.index + boundary.length);

      const payload = dataPayload(frame);
      if (payload === null) continue;

      try {
        values.push(JSON.parse(payload));
      } catch {
        /* One bad frame, dropped. The stream continues: an SSE frame is
           self-delimiting, so the next one is unaffected by this one's
           contents. */
        malformed += 1;
        this.#malformed += 1;
      }
    }

    return { values, malformed };
  }

  /** Characters held for an incomplete frame. The caller enforces the ceiling. */
  get pending(): number {
    return this.#pending.length;
  }

  /** Total malformed frames seen across every push. */
  get malformedTotal(): number {
    return this.#malformed;
  }
}

/**
 * Find the end of the first complete frame.
 *
 * Frames are separated by a blank line, which is `\n\n` from Node's encoder and
 * `\r\n\r\n` from anything that has passed through a normalising proxy. Both
 * are matched, and the *earliest* boundary wins so a `\r\n\r\n` is never split
 * into a `\n` plus a stray `\r`.
 */
function findFrameBoundary(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');

  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

/**
 * Extract the `data` payload of one frame, or `null` when it carries none.
 *
 * A frame with no `data:` line at all — a lone comment, a bare `event:` from
 * some other dialect — is not an error; it simply has nothing to hand up.
 */
function dataPayload(frame: string): string | null {
  const lines = frame.split('\n');
  const parts: string[] = [];

  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length === 0) continue;
    if (line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') continue;

    let value = colon === -1 ? '' : line.slice(colon + 1);
    /* Exactly one leading space is part of the framing, not the payload. */
    if (value.startsWith(' ')) value = value.slice(1);
    parts.push(value);
  }

  if (parts.length === 0) return null;
  const payload = parts.join('\n').trim();
  return payload.length === 0 ? null : payload;
}
