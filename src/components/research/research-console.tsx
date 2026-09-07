"use client";

import * as React from "react";
import { X } from "lucide-react";
import { EvidencePanel } from "./evidence-panel";
import { PlanReview } from "./run-controls";
import { RunSpine, type StageYield } from "./run-spine";
import { RunTimeline } from "./run-timeline";
import { SourceDeck } from "./source-deck";
import { hostOf } from "@/components/chat/source-chip";
import { cn } from "@/lib/utils";
import { type ResearchEventDTO, type ResearchState } from "@/lib/research/domain";
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
  const [tab, setTab] = React.useState("overview");
  const awaitingPlan = state === "awaiting_plan_confirmation";
  const latest = [...events].reverse().find(event => event.kind === "source_read" || event.kind === "query_issued");
  const detail = typeof latest?.payload.url === "string" ? hostOf(latest.payload.url) : typeof latest?.payload.query === "string" ? latest.payload.query : null;
  return <section aria-label="Deep research" className={cn("research-surface relative min-w-0", className)}>
    <header className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-balance font-serif text-title font-normal leading-tight sm:text-page-title">{run.goal}</h2>
        <p className="mt-3 text-ui text-muted-foreground">{run.sources.length} sources found · {run.sources.filter(source => source.read).length} read</p>
      </div>
      {onDismiss && !run.live && <button type="button" aria-label="Hide this research run" onClick={onDismiss} className="research-icon"><X className="size-4" /></button>}
    </header>
    {awaitingPlan ? <div className="mt-7"><PlanReview key={run.id} steps={run.plan.steps ?? []} queries={run.plan.queries} constraints={run.plan.constraints ?? []} pinnedSources={run.plan.pinnedSources ?? []} busy={busy} onConfirm={plan => void post("/plan", { decision: "confirm", ...plan })} onDiscard={() => void post("/plan", { decision: "cancel" })} /></div> : <>
      <RunSpine state={state} live={run.live} detail={detail} yields={stageYields(run)} className="mt-8" />
      <nav aria-label="Research view" className="mt-7 flex gap-5 overflow-x-auto border-b border-border">
        {[{value:"overview",label:"Overview"},{value:"sources",label:"Sources"},{value:"activity",label:"Activity"},{value:"evidence",label:"Evidence"}].map(item => <button key={item.value} type="button" aria-pressed={tab === item.value} onClick={() => setTab(item.value)} className={cn("shrink-0 border-b-2 px-1 py-3 text-ui focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", tab === item.value ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>{item.label}</button>)}
      </nav>
      <div key={tab} className="research-tab-body" role="region" aria-label={tab}>
        {tab === "overview" && <>
          <h3 className="font-serif text-title">Research plan</h3>
          <ol className="mt-5 space-y-4">{(run.plan.steps?.length ? run.plan.steps : run.plan.queries).map((step,index) => <li key={index} className="flex items-start gap-3 text-body leading-relaxed"><span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-caption tabular-nums">{index+1}</span><span>{step}</span></li>)}</ol>
          {!run.plan.steps?.length && !run.plan.queries.length && <p className="mt-3 text-ui text-muted-foreground">Building an approach to your question…</p>}
          {run.plan.constraints.length > 0 && <div className="mt-6 border-t border-border pt-5"><h4 className="text-ui font-medium">Your focus</h4><ul className="mt-2 space-y-2 text-ui text-muted-foreground">{run.plan.constraints.map((value,index)=><li key={index}>{value}</li>)}</ul></div>}
          {detail && <div className="mt-7 border-t border-border pt-5"><h3 className="font-serif text-title">Latest activity</h3><p className="mt-3 break-words text-ui text-muted-foreground">{detail}</p></div>}
        </>}
        {tab === "sources" && <SourceDeck sources={run.sources} />}
        {tab === "activity" && <RunTimeline events={events} live={run.live} />}
        {tab === "evidence" && <EvidencePanel objectives={run.plan.objectives ?? []} coverage={run.plan.coverage ?? []} conflicts={(run.plan.conflicts ?? []).filter(item => !item.resolved)} sources={run.sources} />}
      </div>
    </>}
    {(run.error || notice) && <p role="alert" className="mt-5 rounded-field bg-destructive/10 p-3 text-ui text-destructive">{run.error ?? notice}</p>}
  </section>;
}
