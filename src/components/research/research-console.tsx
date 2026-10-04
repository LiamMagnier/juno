"use client";

import * as React from "react";
import { ChevronDown, Pause, Play } from "@/components/ui/icons";
import { Collapse } from "@/components/ui/collapse";
import { Button } from "@/components/ui/button";
import { RollingNumber } from "@/components/ui/micro";
import { hostOf, isRenderableSourceUrl } from "@/components/chat/source-chip";
import { RunClock } from "@/components/chat/run/run-clock";
import { PhraseWithArgs } from "@/lib/i18n-phrase";
import { EvidencePanel } from "./evidence-panel";
import { ClarifyGate, PlanOutline } from "./run-controls";
import { RunTimeline } from "./run-timeline";
import { SourceDeck } from "./source-deck";
import { ScopeCard } from "./scope-card";
import { DeepField, Figure, QuestionRail } from "./deep-field";
import { EmergingAnswers } from "./emerging-answers";
import { recoveryLine } from "./next-steps";
import { formatMicroUsd } from "./run-format";
import { panelControls, researchClock, rowLine } from "./research-view";
import { phaseOfRun } from "@/lib/research/phase";
import { readingHost, researchWorkspace } from "./workspace-model";
import { isWorkingResearchState, type ResearchEventDTO, type ResearchState } from "@/lib/research/domain";
import type { ResearchRunView } from "./use-research-run";
import { cn } from "@/lib/utils";
import { ThinkingMark } from "@/components/brand/thinking-mark";
import { FEATURE_NAMES } from "@/lib/brand/names";

const WORKSPACE_COPY = {
  guide: "Guide", pause: "Pause", resume: "Resume", stop: "Stop",
  found: "Found", read: "Read", cited: "Cited", researchers: "Researchers",
  evidence: "Latest evidence",
  details: "Sources, evidence and activity", hideDetails: "Hide sources, evidence and activity",
  guidance: "What should the research focus on?", placeholder: "Change the scope, suggest an angle, or add a source…",
  addGuidance: "Add guidance", guidanceQueued: "Added. It applies at the next research round.",
  guidanceNote: "Guidance applies at the next round. Adding it while paused keeps the research paused.",
  queued: "Queued guidance", applied: "Applied guidance",
  noEvidence: "Evidence appears here as sources answer the questions.",
  noActivity: "Activity appears here as sources are searched and read.",
  noResearchers: "No researchers have started yet.",
  working: "Working", waiting: "Paused", finished: "Finished", idle: "Idle",
  retry: "Retry connection", reconnecting: "Connection lost. Showing the last saved research.",
  unavailable: "This research is unavailable. Sign in again or return to the conversation.",
  finish: "Write with what you have", finishing: "Finishing with the evidence gathered so far",
  limit: "limit",
};

const TABS = [
  { id: "sources", label: "Sources" },
  { id: "evidence", label: "Evidence" },
  { id: "activity", label: "Activity" },
  { id: "researchers", label: "Researchers" },
  { id: "plan", label: "Plan" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/**
 * A research run in the conversation, while it works: Deep Field.
 *
 * Laid out like Memory, the page it belongs with: a mono line saying what is
 * happening, the question in Newsreader, then the field (the run's real
 * sources on their orbits) beside the questions it is answering, the figures,
 * the newest evidence in the sources' own words, and the controls. The
 * machinery (every source, the coverage, the activity, the researchers and
 * the plan) is one disclosure below. Nothing here is boxed: it is a section
 * of the conversation, separated by hairlines.
 */
export function ResearchConsole({ run, state, events, busy, notice, post, className, disconnected = false, failed = false, reload, fetchedAt }: {
  run: ResearchRunView; state: ResearchState; events: ResearchEventDTO[]; busy: boolean; notice: string | null;
  post: (path: string, body: Record<string, unknown>) => Promise<boolean>; className?: string;
  disconnected?: boolean; failed?: boolean; reload?: () => Promise<unknown>; fetchedAt?: number | null;
}) {
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  const onStarted = React.useCallback(() => titleRef.current?.focus(), []);
  const model = React.useMemo(() => researchWorkspace(run, events), [run, events]);
  const [tab, setTab] = React.useState<Tab>("sources");
  const [expanded, setExpanded] = React.useState(false);
  const [guideOpen, setGuideOpen] = React.useState(false);
  const [guidance, setGuidance] = React.useState("");
  const [guided, setGuided] = React.useState(false);
  const guideId = React.useId();
  const detailsId = React.useId();
  const awaitingPlan = state === "awaiting_plan_confirmation";
  const awaitingClarify = state === "awaiting_clarification";
  const atGate = awaitingPlan || awaitingClarify;
  const phase = phaseOfRun(run, events);
  const controls = panelControls(run, phase);
  const clock = researchClock(run, phase, fetchedAt ?? null);
  const working = isWorkingResearchState(state) && !disconnected && !failed;
  const host = React.useMemo(() => readingHost(run, events), [run, events]);
  const lastSeq = events.at(-1)?.seq;
  const disabled = busy || disconnected || failed;
  const steering = run.steering?.at(-1) ?? null;
  const findings = (run.latestFindings ?? []).slice(0, 2);
  const answers = run.emergingAnswers ?? [];
  const writing = phase === "writing" || phase === "checking";
  // The engine recovering (a second planner, wider searches, a retried step), in its own words.
  const recovery = recoveryLine(events, isWorkingResearchState(state) && !disconnected && !failed);
  const subtitle = run.title && run.title.trim() !== run.goal.trim() ? run.goal : null;

  return (
    <section aria-label={FEATURE_NAMES.research.accessibleLabel} data-research-workspace data-state={state} className={cn("rf min-w-0", className)}>
      <header className="rf-rise" style={{ ["--i" as string]: 0 }}>
        <div className="rf-annot flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 whitespace-nowrap text-foreground">{FEATURE_NAMES.research.label}</span>
            <span aria-hidden>·</span>
            <span className="min-w-0 truncate" aria-live="polite">
              {controls.finishing ? WORKSPACE_COPY.finishing : <PhraseWithArgs spec={rowLine(phase, run)} />}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-3 tabular-nums">
            <RunClock elapsedMs={clock.elapsedMs} since={disconnected || failed ? null : clock.since} showAfterMs={0} />
            <span>
              {formatMicroUsd(run.costMicroUsd)}
              {run.budgetMicroUsd ? ` / ${formatMicroUsd(run.budgetMicroUsd)} ${WORKSPACE_COPY.limit}` : ""}
            </span>
          </span>
        </div>
        <h3 ref={titleRef} tabIndex={-1} lang={run.language ?? undefined} className="rf-title mt-3 outline-none">
          {run.title || run.goal}
        </h3>
        {subtitle && <p lang={run.language ?? undefined} className="mt-2 max-w-[38rem] text-pretty text-ui text-muted-foreground">{subtitle}</p>}
        {recovery && (
          <p key={recovery} role="status" className="rf-annot rf-recovery mt-3">
            <ThinkingMark phase="working" size={12} />
            {recovery}
          </p>
        )}
      </header>

      {(disconnected || failed) && (
        <div className="rf-notice" role="alert">
          <p>{failed ? WORKSPACE_COPY.unavailable : WORKSPACE_COPY.reconnecting}</p>
          {reload && <Button variant="outline" size="sm" onClick={() => void reload()}>{WORKSPACE_COPY.retry}</Button>}
        </div>
      )}

      {awaitingClarify ? (
        <div className="rf-gate rf-rise" style={{ ["--i" as string]: 1 }}>
          <ClarifyGate key={`${run.id}-clarify`} goal={run.goal} questions={run.plan.clarifications ?? []} busy={disabled} onSubmit={answers => void post("/clarify", { answers })} />
        </div>
      ) : awaitingPlan ? (
        <div className="rf-gate rf-rise" style={{ ["--i" as string]: 1 }}>
          <ScopeCard runId={run.id} atTail embedded onStarted={onStarted} />
        </div>
      ) : (
        <>
          <div className="rf-stage rf-rise" style={{ ["--i" as string]: 1 }}>
            <DeepField
              sources={run.sources}
              currentHost={host}
              working={working}
              eventKey={working ? lastSeq : undefined}
              counts={{ found: model.found, read: model.read, cited: model.cited }}
            />
            <QuestionRail questions={model.questions} working={working} language={run.language} sources={run.sources} eventKey={lastSeq} />
          </div>

          <dl className="rf-figures rf-rise" style={{ ["--i" as string]: 2 }}>
            <Figure label={WORKSPACE_COPY.found}><RollingNumber value={model.found} /></Figure>
            <Figure label={WORKSPACE_COPY.read}><RollingNumber value={model.read} /></Figure>
            <Figure label={WORKSPACE_COPY.cited}>{model.cited == null ? <span className="text-muted-foreground">–</span> : <RollingNumber value={model.cited} />}</Figure>
            <Figure label={WORKSPACE_COPY.researchers}><RollingNumber value={model.activeWorkers} /></Figure>
          </dl>

          {answers.length > 0 ? (
            <EmergingAnswers answers={answers} questions={model.questions} language={run.language} writing={writing} className="rf-rise" />
          ) : findings.length > 0 && (
            <section className="rf-evidence rf-rise" style={{ ["--i" as string]: 3 }} aria-label={WORKSPACE_COPY.evidence}>
              <h4 className="rf-annot">{WORKSPACE_COPY.evidence}</h4>
              <ul>
                {findings.map(finding => (
                  <li key={finding.id} className="rf-finding">
                    <p lang={run.language ?? undefined} className="rf-claim">{finding.claim}</p>
                    {isRenderableSourceUrl(finding.url) && (
                      <a href={finding.url} target="_blank" rel="noopener noreferrer" title={finding.title} className="rf-annot rf-link">
                        <bdi translate="no">{hostOf(finding.url)}</bdi>
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <div className="rf-controls">
        {model.canGuide && (
          <Button variant="secondary" size="sm" aria-expanded={guideOpen} aria-controls={guideId} disabled={disabled} onClick={() => setGuideOpen(value => !value)}>
            {WORKSPACE_COPY.guide}
          </Button>
        )}
        {controls.pause && <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void post("/control", { action: "pause" })}><Pause className="size-3.5" aria-hidden />{WORKSPACE_COPY.pause}</Button>}
        {controls.resume && <Button variant="secondary" size="sm" disabled={disabled} onClick={() => void post("/control", { action: "resume" })}><Play className="size-3.5" aria-hidden />{WORKSPACE_COPY.resume}</Button>}
        {!atGate && controls.finish !== "hidden" && <Button variant="ghost" size="sm" disabled={disabled || controls.finish === "disabled"} onClick={() => void post("/control", { action: "finish" })}>{WORKSPACE_COPY.finish}</Button>}
        {controls.cancel && !awaitingPlan && <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={busy} onClick={() => void post("/control", { action: "cancel" })}>{WORKSPACE_COPY.stop}</Button>}
      </div>

      <div id={guideId} inert={!guideOpen || !model.canGuide}>
        <Collapse open={guideOpen && model.canGuide}>
          <form className="rf-guidance" onSubmit={async event => {
            event.preventDefault();
            if (!guidance.trim() || disabled) return;
            const ok = await post("/steer", { guidance: guidance.trim() });
            if (ok) { setGuidance(""); setGuided(true); }
          }}>
            <label htmlFor={`${guideId}-field`} className="rf-h4 mb-3 block">{WORKSPACE_COPY.guidance}</label>
            <textarea id={`${guideId}-field`} value={guidance} maxLength={1000} disabled={disabled} placeholder={WORKSPACE_COPY.placeholder} onChange={event => { setGuidance(event.target.value); setGuided(false); }} />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button size="sm" type="submit" disabled={disabled || !guidance.trim()}>{WORKSPACE_COPY.addGuidance}</Button>
              <p className="flex-1 text-caption text-muted-foreground">{WORKSPACE_COPY.guidanceNote}</p>
            </div>
            {guided && <p role="status" className="mt-3 text-caption text-foreground">{WORKSPACE_COPY.guidanceQueued}</p>}
          </form>
        </Collapse>
      </div>

      {steering && (
        <p className="rf-steering">
          <span className="rf-annot">{steering.appliedAtRound === null ? WORKSPACE_COPY.queued : WORKSPACE_COPY.applied}</span>
          <span lang={run.language ?? undefined}>{steering.text}</span>
        </p>
      )}

      {!atGate && (
        <div className="rf-details">
          <button type="button" className="rf-disclosure" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}>
            {expanded ? WORKSPACE_COPY.hideDetails : WORKSPACE_COPY.details}
            <ChevronDown className={cn("size-4 transition-transform duration-base motion-reduce:transition-none", expanded && "rotate-180")} aria-hidden />
          </button>
          <div id={detailsId} inert={!expanded}>
            <Collapse open={expanded} innerClassName="pb-1">
              <div role="tablist" aria-label="Research details" className="rf-tabs">
                {TABS.map(item => (
                  <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} aria-controls={`${detailsId}-panel`} onClick={() => setTab(item.id)}>
                    {item.label}
                  </button>
                ))}
              </div>
              <div key={tab} id={`${detailsId}-panel`} role="tabpanel" className="rf-view-enter min-w-0 pt-5">
                {tab === "sources" && <SourceDeck sources={run.sources} />}
                {tab === "evidence" && <EvidencePanel objectives={run.plan.objectives ?? []} coverage={run.plan.coverage ?? []} conflicts={(run.plan.conflicts ?? []).filter(item => !item.resolved)} sources={run.sources} empty={<p className="text-ui text-muted-foreground">{WORKSPACE_COPY.noEvidence}</p>} />}
                {tab === "activity" && <RunTimeline events={events} live={run.live} empty={<p className="text-ui text-muted-foreground">{WORKSPACE_COPY.noActivity}</p>} />}
                {tab === "researchers" && (model.workers.length ? (
                  <ul className="rf-rows">
                    {model.workers.map((worker, index) => (
                      <li key={worker.id}>
                        <span className="min-w-0">{worker.label === "Researcher" ? `Researcher ${index + 1}` : worker.label}</span>
                        <span className="rf-annot shrink-0">{worker.state === "finished" ? WORKSPACE_COPY.finished : state === "paused" ? WORKSPACE_COPY.waiting : working ? WORKSPACE_COPY.working : WORKSPACE_COPY.idle}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-ui text-muted-foreground">{WORKSPACE_COPY.noResearchers}</p>)}
                {tab === "plan" && <PlanOutline approach={run.plan.approach || undefined} objectives={run.plan.objectives ?? []} steps={run.plan.steps ?? []} queries={run.plan.queries} successCriteria={run.plan.successCriteria} risks={run.plan.risks} />}
              </div>
            </Collapse>
          </div>
        </div>
      )}
      {(run.error || notice) && <p role="alert" className="mt-4 text-ui text-destructive">{notice ?? run.error}</p>}
    </section>
  );
}
