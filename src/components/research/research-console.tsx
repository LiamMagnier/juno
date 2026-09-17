"use client";

import * as React from "react";
import { ChevronDown, Pause, Play, Square, X } from "lucide-react";
import { EvidencePanel } from "./evidence-panel";
import { ClarifyGate, PlanOutline, PlanReview } from "./run-controls";
import { workingElapsedMs } from "./run-clock";
import { formatMicroUsd } from "./run-format";
import { RunSpine, type StageYield } from "./run-spine";
import { RunTimeline } from "./run-timeline";
import { SourceDeck } from "./source-deck";
import { hostOf } from "@/components/chat/source-chip";
import { formatSpan } from "@/lib/run-receipt";
import { cn } from "@/lib/utils";
import { RESEARCH_STATE_MESSAGE, isWorkingResearchState, type ResearchEventDTO, type ResearchState } from "@/lib/research/domain";
import type { ResearchRunView } from "./use-research-run";

/**
 * A run being watched.
 *
 * The card opens with the question, set as the recap sets the report's title,
 * because that is the one thing on it a person cannot get from anywhere else
 * — "Researching your question" above it said nothing the question did not
 * (PREMIUM_AUDIT rule 15). Under it, in order: the one state sentence, the
 * four acts with the live one marked, and a line of facts a person watching
 * paid work actually asks about — how long, how much, what it has found, what
 * it is reading right now. The machinery (sources, activity, plan, evidence)
 * is one disclosure down, and the disclosure opens on Activity because a live
 * run's question is "is it doing anything".
 *
 * The rail used to sit INSIDE that disclosure, so a live run collapsed to a
 * label, a sentence and a middot line — the panel one level up promised "five
 * acts with the live one open" and drew none of them.
 */
const CONSOLE_COPY = {
  oneQuery: "query", queries: "queries", found: "found", read: "read", checked: "checked",
  of: "of",
  sourcesRead: "sources read",
  working: "researchers working",
  reported: "researchers reported",
  findings: "findings",
  show: "View research activity",
  hide: "Hide research details",
  noActivity: "Nothing yet — steps appear here as researchers search and read.",
  noEvidence: "Nothing yet — what each question rests on appears here as sources are read.",
  noPlan: "The plan appears here once Juno has worked out what to look up.",
};
export function stageYields(run: ResearchRunView): StageYield {
  const read = run.sources.filter((source) => source.read).length;
  const queries = run.plan.queries.length;
  const coverage = run.plan.coverage ?? [];
  const satisfied = coverage.filter((entry) => entry.status === "satisfied").length;
  return {
    plan: queries > 0 ? `${queries} ${queries === 1 ? CONSOLE_COPY.oneQuery : CONSOLE_COPY.queries}` : null,
    investigate:
      run.sources.length > 0
        ? `${run.sources.length} ${CONSOLE_COPY.found}${read > 0 ? ` · ${read} ${CONSOLE_COPY.read}` : ""}`
        : null,
    review: coverage.length > 0 ? `${satisfied}/${coverage.length} ${CONSOLE_COPY.checked}` : null,
    write: null,
  };
}

/**
 * The working clock, as its own leaf so the 1s tick re-renders one span and
 * not the deck, the timeline and the evidence panel under it. `now` is read in
 * an effect, never during render: the console is server-rendered on the chat
 * page and `Date.now()` in render is a hydration mismatch by construction.
 * The interval runs only while the run is working; a parked run's figure is
 * fixed by the log and needs no clock.
 */
function RunClock({ events, state, createdAt }: { events: ResearchEventDTO[]; state: ResearchState; createdAt?: string }) {
  const working = isWorkingResearchState(state);
  const [now, setNow] = React.useState<number | null>(null);
  React.useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    if (!working) return;
    const interval = window.setInterval(tick, 1_000);
    return () => window.clearInterval(interval);
  }, [working]);
  if (now === null) return null;
  const ms = workingElapsedMs(events, { state, createdAt }, now);
  if (ms === null) return null;
  return <span className="tabular-nums">{formatSpan(ms, { live: true })}</span>;
}

export function ResearchConsole({ run, state, events, busy, notice, post, onDismiss, className }: {
  run: ResearchRunView; state: ResearchState; events: ResearchEventDTO[]; busy: boolean; notice: string | null;
  post: (path: string, body: Record<string, unknown>) => Promise<boolean>; onDismiss?: () => void; className?: string;
}) {
  // Activity, not Sources: this console only ever mounts for a run that is
  // still going (the recap takes over at the terminal states), and the tab a
  // person opens on a live run is the one that moves.
  const [tab, setTab] = React.useState("activity");
  const [expanded, setExpanded] = React.useState(false);
  const awaitingPlan = state === "awaiting_plan_confirmation";
  // The two gates are mutually exclusive states, but they share the header and
  // the panel, so "is a person being asked something" is one flag.
  const awaitingClarify = state === "awaiting_clarification";
  const atGate = awaitingPlan || awaitingClarify;
  const latest = [...events].reverse().find(event => event.kind === "source_read" || event.kind === "query_issued");
  const detail = typeof latest?.payload.url === "string" ? hostOf(latest.payload.url) : typeof latest?.payload.query === "string" ? latest.payload.query : null;
  const team = React.useMemo(() => {
    const spawned = new Set<string>();
    const finished = new Set<string>();
    let findings = 0;
    for (const event of events) {
      const workerId = typeof event.payload.workerId === "string" ? event.payload.workerId : "";
      if (event.kind === "worker_spawned" && workerId) spawned.add(workerId);
      else if (event.kind === "worker_finished" && workerId) finished.add(workerId);
      else if (event.kind === "worker_tool_call" && event.payload.tool === "note_finding" && event.payload.ok !== false) findings += 1;
    }
    return { total: spawned.size, working: [...spawned].filter((id) => !finished.has(id)).length, findings };
  }, [events]);
  const planEmpty = !run.plan.approach && (run.plan.objectives?.length ?? 0) === 0 && (run.plan.steps?.length ?? 0) === 0 && run.plan.queries.length === 0;
  // Not `emptyNote`: scripts/generate-i18n-catalog.mjs harvests every string
  // literal inside a variable whose name ends in Note/Copy/Label, class lists
  // included. The copy this draws lives in CONSOLE_COPY, where it belongs.
  const emptyLine = (text: string) => <p className="text-ui text-muted-foreground">{text}</p>;
  return <section aria-label="Deep research" className={cn("research-surface research-enter relative min-w-0", className)}>
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        {atGate
          // The gate labels earn their line: "Before Juno starts" says something
          // the question does not, and the gates print the question themselves.
          ? <p className="text-ui font-medium">{awaitingClarify ? "Before Juno starts" : "Your research plan"}</p>
          : <h3 className="line-clamp-2 text-balance font-serif text-title font-normal leading-snug tracking-tight text-foreground">{run.goal}</h3>}
        <p role="status" className="mt-1 text-caption text-muted-foreground">{RESEARCH_STATE_MESSAGE[state]}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!atGate && run.live && <>
          <button type="button" disabled={busy} aria-label={state === "paused" ? "Resume research" : "Pause research"} title={state === "paused" ? "Resume research" : "Pause research"} onClick={() => void post("/control", { action: state === "paused" ? "resume" : "pause" })} className="research-icon disabled:opacity-50">{state === "paused" ? <Play className="size-4" /> : <Pause className="size-4" />}</button>
          <button type="button" disabled={busy} aria-label="Stop research" title="Stop research" onClick={() => void post("/control", { action: "cancel" })} className="research-icon disabled:opacity-50"><Square className="size-3.5" /></button>
        </>}
        {onDismiss && !run.live && <button type="button" aria-label="Hide this research run" onClick={onDismiss} className="research-icon"><X className="size-4" /></button>}
      </div>
    </header>
    {awaitingClarify ? <div className="mt-5"><ClarifyGate key={`${run.id}-clarify`} goal={run.goal} questions={run.plan.clarifications ?? []} busy={busy} onSubmit={answers => void post("/clarify", { answers })} /></div> : awaitingPlan ? <div className="mt-5"><PlanReview key={run.id} goal={run.goal} effort={run.plan.effort ?? null} budgetMicroUsd={run.budgetMicroUsd} steps={run.plan.steps ?? []} queries={run.plan.queries} constraints={run.plan.constraints ?? []} pinnedSources={run.plan.pinnedSources ?? []} approach={run.plan.approach || undefined} objectives={run.plan.objectives ?? []} successCriteria={run.plan.successCriteria} risks={run.plan.risks} busy={busy} onConfirm={plan => void post("/plan", { decision: "confirm", ...plan })} onDiscard={() => void post("/plan", { decision: "cancel" })} /></div> : <>
      <RunSpine className="mt-5" state={state} live={run.live} yields={stageYields(run)} />
      <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
        <RunClock events={events} state={state} createdAt={run.createdAt} />
        {/* The ceiling beside the spend, while there is still time to act on
            it. It used to surface only in the Activity tab's "Stopped at the
            research budget" note — after it had truncated the report. */}
        <span className="tabular-nums">{formatMicroUsd(run.costMicroUsd)}{run.budgetMicroUsd ? ` ${CONSOLE_COPY.of} ${formatMicroUsd(run.budgetMicroUsd)}` : ""}</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">{run.sources.filter(source => source.read).length} {CONSOLE_COPY.sourcesRead}</span>
        {team.total > 0 && <>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{team.working > 0 ? `${team.working} ${CONSOLE_COPY.of} ${team.total} ${CONSOLE_COPY.working}` : `${team.total} ${CONSOLE_COPY.reported}`}</span>
          {team.findings > 0 && <><span aria-hidden>·</span><span className="tabular-nums">{team.findings} {CONSOLE_COPY.findings}</span></>}
        </>}
        {detail && <><span aria-hidden>·</span><span className="min-w-0 truncate">{detail}</span></>}
      </div>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} className="mt-4 flex min-h-9 w-full items-center justify-between border-t border-border pt-3 text-ui text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {expanded ? CONSOLE_COPY.hide : CONSOLE_COPY.show}<ChevronDown className={cn("size-4 transition-transform duration-fast motion-reduce:transition-none", expanded && "rotate-180")} />
      </button>
      {expanded && <div className="research-tab-body">
        <nav aria-label="Research view" className="flex gap-4 overflow-x-auto border-b border-border">
          {[{value:"activity",label:"Activity"},{value:"sources",label:"Sources"},{value:"plan",label:"Plan"},{value:"evidence",label:"Evidence"}].map(item => <button key={item.value} type="button" aria-pressed={tab === item.value} onClick={() => setTab(item.value)} className={cn("shrink-0 border-b-2 px-1 py-3 text-ui focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", tab === item.value ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{item.label}</button>)}
        </nav>
        {/* Every tab says something when it has nothing: a tab opened during
            planning used to render a bare region, and an empty region under a
            tab bar reads as a broken tab, not an early one. The empty copy
            lives here rather than in the panels because the recap mounts the
            same panels in a stack that relies on them rendering nothing. */}
        <div key={tab} className="research-tab-body" role="region" aria-label={tab}>
          {tab === "plan" && (planEmpty ? emptyLine(CONSOLE_COPY.noPlan) : <PlanOutline approach={run.plan.approach || undefined} objectives={run.plan.objectives ?? []} steps={run.plan.steps ?? []} queries={run.plan.queries} successCriteria={run.plan.successCriteria} risks={run.plan.risks} />)}
          {tab === "sources" && <SourceDeck sources={run.sources} />}
          {tab === "activity" && <RunTimeline events={events} live={run.live} empty={emptyLine(CONSOLE_COPY.noActivity)} />}
          {tab === "evidence" && <EvidencePanel objectives={run.plan.objectives ?? []} coverage={run.plan.coverage ?? []} conflicts={(run.plan.conflicts ?? []).filter(item => !item.resolved)} sources={run.sources} empty={emptyLine(CONSOLE_COPY.noEvidence)} />}
        </div>
      </div>}
    </>}
    {(run.error || notice) && <p role="alert" className="mt-4 rounded-field bg-destructive/10 p-3 text-ui text-destructive">{run.error ?? notice}</p>}
  </section>;
}
