/**
 * A PDF page's positioned text back into reading order, with its tables.
 *
 * pdf.js hands over text items in content-stream order, each with its
 * position. The reader used to join them in that order, which is right for a
 * simple report and wrong for the two documents research reads most: a
 * two-column paper whose producer wrote the stream line by line across the
 * gutter (the text came out as alternating half-sentences), and a pricing or
 * results table (cells joined with single spaces, so "Business $24 per month
 * 50 1 TB" no longer said which figure was the seats and which the storage).
 *
 * This lays the items out by position instead, deterministically:
 * 1. items become lines by baseline, and each line becomes segments split at
 *    gaps wider than a word space;
 * 2. a page whose body lines split into two long segments at a common x is a
 *    two-column page, read left column then right;
 * 3. three or more consecutive lines whose segments start at shared column
 *    anchors are a table, written as a Markdown table (first row as header);
 * 4. a vertical gap wider than the leading becomes a paragraph break, which
 *    is what the citation audit's passage splitter keys on.
 * Items that are rotated or right-to-left leave the page to the old join.
 * Pure; no pdf.js types leak in.
 */

export interface PositionedItem {
  str: string;
  /** Left edge, in PDF units. */
  x: number;
  /** Baseline, in PDF units (larger is higher on the page). */
  y: number;
  width: number;
  /** Font height; 0 when unknown. */
  height: number;
  hasEOL?: boolean;
  /** False when the item is rotated or skewed. */
  upright?: boolean;
  rtl?: boolean;
}

interface Segment {
  x: number;
  right: number;
  text: string;
}

interface Line {
  y: number;
  height: number;
  segments: Segment[];
}

const MAX_TABLE_COLUMNS = 12;
/** Past this many text items on one page, layout analysis is skipped (bounded work on a hostile file). */
const MAX_LAYOUT_ITEMS = 20_000;
/** Distinct x positions one run may propose before it is plainly not a table. */
const MAX_ANCHOR_CANDIDATES = 64;
/** A line's segments this long on average are prose, not cells. */
const PROSE_SEGMENT_CHARS = 28;

function cell(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

/** The old join: content-stream order, a newline where the item ends a line. */
export function streamOrderText(items: readonly PositionedItem[]): string {
  return items.map((item) => item.str + (item.hasEOL ? "\n" : "")).join("");
}

function toLines(items: readonly PositionedItem[]): Line[] {
  const sorted = items
    .filter((item) => item.str.trim())
    .map((item) => ({ ...item, height: item.height > 0 ? item.height : 10 }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Array<{ y: number; height: number; items: PositionedItem[] }> = [];
  for (const item of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - item.y) <= Math.max(last.height, item.height) * 0.45) last.items.push(item);
    else lines.push({ y: item.y, height: item.height, items: [item] });
  }
  return lines.map((line) => {
    const items = [...line.items].sort((a, b) => a.x - b.x);
    const segments: Segment[] = [];
    for (const item of items) {
      const current = segments[segments.length - 1];
      const gap = current ? item.x - current.right : Infinity;
      if (current && gap <= line.height * 1.1) {
        current.text += gap > line.height * 0.12 && !current.text.endsWith(" ") && !item.str.startsWith(" ") ? ` ${item.str}` : item.str;
        current.right = Math.max(current.right, item.x + item.width);
      } else segments.push({ x: item.x, right: item.x + item.width, text: item.str });
    }
    for (const segment of segments) segment.text = segment.text.replace(/\s+/g, " ").trim();
    return { y: line.y, height: line.height, segments: segments.filter((segment) => segment.text) };
  });
}

/** The gutter's x when this page is set in two columns of prose, else null. */
function gutterOf(lines: readonly Line[]): number | null {
  const body = lines.filter((line) => line.segments.reduce((n, s) => n + s.text.length, 0) >= 30);
  if (body.length < 4) return null;
  const split = body.filter(
    (line) => line.segments.length === 2 && line.segments.every((s) => s.text.length >= 12) &&
      (line.segments[0]!.text.length + line.segments[1]!.text.length) / 2 >= PROSE_SEGMENT_CHARS
  );
  if (split.length < Math.max(3, body.length * 0.6)) return null;
  const starts = split.map((line) => line.segments[1]!.x).sort((a, b) => a - b);
  const median = starts[Math.floor(starts.length / 2)]!;
  const tolerance = Math.max(...split.map((line) => line.height)) * 1.5;
  const aligned = split.filter((line) => Math.abs(line.segments[1]!.x - median) <= tolerance);
  if (aligned.length < split.length * 0.8) return null;
  // Every left segment must end before the right column starts.
  if (aligned.some((line) => line.segments[0]!.right > median)) return null;
  return median - tolerance / 2;
}

/** Column anchors shared by a run of lines, or null when they do not line up. */
function anchorsOf(run: readonly Line[]): number[] | null {
  const tolerance = Math.max(...run.map((line) => line.height)) * 0.9;
  const anchors: Array<{ x: number; hits: number }> = [];
  for (const line of run) {
    for (const segment of line.segments) {
      const near = anchors.find((anchor) => Math.abs(anchor.x - segment.x) <= tolerance);
      if (near) {
        near.x = (near.x * near.hits + segment.x) / (near.hits + 1);
        near.hits += 1;
      } else {
        anchors.push({ x: segment.x, hits: 1 });
        if (anchors.length > MAX_ANCHOR_CANDIDATES) return null;
      }
    }
  }
  const kept = anchors.filter((anchor) => anchor.hits >= Math.max(2, Math.ceil(run.length * 0.5))).sort((a, b) => a.x - b.x);
  if (kept.length < 2 || kept.length > MAX_TABLE_COLUMNS) return null;
  // Most segments must sit on an anchor.
  const total = run.reduce((n, line) => n + line.segments.length, 0);
  const onAnchor = run.reduce(
    (n, line) => n + line.segments.filter((segment) => kept.some((anchor) => Math.abs(anchor.x - segment.x) <= tolerance)).length,
    0
  );
  if (onAnchor < total * 0.85) return null;
  return kept.map((anchor) => anchor.x);
}

function tableMarkdown(run: readonly Line[], anchors: readonly number[]): string {
  const tolerance = Math.max(...run.map((line) => line.height)) * 0.9;
  const rows = run.map((line) => {
    const cells = anchors.map(() => [] as string[]);
    for (const segment of line.segments) {
      // The rightmost anchor at or left of the segment's start.
      let column = 0;
      for (let c = 0; c < anchors.length; c += 1) if (segment.x >= anchors[c]! - tolerance) column = c;
      cells[column]!.push(segment.text);
    }
    return cells.map((parts) => cell(parts.join(" ")));
  });
  const line = (row: readonly string[]) => `| ${row.map((value) => value || " ").join(" | ")} |`;
  return [line(rows[0]!), `|${" --- |".repeat(anchors.length)}`, ...rows.slice(1).map(line)].join("\n");
}

function isTableCandidate(line: Line): boolean {
  if (line.segments.length < 2) return false;
  const average = line.segments.reduce((n, s) => n + s.text.length, 0) / line.segments.length;
  return average < PROSE_SEGMENT_CHARS || line.segments.length >= 3;
}

/** Lines in reading order to text: tables as Markdown, paragraph gaps as blank lines. */
function linesToText(lines: readonly Line[]): string {
  const out: string[] = [];
  let previous: Line | null = null;
  for (let i = 0; i < lines.length; ) {
    // A table: three or more consecutive candidate lines that share anchors.
    if (isTableCandidate(lines[i]!)) {
      let j = i;
      while (j < lines.length && isTableCandidate(lines[j]!)) j += 1;
      const run = lines.slice(i, j);
      const anchors = run.length >= 3 ? anchorsOf(run) : null;
      if (anchors) {
        out.push("", tableMarkdown(run, anchors), "");
        previous = lines[j - 1]!;
        i = j;
        continue;
      }
    }
    const line = lines[i]!;
    if (previous && previous.y - line.y > Math.max(previous.height, line.height) * 1.75) out.push("");
    out.push(line.segments.map((segment) => segment.text).join(" "));
    previous = line;
    i += 1;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * One page's text in reading order. Falls back to the content-stream join
 * when the items carry no usable positions, or any of them is rotated or
 * right-to-left (layout by baseline would scramble those).
 */
export function layoutPageText(items: readonly PositionedItem[]): string {
  const visible = items.filter((item) => item.str.trim());
  if (visible.length === 0) return "";
  if (visible.length > MAX_LAYOUT_ITEMS || visible.some((item) => item.upright === false || item.rtl || !Number.isFinite(item.x) || !Number.isFinite(item.y))) {
    return streamOrderText(items);
  }
  const lines = toLines(visible);
  const gutter = gutterOf(lines);
  if (gutter === null) return linesToText(lines);

  // Two columns: full-width lines above the first split line stay on top,
  // then the left column top to bottom, then the right, then the rest.
  const firstSplit = lines.findIndex((line) => line.segments.some((s) => s.x >= gutter) && line.segments.some((s) => s.right <= gutter));
  const head = lines.slice(0, Math.max(0, firstSplit));
  const body = lines.slice(Math.max(0, firstSplit));
  const left: Line[] = [];
  const right: Line[] = [];
  const tail: Line[] = [];
  for (const line of body) {
    const l = line.segments.filter((s) => s.x < gutter);
    const r = line.segments.filter((s) => s.x >= gutter);
    const spans = l.some((s) => s.right > gutter + line.height * 2);
    if (spans && r.length === 0 && (left.length || right.length)) {
      tail.push(line);
      continue;
    }
    if (l.length) left.push({ ...line, segments: l });
    if (r.length) right.push({ ...line, segments: r });
  }
  return [linesToText(head), linesToText(left), linesToText(right), linesToText(tail)].filter(Boolean).join("\n\n");
}
