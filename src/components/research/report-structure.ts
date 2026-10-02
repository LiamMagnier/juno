/**
 * A finished report as a document with parts (SPEC §9.12, DECISIONS R5).
 *
 * The writer marks each section with an HTML comment before its heading —
 * `<!-- juno:section=bottom-line -->`, `findings`, `question:{id}`,
 * `conflicts`, `gaps`, `method` (§9.6.3) — so the reader can build its
 * contents, jump to a section and address a question's section without
 * reading the headings, which are in the report's language, not the UI's
 * (I-14). A report written before the markers (or by a writer that dropped
 * them) is split on its level-2 headings instead.
 *
 * Also here, because the report view and the citation card both need them and
 * neither needs a DOM:
 *
 * - `sentenceGroups`: the top-level blocks of a section (a paragraph, a list,
 *   a table, a quote), which is what a support mark follows;
 * - `groupSupport`: the mark for a group, from the audit's claim labels;
 * - `citationPassages`: the verbatim passages that support citation `[n]`;
 * - `passageUrl`: "Open at passage", a `#:~:text=` link to the quote's first
 *   eight words, cut with `Intl.Segmenter` so it works for CJK;
 * - `readingMinutes`.
 */

import type { CitationAudit, CitationAuditClaim } from "@/components/chat/citation-audit";
import { parseArtifacts } from "@/lib/message-content";
import type { ClientSource } from "@/types/chat";

/**
 * The document half of whatever `run.report` holds: the report itself, or —
 * on a run whose chat turn wrote it (the native path, and runs from before
 * the rework) — the Markdown artifact inside the turn, without the recap in
 * front of it. Never an error: a report that renders with its wrapper beats a
 * blank reader.
 */
export function reportBodyOf(report: string): string {
  const artifacts = parseArtifacts(report);
  const artifact = artifacts.find((a) => a.type === "MARKDOWN") ?? artifacts[0];
  return artifact?.content.trim() || report.trim();
}

/**
 * The list a report's `[n]` resolve into, in citation order: the audit's
 * numbering when there is an audit; else each source's `citedIndex` when the
 * run carries one (the writer's ordered cited list, §9.6.3); else the run's
 * own source order, which is how reports before the rework were numbered.
 * Each carries the strongest supporting passage as its snippet, so even a
 * plain source chip shows the quote rather than an empty line (bug 36).
 */
export function citationSources(
  sources: ReadonlyArray<{ url: string; title: string; citedIndex?: number | null }>,
  audit: Pick<CitationAudit, "claims" | "sources"> | null,
): ClientSource[] {
  const indexed = sources.filter((s) => typeof s.citedIndex === "number" && s.citedIndex > 0);
  const ordered = audit?.sources.length
    ? [...audit.sources].sort((a, b) => a.index - b.index).map((s) => ({ url: s.url, title: s.title }))
    : indexed.length
      ? [...indexed].sort((a, b) => (a.citedIndex as number) - (b.citedIndex as number)).map((s) => ({ url: s.url, title: s.title }))
      : sources.map((s) => ({ url: s.url, title: s.title }));
  return ordered.map((source, i) => ({
    title: source.title,
    url: source.url,
    snippet: citationPassages(audit, i + 1)[0]?.quote ?? "",
    cited: true,
  }));
}

export type ReportSectionKind = "bottom-line" | "findings" | "question" | "conflicts" | "gaps" | "method" | "other";

export interface ReportSection {
  /** Stable within the report: the marker (`question:q2`), else `section-{n}`. */
  id: string;
  kind: ReportSectionKind;
  /** The heading's text, in the report's language; empty for a preamble. */
  title: string;
  /** The section's Markdown, heading included. */
  body: string;
}

export interface ParsedReport {
  /** The report's `# ` title, or null. */
  title: string | null;
  /** Text before the first section (under the title), if any. */
  preamble: string;
  sections: ReportSection[];
  /** The report had section markers. */
  marked: boolean;
}

const MARKER_RE = /^\s*<!--\s*juno:section=([a-z-]+(?::[\w.-]+)?)\s*-->\s*$/i;
/** Any other `<!-- juno:… -->` line (summary, report title) is writer scaffolding. */
const SCAFFOLD_RE = /^\s*<!--\s*juno:[^>]*-->\s*$/i;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
/** A model-written sources list: the reader renders sources from rows instead (research-UI bug 7). */
const SOURCES_HEADING_RE = /^(sources|references|bibliography|works cited)$/i;

function kindOf(marker: string): ReportSectionKind {
  const head = marker.split(":")[0].toLowerCase();
  switch (head) {
    case "bottom-line":
    case "findings":
    case "question":
    case "conflicts":
    case "gaps":
    case "method":
      return head;
    default:
      return "other";
  }
}

function headingOf(line: string): { level: number; text: string } | null {
  const m = HEADING_RE.exec(line);
  return m ? { level: m[1].length, text: m[2].trim() } : null;
}

/** Splits the report into its title, preamble and sections. Fenced code never splits. */
export function parseReport(markdown: string): ParsedReport {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const marked = lines.some((line) => MARKER_RE.test(line));

  let title: string | null = null;
  const preamble: string[] = [];
  const sections: Array<{ id: string; kind: ReportSectionKind; title: string; lines: string[] }> = [];
  let current: (typeof sections)[number] | null = null;
  let pendingMarker: string | null = null;
  let inFence = false;

  for (const line of lines) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    if (!inFence) {
      const marker = MARKER_RE.exec(line);
      if (marker) {
        pendingMarker = marker[1];
        continue;
      }
      if (SCAFFOLD_RE.test(line)) continue;
      const heading = headingOf(line);
      if (heading && heading.level === 1 && title === null && !current && !pendingMarker) {
        title = heading.text;
        continue;
      }
      const opens = marked ? pendingMarker !== null && !!heading : heading?.level === 2;
      if (opens && heading) {
        const id = pendingMarker ?? `section-${sections.length + 1}`;
        current = { id, kind: pendingMarker ? kindOf(pendingMarker) : "other", title: heading.text, lines: [line] };
        sections.push(current);
        pendingMarker = null;
        continue;
      }
    }
    (current ? current.lines : preamble).push(line);
  }

  const out = sections
    .filter((s) => !(s.kind === "other" && SOURCES_HEADING_RE.test(s.title)))
    .map((s) => ({ id: s.id, kind: s.kind, title: s.title, body: s.lines.join("\n").trim() }));
  return { title, preamble: preamble.join("\n").trim(), sections: out, marked };
}

/** The contents: one entry per section, in order. */
export function reportToc(report: ParsedReport): Array<{ id: string; title: string }> {
  return report.sections.filter((s) => s.title).map((s) => ({ id: s.id, title: s.title }));
}

/** The citation numbers a report uses, e.g. `[3]` → 3. */
export function citedNumbers(markdown: string): Set<number> {
  const out = new Set<number>();
  for (const m of markdown.matchAll(/\[(\d{1,3})\]/g)) {
    const n = Number(m[1]);
    if (n >= 1) out.add(n);
  }
  return out;
}

// ── Sentence groups and support marks ─────────────────────────────────────────

const LIST_ITEM_RE = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/;
const CONTINUATION_RE = /^(?:\s{2,}|\t)/;

/**
 * The top-level blocks of a piece of Markdown, split at blank lines outside
 * fences. A list whose items are separated by blank lines stays one block
 * (splitting it would restart its numbering), as does an indented
 * continuation.
 */
export function sentenceGroups(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[][] = [];
  let block: string[] = [];
  let inFence = false;
  let blankSeen = false;

  const isList = (b: string[]) => b.some((l) => LIST_ITEM_RE.test(l));
  const flush = () => {
    if (block.length) blocks.push(block);
    block = [];
  };

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      if (!inFence && blankSeen) flush();
      blankSeen = false;
      inFence = !inFence;
      block.push(line);
      continue;
    }
    if (inFence) {
      block.push(line);
      continue;
    }
    if (line.trim() === "") {
      blankSeen = block.length > 0;
      continue;
    }
    if (blankSeen) {
      const continuesList = isList(block) && (LIST_ITEM_RE.test(line) || CONTINUATION_RE.test(line));
      if (continuesList) block.push("");
      else flush();
      blankSeen = false;
    }
    block.push(line);
  }
  flush();
  return blocks.map((b) => b.join("\n"));
}

/** Lowercased words only: markdown syntax, citation markers and punctuation removed. */
export function normaliseForMatch(text: string): string {
  return text
    .replace(/\[(\d{1,3})\]/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export type SupportMark = "supported" | "partial" | "notChecked" | "notSupported" | "contradicted";

function markOf(claim: Pick<CitationAuditClaim, "label">): SupportMark {
  switch (claim.label) {
    case "supported":
      return "supported";
    case "partially supported":
      return "partial";
    case "unsupported":
      return "notSupported";
    case "contradicted":
      return "contradicted";
    default:
      return "notChecked";
  }
}

/**
 * The claims whose sentence is in this group: the claim's text (markers and
 * syntax removed, as the audit extracted it) found in the group's text.
 */
export function claimsInGroup<T extends Pick<CitationAuditClaim, "text">>(group: string, claims: readonly T[]): T[] {
  const haystack = normaliseForMatch(group);
  if (!haystack) return [];
  return claims.filter((claim) => {
    const needle = normaliseForMatch(claim.text);
    return needle.length > 0 && haystack.includes(needle.length > 120 ? needle.slice(0, 120) : needle);
  });
}

/**
 * One mark for a group of cited sentences: the worst verdict a judge reached
 * ("Contradicted by the source", "Not supported") — those two only when a
 * judge actually looked, which is what `unsupported` and `contradicted`
 * labels mean after the judge cap (B4) — else "Supported" when every claim
 * is, "Not checked" when none was, and "Partly supported" for the rest.
 * Null when the group holds no audited claim.
 */
export function groupSupport(claims: ReadonlyArray<Pick<CitationAuditClaim, "label">>): SupportMark | null {
  if (claims.length === 0) return null;
  const marks = claims.map(markOf);
  if (marks.includes("contradicted")) return "contradicted";
  if (marks.includes("notSupported")) return "notSupported";
  if (marks.every((m) => m === "supported")) return "supported";
  if (marks.every((m) => m === "notChecked")) return "notChecked";
  return "partial";
}

// ── Citations ─────────────────────────────────────────────────────────────────

export interface CitationPassage {
  /** Verbatim from the source, as the validator read it. */
  quote: string;
  /** The report's sentence it supports. */
  claim: string;
}

/** The passages that support citation `[n]`, de-duplicated, strongest first. */
export function citationPassages(audit: Pick<CitationAudit, "claims"> | null, n: number): CitationPassage[] {
  if (!audit) return [];
  const found: Array<CitationPassage & { strength: number }> = [];
  const seen = new Set<string>();
  for (const claim of audit.claims) {
    for (const link of claim.links) {
      if (link.sourceIndex !== n || link.stance !== "supports") continue;
      const quote = link.passage.trim();
      if (!quote || seen.has(quote)) continue;
      seen.add(quote);
      found.push({ quote, claim: claim.text, strength: link.strength ?? 0 });
    }
  }
  return found.sort((a, b) => b.strength - a.strength).map(({ quote, claim }) => ({ quote, claim }));
}

const WORDS_IN_FRAGMENT = 8;

/** Percent-encoding for a text directive: `-`, `,` and `&` are syntax there. */
function encodeTextDirective(text: string): string {
  return encodeURIComponent(text).replace(/-/g, "%2D").replace(/,/g, "%2C").replace(/&/g, "%26");
}

/**
 * "Open at passage": the source URL with a `#:~:text=` fragment made of the
 * quote's first eight words. The cut is by word segments in the report's
 * language, so a CJK quote (no spaces) is cut into words too, and the
 * fragment is the quote's own text up to the eighth word (its spacing and
 * punctuation kept), which is what the browser matches against the page.
 */
export function passageUrl(url: string, quote: string, language?: string | null): string {
  const base = url.split("#")[0];
  const text = quote.replace(/\s+/g, " ").trim();
  if (!text) return base;
  let end = text.length;
  try {
    const segmenter = new Intl.Segmenter(language || undefined, { granularity: "word" });
    let words = 0;
    for (const segment of segmenter.segment(text)) {
      if (!segment.isWordLike) continue;
      words += 1;
      if (words === WORDS_IN_FRAGMENT) {
        end = segment.index + segment.segment.length;
        break;
      }
    }
  } catch {
    end = text.split(" ").slice(0, WORDS_IN_FRAGMENT).join(" ").length;
  }
  return `${base}#:~:text=${encodeTextDirective(text.slice(0, end))}`;
}

/** Minutes to read, at 220 words a minute, words counted by segment so CJK counts too. */
export function readingMinutes(markdown: string, language?: string | null): number {
  let words = 0;
  try {
    const segmenter = new Intl.Segmenter(language || undefined, { granularity: "word" });
    for (const segment of segmenter.segment(markdown)) if (segment.isWordLike) words += 1;
  } catch {
    words = markdown.split(/\s+/).filter(Boolean).length;
  }
  return Math.max(1, Math.ceil(words / 220));
}
