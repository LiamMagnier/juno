/**
 * Quoted-selection context for the canvas → composer flow.
 *
 * A ComposerQuote captures "what the user selected" in an artifact (a text
 * range or a DOM element) plus the intent (modify vs. ask). serializeQuote
 * turns it into a structured block the model can parse reliably.
 */

import type { ArtifactEditRequest } from "@/lib/artifact-edit";

export type ComposerQuoteMode = "modify" | "ask";
export type ComposerQuoteKind = "text" | "element";

export interface ComposerQuote {
  artifactId: string;
  identifier: string;
  title: string;
  /** Artifact version the user selected from; used for stale-edit protection. */
  baseVersion: number;
  kind: ComposerQuoteKind;
  /** Selected text, or the element's outerHTML snippet for kind "element". */
  text: string;
  lineStart?: number;
  lineEnd?: number;
  /** Stable CSS selector when kind === "element". */
  selector?: string;
  mode: ComposerQuoteMode;
}

export const QUOTE_TEXT_LIMIT = 2000;

export function artifactEditRequestFromQuote(quote: ComposerQuote): ArtifactEditRequest {
  return {
    artifactId: quote.artifactId,
    identifier: quote.identifier,
    baseVersion: quote.baseVersion,
    kind: quote.kind,
    text: quote.text,
    ...(quote.lineStart != null ? { lineStart: quote.lineStart } : {}),
    ...(quote.lineEnd != null ? { lineEnd: quote.lineEnd } : {}),
    ...(quote.selector ? { selector: quote.selector } : {}),
  };
}

/** Cap quoted text, trimming the middle so both ends stay visible. */
export function clampQuoteText(text: string, limit = QUOTE_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  const head = Math.ceil(limit * 0.6);
  const tail = limit - head;
  const trimmed = text.length - head - tail;
  return `${text.slice(0, head)}\n[… ${trimmed.toLocaleString()} characters trimmed …]\n${text.slice(text.length - tail)}`;
}

/**
 * Best-effort mapping of a selected string back to 1-based line numbers in the
 * artifact content. Returns null when the string can't be found or appears
 * more than once (ambiguous — better to omit line numbers than to lie).
 */
export function findLineRange(content: string, selected: string): { start: number; end: number } | null {
  const hay = content.replace(/\r\n/g, "\n");
  let needle = selected.replace(/\r\n/g, "\n");
  let idx = hay.indexOf(needle);
  if (idx === -1) {
    needle = needle.trim();
    if (!needle) return null;
    idx = hay.indexOf(needle);
  }
  if (idx === -1) return null;
  if (hay.indexOf(needle, idx + 1) !== -1) return null;
  const start = hay.slice(0, idx).split("\n").length;
  const end = start + needle.split("\n").length - 1;
  return { start, end };
}

/** Short human-readable location tag for the chip ("lines 4–12", "element .card"). */
export function quoteLocationLabel(quote: ComposerQuote): string | null {
  if (quote.kind === "element" && quote.selector) return `element ${quote.selector}`;
  if (quote.lineStart != null) {
    return quote.lineEnd != null && quote.lineEnd !== quote.lineStart
      ? `lines ${quote.lineStart}–${quote.lineEnd}`
      : `line ${quote.lineStart}`;
  }
  return null;
}

/**
 * Build the outgoing message text: a structured selection block, the user's
 * request, then a mode-specific instruction the model can act on precisely.
 */
export function serializeQuote(quote: ComposerQuote, userText: string): string {
  const where =
    quote.kind === "element" && quote.selector
      ? `, element ${quote.selector}`
      : quote.lineStart != null
        ? quote.lineEnd != null && quote.lineEnd !== quote.lineStart
          ? `, lines ${quote.lineStart}-${quote.lineEnd}`
          : `, line ${quote.lineStart}`
        : "";
  const instruction =
    quote.mode === "modify"
      ? `Apply a minimal, targeted change to ONLY this selected part in the existing artifact "${quote.identifier}" and keep everything else unchanged.`
      : "Answer about this selection — do not re-emit the artifact unless explicitly asked to change it.";
  const request = userText.trim();
  return [
    `[Selection from artifact "${quote.identifier}" (${quote.title}), version ${quote.baseVersion}${where}]:`,
    `"""`,
    quote.text,
    `"""`,
    ...(request ? ["", request] : []),
    "",
    instruction,
  ].join("\n");
}
