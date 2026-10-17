/**
 * The pure half of "select a passage in an answer" (answer-selection-bar.tsx):
 * which selections count, what a passage becomes in the composer, and where
 * the floating bar sits. No DOM here beyond the shapes, so it is tested
 * directly.
 */

import { ANSWER_QUOTE_TITLE, clampQuoteText, type AnswerQuote } from "@/lib/quote-context";

/** The marker message-item puts on a settled answer's prose. */
export const ANSWER_TEXT_ATTR = "data-answer-text";

/** Shortest selection worth a bar: a single stray character is a misclick. */
export const MIN_PASSAGE_CHARS = 2;

/** Selected text as the reader meant it: no-break spaces flattened, ends trimmed. */
export function normalizePassage(raw: string): string {
  return raw.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function isPassage(text: string): boolean {
  return text.length >= MIN_PASSAGE_CHARS && /\S/.test(text);
}

export function answerQuoteFor(messageId: string, text: string): AnswerQuote {
  return { source: "answer", messageId, title: ANSWER_QUOTE_TITLE, kind: "text", text: clampQuoteText(text), mode: "ask" };
}

/**
 * "Quote": the passage as a Markdown blockquote for the draft, with the blank
 * line after it that the reader's own words go under. Blank lines inside the
 * passage stay inside the quote (`>` alone), so a two-paragraph selection is
 * one quotation, not a quotation and a stray paragraph.
 */
export function blockquoteFor(text: string): string {
  const body = clampQuoteText(text)
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  return `${body}\n\n`;
}

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Where the bar goes: centred on the selection, above it — or below it on a
 * touch screen, where the system's own copy/look-up callout already sits
 * above. It flips to the other side when there is no room, is clamped inside
 * the transcript's box, and is hidden (not moved) once the selection has
 * scrolled out of that box, so it never floats over the header or composer.
 */
export function placeSelectionBar(input: {
  selection: Box;
  bar: { width: number; height: number };
  bounds: Box;
  prefer: "above" | "below";
  margin?: number;
}): { top: number; left: number; visible: boolean; side: "above" | "below" } {
  const { selection, bar, bounds, prefer } = input;
  const margin = input.margin ?? 8;
  const visible = selection.bottom > bounds.top && selection.top < bounds.bottom;
  const centre = (selection.left + selection.right) / 2;
  const left = Math.min(Math.max(centre - bar.width / 2, bounds.left + margin), Math.max(bounds.left + margin, bounds.right - bar.width - margin));
  const above = selection.top - bar.height - margin;
  const below = selection.bottom + margin;
  const fitsAbove = above >= bounds.top + margin;
  const fitsBelow = below + bar.height <= bounds.bottom - margin;
  let side: "above" | "below" = prefer;
  if (prefer === "above" && !fitsAbove && fitsBelow) side = "below";
  if (prefer === "below" && !fitsBelow && fitsAbove) side = "above";
  let top = side === "above" ? above : below;
  // A selection taller than the box: keep the bar inside it rather than off screen.
  top = Math.min(Math.max(top, bounds.top + margin), Math.max(bounds.top + margin, bounds.bottom - bar.height - margin));
  return { top, left, visible, side };
}

/** Roving focus inside the toolbar: next index for a key, or null when the key is not ours. */
export function nextToolbarIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
