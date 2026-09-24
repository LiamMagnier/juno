"use client";

import * as React from "react";
import { RESEARCH_COPY, sourcesCount } from "@/components/research/copy";
import { KeepResearching } from "@/components/research/keep-researching";
import { useReportModel } from "@/components/research/report-document";
import { ReportFullscreen } from "@/components/research/report-fullscreen";
import { readingMinutes } from "@/components/research/report-structure";
import { useResearchRun } from "@/components/research/use-research-run";
import { Button } from "@/components/ui/button";
import { ChevronRight, FileText, Maximize2 } from "@/components/ui/icons";
import { Pressable } from "@/components/ui/pressable";
import { useUiLocale } from "@/lib/i18n-format";
import { PhraseWithArgs, Phrase, phraseText } from "@/lib/i18n-phrase";
import type { PhraseLine } from "@/lib/run/types";
import type { ClientSource } from "@/types/chat";
import type { RunFact } from "@/types/run";

/*
 * The research completion message's own parts (SPEC §9.11.3): the line at
 * rest from the `research` fact, and the report card that stands in for the
 * artifact card. The summary between them is ordinary message Markdown.
 *
 * - `ResearchFactLine`: ["Researched for", duration] · n sources + a caret, a
 *   press target that opens the panel's Report view. It has no
 *   `aria-expanded`: unlike a chat run line it opens a panel, it does not
 *   disclose anything inline.
 * - `ResearchReportCard`: the title, n sources · m min read, ["Written by",
 *   model], "Open report" and "Full screen", and "Keep researching".
 *   Regenerate and Edit are hidden on this message by the message item.
 */

/** The artifact identifier a completion message's report carries (§9.6.3). */
export const RESEARCH_REPORT_PREFIX = "research-report-";

export function isResearchReportIdentifier(identifier: string | null | undefined): boolean {
  return !!identifier && identifier.startsWith(RESEARCH_REPORT_PREFIX) && identifier.length > RESEARCH_REPORT_PREFIX.length;
}

/** The run a report artifact belongs to, or null. */
export function researchRunIdOf(identifier: string | null | undefined): string | null {
  return isResearchReportIdentifier(identifier) ? (identifier as string).slice(RESEARCH_REPORT_PREFIX.length) : null;
}

type ResearchFact = Extract<RunFact, { key: "research" }>;

export function researchFactLine(fact: Pick<ResearchFact, "workedMs" | "cited">): PhraseLine {
  return [
    { parts: [{ phrase: RESEARCH_COPY.card.researchedFor }, { kind: "duration", ms: fact.workedMs, style: "long" }] },
    sourcesCount(fact.cited),
  ];
}

export function ResearchFactLine({ fact, onOpen }: { fact: ResearchFact; onOpen(runId: string): void }) {
  const locale = useUiLocale();
  const line = researchFactLine(fact);
  return (
    <Pressable
      kind="row"
      onClick={() => onOpen(fact.runId)}
      aria-label={phraseText([...line, { parts: [{ phrase: RESEARCH_COPY.row.openReport }] }], locale)}
      data-no-auto-translate
      className="h-9 min-h-9 w-auto gap-1.5 rounded-control px-2 py-0 text-ui font-medium text-foreground/80 coarse:h-11"
    >
      <PhraseWithArgs spec={line} />
      <ChevronRight aria-hidden className="size-3.5 text-muted-foreground rtl:-scale-x-100" />
    </Pressable>
  );
}

export interface ResearchReportCardProps {
  /** The artifact's identifier, `research-report-{runId}`. */
  identifier: string;
  title: string;
  /** The report Markdown (the artifact's content): the reading time comes from it. */
  content: string;
  /** The message's sources: cited first (§9.6.3). */
  sources: readonly ClientSource[];
  /** Opens the Research panel's Report view on this run. */
  onOpenReport(runId: string): void;
  className?: string;
}

export function ResearchReportCard({ identifier, title, content, sources, onOpenReport, className }: ResearchReportCardProps) {
  const runId = researchRunIdOf(identifier);
  const { run } = useResearchRun(runId);
  const model = useReportModel(run);
  const [fullscreen, setFullscreen] = React.useState(false);
  const cited = sources.filter((s) => s.cited).length || run?.counts?.cited || 0;
  const minutes = readingMinutes(content, run?.language);
  const meta: PhraseLine = [
    sourcesCount(cited),
    { parts: [{ kind: "number", value: minutes }, { phrase: RESEARCH_COPY.count.minRead }] },
  ];

  if (!runId) return null;

  return (
    <section className={className} aria-label={title}>
      <div className="rounded-card border border-border/70 bg-card px-4 py-3.5 [--fav-ring:var(--card)]">
        <div className="flex items-start gap-3">
          <FileText aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-1">
            <p lang={run?.language ?? undefined} className="text-ui font-medium text-foreground">
              {title}
            </p>
            <PhraseWithArgs spec={meta} className="block text-caption text-muted-foreground" />
            {run?.leadModel && (
              <PhraseWithArgs
                spec={{ parts: [{ phrase: RESEARCH_COPY.report.writtenBy }, { kind: "label", value: run.leadModel.label }] }}
                className="block text-caption text-muted-foreground"
              />
            )}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => onOpenReport(runId)}>
            <Phrase text={RESEARCH_COPY.row.openReport} />
          </Button>
          <Button variant="outline" size="sm" disabled={!model.report} onClick={() => setFullscreen(true)} className="gap-1.5">
            <Maximize2 className="size-3.5" />
            <Phrase text={RESEARCH_COPY.report.fullScreen} />
          </Button>
        </div>
        {run && (
          <KeepResearching
            goal={run.goal}
            conversationId={run.conversationId ?? null}
            pinnedSources={sources.filter((s) => s.cited).map((s) => s.url)}
            className="mt-3 border-t border-border/60 pt-3"
          />
        )}
      </div>
      {run && <ReportFullscreen run={run} model={model} open={fullscreen} onOpenChange={setFullscreen} />}
    </section>
  );
}
