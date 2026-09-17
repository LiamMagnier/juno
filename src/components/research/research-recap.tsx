"use client";

import * as React from "react";
import { AlertCircle, ArrowRight, CheckCircle2, ChevronDown, ShieldCheck } from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import { auditHeadline } from "@/components/chat/citation-audit";
import { SourceRail } from "@/components/research/source-rail";
import { formatMicroUsd, runDuration } from "@/components/research/run-format";
import { reportTitle } from "@/components/research/report-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RESEARCH_STATE_MESSAGE, isResearchState, type ResearchState } from "@/lib/research/domain";
import type { ResearchRunView } from "@/components/research/use-research-run";

/**
 * What a finished run leaves in the conversation: a report cover.
 *
 * The verdict as a word, the report's own title, one line of provenance, the
 * citation verdict, a door into the document, and the machinery behind a
 * disclosure — in that order, because the reader's question is "can I trust
 * it and where do I read it".
 *
 * TWO VOICES. The cover speaks in `ui` for the verdict and `caption` for
 * every fact; the serif title is content, not chrome. It used to speak in
 * five rungs and three faces — a mono `micro` elapsed, a captioned cost
 * capsule, two bordered provenance capsules, a `body` CTA — which is the
 * "control panel" diagnosis PREMIUM_AUDIT §2 made of the model picker,
 * repeated on a report cover. Facts are plain text now, separated by a
 * middot, and nothing on the cover wears a capsule.
 *
 * NOTHING NESTED WEARS A BOX. `.research-surface` is a 16px radius padded by
 * 16px, so FLAT_UI §6 gives a full-width child a radius of zero: the audit
 * verdict is an icon and a sentence on the panel, and the door is a button —
 * narrower than the content box, which is what puts it outside the rule.
 */

const RECAP_COPY = {
  kicker: "Deep research report",
  complete: "Research complete",
  read: "sources read",
  oneRead: "source read",
  found: "found",
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
        "research-surface relative overflow-hidden",
        className
      )}
    >
      {/*
       * THE VERDICT, AS A WORD. These four were `rounded-full` capsules with
       * their own border, a 15%-alpha tinted fill and 12px semibold type — the
       * loudest treatment the design system can produce, spent on a label that
       * repeats what the surface around it already says. FLAT_UI §2.4: the
       * accent (and every semantic hue) is state, never furniture. They are
       * now a glyph and a word in the hue that carries the meaning, which is
       * the same badge idiom the model picker uses.
       */}
      {/* Top Header: Status badge & metadata */}
      <header className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {clean ? (
            <span className="inline-flex items-center gap-1.5 text-ui font-medium text-success-ink">
              <CheckCircle2 className="size-3.5 text-success-ink" />
              {RECAP_COPY.complete}
            </span>
          ) : state === "failed" ? (
            <span className="inline-flex items-center gap-1.5 text-ui font-medium text-destructive">
              <AlertCircle className="size-3.5 text-destructive" />
              {RESEARCH_STATE_MESSAGE[state]}
            </span>
          ) : state === "cancelled" ? (
            <span className="inline-flex items-center gap-1.5 text-ui font-medium text-muted-foreground">
              Cancelled
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-ui font-medium text-warning-foreground">
              {RESEARCH_STATE_MESSAGE[state]}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 text-caption tabular-nums text-muted-foreground">
          {elapsed && (
            <>
              <span>{elapsed}</span>
              <span aria-hidden>·</span>
            </>
          )}
          <span>{formatMicroUsd(run.costMicroUsd)}</span>
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
      <div className="mt-3.5 ">
        <h3 className="text-balance font-serif text-title font-normal leading-snug tracking-tight text-foreground">
          {title ?? run.goal}
        </h3>
      </div>

      {/* Provenance. "Read" leads because it is the number the reader will
          meet again in the report: the reader is handed the read corpus, so
          its "7 sources read" and this line's "7 sources read" are the same
          count in the same words. The old capsule led with the found total
          and the reader answered with the read one — two totals for one run,
          one click apart. */}
      <p className="mt-2 text-caption tabular-nums text-muted-foreground">
        {read} {read === 1 ? RECAP_COPY.oneRead : RECAP_COPY.read} · {run.sources.length} {RECAP_COPY.found}
        {objectives.length > 0 && ` · ${covered}/${objectives.length} ${RECAP_COPY.covered}`}
      </p>

      {/* Publishers Rail */}
      {run.sources.length > 0 && (
        <div className="mt-4 border-t border-border/50 pt-3.5">
          <SourceRail sources={run.sources} onOpenSources={() => setWorkOpen(true)} />
        </div>
      )}

      {/* The citation verdict: an icon and a sentence on the panel. */}
      {audit && (
        <div className="mt-4 flex items-center gap-2.5 text-caption">
          <ShieldCheck className={cn("size-4 shrink-0", auditClean ? "text-success" : "text-warning-foreground")} />
          <span className="flex-1 font-medium text-foreground/90">{auditHeadline(audit)}</span>
        </div>
      )}

      {/* The door into the document. */}
      {onOpenReport ? (
        <Button type="button" variant="secondary" onClick={onOpenReport} className="group mt-4">
          {RECAP_COPY.openReport}
          <ArrowRight
            aria-hidden
            className="ml-2 size-4 shrink-0 transition-transform duration-fast ease-out-soft motion-safe:group-hover:translate-x-0.5"
          />
        </Button>
      ) : (
        <p className="mt-4 text-caption text-muted-foreground">{RECAP_COPY.noReport}</p>
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
            className="pressable inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-caption font-medium text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
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
