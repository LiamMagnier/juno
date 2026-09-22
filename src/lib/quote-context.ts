/**
 * Quoted-selection context for the "select → ask" flow.
 *
 * A ComposerQuote captures "what the user selected" plus the intent, and
 * serializeQuote turns it into a structured block the model can parse
 * reliably. Two surfaces produce one:
 *
 *   - the canvas: a text range or a DOM element of an ARTIFACT, to ask about
 *     or to modify in place;
 *   - the document viewer: a passage of an attached FILE, or an area of one of
 *     its pages drawn around a figure. Files are read, never edited, so a
 *     document quote is always "ask".
 *
 * The serialized block is also what the transcript shows back, so
 * `parseQuotedMessage` reads it into a quote card instead of leaving the
 * reader to squint at triple quotes and an instruction written for the model.
 */

import type { ArtifactEditRequest } from "@/lib/artifact-edit";

export type ComposerQuoteMode = "modify" | "ask";
export type ComposerQuoteKind = "text" | "element";

export interface ArtifactQuote {
  /** Absent on quotes built before documents could be quoted — still an artifact. */
  source?: "artifact";
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

/**
 * Where in a file a selection sits, in the file's own terms: a PDF has pages,
 * a deck has slides, a workbook has sheets, a text file has lines. Only the
 * fields the format actually has are set.
 */
export interface DocumentQuoteLocation {
  page?: number;
  pageEnd?: number;
  slide?: number;
  slideEnd?: number;
  sheet?: string;
  lineStart?: number;
  lineEnd?: number;
}

/** A rectangle in percent of the page (0–100), measured from the top-left. */
export interface QuoteRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocumentQuote {
  source: "document";
  attachmentId: string;
  /** The file name — shown on the chip and named to the model. */
  title: string;
  /**
   * `text` is a passage the reader selected. `area` is a rectangle drawn over
   * a page — a chart, a diagram, a table that has no text layer — which rides
   * with the message as a cropped image; `text` then holds whatever words the
   * page's text layer had inside the rectangle (often empty).
   */
  kind: "text" | "area";
  text: string;
  location?: DocumentQuoteLocation;
  region?: QuoteRegion;
  mode: "ask";
}

export type ComposerQuote = ArtifactQuote | DocumentQuote;

export function isDocumentQuote(quote: ComposerQuote): quote is DocumentQuote {
  return quote.source === "document";
}

export const QUOTE_TEXT_LIMIT = 2000;

export function artifactEditRequestFromQuote(quote: ArtifactQuote): ArtifactEditRequest {
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

function span(noun: string, start: number, end: number | undefined, dash: string): string {
  return end != null && end !== start ? `${noun}s ${start}${dash}${end}` : `${noun} ${start}`;
}

/**
 * "page 4", "pages 4–5", "slide 2", "sheet Revenue", "lines 3–9".
 *
 * `dash` is the en dash on screen and a hyphen in the serialized block, which
 * is written for a model and parsed back by `parseQuotedMessage` — one spelling
 * there keeps the round trip exact.
 */
export function documentLocationLabel(location: DocumentQuoteLocation | undefined, dash = "–"): string | null {
  if (!location) return null;
  if (location.page != null) return span("page", location.page, location.pageEnd, dash);
  if (location.slide != null) return span("slide", location.slide, location.slideEnd, dash);
  if (location.sheet) return `sheet ${location.sheet}`;
  if (location.lineStart != null) return span("line", location.lineStart, location.lineEnd, dash);
  return null;
}

/** Short human-readable location tag for the chip ("lines 4–12", "element .card", "page 4 · area"). */
export function quoteLocationLabel(quote: ComposerQuote): string | null {
  if (isDocumentQuote(quote)) {
    const where = documentLocationLabel(quote.location);
    if (quote.kind === "area") return where ? `${where} · area` : "area";
    return where;
  }
  if (quote.kind === "element" && quote.selector) return `element ${quote.selector}`;
  if (quote.lineStart != null) {
    return quote.lineEnd != null && quote.lineEnd !== quote.lineStart
      ? `lines ${quote.lineStart}–${quote.lineEnd}`
      : `line ${quote.lineStart}`;
  }
  return null;
}

/* The closing instruction of each block. Constants because the transcript
 * strips them back out for display — a sentence addressed to the model is not
 * something the person typed, and showing it in their bubble reads as though
 * they had. */
export const QUOTE_INSTRUCTIONS = {
  artifactAsk: "Answer about this selection — do not re-emit the artifact unless explicitly asked to change it.",
  documentText:
    "Answer about this passage specifically. It is quoted verbatim from the attached document; use the rest of the document for context where it helps, and say which page or section you draw on.",
  documentArea:
    "Answer about this area specifically. Look closely at the attached image of it — it is the part of the file the person drew a box around — and use the rest of the file for context where it helps.",
  documentAreaBare:
    "Explain what this area shows. Look closely at the attached image of it — it is the part of the file the person drew a box around — and use the rest of the file for context where it helps.",
} as const;

function artifactModifyInstruction(identifier: string): string {
  return `Apply a minimal, targeted change to ONLY this selected part in the existing artifact "${identifier}" and keep everything else unchanged.`;
}

const AREA_IMAGE_LINE = "The attached image is this area, cropped from the original.";
const AREA_TEXT_LINE = "Text inside the area:";

function pct(n: number): string {
  return String(Math.round(Math.min(Math.max(n, 0), 100)));
}

/** "x 12-58%, y 30-64%" — the region as the model reads it. */
export function regionLabel(region: QuoteRegion): string {
  return `x ${pct(region.x)}-${pct(region.x + region.width)}%, y ${pct(region.y)}-${pct(region.y + region.height)}%`;
}

function serializeDocumentQuote(quote: DocumentQuote, request: string): string {
  const where = documentLocationLabel(quote.location, "-");
  if (quote.kind === "area") {
    const parts = [where, quote.region ? `region ${regionLabel(quote.region)}` : null].filter(Boolean);
    const text = quote.text.trim();
    return [
      `[Area from document "${quote.title}"${parts.length ? `, ${parts.join(", ")}` : ""}]:`,
      AREA_IMAGE_LINE,
      ...(text ? [AREA_TEXT_LINE, `"""`, text, `"""`] : []),
      ...(request ? ["", request] : []),
      "",
      request ? QUOTE_INSTRUCTIONS.documentArea : QUOTE_INSTRUCTIONS.documentAreaBare,
    ].join("\n");
  }
  return [
    `[Selection from document "${quote.title}"${where ? `, ${where}` : ""}]:`,
    `"""`,
    quote.text,
    `"""`,
    ...(request ? ["", request] : []),
    "",
    QUOTE_INSTRUCTIONS.documentText,
  ].join("\n");
}

/**
 * Build the outgoing message text: a structured selection block, the user's
 * request, then a mode-specific instruction the model can act on precisely.
 */
export function serializeQuote(quote: ComposerQuote, userText: string): string {
  const request = userText.trim();
  if (isDocumentQuote(quote)) return serializeDocumentQuote(quote, request);
  const where =
    quote.kind === "element" && quote.selector
      ? `, element ${quote.selector}`
      : quote.lineStart != null
        ? quote.lineEnd != null && quote.lineEnd !== quote.lineStart
          ? `, lines ${quote.lineStart}-${quote.lineEnd}`
          : `, line ${quote.lineStart}`
        : "";
  const instruction = quote.mode === "modify" ? artifactModifyInstruction(quote.identifier) : QUOTE_INSTRUCTIONS.artifactAsk;
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

/* ─── Reading a sent quote back, for the transcript ──────────────────────── */

export interface ParsedQuotedMessage {
  source: "artifact" | "document";
  kind: "text" | "element" | "area";
  mode: ComposerQuoteMode;
  /** The artifact's title or the file's name. */
  title: string;
  /** "page 4", "lines 3–9", "element .card" — on-screen spelling. */
  location: string | null;
  /** The quoted words; empty for an area whose page had no text layer. */
  text: string;
  /** What the person actually typed. */
  request: string;
}

const ARTIFACT_HEADER = /^\[Selection from artifact "([^"\n]*)" \((.*)\), version (\d+)(?:, (.+))?\]:$/;
const DOCUMENT_HEADER = /^\[(Selection|Area) from document "(.*)"(?:, (.+))?\]:$/;

/** Hyphenated ranges back to the en dash the chip uses. */
function screenSpelling(location: string): string {
  return location.replace(/(\d)-(\d)/g, "$1–$2");
}

/** Lines `from..` up to (not including) the closing `"""`, or null when unclosed. */
function readFence(lines: string[], from: number): { text: string; next: number } | null {
  if (lines[from] !== `"""`) return null;
  for (let i = from + 1; i < lines.length; i++) {
    if (lines[i] === `"""`) return { text: lines.slice(from + 1, i).join("\n"), next: i + 1 };
  }
  return null;
}

/**
 * The person's words, with the closing instruction taken off.
 *
 * Only a KNOWN instruction is removed, and only from the very end: anything
 * else is the person's text and is shown as written. A body that does not end
 * in one is not a block this module wrote, and the caller gets `null`.
 */
function splitRequest(rest: string, instructions: readonly string[]): string | null {
  const body = rest.trim();
  for (const instruction of instructions) {
    if (body === instruction) return "";
    if (body.endsWith(`\n\n${instruction}`)) return body.slice(0, -instruction.length).trim();
  }
  return null;
}

export function parseQuotedMessage(content: string): ParsedQuotedMessage | null {
  if (!content.startsWith("[")) return null;
  const lines = content.split("\n");
  const header = lines[0];

  const artifact = ARTIFACT_HEADER.exec(header);
  if (artifact) {
    const fence = readFence(lines, 1);
    if (!fence) return null;
    const [, identifier, title, , where] = artifact;
    const rest = lines.slice(fence.next).join("\n");
    const modify = artifactModifyInstruction(identifier);
    const request = splitRequest(rest, [QUOTE_INSTRUCTIONS.artifactAsk, modify]);
    if (request === null) return null;
    const isModify = rest.trim().endsWith(modify);
    return {
      source: "artifact",
      kind: where?.startsWith("element ") ? "element" : "text",
      mode: isModify ? "modify" : "ask",
      title,
      location: where ? screenSpelling(where) : null,
      text: fence.text,
      request,
    };
  }

  const document = DOCUMENT_HEADER.exec(header);
  if (!document) return null;
  const [, verb, title, where] = document;
  const isArea = verb === "Area";
  // The region is for the model; the card says "area" and the image shows it.
  const location = where ? screenSpelling(where.replace(/,?\s*region x [^\]]*$/, "").trim()) || null : null;

  let cursor = 1;
  let text = "";
  if (isArea) {
    if (lines[cursor] !== AREA_IMAGE_LINE) return null;
    cursor += 1;
    if (lines[cursor] === AREA_TEXT_LINE) {
      const fence = readFence(lines, cursor + 1);
      if (!fence) return null;
      text = fence.text;
      cursor = fence.next;
    }
  } else {
    const fence = readFence(lines, cursor);
    if (!fence) return null;
    text = fence.text;
    cursor = fence.next;
  }
  const request = splitRequest(
    lines.slice(cursor).join("\n"),
    isArea ? [QUOTE_INSTRUCTIONS.documentArea, QUOTE_INSTRUCTIONS.documentAreaBare] : [QUOTE_INSTRUCTIONS.documentText],
  );
  if (request === null) return null;
  return {
    source: "document",
    kind: isArea ? "area" : "text",
    mode: "ask",
    title,
    location,
    text,
    request,
  };
}
