"use client";

import * as React from "react";
import { RESEARCH_COPY } from "@/components/research/copy";
import {
  ReportDocument,
  ReportSources,
  jumpToSection,
  provenanceLine,
  sectionAnchor,
  type ReportModel,
} from "@/components/research/report-document";
import { ReportExportButtons, printReport } from "@/components/research/report-export";
import { reportToc } from "@/components/research/report-structure";
import type { ResearchRunView } from "@/components/research/use-research-run";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { List, X } from "@/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SourceFavicon, isRenderableSourceUrl } from "@/components/chat/source-chip";
import { Phrase, PhraseWithArgs, formatPhrase, usePhrase } from "@/lib/i18n-phrase";
import { cn } from "@/lib/utils";
import { FEATURE_NAMES } from "@/lib/brand/names";

/*
 * The full-screen reader (SPEC §9.12): a full-bleed dialog with no route of
 * its own. From 1280 px, three columns: the contents (sections by marker),
 * the text at a 70ch measure, and the cited sources with the citation being
 * read highlighted. From 1024 px the contents move behind the header button
 * and the cited rail stays; narrower, one column. Esc closes it and focus
 * goes back to what opened it.
 *
 * Layout rules this file keeps (the report could not be scrolled to its end
 * and its text ran under the sources rail):
 *   - the dialog is a flex column, never a grid: a grid's auto row sizes to
 *     the content, so the scroller grew as tall as the report, the dialog
 *     clipped it and the last screen could not be reached;
 *   - the middle column is `minmax(0, 1fr)` and the article caps at 70ch, so
 *     nothing in it can widen the track over a rail;
 *   - the rails are sticky inside the scroller and scroll on their own;
 *   - the article ends with real bottom padding, so its last line clears the
 *     window edge.
 *
 * It is also the PDF: its article is the page's `data-print-document`, the
 * global print rule prints links with their addresses, and the tab title
 * follows the report's title while the print dialog is up (§9.13).
 */

export interface ReportFullscreenProps {
  run: ResearchRunView;
  model: ReportModel;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Print as soon as it has opened (the PDF export from elsewhere). */
  printOnOpen?: boolean;
}

function Contents({
  toc,
  anchorPrefix,
  onPick,
}: {
  toc: Array<{ id: string; title: string }>;
  anchorPrefix: string;
  onPick?(): void;
}) {
  return (
    <ul className="space-y-0.5">
      {toc.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            onClick={() => {
              jumpToSection(sectionAnchor(anchorPrefix, item.id));
              onPick?.();
            }}
            className="block w-full rounded-control px-2 py-1.5 text-start text-caption text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground motion-reduce:transition-none"
          >
            {item.title}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ReportFullscreen({ run, model, open, onOpenChange, printOnOpen }: ReportFullscreenProps) {
  const anchorPrefix = `full-${React.useId().replace(/[^A-Za-z0-9]/g, "")}`;
  const [active, setActive] = React.useState<number | null>(null);
  const [tocOpen, setTocOpen] = React.useState(false);
  const closeName = usePhrase(RESEARCH_COPY.report.close);
  const contentsName = usePhrase(RESEARCH_COPY.report.contents);
  const title = model.parsed?.title ?? run.title ?? formatPhrase(RESEARCH_COPY.report.name);
  const toc = model.parsed ? reportToc(model.parsed) : [];

  React.useEffect(() => {
    if (!open || !printOnOpen) return;
    // One frame for the dialog to lay out its article before the print snapshot.
    const frame = window.requestAnimationFrame(() => printReport(title));
    return () => window.cancelAnimationFrame(frame);
  }, [open, printOnOpen, title]);

  if (!model.report) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        // Open on the document, not on its first toolbar button: focus lands on
        // the title (read first by a screen reader), with no ring drawn on Markdown.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>("[data-report-title]")?.focus({ preventScroll: true });
        }}
        className="inset-0 left-0 top-0 flex h-dvh max-h-none w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 [translate:none] sm:p-0 print:static print:block print:h-auto print:overflow-visible print:shadow-none"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <div className="flex min-h-0 flex-1 flex-col print:block">
          <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border/70 px-4 print:hidden">
            <div className="flex items-center gap-3">
              <span className="rf-annot hidden whitespace-nowrap ps-1 sm:inline">
                <span className="text-foreground">{FEATURE_NAMES.research.label}</span> · <Phrase text={RESEARCH_COPY.report.name} />
              </span>
              {toc.length >= 2 && (
                <Popover open={tocOpen} onOpenChange={setTocOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="sm" className="gap-1.5 px-2.5 text-caption xl:hidden" aria-label={contentsName}>
                      <List className="size-3.5" />
                      <Phrase text={RESEARCH_COPY.report.contents} />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="max-h-[70dvh] w-80 overflow-y-auto p-1">
                    <Contents toc={toc} anchorPrefix={anchorPrefix} onPick={() => setTocOpen(false)} />
                  </PopoverContent>
                </Popover>
              )}
            </div>
            <div className="flex items-center gap-1">
              <ReportExportButtons
                input={{ run, report: model.report, citationOrder: model.citationOrder }}
                onPdf={() => printReport(title)}
              />
              <DialogClose asChild>
                <Button variant="ghost" size="icon-sm" aria-label={closeName}>
                  <X className="size-4" />
                </Button>
              </DialogClose>
            </div>
          </header>

          <div className="app-page-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain print:overflow-visible">
            <div
              className={cn(
                "report-reader-grid mx-auto grid max-w-[96rem] gap-x-10 px-5 pb-0 pt-10 sm:px-8 print:block print:p-0",
                model.sections.cited.length > 0
                  ? "lg:grid-cols-[minmax(0,1fr)_16rem] xl:grid-cols-[13rem_minmax(0,1fr)_17rem]"
                  : "xl:grid-cols-[13rem_minmax(0,1fr)_17rem]",
              )}
            >
              {toc.length >= 2 ? (
                <nav aria-label={contentsName} className="report-rail sticky top-8 hidden self-start overflow-y-auto overscroll-contain xl:block print:hidden">
                  <p className="rf-annot mb-3 px-2 text-foreground">
                    <Phrase text={RESEARCH_COPY.report.contents} />
                  </p>
                  <Contents toc={toc} anchorPrefix={anchorPrefix} />
                </nav>
              ) : (
                <span className="hidden xl:block" />
              )}

              <article data-print-document="" className="report-article mx-auto w-full min-w-0 max-w-[70ch] pb-32 print:pb-0">
                <header className="space-y-3 pb-10">
                  <h1 data-report-title tabIndex={-1} lang={run.language ?? undefined} className="research-title text-balance text-foreground outline-none">
                    {title}
                  </h1>
                  <PhraseWithArgs spec={provenanceLine(run, model.sections.cited.length)} className="rf-annot block pt-1" />
                </header>
                <ReportDocument run={run} model={model} anchorPrefix={anchorPrefix} onActiveCitation={setActive} className="research-document-reader" />
                <div className="pt-14">
                  <ReportSources sections={model.sections} />
                </div>
              </article>

              {model.sections.cited.length > 0 && (
                <aside
                  aria-label={formatPhrase(RESEARCH_COPY.sources.cited)}
                  className="report-rail sticky top-8 hidden self-start overflow-y-auto overscroll-contain lg:block print:hidden"
                >
                  <p className="rf-annot mb-3 px-2 text-foreground">
                    <Phrase text={RESEARCH_COPY.sources.cited} />
                  </p>
                  <ol className="space-y-0.5">
                    {model.sections.cited.map((row) => (
                      <li key={row.key}>
                        <a
                          href={isRenderableSourceUrl(row.url) ? row.url : undefined}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-current={active === row.cited ? "true" : undefined}
                          className={cn(
                            "flex items-start gap-2 rounded-control px-2 py-1.5 transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none",
                            active === row.cited && "bg-selected",
                          )}
                        >
                          <span className="w-5 shrink-0 text-right font-mono text-caption tabular-nums text-muted-foreground">{row.cited}</span>
                          <SourceFavicon url={row.url} variant="list" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-caption font-medium text-foreground/90">{row.title}</span>
                            <bdi translate="no" className="block truncate text-caption text-muted-foreground">
                              {row.domain}
                            </bdi>
                          </span>
                        </a>
                      </li>
                    ))}
                  </ol>
                </aside>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
