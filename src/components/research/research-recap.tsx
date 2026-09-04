"use client";

import * as React from "react";
import { AlertCircle, ArrowRight, CheckCircle2, ChevronDown, Clock, ShieldCheck } from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import { auditHeadline } from "@/components/chat/citation-audit";
import { SourceRail } from "@/components/research/source-rail";
import { formatMicroUsd, runDuration } from "@/components/research/run-format";
import { reportTitle } from "@/components/research/report-dialog";
import { cn } from "@/lib/utils";
import { RESEARCH_STATE_MESSAGE, isResearchState, type ResearchState } from "@/lib/research/domain";
import type { ResearchRunView } from "@/components/research/use-research-run";

/**
 * What a finished run leaves in the conversation: an elevated, authoritative report cover.
 *
 * Designed according to ChatGPT Deep Research and Claude Research standards:
 * - Clear verification & completion status badge
 * - Prominent document title and duration
 * - Provenance pills (sources read, objectives covered)
 * - Trustworthy citation audit verdict
 * - Distinct, prominent CTA to open the full report
 * - Collapsible provenance machinery (sources deck, evidence panel, timeline)
 */

const RECAP_COPY = {
  kicker: "Deep research report",
  complete: "Research complete",
  sources: "sources",
  oneSource: "source",
  read: "read in full",
  covered: "objectives answered",
  openReport: "Read the full report",
  noReport: "This run stopped before it wrote a report.",
  showWork: "Inspect methodology & sources",
  hideWork: "Hide methodology & sources",
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
  onOpenReport?: () => void;
  onDismiss?: () => void;
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

  const title = run.report ? reportTitle(run.report) : null;
  const audit = run.auditSummary;
  const auditClean = audit ? audit.contradicted + audit.unsupported === 0 : false;

  return (
    <section
      aria-label={RECAP_COPY.kicker}
      className={cn(
        "surface-raised-lg relative overflow-hidden rounded-panel border border-border/60 bg-card p-5 shadow-raised transition-all duration-base sm:p-6",
        className
      )}
    >
      {/* Top Header: Status badge & metadata */}
      <header className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {clean ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/15 px-2.5 py-1 text-xs font-semibold uppercase tracking-wider text-success-ink">
              <CheckCircle2 className="size-3.5 text-success-ink" />
              {RECAP_COPY.complete}
            </span>
          ) : state === "failed" ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/15 px-2.5 py-1 text-xs font-semibold uppercase tracking-wider text-destructive">
              <AlertCircle className="size-3.5 text-destructive" />
              {RESEARCH_STATE_MESSAGE[state]}
            </span>
          ) : state === "cancelled" ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-secondary/80 px-2.5 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Cancelled
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/15 px-2.5 py-1 text-xs font-semibold uppercase tracking-wider text-warning-foreground">
              {RESEARCH_STATE_MESSAGE[state]}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {elapsed && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-secondary/80 px-2.5 py-1 font-mono text-xs font-medium tabular-nums text-foreground">
              <Clock className="size-3 text-muted-foreground" />
              {elapsed}
            </span>
          )}
          <span className="inline-flex items-center rounded-full border border-border/60 bg-secondary/80 px-2.5 py-1 font-mono text-xs tabular-nums text-muted-foreground">
            {formatMicroUsd(run.costMicroUsd)}
          </span>
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
      </header>

      {/* Report Document Title */}
      <div className="mt-3.5 border-l-2 border-success/50 pl-3.5">
        <h3 className="text-balance font-sans text-lg font-bold leading-snug tracking-tight text-foreground sm:text-xl">
          {title ?? run.goal}
        </h3>
      </div>

      {/* Provenance Badges */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-secondary/60 px-2.5 py-1 font-mono text-xs text-foreground/90 tabular-nums">
          {run.sources.length} {run.sources.length === 1 ? RECAP_COPY.oneSource : RECAP_COPY.sources} ({read} {RECAP_COPY.read})
        </span>
        {objectives.length > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-secondary/60 px-2.5 py-1 font-mono text-xs text-foreground/90 tabular-nums">
            {covered}/{objectives.length} {RECAP_COPY.covered}
          </span>
        )}
      </div>

      {/* Publishers Rail */}
      {run.sources.length > 0 && (
        <div className="mt-4 border-t border-border/50 pt-3.5">
          <SourceRail sources={run.sources} onOpenSources={() => setWorkOpen(true)} />
        </div>
      )}

      {/* Citation Audit Verdict Banner */}
      {audit && (
        <div className="mt-4 flex items-center gap-2.5 rounded-card border border-border/60 bg-secondary/30 p-3 text-xs">
          <ShieldCheck className={cn("size-4 shrink-0", auditClean ? "text-success" : "text-warning-foreground")} />
          <span className="flex-1 font-medium text-foreground/90">{auditHeadline(audit)}</span>
        </div>
      )}

      {/* Primary Report CTA */}
      {onOpenReport ? (
        <button
          type="button"
          onClick={onOpenReport}
          className={cn(
            "group mt-4 flex w-full items-center justify-between gap-3 rounded-field border border-primary/30 bg-primary/10 px-4 py-3.5 text-left text-primary transition-all duration-fast",
            "hover:border-primary/50 hover:bg-primary/15 hover:shadow-xs motion-reduce:transition-none",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
        >
          <span className="text-body font-semibold">{RECAP_COPY.openReport}</span>
          <ArrowRight
            aria-hidden
            className="size-4 shrink-0 transition-transform duration-fast ease-out-soft group-hover:translate-x-1"
          />
        </button>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">{RECAP_COPY.noReport}</p>
      )}

      {run.error && (
        <p role="status" className="mt-4 rounded-field bg-destructive/10 px-3 py-2 text-ui text-destructive">
          {run.error}
        </p>
      )}

      {/* Inspect Methodology Drawer */}
      {work && (
        <div className="mt-4 border-t border-border/40 pt-3">
          <button
            type="button"
            aria-expanded={workOpen}
            onClick={() => setWorkOpen((value) => !value)}
            className="pressable inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
          >
            <span>{workOpen ? RECAP_COPY.hideWork : RECAP_COPY.showWork}</span>
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

