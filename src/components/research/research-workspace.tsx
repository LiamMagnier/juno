"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { ArrowUp, Pause, Play, Plus, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResearchConsole } from "./research-console";
import { reportBody } from "./report-dialog";
import { useResearchRun } from "./use-research-run";
import { RESEARCH_EFFORT_COPY } from "./effort-copy";
import { startResearchSchema, steerResearchSchema } from "@/app/api/research/protocol";
import { isResearchState, RESEARCH_STATE_MESSAGE, type ResearchEffort } from "@/lib/research/domain";
import { cn } from "@/lib/utils";

const ReportReader = dynamic(() => import("./report-reader").then(module => module.ReportReader));
type RecentRun = { id: string; goal: string; state: string; sourceCount: number };
const EFFORTS: { value: ResearchEffort; label: string; description: string }[] = RESEARCH_EFFORT_COPY.map((tier) => ({
  value: tier.value,
  label: tier.label,
  description: `${tier.note} · ${tier.summary} · ${tier.eta}`,
}));

export function ResearchWorkspace({ runId = null }: { runId?: string | null }) {
  const router = useRouter();
  const [recent, setRecent] = React.useState<RecentRun[]>([]);
  const [listError, setListError] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  React.useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch("/api/research", { signal: controller.signal });
        if (!response.ok) throw new Error("History unavailable");
        const data = await response.json();
        if (!controller.signal.aborted) { setRecent(data.runs ?? []); setListError(false); }
      } catch { if (!controller.signal.aborted) setListError(true); }
      if (!controller.signal.aborted) timer = setTimeout(load, 15_000);
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [runId]);
  return <div className="flex min-h-0 flex-1 flex-col bg-background">
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-8">
      <h1 className="font-serif text-title">Research</h1>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" className="lg:hidden" aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}>History</Button>
        <Button variant="outline" size="sm" onClick={() => { setHistoryOpen(false); router.push("/research"); }}><Plus className="mr-1.5 size-4" />New research</Button>
      </div>
    </header>
    <div className="flex min-h-0 flex-1">
      <aside aria-label="Recent research" className={cn("w-64 shrink-0 overflow-y-auto border-r border-border p-3", historyOpen ? "block w-full lg:w-64" : "hidden lg:block")}>
        <p className="px-3 py-3 text-ui font-medium">Recent research</p>
        {listError && <p role="status" className="px-3 text-ui text-muted-foreground">History could not load. Retrying…</p>}
        {!listError && recent.length === 0 && <p className="px-3 py-2 text-ui leading-relaxed text-muted-foreground">Your plans and reports will appear here.</p>}
        {recent.map(item => <button type="button" key={item.id} aria-current={item.id === runId ? "page" : undefined} onClick={() => { setHistoryOpen(false); router.push(`/research/${encodeURIComponent(item.id)}`); }} className={cn("mb-1 block w-full rounded-control px-3 py-3 text-left transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none", item.id === runId ? "bg-secondary" : "hover:bg-secondary/60")}>
          <span className="line-clamp-2 font-serif text-body leading-snug">{item.goal}</span><span className="mt-1.5 block text-caption text-muted-foreground">{item.sourceCount} sources · {isResearchState(item.state) ? RESEARCH_STATE_MESSAGE[item.state] : item.state}</span>
        </button>)}
      </aside>
      <main className={cn("app-page-scroll min-w-0 flex-1", historyOpen && "hidden lg:block")}>
        <div className="mx-auto w-full max-w-6xl px-5 py-8 sm:px-8 sm:py-10 xl:px-10">
          {runId ? <ResearchDetail key={runId} runId={runId} /> : <ResearchBrief onStarted={id => router.push(`/research/${encodeURIComponent(id)}`)} />}
        </div>
      </main>
    </div>
  </div>;
}

export function ResearchBrief({ onStarted }: { onStarted: (id: string) => void }) {
  const [goal, setGoal] = React.useState("");
  const [focus, setFocus] = React.useState("");
  const [sources, setSources] = React.useState("");
  const [effort, setEffort] = React.useState<ResearchEffort>("standard");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const submitting = React.useRef(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (submitting.current) return;
    const parsed = startResearchSchema.safeParse({ goal, effort, constraints: focus.trim() ? [focus.trim()] : [], pinnedSources: sources.split(/\n/).map(value => value.trim()).filter(Boolean) });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Check your research brief."); return; }
    submitting.current = true; setBusy(true); setError(null);
    try {
      const response = await fetch("/api/research", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed.data) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? data.error ?? "Research could not start.");
      if (!data.run?.id) throw new Error("The server did not return a research run. Check history before retrying.");
      onStarted(data.run.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Research could not start."); }
    finally { setBusy(false); submitting.current = false; }
  };
  return <form onSubmit={submit} className="research-enter mx-auto max-w-2xl">
    <h2 className="text-balance font-serif text-page-title font-normal leading-tight sm:text-display">Go deeper into a question.</h2>
    <p className="mt-4 max-w-lg text-body leading-relaxed text-muted-foreground">Build a plan, explore the evidence, and come back to a report with sources you can check.</p>
    <label htmlFor="research-question" className="mt-9 block text-ui font-medium">What would you like to understand?</label>
    <textarea id="research-question" required minLength={8} maxLength={4000} rows={4} value={goal} disabled={busy} onChange={event => setGoal(event.target.value)} placeholder="Describe your question and what a useful answer would cover…" className="research-field mt-3 resize-y" />
    <fieldset className="mt-6" disabled={busy}><legend className="text-ui font-medium">Research depth</legend><div className="mt-3 grid gap-2 sm:grid-cols-3">{EFFORTS.map(item => <label key={item.value} className={cn("cursor-pointer rounded-field border p-3 transition-colors duration-fast motion-reduce:transition-none", effort === item.value ? "border-primary bg-primary/5" : "border-border hover:bg-secondary")}><span className="flex items-center gap-2 text-ui font-medium"><input type="radio" name="effort" value={item.value} checked={effort === item.value} onChange={() => setEffort(item.value)} className="accent-primary" />{item.label}</span><span className="mt-2 block text-caption leading-relaxed text-muted-foreground">{item.description}</span></label>)}</div></fieldset>
    <details className="mt-6 border-y border-border py-4"><summary className="cursor-pointer text-ui font-medium">Focus and preferred sources <span className="font-normal text-muted-foreground">· optional</span></summary><div className="mt-4 space-y-4">
      <label className="block text-ui">Focus or constraints<textarea value={focus} maxLength={300} rows={2} disabled={busy} onChange={event => setFocus(event.target.value)} placeholder="Audience, region, date range, or questions to prioritize" className="research-field mt-2" /></label>
      <label className="block text-ui">Sources to read first<textarea value={sources} rows={3} disabled={busy} onChange={event => setSources(event.target.value)} placeholder="https://example.com/report — one URL per line" className="research-field mt-2" /></label>
      <p className="text-caption text-muted-foreground">Juno searches the public web and prioritizes these URLs. Preferred sources do not restrict the rest of the search. Up to 24 URLs.</p>
    </div></details>
    {error && <p role="alert" className="mt-4 text-ui text-destructive">{error}</p>}
    <div className="mt-6 flex flex-wrap items-center gap-4"><Button type="submit" disabled={busy || goal.trim().length < 8}>{busy ? "Preparing your plan…" : "Create research plan"}<ArrowUp className="ml-2 size-4 rotate-45" /></Button><p className="text-caption text-muted-foreground">Review and edit the plan before research begins.</p></div>
  </form>;
}

function ResearchDetail({ runId }: { runId: string }) {
  const { run, events, busy, notice, post, failed, reload } = useResearchRun(runId);
  const [showProcess, setShowProcess] = React.useState(false);
  const [steer, setSteer] = React.useState("");
  const [inputError, setInputError] = React.useState<string | null>(null);
  if (failed) return <div role="alert"><h2 className="font-serif text-title">Research unavailable</h2><p className="mt-3 text-ui text-muted-foreground">This run could not be found or your session has expired.</p><Button className="mt-4" variant="outline" onClick={() => void reload()}>Try again</Button></div>;
  if (!run) return <div role="status"><p className="text-ui text-muted-foreground">Loading your research…</p><Button variant="ghost" className="mt-4" onClick={() => void reload()}>Retry loading</Button></div>;
  const state = isResearchState(run.state) ? run.state : "failed";
  const canSteer = run.live && ["investigating", "reviewing", "paused", "awaiting_user_input"].includes(state);
  const submitSteer = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy) return;
    const text = steer.trim();
    const parsed = steerResearchSchema.safeParse(/^https?:\/\/\S+$/.test(text) ? { sourceUrl: text } : { constraint: text });
    if (!parsed.success) { setInputError(parsed.error.issues[0]?.message ?? "Check your instruction."); return; }
    setInputError(null); if (await post("/steer", parsed.data)) setSteer("");
  };
  const hasReport = !!run.report && !run.live;
  return <div className="research-enter">
    {hasReport && <div className="mb-6 flex flex-wrap items-center justify-between gap-3"><p role="status" className="text-ui text-muted-foreground">{RESEARCH_STATE_MESSAGE[state]}</p><Button variant="ghost" size="sm" onClick={() => setShowProcess(value => !value)}>{showProcess ? "Read report" : "Inspect research"}</Button></div>}
    {hasReport && !showProcess ? <ReportReader report={reportBody(run.report!)} sources={run.sources} /> : <ResearchConsole run={run} state={state} events={events} busy={busy} notice={notice} post={post} />}
    {run.live && state !== "awaiting_plan_confirmation" && <div className="mt-6 flex flex-wrap items-center gap-2">
      {state === "paused" ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void post("/control", {action:"resume"})}><Play className="mr-2 size-3.5" />Resume</Button> : <Button variant="outline" size="sm" disabled={busy} onClick={() => void post("/control", {action:"pause"})}><Pause className="mr-2 size-3.5" />Pause</Button>}
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void post("/control", {action:"cancel"})}><Square className="mr-2 size-3.5" />Stop</Button>
      <p className="text-caption text-muted-foreground">{state === "paused" ? "Your progress is saved." : "Research continues when you leave this page."}</p>
    </div>}
    {canSteer && <form onSubmit={submitSteer} className="mt-7"><label htmlFor="research-steer" className="mb-2 block text-ui font-medium">Adjust the focus</label><div className="flex items-center gap-2 rounded-field border border-border bg-card p-2"><input id="research-steer" value={steer} disabled={busy} maxLength={400} onChange={event => setSteer(event.target.value)} placeholder="Add a constraint or a source URL…" className="min-w-0 flex-1 bg-transparent px-2 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring" /><Button type="submit" size="icon-sm" aria-label="Update research focus" disabled={busy || steer.trim().length < 3}><ArrowUp className="size-4" /></Button></div>{inputError && <p role="alert" className="mt-2 text-ui text-destructive">{inputError}</p>}</form>}
    {!run.live && !run.report && <p className="mt-5 text-ui text-muted-foreground">No report was produced. Any gathered sources remain available above.</p>}
  </div>;
}
