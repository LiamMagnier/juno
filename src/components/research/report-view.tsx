"use client";

import * as React from "react";
import { RESEARCH_COPY, phrase } from "@/components/research/copy";
import { KeepResearching } from "@/components/research/keep-researching";
import {
  ReportContentsMenu,
  ReportDocument,
  ReportSources,
  provenanceLine,
  supportCountsLine,
  type ReportModel,
} from "@/components/research/report-document";
import { ReportExportButtons, type ReportExportInput } from "@/components/research/report-export";
import { ReportFullscreen } from "@/components/research/report-fullscreen";
import { reportToc } from "@/components/research/report-structure";
import { stoppedEarlyReason } from "@/components/research/research-view";
import type { ResearchRunView } from "@/components/research/use-research-run";
import { Button } from "@/components/ui/button";
import { Maximize2 } from "@/components/ui/icons";
import { Phrase, PhraseWithArgs, usePhrase } from "@/lib/i18n-phrase";
import type { ResearchEventDTO } from "@/lib/research/domain";

/*
 * The report in the Research panel's Report tab (SPEC §9.12): the title, the
 * provenance line and the audit's counts, a sticky bar with the contents menu,
 * Full screen and the exports, the document itself, its sources, and "Keep
 * researching". "Stopped early" leads when the run ended before its plan did.
 */

export function ReportView({
  run,
  events,
  model,
}: {
  run: ResearchRunView;
  events: readonly ResearchEventDTO[];
  /** `useReportModel(run)`, computed once by the panel (the Sources tab reads it too). */
  model: ReportModel;
}) {
  const anchorPrefix = `report-${React.useId().replace(/[^A-Za-z0-9]/g, "")}`;
  const [fullscreen, setFullscreen] = React.useState<"closed" | "open" | "print">("closed");
  const fullScreenName = usePhrase(RESEARCH_COPY.report.fullScreen);

  if (!model.report || !model.parsed) {
    return (
      <p className="text-caption text-muted-foreground">
        <Phrase text={RESEARCH_COPY.report.noReport} />
      </p>
    );
  }

  const title = model.parsed.title ?? run.title ?? null;
  const counts = supportCountsLine(model.audit);
  const toc = reportToc(model.parsed);
  const stopped = run.state === "partially_completed" ? stoppedEarlyReason(events, run.finishRequested) : null;
  const exportInput: ReportExportInput = { run, report: model.report, citationOrder: model.citationOrder };

  return (
    <div className="space-y-5">
      <header className="space-y-1.5">
        {title && (
          <h3 lang={run.language ?? undefined} className="text-heading text-foreground">
            {title}
          </h3>
        )}
        <PhraseWithArgs spec={provenanceLine(run, model.sections.cited.length)} className="block text-caption text-muted-foreground" />
        {counts && <PhraseWithArgs spec={counts} className="block text-caption text-muted-foreground" />}
        {run.state === "partially_completed" && (
          <p className="text-caption text-warning-foreground">
            <PhraseWithArgs spec={stopped ? [phrase(RESEARCH_COPY.report.stoppedEarly), phrase(stopped)] : [phrase(RESEARCH_COPY.report.stoppedEarly)]} />
          </p>
        )}
      </header>

      <div className="sticky top-0 z-[1] -mx-1 flex flex-wrap items-center justify-between gap-1 bg-background/95 px-1 py-1 backdrop-blur-sm print:hidden">
        <ReportContentsMenu toc={toc} anchorPrefix={anchorPrefix} />
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" aria-label={fullScreenName} onClick={() => setFullscreen("open")} className="gap-1.5 px-2.5 text-caption">
            <Maximize2 className="size-3.5" />
            <Phrase text={RESEARCH_COPY.report.fullScreen} />
          </Button>
          <ReportExportButtons input={exportInput} onPdf={() => setFullscreen("print")} />
        </div>
      </div>

      <ReportDocument run={run} model={model} anchorPrefix={anchorPrefix} />
      <ReportSources sections={model.sections} />
      <KeepResearching
        goal={run.goal}
        conversationId={run.conversationId ?? null}
        pinnedSources={model.sections.cited.map((s) => s.url)}
        className="border-t border-border/60 pt-5"
      />

      <ReportFullscreen
        run={run}
        model={model}
        open={fullscreen !== "closed"}
        printOnOpen={fullscreen === "print"}
        onOpenChange={(open) => setFullscreen(open ? "open" : "closed")}
      />
    </div>
  );
}
