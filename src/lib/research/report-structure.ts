/**
 * The shape of a research report, read from its markers (SPEC §9.6.3, §9.13).
 *
 * The writer produces, in one call, a cited summary and a report whose
 * sections are each preceded by an HTML comment naming them:
 *
 *   <!-- juno:summary -->
 *   {120–250 words, cited}
 *   <!-- juno:report title="…" -->
 *   # {title}
 *   <!-- juno:section=bottom-line -->
 *   ## {Bottom line, in the report's language}
 *   …
 *
 * Everything here keys on those markers and never on heading text, because
 * the headings are written in the run's content language (D-1): "## Fazit" is
 * the bottom line of a German report, and a reader that looked for "Bottom
 * line" would find nothing (I-14). Pure and client-safe — the completion
 * writer, the export and the report view all read a report the same way.
 */

/** The fixed sections, in the order the writer is asked to write them. */
export const REPORT_SECTION_ORDER = ["bottom-line", "findings", "question", "conflicts", "gaps", "method"] as const;
export type ReportSectionKind = (typeof REPORT_SECTION_ORDER)[number];

export interface ReportSection {
  /** `bottom-line`, `findings`, `question:{id}`, `conflicts`, `gaps`, `method`, or null for an unmarked heading. */
  key: string | null;
  kind: ReportSectionKind | null;
  /** The question id, for a `question:{id}` section. */
  questionId: string | null;
  heading: string;
  level: number;
  /** Offsets into the report: from the marker (or heading) to the next section. */
  start: number;
  end: number;
}

const SUMMARY_MARKER = /<!--\s*juno:summary\s*-->/i;
const REPORT_MARKER = /<!--\s*juno:report(?:\s+title\s*=\s*"([^"]*)")?\s*-->/i;
const SECTION_MARKER = /<!--\s*juno:section\s*=\s*([a-z0-9:_-]+)\s*-->/gi;
const ANY_MARKER = /<!--\s*juno:[^>]*-->\s*\n?/gi;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;

/** Shorter than this, or with no `##` heading, a report is not a report (B6). */
export const MIN_REPORT_CHARS = 400;

export function isUsableReport(report: string): boolean {
  const text = report.trim();
  return text.length >= MIN_REPORT_CHARS && /^##[ \t]+\S/m.test(text);
}

function kindOf(key: string): { kind: ReportSectionKind | null; questionId: string | null } {
  const lower = key.toLowerCase();
  if (lower.startsWith("question:")) return { kind: "question", questionId: key.slice("question:".length) || null };
  return {
    kind: (REPORT_SECTION_ORDER as readonly string[]).includes(lower) && lower !== "question" ? (lower as ReportSectionKind) : null,
    questionId: null,
  };
}

/**
 * Every `##`-or-deeper section of a report, with the marker that preceded its
 * heading when there was one. A marker belongs to the first heading after it
 * with nothing but whitespace between them.
 */
export function reportSections(report: string): ReportSection[] {
  const headings: Array<{ index: number; level: number; heading: string }> = [];
  for (const match of report.matchAll(HEADING)) {
    headings.push({ index: match.index ?? 0, level: match[1].length, heading: match[2].trim() });
  }
  const markers: Array<{ index: number; end: number; key: string }> = [];
  for (const match of report.matchAll(SECTION_MARKER)) {
    markers.push({ index: match.index ?? 0, end: (match.index ?? 0) + match[0].length, key: match[1] });
  }
  const sections: ReportSection[] = [];
  // Sections are the `##` headings; a `###` inside one is part of it, and the
  // `#` title closes whatever came before it.
  const bounds = headings.filter((h) => h.level <= 2);
  const markerBefore = (index: number) =>
    [...markers].reverse().find((m) => m.end <= index && report.slice(m.end, index).trim() === "");
  for (let i = 0; i < bounds.length; i += 1) {
    const h = bounds[i];
    if (h.level !== 2) continue;
    const marker = markerBefore(h.index);
    const start = marker ? marker.index : h.index;
    const next = bounds[i + 1];
    const nextMarker = next ? markerBefore(next.index) : undefined;
    const end = next ? (nextMarker ? nextMarker.index : next.index) : report.length;
    const key = marker?.key ?? null;
    const { kind, questionId } = key ? kindOf(key) : { kind: null, questionId: null };
    sections.push({ key, kind, questionId, heading: h.heading, level: h.level, start, end });
  }
  return sections;
}

/** Headings a model writes over its own list of sources, in the languages Juno ships. */
const SOURCES_HEADING =
  /^(sources?|references?|bibliograph(y|ie|ía)|works cited|citations?|quellen(verzeichnis)?|literatur(verzeichnis)?|références|sources et références|fuentes|referencias|fonti|riferimenti|bronnen|referenties|źródła|fontes|referências|källor|kilder|lähteet|出典|参考文献|来源|參考資料|출처|参考资料)\b/i;

/**
 * True for a section that is a list of sources rather than prose: its heading
 * names one, or most of its lines are URLs or `[n]` entries. The second test
 * is what keeps this language-agnostic for a heading the list above misses.
 */
function isSourcesList(heading: string, body: string): boolean {
  if (SOURCES_HEADING.test(heading.replace(/^[\d.)\s]+/, ""))) return true;
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("<!--"));
  if (lines.length < 2) return false;
  const listy = lines.filter((line) => /https?:\/\/\S+/.test(line) || /^(?:[-*]\s*)?\[\d{1,3}\]/.test(line)).length;
  return listy / lines.length >= 0.6;
}

/**
 * The report without a sources section the model wrote itself (research-UI
 * bug 7). The reader renders sources from rows — cited, then read — so a
 * model's own list is at best a duplicate and at worst numbered differently.
 * Only an UNMARKED section is a candidate: nothing the writer was asked for is
 * ever stripped.
 */
export function stripModelSources(report: string): string {
  const sections = reportSections(report);
  let out = report;
  for (const section of [...sections].reverse()) {
    if (section.key) continue;
    const body = report.slice(section.start, section.end).replace(/^.*\n?/, "");
    if (!isSourcesList(section.heading, body)) continue;
    out = out.slice(0, section.start) + out.slice(section.end);
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** The report with every `<!-- juno:… -->` marker removed, for a reader outside Juno. */
export function withoutMarkers(text: string): string {
  return text.replace(ANY_MARKER, "").replace(/\n{3,}/g, "\n\n").trim();
}

export interface WriterOutput {
  /** 120–250 words, cited; empty when the writer skipped it. */
  summary: string;
  title: string;
  /** From `# {title}` on, markers kept, any model sources section stripped. */
  report: string;
}

/**
 * Splits the writer's one reply into the summary and the report.
 *
 * Tolerant in the direction that is safe: a reply with no markers is all
 * report, titled by its first `#` heading, and the completion writer then
 * builds the summary from its bottom line. The report never loses text to a
 * marker it did not write.
 */
export function parseWriterOutput(text: string): WriterOutput {
  const raw = text.replace(/\r\n?/g, "\n");
  const summaryAt = raw.search(SUMMARY_MARKER);
  const reportMatch = REPORT_MARKER.exec(raw);
  let summary = "";
  let body = raw;
  let title = reportMatch?.[1]?.trim() ?? "";
  if (reportMatch) {
    const reportAt = reportMatch.index;
    if (summaryAt >= 0 && summaryAt < reportAt) {
      summary = raw.slice(summaryAt, reportAt).replace(SUMMARY_MARKER, "").trim();
    }
    body = raw.slice(reportAt + reportMatch[0].length);
  } else if (summaryAt >= 0) {
    // A summary marker and no report marker: the summary runs to the first heading.
    const after = raw.slice(summaryAt).replace(SUMMARY_MARKER, "");
    const heading = after.search(/^#\s/m);
    summary = (heading >= 0 ? after.slice(0, heading) : "").trim();
    body = heading >= 0 ? after.slice(heading) : after;
  }
  body = body.trim();
  const h1 = /^#[ \t]+(.+?)[ \t]*$/m.exec(body);
  if (!title && h1) title = h1[1].trim();
  return { summary, title: title.replace(/\s+/g, " ").slice(0, 200), report: stripModelSources(body) };
}

/** The bottom line's prose, for a summary the writer did not write. */
export function bottomLineOf(report: string): string {
  const section = reportSections(report).find((s) => s.kind === "bottom-line") ?? reportSections(report)[0];
  if (!section) return "";
  return withoutMarkers(report.slice(section.start, section.end))
    .replace(/^#{1,6}[ \t].*$/m, "")
    .trim();
}

/** `[n]` markers outside fenced code, in order of first appearance across the texts. */
export function citationOrder(texts: readonly string[]): number[] {
  const order: number[] = [];
  const seen = new Set<number>();
  for (const text of texts) {
    const prose = text.replace(/```[\s\S]*?```/g, (block) => " ".repeat(block.length));
    for (const match of prose.matchAll(/\[(\d{1,3})\]/g)) {
      const n = Number(match[1]);
      if (seen.has(n)) continue;
      seen.add(n);
      order.push(n);
    }
  }
  return order;
}

/**
 * Renumbers `[n]` outside fenced code by `mapping` (old → new). A marker the
 * mapping does not know is left as it was, so a dangling citation stays
 * visibly dangling rather than silently pointing somewhere else.
 */
export function renumberCitations(text: string, mapping: ReadonlyMap<number, number>): string {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, i) =>
      i % 2 === 1 ? part : part.replace(/\[(\d{1,3})\]/g, (whole, n: string) => {
        const next = mapping.get(Number(n));
        return next === undefined ? whole : `[${next}]`;
      })
    )
    .join("");
}
