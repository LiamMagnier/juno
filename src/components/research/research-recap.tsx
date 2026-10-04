"use client";

import * as React from "react";
import { ArrowRight, ChevronDown, ShieldCheck } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { auditHeadline } from "@/components/chat/citation-audit";
import { formatMicroUsd, runDuration } from "@/components/research/run-format";
import { reportTitle } from "@/components/research/report-dialog";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { cn } from "@/lib/utils";
import { RESEARCH_STATE_MESSAGE, isResearchState, type ResearchState } from "@/lib/research/domain";
import type { ResearchRunView } from "@/components/research/use-research-run";
import { FEATURE_NAMES } from "@/lib/brand/names";
import { DeepField, Figure, QuestionRail } from "./deep-field";
import { answeredCount, researchAuditClean, researchWorkspace } from "./workspace-model";

/**
 * What a finished run leaves in the conversation: the report's cover.
 *
 * The live view settles into it: the same section, the same field (now
 * still, every cited source on the inner orbit with its number), the same
 * questions with how each ended, then the figures a reader checks a report
 * by, the citation verdict in words, and one door into the document. The
 * machinery is one disclosure below, where an auditor looks and a reader
 * does not.
 *
 * The verdict is a word, never a capsule; a run that stopped short says so
 * in the attention colour with the reason the server recorded.
 */

const RECAP_COPY = {
  report: "Report",
  ready: "Report ready",
  cancelled: "Stopped",
  read: "Read",
  cited: "Cited",
  answered: "Answered",
  time: "Time",
  openReport: "Read the report",
  library: "Saved in Library",
  noReport: "This research stopped before it wrote a report.",
  showWork: "How it was researched",
  hideWork: "Hide how it was researched",
  dismiss: "Hide this research",
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
  const model = React.useMemo(() => researchWorkspace(run, []), [run]);
  const elapsed = runDuration(run.createdAt ?? "", run.finishedAt ?? null);
  const title = (run.report ? reportTitle(run.report) : null) ?? run.title ?? run.goal;
  const subtitle = title.trim() !== run.goal.trim() ? run.goal : null;
  const audit = run.auditSummary;
  const auditClean = audit ? researchAuditClean(audit) : false;
  const verdict =
    state === "completed" ? RECAP_COPY.ready : state === "cancelled" ? RECAP_COPY.cancelled : RESEARCH_STATE_MESSAGE[state];
  const tone = state === "completed" ? undefined : state === "failed" ? "error" : state === "cancelled" ? undefined : "attention";

  return (
    <section aria-label={`${FEATURE_NAMES.research.label} ${RECAP_COPY.report}`} data-state={state} className={cn("rf min-w-0", className)}>
      <header className="rf-rise" style={{ ["--i" as string]: 0 }}>
        <div className="rf-annot flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 whitespace-nowrap text-foreground">{FEATURE_NAMES.research.label}</span>
            <span aria-hidden>·</span>
            <span className="rf-verdict" data-tone={tone}>{verdict}</span>
          </span>
          <span className="flex shrink-0 items-center gap-3 tabular-nums">
            {elapsed && <span>{elapsed}</span>}
            <span>{formatMicroUsd(run.costMicroUsd)}</span>
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                aria-label={RECAP_COPY.dismiss}
                title={RECAP_COPY.dismiss}
                className="pressable -me-1.5 inline-flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground motion-reduce:transition-none coarse:size-11"
              >
                <ActionIcons.dismiss className="size-3.5" />
              </button>
            )}
          </span>
        </div>
        <h3 lang={run.language ?? undefined} className="rf-title mt-3">{title}</h3>
        {subtitle && <p lang={run.language ?? undefined} className="mt-2 max-w-[38rem] text-pretty text-ui text-muted-foreground">{subtitle}</p>}
      </header>

      {run.sources.length > 0 && (
        <div className="rf-stage rf-stage-still rf-rise" style={{ ["--i" as string]: 1 }}>
          <DeepField
            sources={run.sources}
            currentHost={null}
            working={false}
            still
            counts={{ found: model.found, read: model.read, cited: model.cited }}
          />
          <QuestionRail questions={model.questions} working={false} language={run.language} sources={run.sources} />
        </div>
      )}

      <dl className="rf-figures rf-rise" style={{ ["--i" as string]: 2 }}>
        <Figure label={RECAP_COPY.read}>{model.read}</Figure>
        <Figure label={RECAP_COPY.cited}>{model.cited ?? <span className="text-muted-foreground">–</span>}</Figure>
        <Figure label={RECAP_COPY.answered}>
          {model.questions.length ? <>{answeredCount(model.questions)}<span className="rf-figure-of">/{model.questions.length}</span></> : <span className="text-muted-foreground">–</span>}
        </Figure>
        <Figure label={RECAP_COPY.time}>{elapsed ?? <span className="text-muted-foreground">–</span>}</Figure>
      </dl>

      {audit && (
        <p className="rf-audit rf-rise" style={{ ["--i" as string]: 3 }}>
          <ShieldCheck className={cn("size-4 shrink-0", auditClean ? "text-foreground" : "text-[hsl(var(--attention))]")} aria-hidden />
          <span>{auditHeadline(audit)}</span>
        </p>
      )}

      {run.error && <p role="status" className="rf-notice">{run.error}</p>}

      <div className="rf-controls rf-rise" style={{ ["--i" as string]: 4 }}>
        {onOpenReport ? (
          <>
            <Button type="button" onClick={onOpenReport}>
              {RECAP_COPY.openReport}
              <ArrowRight aria-hidden className="size-4 shrink-0" />
            </Button>
            {/* Completion writes the report into Library in the same transaction as this message. */}
            {run.assistantMessageId && <span className="rf-annot ms-2">{RECAP_COPY.library}</span>}
          </>
        ) : (
          <p className="text-ui text-muted-foreground">{RECAP_COPY.noReport}</p>
        )}
      </div>

      {work && (
        <div className="rf-details">
          <button type="button" className="rf-disclosure" aria-expanded={workOpen} onClick={() => setWorkOpen((value) => !value)}>
            {workOpen ? RECAP_COPY.hideWork : RECAP_COPY.showWork}
            <ChevronDown aria-hidden className={cn("size-4 transition-transform duration-base motion-reduce:transition-none", workOpen && "rotate-180")} />
          </button>
          <div className="contents" inert={!workOpen}>
            <Collapse open={workOpen} innerClassName="pb-1 pt-4">{work}</Collapse>
          </div>
        </div>
      )}
    </section>
  );
}
