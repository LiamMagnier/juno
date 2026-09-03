"use client";

import * as React from "react";
import { ArrowRight, ChevronDown } from "lucide-react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { auditHeadline } from "@/components/chat/citation-audit";
import { SourceRail } from "@/components/research/source-rail";
import { formatMicroUsd, runDuration } from "@/components/research/run-format";
import { reportTitle } from "@/components/research/report-dialog";
import { cn } from "@/lib/utils";
import { RESEARCH_STATE_MESSAGE, isResearchState, type ResearchState } from "@/lib/research/domain";
import type { ResearchRunView } from "@/components/research/use-research-run";

/**
 * What a finished run leaves in the conversation: a cover, not a dashboard.
 *
 * The panel this replaces did not change when the run ended — a completed run
 * went on rendering its stage ladder, objective list, evidence scatter, step log
 * and eighteen source rows, the entire machinery of an investigation that was
 * over, parked above the answer it produced. The first rewrite fixed that and
 * replaced it with a four-column stat block, which was the same mistake in
 * nicer clothes: a grid of big mono numbers over little grey nouns is what every
 * analytics screen in the world looks like, and none of those four numbers is
 * what a reader wants from a finished piece of research.
 *
 * What they want is the DOCUMENT. So this is shaped like the cover of one: the
 * report's own title in the serif, one quiet line of provenance under it, the
 * publishers it rests on, the citation verdict, and a single wide action that
 * opens it. The numbers are still all here — they are a sentence now instead of
 * a scoreboard, which is the correct weight for them.
 *
 * The prose recap is deliberately NOT in this card. RESEARCH_OUTPUT_CONTRACT
 * already makes the model answer in 100–200 words of flowing prose in the thread
 * itself, which is the right place for it: the finding belongs in the
 * conversation, in the reading order the question was asked in. Restating it
 * inside a card would be the summary twice, and card-shaped prose is the exact
 * reflex this redesign exists to remove. What this adds beside that prose is
 * everything the prose cannot say about itself.
 */

/**
 * Composed with counts at runtime, so the fixed halves live in a `COPY` const —
 * template literals are invisible to scripts/generate-i18n-catalog.mjs.
 */
const RECAP_COPY = {
  kicker: "Deep research",
  sources: "sources",
  oneSource: "source",
  read: "read in full",
  covered: "objectives answered",
  openReport: "Read the full report",
  noReport: "This run stopped before it wrote a report.",
  showWork: "How it worked",
  hideWork: "Hide how it worked",
  dismiss: "Hide this research receipt",
} as const;

export function ResearchRecap({
  run,
  onOpenReport,
  onDismiss,
  work,
  className,
}: {
  run: ResearchRunView;
  /** Opens the report document. Absent when the run produced no report. */
  onOpenReport?: () => void;
  onDismiss?: () => void;
  /** The run's machinery, rendered only once the reader asks for it. */
  work?: React.ReactNode;
  className?: string;
}) {
  const [workOpen, setWorkOpen] = React.useState(false);

  const state: ResearchState = isResearchState(run.state) ? run.state : "failed";
  const clean = state === "completed";
  const read = run.sources.filter((source) => source.read).length;
  const objectives = run.plan.objectives ?? [];
  const covered = objectives.filter((objective) => objective.status === "covered").length;
  const elapsed = runDuration(run.createdAt ?? "", run.finishedAt ?? null);

  // The report's OWN title, not the question. A finished document is referred to
  // by its name; the question that produced it is already three lines up the
  // transcript, in the user's own message.
  const title = run.report ? reportTitle(run.report) : null;

  const audit = run.auditSummary;
  const auditClean = audit ? audit.contradicted + audit.unsupported === 0 : false;

  /** The provenance line: everything the old stat grid said, as one sentence. */
  const provenance = [
    `${run.sources.length} ${run.sources.length === 1 ? RECAP_COPY.oneSource : RECAP_COPY.sources}`,
    `${read} ${RECAP_COPY.read}`,
    objectives.length > 0 ? `${covered}/${objectives.length} ${RECAP_COPY.covered}` : null,
    elapsed,
    formatMicroUsd(run.costMicroUsd),
  ].filter(Boolean) as string[];

  return (
    <section
      aria-label={RECAP_COPY.kicker}
      className={cn(
        "relative rounded-surface border border-border/50 bg-card px-5 py-5 shadow-soft sm:px-6",
        className
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            {/* Sentence case. See the note on the same line in
                research-console.tsx: nothing here is set in full uppercase,
                and `text-label`'s 0.10em tracking exists for caps only. */}
            <p className="text-caption font-medium text-primary">{RECAP_COPY.kicker}</p>
            {/* A run that did not simply finish says so here, in words, at the
                size of an aside — not as a coloured pill. "Stopped early" is a
                fact about the document below it, not a status chip. */}
            {!clean && (
              <p className="text-caption text-muted-foreground">{RESEARCH_STATE_MESSAGE[state]}</p>
            )}
          </div>
          <h3 className="mt-2 text-balance font-sans text-title text-foreground">{title ?? run.goal}</h3>
          <p className="mt-2 text-ui text-muted-foreground">{provenance.join(" · ")}</p>
        </div>

        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={RECAP_COPY.dismiss}
            className="pressable inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ActionIcons.dismiss className="size-3.5" />
          </button>
        )}
      </div>

      {run.sources.length > 0 && <SourceRail sources={run.sources} className="mt-4" />}

      {/* The citation verdict — the single best answer to "should I believe
          this". It was already being fetched on every poll and rendered as an
          11px mono line at the bottom of a five-section stack. */}
      {audit && (
        <p className="mt-4 flex min-w-0 items-start gap-2 text-ui">
          <span
            aria-hidden
            className={cn(
              "mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-full",
              auditClean ? "bg-success/15 text-success-ink" : "bg-warning/15 text-warning-foreground"
            )}
          >
            {auditClean ? <StatusIcons.success className="size-2.5" /> : <StatusIcons.warning className="size-2.5" />}
          </span>
          <span className="min-w-0 flex-1 text-muted-foreground">{auditHeadline(audit)}</span>
        </p>
      )}

      {/* One wide door, not a row of buttons. The report is the thing this card
          is a cover for, and every competing action on it is a reason not to
          open it. */}
      {onOpenReport ? (
        <button
          type="button"
          onClick={onOpenReport}
          className={cn(
            "group mt-5 flex w-full items-center justify-between gap-3 rounded-field border border-border/70 bg-secondary/40 px-4 py-3 text-left",
            "transition-colors duration-fast ease-out-soft hover:border-primary/40 hover:bg-primary/[0.06] motion-reduce:transition-none",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
        >
          <span className="min-w-0 text-body font-medium text-foreground">{RECAP_COPY.openReport}</span>
          <ArrowRight
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground transition-transform duration-fast ease-out-soft group-hover:translate-x-0.5 group-hover:text-primary motion-reduce:transition-none"
          />
        </button>
      ) : (
        <p className="mt-5 text-ui text-muted-foreground">{RECAP_COPY.noReport}</p>
      )}

      {run.error && (
        <p role="status" className="mt-4 rounded-field bg-destructive/10 px-3 py-2 text-ui text-destructive">
          {run.error}
        </p>
      )}

      {work && (
        <div className="mt-4">
          <button
            type="button"
            aria-expanded={workOpen}
            onClick={() => setWorkOpen((value) => !value)}
            className="pressable -ml-1 inline-flex items-center gap-1 rounded-control px-1 py-0.5 text-ui text-muted-foreground hover:text-foreground"
          >
            {workOpen ? RECAP_COPY.hideWork : RECAP_COPY.showWork}
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3.5 transition-transform duration-base ease-out-soft motion-reduce:transition-none",
                workOpen && "rotate-180"
              )}
            />
          </button>
          {workOpen && <div className="mt-4 border-t border-border/50 pt-4">{work}</div>}
        </div>
      )}
    </section>
  );
}
