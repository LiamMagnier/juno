"use client";

import * as React from "react";
import { Check, Loader2, Pause, Play, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, truncate } from "@/lib/utils";
import {
  RESEARCH_STAGES,
  RESEARCH_STAGE_LABEL,
  RESEARCH_STATE_MESSAGE,
  isResearchState,
  stageForState,
  type ResearchStage,
  type ResearchState,
} from "@/lib/research/domain";

/**
 * The durable research run, next to the conversation that started it.
 *
 * This is the panel the in-request pipeline could never have: the run outlives
 * the request, so there is something to show after a reload, something to pause
 * and something to steer. It replaces nothing in the chat timeline — the
 * timeline still narrates the turn as it streams — it is what remains when the
 * turn is over and the run is still going, or when the user comes back to it.
 *
 * Progress is shown as STAGES, not as events. The event log carries every
 * query, fetch and spend, and rendering all of it was the earlier mistake: a
 * fifty-line wall of "Searching the web" tells a person nothing about whether
 * to keep waiting. Six stages, one line of live copy and the sources as they
 * land is what actually answers "what is it doing and is it nearly done".
 */

interface ResearchSourceView {
  id: string;
  url: string;
  title: string;
  read: boolean;
  contentHash: string | null;
  fetchedAt: string;
}

interface ResearchRunView {
  id: string;
  goal: string;
  state: string;
  plan: {
    queries: string[];
    constraints: string[];
    pinnedSources: string[];
    confirmed: boolean;
    objectives?: Array<{ id: string; question: string; status: string }>;
    coverage?: Array<{
      objectiveId: string;
      requirementId: string;
      status: string;
      independentSourceCount: number;
      evidenceStrength: number;
      missingReason?: string;
    }>;
    conflicts?: Array<{ description: string; severity: string }>;
    followUpRound?: number;
  };
  auditSummary?: {
    claims: number;
    supported: number;
    partiallySupported: number;
    unsupported: number;
    contradicted: number;
    unverified: number;
    duplicateSources: number;
  } | null;
  costMicroUsd: string;
  budgetMicroUsd: string | null;
  error: string | null;
  report: string | null;
  live: boolean;
  sources: ResearchSourceView[];
}

interface RunPayload {
  run: ResearchRunView;
  lastSeq: number;
}

/**
 * Poll intervals, and why there are two.
 *
 * A run that is working changes every few seconds and a person is watching it;
 * a run that is waiting for a plan decision or paused changes only when that
 * same person does something, and polling it hard is a query per second for
 * nothing. Both are slower than the Work session stream on purpose — research
 * emits a handful of events a minute, not one a second.
 */
const WORKING_POLL_MS = 2_500;
const IDLE_POLL_MS = 8_000;

function stageStatus(stage: ResearchStage, current: ResearchStage, live: boolean) {
  const order = RESEARCH_STAGES.indexOf(stage);
  const at = RESEARCH_STAGES.indexOf(current);
  if (order < at) return "done" as const;
  if (order > at) return "pending" as const;
  return live ? ("active" as const) : ("done" as const);
}

function formatCost(microUsd: string): string {
  const usd = Number(microUsd) / 1_000_000;
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

export function ResearchRunPanel({ conversationId }: { conversationId: string | null }) {
  const [payload, setPayload] = React.useState<RunPayload | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [draftQueries, setDraftQueries] = React.useState<string[] | null>(null);
  const [steerText, setSteerText] = React.useState("");
  const [dismissed, setDismissed] = React.useState<string | null>(null);

  // The newest run for this conversation, then that run by id. Two requests
  // rather than one, because the id is what the cursor belongs to: a panel that
  // re-derived the run from the list on every poll would reset its cursor every
  // time the account started another run somewhere else.
  const [runId, setRunId] = React.useState<string | null>(null);
  React.useEffect(() => {
    setRunId(null);
    setPayload(null);
    setDraftQueries(null);
    if (!conversationId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/research?conversationId=${encodeURIComponent(conversationId)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { runs?: Array<{ id: string }> };
        if (!cancelled) setRunId(data.runs?.[0]?.id ?? null);
      } catch {
        // A panel that cannot find a run simply does not render. This is an
        // addition to the conversation, never a reason to break it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const load = React.useCallback(async (): Promise<RunPayload | null> => {
    if (!runId) return null;
    const res = await fetch(`/api/research/${runId}?after=0`);
    if (!res.ok) return null;
    const next = (await res.json()) as RunPayload;
    setPayload(next);
    return next;
  }, [runId]);

  React.useEffect(() => {
    if (!runId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped) return;
      // The interval comes from what this fetch just returned, not from state:
      // `setPayload` has not re-rendered yet at this point, so reading component
      // state here would always schedule against the previous poll's answer and
      // leave a working run on the idle interval for its whole first stage.
      const fresh = await load().catch(() => null);
      if (stopped) return;
      // A finished run never changes again: stop polling entirely rather than
      // asking the same question of the same row for as long as the tab is open.
      if (fresh && !fresh.run.live) return;
      const working =
        !!fresh &&
        fresh.run.live &&
        fresh.run.state !== "paused" &&
        fresh.run.state !== "awaiting_plan_confirmation";
      timer = setTimeout(tick, working ? WORKING_POLL_MS : IDLE_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runId, load]);

  const run = payload?.run ?? null;
  const state: ResearchState = run && isResearchState(run.state) ? run.state : "failed";

  const post = React.useCallback(
    async (path: string, body: Record<string, unknown>) => {
      if (!runId) return;
      setBusy(true);
      setNotice(null);
      try {
        const res = await fetch(`/api/research/${runId}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => ({}))) as Partial<RunPayload> & {
          message?: string;
        };
        if (!res.ok) {
          // The server's own words. A client that invents its own message for a
          // 409 tells the user a different story than the audit log does.
          setNotice(data.message ?? "That could not be applied.");
          await load().catch(() => undefined);
          return;
        }
        if (data.run) setPayload(data as RunPayload);
        setDraftQueries(null);
        setSteerText("");
      } catch {
        setNotice("Juno could not reach the server. Nothing was changed.");
      } finally {
        setBusy(false);
      }
    },
    [runId, load]
  );

  if (!run || dismissed === run.id) return null;

  const stage = stageForState(state);
  const awaitingPlan = state === "awaiting_plan_confirmation";
  const paused = state === "paused";
  const queries = draftQueries ?? run.plan.queries;

  return (
    <section
      aria-label="Research run"
      className="w-full rounded-card border border-border/60 bg-card/70 p-3 shadow-soft backdrop-blur-md sm:p-4"
    >
      <header className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-primary/25 bg-primary/10">
          {run.live ? (
            <Loader2 className="h-3 w-3 animate-spin text-primary motion-reduce:animate-none" />
          ) : (
            <Check className="h-3 w-3 text-primary" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{truncate(run.goal, 120)}</p>
          {/* The one line that changes as the run works, announced politely so a
              screen reader hears the stage change without losing its place. */}
          <p aria-live="polite" className="mt-0.5 truncate text-xs text-muted-foreground">
            {RESEARCH_STATE_MESSAGE[state]}
            {" · "}
            {formatCost(run.costMicroUsd)}
            {run.budgetMicroUsd ? ` of ${formatCost(run.budgetMicroUsd)}` : ""}
          </p>
        </div>
        {!run.live && (
          <button
            type="button"
            onClick={() => setDismissed(run.id)}
            aria-label="Hide this research run"
            className="pressable inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground coarse:h-11 coarse:w-11"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </header>

      {/* Stages, not events. */}
      <ol className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        {RESEARCH_STAGES.filter((key) => key !== "done").map((key) => {
          const status = stageStatus(key, stage, run.live);
          return (
            <li
              key={key}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition-colors duration-base ease-out-soft",
                status === "done" && "border-border/50 text-muted-foreground",
                status === "active" && "border-primary/40 bg-primary/10 text-foreground",
                status === "pending" && "border-border/40 text-muted-foreground/60"
              )}
            >
              {status === "done" && <Check className="h-3 w-3" aria-hidden />}
              {status === "active" && (
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 rounded-full bg-primary motion-safe:animate-ping"
                />
              )}
              {RESEARCH_STAGE_LABEL[key]}
            </li>
          );
        })}
      </ol>

      {run.plan.objectives && run.plan.objectives.length > 0 && !awaitingPlan && (
        <div className="mt-3 rounded-field border border-border/50 bg-background/35 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-mono text-label uppercase text-muted-foreground">Evidence coverage</p>
            {run.plan.followUpRound ? (
              <span className="font-mono text-caption text-muted-foreground">
                follow-up round {run.plan.followUpRound}
              </span>
            ) : null}
          </div>
          <ul className="mt-2 space-y-1.5">
            {run.plan.objectives.slice(0, 8).map((objective) => {
              const status = objective.status.replace("_", " ");
              return (
                <li key={objective.id} className="flex items-start gap-2 text-xs">
                  <span
                    aria-hidden
                    className={cn(
                      "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                      objective.status === "covered" ? "bg-primary" : "bg-warning"
                    )}
                  />
                  <span className="min-w-0 flex-1 text-muted-foreground">{truncate(objective.question, 96)}</span>
                  <span className="shrink-0 font-mono text-caption text-muted-foreground/70">{status}</span>
                </li>
              );
            })}
          </ul>
          {run.plan.conflicts && run.plan.conflicts.length > 0 && (
            <p className="mt-2 text-caption text-warning-foreground">
              {run.plan.conflicts.length} source conflict{run.plan.conflicts.length === 1 ? "" : "s"} remain visible.
            </p>
          )}
        </div>
      )}

      {run.auditSummary && !run.live && (
        <p className="mt-3 text-xs text-muted-foreground" role="status">
          Citation check: {run.auditSummary.supported} supported · {run.auditSummary.partiallySupported} partial ·{" "}
          {run.auditSummary.unsupported + run.auditSummary.contradicted + run.auditSummary.unverified} flagged.
        </p>
      )}

      {/* The plan gate: nothing expensive has happened yet, and these are the
          queries that will actually be issued. Editable, because the whole point
          of stopping here is that the user can change them. */}
      {awaitingPlan && (
        <div className="mt-3 rounded-field border border-border/50 bg-background/40 p-3">
          <p className="text-xs font-medium text-foreground">
            Juno will search for these. Edit anything before it starts.
          </p>
          <div className="mt-2 flex flex-col gap-2">
            {queries.map((query, i) => (
              <Input
                key={i}
                value={query}
                aria-label={`Search ${i + 1}`}
                onChange={(e) => {
                  const next = [...queries];
                  next[i] = e.target.value;
                  setDraftQueries(next);
                }}
              />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || queries.every((q) => !q.trim())}
              onClick={() =>
                post("/plan", {
                  decision: "confirm",
                  queries: queries.map((q) => q.trim()).filter(Boolean),
                })
              }
            >
              Start researching
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => post("/plan", { decision: "cancel" })}
            >
              Discard this run
            </Button>
          </div>
        </div>
      )}

      {/* Sources as they land. A run that has found nothing yet says so rather
          than showing an empty box that reads as broken. */}
      {!awaitingPlan && (
        <div className="mt-3">
          <p className="font-mono text-label uppercase text-muted-foreground">
            {run.sources.length === 0
              ? "No sources yet"
              : `${run.sources.length} ${run.sources.length === 1 ? "source" : "sources"}`}
          </p>
          {run.sources.length > 0 && (
            <ul className="mt-1.5 flex flex-col gap-1">
              {run.sources.slice(0, 12).map((source) => (
                <li key={source.id} className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      source.read ? "bg-primary" : "bg-border"
                    )}
                  />
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 truncate text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    // Not read yet is worth saying: a source in this list that
                    // the report cannot cite is otherwise indistinguishable
                    // from one it can.
                    title={source.read ? source.title : `${source.title} — found, not read yet`}
                  >
                    {source.title || source.url}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {run.error && (
        <p role="status" className="mt-3 text-xs text-destructive">
          {run.error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-xs text-destructive">
          {notice}
        </p>
      )}

      {/* Steering and the run controls. Hidden once the run is over — there is
          nothing to steer, and a disabled row of buttons is just noise. */}
      {run.live && !awaitingPlan && (
        <div className="mt-3 flex flex-col gap-2">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const value = steerText.trim();
              if (!value || busy) return;
              // A URL is a source to read; anything else is a constraint on the
              // whole report. Guessing here beats a mode switch the user has to
              // find before they can type.
              void post(
                "/steer",
                /^https?:\/\//i.test(value) ? { sourceUrl: value } : { constraint: value }
              );
            }}
          >
            <Input
              value={steerText}
              onChange={(e) => setSteerText(e.target.value)}
              placeholder="Add a constraint, or paste a source to include…"
              aria-label="Steer this research run"
              className="h-9 flex-1 text-xs"
            />
            <Button
              type="submit"
              size="icon"
              variant="outline"
              disabled={busy || !steerText.trim()}
              aria-label="Add to this run"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </form>
          {run.plan.constraints.length > 0 && (
            <ul className="flex flex-wrap gap-1">
              {run.plan.constraints.map((constraint) => (
                <li
                  key={constraint}
                  className="rounded-full border border-border/50 px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  {truncate(constraint, 60)}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => post("/control", { action: paused ? "resume" : "pause" })}
            >
              {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => post("/control", { action: "cancel" })}
            >
              Cancel run
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
