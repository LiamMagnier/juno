/**
 * Research report export (SPEC §9.13). WS8 draws the buttons; this is what
 * they download.
 *
 * Markdown: the report as the reader sees it — the model's own sources list
 * stripped, `[n]` kept, the `<!-- juno:… -->` markers removed — with front
 * matter (title, date, lead model) and a sources appendix built from the rows:
 * the cited sources numbered as the report cites them, then what was read and
 * not cited. PDF goes through the print pipeline in the browser, and needs
 * nothing from here but the title (the print title rides the title override,
 * §9.8).
 *
 * Pure and client-safe: no dates are read from the clock and no locale is
 * assumed; the caller passes both.
 */

import { stripModelSources, withoutMarkers } from "@/lib/research/report-structure";

export interface ExportSource {
  title: string;
  url: string;
}

export interface ReportExportInput {
  title: string;
  report: string;
  /** Cited sources, in citation order: the first is `[1]`. */
  cited: readonly ExportSource[];
  /** Sources read and not cited. */
  alsoRead?: readonly ExportSource[];
  /** When the report was written, for the front matter and the file name. */
  writtenAt: Date;
  /** When the sources were read, for "accessed {date}". Defaults to `writtenAt`. */
  accessedAt?: Date;
  /** The lead model's display name. */
  leadModel?: string | null;
}

/** Headings of the appendix. English: the export is a file, like the report's own markers. */
export const REPORT_EXPORT_HEADINGS = { sources: "Sources", alsoRead: "Also read", accessed: "accessed" } as const;

const SLUG_MAX = 80;

function isoDay(date: Date): string {
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "1970-01-01";
}

/**
 * The file name's stem: NFKD, diacritics stripped, lowercase, everything that
 * is not a letter or digit collapsed to `-`, trimmed to 80 characters on a
 * word boundary. A title with nothing left (a title in a script the slug
 * cannot keep, or no title) falls back to `research-{yyyy-mm-dd}`.
 */
export function exportFileSlug(title: string, date: Date): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return `research-${isoDay(date)}`;
  if (slug.length <= SLUG_MAX) return slug;
  const cut = slug.slice(0, SLUG_MAX);
  const boundary = cut.lastIndexOf("-");
  return (boundary > SLUG_MAX / 2 ? cut.slice(0, boundary) : cut).replace(/-+$/g, "");
}

export function exportFileName(title: string, date: Date): string {
  return `${exportFileSlug(title, date)}.md`;
}

/** A value safe inside double-quoted YAML. */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ").trim()}"`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The Markdown file, front matter to appendix. */
export function reportMarkdownExport(input: ReportExportInput): string {
  const accessed = isoDay(input.accessedAt ?? input.writtenAt);
  const body = withoutMarkers(stripModelSources(input.report));
  const front = [
    "---",
    `title: ${yamlString(input.title || "Research report")}`,
    `date: ${isoDay(input.writtenAt)}`,
    ...(input.leadModel ? [`lead_model: ${yamlString(input.leadModel)}`] : []),
    "---",
  ].join("\n");
  const cited = input.cited.map(
    (source, i) => `[${i + 1}] ${oneLine(source.title) || source.url} — ${source.url} (${REPORT_EXPORT_HEADINGS.accessed} ${accessed})`
  );
  const alsoRead = (input.alsoRead ?? []).map((source) => `- ${oneLine(source.title) || source.url} — ${source.url}`);
  const appendix = [
    ...(cited.length ? [`## ${REPORT_EXPORT_HEADINGS.sources}`, "", cited.join("\n\n")] : []),
    ...(alsoRead.length ? ["", `### ${REPORT_EXPORT_HEADINGS.alsoRead}`, "", alsoRead.join("\n")] : []),
  ].join("\n");
  return `${front}\n\n${body}\n${appendix ? `\n${appendix.trim()}\n` : ""}`;
}
