/**
 * Terminal output for the Terminal dock tab (DESIGN §5.16). The env server
 * streams `terminal.output` chunks (directly, or through the device link's
 * global stream); the web keeps a bounded tail per terminal and xterm.js
 * renders it. Pure, so the bookkeeping is unit-tested without a DOM.
 *
 * A buffer is `{ output, offset }`: `offset` counts the characters dropped
 * from the front, so `offset + output.length` is the stream position and a
 * view that wrote up to some position can write exactly what is new.
 */

/** Characters kept per terminal (xterm keeps its own scrollback). */
export const TERMINAL_TAIL_CHARS = 200_000;

export interface TerminalBuffer {
  output: string;
  /** Characters dropped from the front of the stream. */
  offset: number;
}

/** Appends a chunk, trimming the front past `limit`. */
export function appendTerminal(buf: TerminalBuffer, data: string, limit = TERMINAL_TAIL_CHARS): TerminalBuffer {
  const output = buf.output + data;
  if (output.length <= limit) return { output, offset: buf.offset };
  const drop = output.length - limit;
  return { output: output.slice(drop), offset: buf.offset + drop };
}

/**
 * What a view that has written up to `written` (a stream position) must do
 * next: write `data`, after clearing the screen when part of what it needs
 * was already dropped (or it is ahead of the stream: a different terminal).
 */
export function terminalDelta(buf: TerminalBuffer, written: number): { reset: boolean; data: string; position: number } {
  const end = buf.offset + buf.output.length;
  if (written < buf.offset || written > end) return { reset: true, data: buf.output, position: end };
  return { reset: false, data: buf.output.slice(written - buf.offset), position: end };
}

/**
 * Turns a shadcn-style token value ("222 47% 11%", or an already complete CSS
 * color) into a CSS color xterm's theme accepts. Empty in, fallback out.
 */
export function cssColorFromToken(value: string | null | undefined, fallback: string): string {
  const v = (value ?? "").trim();
  if (!v) return fallback;
  if (/^(#|rgb|hsl|oklch|oklab|lab|lch|color\()/i.test(v)) return v;
  if (/^-?[\d.]+(deg)?\s+[\d.]+%\s+[\d.]+%(\s*\/\s*[\d.]+%?)?$/.test(v)) return `hsl(${v})`;
  return fallback;
}

