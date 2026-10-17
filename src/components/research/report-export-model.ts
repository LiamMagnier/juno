/*
 * What the research reader hands the research library's exporter
 * (src/lib/research/export.ts), from what the reader already holds: the run,
 * its report model and the title it heads the report with. Pure, so the
 * export's shape is tested without a DOM (tests/research-export.test.ts).
 */

import type { ReportModel } from "@/components/research/report-document";
import type { ResearchRunView } from "@/components/research/use-research-run";
import { exportFileName, reportMarkdownExport, type ReportExportInput as LibraryExportInput } from "@/lib/research/export";

export interface ReportExportInput {
  run: Pick<ResearchRunView, "id" | "report" | "finishedAt" | "createdAt" | "leadModel" | "conversationId" | "reportArtifactId">;
  model: Pick<ReportModel, "report" | "sections">;
  /** The report's title, as the reader heads it. */
  title: string;
}

/** The identifier completion gives the report's artifact (src/lib/research/completion-core.ts). */
export function reportArtifactIdentifier(runId: string): string {
  return `research-report-${runId}`;
}

/** The research library's export input, from what the reader has. */
export function researchExportInput(input: ReportExportInput, opts: { frontMatter?: boolean } = {}): LibraryExportInput {
  const { run, model, title } = input;
  return {
    title,
    report: model.report ?? run.report ?? "",
    // The appendix numbers what the report cites, by the numbers it cites.
    cited: model.sections.cited.map((row) => ({ title: row.title, url: row.url, number: row.cited })),
    alsoRead: model.sections.read.map((row) => ({ title: row.title, url: row.url })),
    writtenAt: new Date(run.finishedAt ?? run.createdAt ?? Date.now()),
    leadModel: run.leadModel?.label ?? null,
    frontMatter: opts.frontMatter,
  };
}

/** The downloaded Markdown file: name and body. */
export function researchMarkdownFile(input: ReportExportInput): { fileName: string; markdown: string } {
  const lib = researchExportInput(input);
  return { fileName: exportFileName(lib.title, lib.writtenAt), markdown: reportMarkdownExport(lib) };
}

/** What Copy and Word carry: the same Markdown, without the front matter. */
export function researchPlainMarkdown(input: ReportExportInput): string {
  return reportMarkdownExport(researchExportInput(input, { frontMatter: false }));
}

/** The Word file's fallback name, when the answer carries none. */
export function researchWordFileName(input: ReportExportInput): string {
  const lib = researchExportInput(input);
  return exportFileName(lib.title, lib.writtenAt).replace(/\.md$/, ".docx");
}
