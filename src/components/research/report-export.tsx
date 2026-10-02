"use client";

import * as React from "react";
import { toast } from "sonner";
import { RESEARCH_COPY } from "@/components/research/copy";
import type { ResearchRunView } from "@/components/research/use-research-run";
import { Button } from "@/components/ui/button";
import { Download, Printer } from "@/components/ui/icons";
import { formatPhrase, Phrase, usePhrase } from "@/lib/i18n-phrase";
import { setTitleOverride } from "@/lib/title-override";

/*
 * The report's export buttons (SPEC §9.13, DECISIONS R5): Markdown, and PDF
 * through the print pipeline. "Share" (which copied the chat URL, bug 8) is
 * gone.
 *
 * The Markdown itself — the model's sources section stripped, `[n]` kept, the
 * numbered appendix and front matter, the file named after the report — is
 * the research library's export (`src/lib/research/export.ts`), handed in
 * through `ResearchExportContext`, so this file never forks the format. Until
 * that exporter is provided the report downloads as written under the dated
 * fallback name the export uses.
 *
 * PDF prints the full-screen reader, whose article is the
 * `data-print-document`; while the print dialog is up the tab title (which
 * browsers use as the file name) is the report's title, through the title
 * override, since `document.title` would be reverted by `DocumentTitle`.
 */

export interface ReportExportInput {
  run: ResearchRunView;
  /** The report Markdown, as the reader shows it. */
  report: string;
  /** What the report's `[n]` resolve to, in order. */
  citationOrder: ReadonlyArray<{ url: string; title: string }>;
}

export type ReportMarkdownExporter = (input: ReportExportInput) => { fileName: string; markdown: string };

/** The report as written, under the dated fallback name (`research-{yyyy-mm-dd}.md`). */
export const fallbackMarkdownExport: ReportMarkdownExporter = ({ run, report }) => {
  const date = (run.finishedAt ?? run.createdAt ?? new Date().toISOString()).slice(0, 10);
  return { fileName: `research-${date}.md`, markdown: report.endsWith("\n") ? report : `${report}\n` };
};

export const ResearchExportContext = React.createContext<ReportMarkdownExporter>(fallbackMarkdownExport);

const PRINT_TITLE_KEY = "print";

/** Prints the page with the report's title as the tab title (the PDF's default file name). */
export function printReport(title: string): void {
  if (typeof window === "undefined") return;
  const clear = () => {
    setTitleOverride(PRINT_TITLE_KEY, null);
    window.removeEventListener("afterprint", clear);
  };
  setTitleOverride(PRINT_TITLE_KEY, title);
  window.addEventListener("afterprint", clear);
  window.print();
}

function download(fileName: string, text: string) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ReportExportButtons({
  input,
  onPdf,
}: {
  input: ReportExportInput;
  /** PDF: the full-screen reader prints itself; elsewhere this opens it to print. */
  onPdf(): void;
}) {
  const exporter = React.useContext(ResearchExportContext);
  const markdownName = usePhrase(RESEARCH_COPY.report.exportMarkdownName);
  const pdfName = usePhrase(RESEARCH_COPY.report.exportPdfName);

  const exportMarkdown = () => {
    try {
      const { fileName, markdown } = exporter(input);
      download(fileName, markdown);
      toast.success(formatPhrase(RESEARCH_COPY.report.downloaded));
    } catch {
      toast.error(formatPhrase(RESEARCH_COPY.report.downloadFailed));
    }
  };

  return (
    <div className="flex items-center gap-1 print:hidden">
      <Button variant="ghost" size="sm" onClick={exportMarkdown} aria-label={markdownName} className="gap-1.5 px-2.5 text-caption">
        <Download className="size-3.5" />
        <Phrase text={RESEARCH_COPY.report.exportMarkdown} />
      </Button>
      <Button variant="ghost" size="sm" onClick={onPdf} aria-label={pdfName} className="gap-1.5 px-2.5 text-caption">
        <Printer className="size-3.5" />
        <Phrase text={RESEARCH_COPY.report.exportPdf} />
      </Button>
    </div>
  );
}
