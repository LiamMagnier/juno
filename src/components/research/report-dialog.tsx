"use client";

import * as React from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ReportReader } from "@/components/research/report-reader";
import { parseArtifacts } from "@/lib/message-content";
import type { ResearchSourceView } from "@/components/research/use-research-run";

/**
 * The full report, as a document.
 *
 * `ReportReader` — the 75ch measure, the scroll-tracking table of contents, the
 * numbered source rail standing beside the prose it supports — has existed in
 * this directory since the run panel was written and was reachable from NOWHERE:
 * `grep -rn ReportReader src` returned its own definition and nothing else. The
 * report a user paid ten minutes and real money for was readable only as a
 * generic markdown artifact card in the transcript, which is exactly the failure
 * every teardown of this feature names — ChatGPT answers this with a fullscreen
 * document viewer, Gemini with a canvas pane, Perplexity with a report-first
 * output. This is the door.
 *
 * WHAT `run.report` ACTUALLY HOLDS, and why it is parsed here. The chat route
 * streams the synthesis through the user's own model and writes the whole
 * assistant turn back onto the run — which, under RESEARCH_OUTPUT_CONTRACT, is
 * the 100–200 word recap FOLLOWED BY the report inside a `<juno:artifact>`
 * block. Handing that string straight to a reader would print the recap twice
 * (once in the thread, once above its own report) and then the raw tag. So the
 * artifact is extracted, and the fallback when there is no artifact — an older
 * run, a turn the model shaped differently — is the raw text rather than an
 * error: a report that renders with its wrapper showing beats a blank dialog.
 */

const REPORT_COPY = { title: "Research report" } as const;

/** The artifact the writer produced, if it produced one. */
function reportArtifact(report: string) {
  const all = parseArtifacts(report);
  return all.find((a) => a.type === "MARKDOWN") ?? all[0] ?? null;
}

/** The document half of a research turn, whatever shape the turn came back in. */
export function reportBody(report: string): string {
  return reportArtifact(report)?.content.trim() || report.trim();
}

/**
 * What the finished document is CALLED.
 *
 * RESEARCH_OUTPUT_CONTRACT instructs the writer to title the artifact after the
 * actual subject rather than "Research Report", so this is a real name and the
 * right thing for the recap card to lead with — a finished document is referred
 * to by its title, not by the question that produced it. Null when the turn
 * carried no artifact, which is the caller's cue to fall back to the goal rather
 * than invent a heading.
 */
export function reportTitle(report: string): string | null {
  const title = reportArtifact(report)?.title?.trim();
  return title && title.toLowerCase() !== "research report" ? title : null;
}

export function ReportDialog({
  open,
  onOpenChange,
  report,
  sources,
  goal,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  report: string;
  sources: ResearchSourceView[];
  goal: string;
}) {
  const body = React.useMemo(() => reportBody(report), [report]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // A report is a document, so it takes the room a document needs: the
        // dialog primitive's `max-w-lg` is sized for a confirm, and the reader
        // inside this has three columns (contents, prose, sources) that only
        // exist above `lg`. `p-0` because the reader owns its own padding and
        // its sticky rails measure against the scroll container.
        className="max-w-[min(96rem,calc(100vw-2rem))] p-0 sm:p-0"
      >
        {/* The accessible name. Visually hidden because the report's own <h1>
            is the title a sighted reader sees, and printing "Research report"
            above it would be the same string twice. */}
        <DialogTitle className="sr-only">{`${REPORT_COPY.title} — ${goal}`}</DialogTitle>
        <div className="app-page-scroll max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 sm:p-8">
          <ReportReader report={body} sources={sources} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
