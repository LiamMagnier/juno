"use client";

import * as React from "react";
import { ChevronDown, Pause, Play, Square, X } from "lucide-react";
import { EvidencePanel } from "./evidence-panel";
import { PlanReview } from "./run-controls";
import { RunSpine, type StageYield } from "./run-spine";
import { RunTimeline } from "./run-timeline";
import { SourceDeck } from "./source-deck";
import { hostOf } from "@/components/chat/source-chip";
import { cn } from "@/lib/utils";
import { RESEARCH_STATE_MESSAGE, type ResearchEventDTO, type ResearchState } from "@/lib/research/domain";
import type { ResearchRunView } from "./use-research-run";

const CONSOLE_COPY = { oneQuery: "query", queries: "queries", found: "found", read: "read", checked: "checked" };
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


export function ResearchConsole({ run, state, events, busy, notice, post, onDismiss, className }: {
  run: ResearchRunView; state: ResearchState; events: ResearchEventDTO[]; busy: boolean; notice: string | null;
  post: (path: string, body: Record<string, unknown>) => Promise<boolean>; onDismiss?: () => void; className?: string;
}) {
  const [tab, setTab] = React.useState("sources");
  const [expanded, setExpanded] = React.useState(false);
  const awaitingPlan = state === "awaiting_plan_confirmation";
  const latest = [...events].reverse().find(event => event.kind === "source_read" || event.kind === "query_issued");
  const detail = typeof latest?.payload.url === "string" ? hostOf(latest.payload.url) : typeof latest?.payload.query === "string" ? latest.payload.query : null;
  return <section aria-label="Deep research" className={cn("research-surface research-enter relative min-w-0", className)}>
    <header className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-ui font-medium">{awaitingPlan ? "Your research plan" : "Researching your question"}</p>
        <p role="status" className="mt-1 text-caption text-muted-foreground">{RESEARCH_STATE_MESSAGE[state]}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!awaitingPlan && run.live && <>
          <button type="button" disabled={busy} aria-label={state === "paused" ? "Resume research" : "Pause research"} title={state === "paused" ? "Resume research" : "Pause research"} onClick={() => void post("/control", { action: state === "paused" ? "resume" : "pause" })} className="research-icon disabled:opacity-50">{state === "paused" ? <Play className="size-4" /> : <Pause className="size-4" />}</button>
          <button type="button" disabled={busy} aria-label="Stop research" title="Stop research" onClick={() => void post("/control", { action: "cancel" })} className="research-icon disabled:opacity-50"><Square className="size-3.5" /></button>
        </>}
        {onDismiss && !run.live && <button type="button" aria-label="Hide this research run" onClick={onDismiss} className="research-icon"><X className="size-4" /></button>}
      </div>
    </header>
    {awaitingPlan ? <div className="mt-5"><PlanReview key={run.id} steps={run.plan.steps ?? []} queries={run.plan.queries} constraints={run.plan.constraints ?? []} pinnedSources={run.plan.pinnedSources ?? []} busy={busy} onConfirm={plan => void post("/plan", { decision: "confirm", ...plan })} onDiscard={() => void post("/plan", { decision: "cancel" })} /></div> : <>
      <p className="mt-4 line-clamp-2 text-ui leading-relaxed text-foreground/85">{run.goal}</p>
      <div className="mt-4 flex items-center gap-2 text-caption text-muted-foreground">
        <span className="tabular-nums">{run.sources.filter(source => source.read).length} sources read</span>
        {detail && <><span aria-hidden>·</span><span className="min-w-0 truncate">{detail}</span></>}
      </div>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} className="mt-4 flex min-h-9 w-full items-center justify-between border-t border-border pt-3 text-ui text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {expanded ? "Hide research details" : "View research activity"}<ChevronDown className={cn("size-4 transition-transform duration-fast motion-reduce:transition-none", expanded && "rotate-180")} />
      </button>
      {expanded && <div className="research-tab-body">
        <RunSpine state={state} live={run.live} yields={stageYields(run)} />
        <nav aria-label="Research view" className="mt-5 flex gap-4 overflow-x-auto border-b border-border">
          {[{value:"sources",label:"Sources"},{value:"activity",label:"Activity"},{value:"plan",label:"Plan"},{value:"evidence",label:"Evidence"}].map(item => <button key={item.value} type="button" aria-pressed={tab === item.value} onClick={() => setTab(item.value)} className={cn("shrink-0 border-b-2 px-1 py-3 text-ui focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", tab === item.value ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{item.label}</button>)}
        </nav>
        <div key={tab} className="research-tab-body" role="region" aria-label={tab}>
          {tab === "plan" && <ol className="space-y-3">{(run.plan.steps?.length ? run.plan.steps : run.plan.queries).map((step,index) => <li key={index} className="flex gap-3 text-ui leading-relaxed"><span className="text-muted-foreground">{index+1}.</span><span>{step}</span></li>)}</ol>}
          {tab === "sources" && <SourceDeck sources={run.sources} />}
          {tab === "activity" && <RunTimeline events={events} live={run.live} />}
          {tab === "evidence" && <EvidencePanel objectives={run.plan.objectives ?? []} coverage={run.plan.coverage ?? []} conflicts={(run.plan.conflicts ?? []).filter(item => !item.resolved)} sources={run.sources} />}
        </div>
      </div>}
    </>}
    {(run.error || notice) && <p role="alert" className="mt-4 rounded-field bg-destructive/10 p-3 text-ui text-destructive">{run.error ?? notice}</p>}
  </section>;
}
