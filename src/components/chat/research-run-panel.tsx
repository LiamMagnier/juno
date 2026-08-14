"use client";

import * as React from "react";
import Link from "next/link";
import { BookOpenText, Check, ChevronDown, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, truncate } from "@/lib/utils";
import { PlanReview, SteerControls } from "@/components/research/run-controls";
import { formatMicroUsd } from "@/components/research/run-format";
import { LiveSourceList } from "@/components/research/source-list";
import { StageRail } from "@/components/research/stage-rail";
import { useResearchRun } from "@/components/research/use-research-run";
import {
  RESEARCH_STATE_MESSAGE,
  isResearchState,
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
 * The stage rail, the plan gate, the steering controls and the polling all live
 * in src/components/research/, shared with the standalone /research surface:
 * the panel is the run seen from its conversation, the reader is the same run
 * seen as a document, and the pieces must not fork.
 */

export function ResearchRunPanel({ conversationId }: { conversationId: string | null }) {
  const [dismissed, setDismissed] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(true);

  // The newest run for this conversation, then that run by id. Two requests
  // rather than one, because the id is what the cursor belongs to: a panel that
  // re-derived the run from the list on every poll would reset its cursor every
  // time the account started another run somewhere else.
  const [runId, setRunId] = React.useState<string | null>(null);
  React.useEffect(() => {
    setRunId(null);
    setExpanded(true);
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

  const { run, busy, notice, post } = useResearchRun(runId);
  const state: ResearchState = run && isResearchState(run.state) ? run.state : "failed";
  const awaitingPlan = state === "awaiting_plan_confirmation";
  const needsYou = awaitingPlan || state === "awaiting_user_input";

  // A run that stops to ask something re-opens the panel itself. The gate and
  // the question are the two moments the run cannot proceed without its owner,
  // and both were invisible behind a collapse the user made minutes earlier.
  React.useEffect(() => {
    if (needsYou) setExpanded(true);
  }, [needsYou]);

  if (!run || dismissed === run.id) return null;

  const paused = state === "paused";

  return (
    <section
      aria-label="Deep Research Run"
      className="mx-auto my-2 w-[calc(100%-1rem)] max-w-4xl rounded-2xl border border-border/60 bg-card/80 backdrop-blur-md p-3.5 shadow-sm transition-all duration-300 sm:w-[calc(100%-2rem)] sm:p-4"
    >
      <header className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            {run.live ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Check className="h-4 w-4" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-micro font-semibold uppercase tracking-wider text-primary">
                Deep Research
              </span>
              {run.live && (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 font-mono text-micro font-medium text-primary">
                  Live
                </span>
              )}
              {needsYou && (
                <span className="inline-flex items-center gap-1 rounded-full border border-warning/35 bg-warning/10 px-2 py-0.5 font-mono text-micro uppercase text-warning-foreground">
                  {awaitingPlan ? "Review plan" : "Input needed"}
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-xs font-medium text-foreground">{truncate(run.goal, 100)}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {run.report && (
            <Button asChild size="sm" variant="default" className="h-7 gap-1 px-2.5 text-xs">
              <Link href={`/research/${run.id}`}>
                <BookOpenText className="size-3" aria-hidden />
                <span>Read Full Report</span>
              </Link>
            </Button>
          )}
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={expanded ? "Hide research details" : "Show research details"}
            className="pressable inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", expanded && "rotate-180")} />
          </button>
          {!run.live && (
            <button
              type="button"
              onClick={() => setDismissed(run.id)}
              aria-label="Hide this research run"
              className="pressable inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </header>

      {/* Progress Rail */}
      <StageRail state={state} live={run.live} className="mt-2.5" />

      {expanded && (
        <div className="mt-3 space-y-2.5">
          {/* Summary status text */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-micro text-muted-foreground">
            <span>{RESEARCH_STATE_MESSAGE[state]}</span>
            <div className="flex items-center gap-1.5 font-mono">
              {run.sources.length > 0 && (
                <span>
                  {run.sources.length} {run.sources.length === 1 ? "source" : "sources"}
                </span>
              )}
              <span>·</span>
              <span>{formatMicroUsd(run.costMicroUsd)}</span>
            </div>
          </div>

          {/* Evidence Coverage & Objectives */}
          {run.plan.objectives && run.plan.objectives.length > 0 && !awaitingPlan && (
            <div className="rounded-xl border border-border/40 bg-secondary/50 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="font-mono text-micro uppercase tracking-wider text-muted-foreground">Research Objectives</p>
                {run.plan.followUpRound ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-1.5 py-0.5 font-mono text-micro text-primary">
                    Round {run.plan.followUpRound} / 4
                  </span>
                ) : null}
              </div>
              <ul className="mt-1.5 space-y-1">
                {run.plan.objectives.slice(0, 6).map((objective) => {
                  const status = objective.status.replace("_", " ");
                  return (
                    <li key={objective.id} className="flex items-center gap-2 text-xs">
                      <span
                        aria-hidden
                        className={cn(
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          objective.status === "covered" ? "bg-primary" : "bg-warning"
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate text-foreground/80">{objective.question}</span>
                      <span className="shrink-0 font-mono text-micro text-muted-foreground">{status}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {awaitingPlan && (
            <PlanReview
              queries={run.plan.queries}
              busy={busy}
              onConfirm={(queries) => void post("/plan", { decision: "confirm", queries })}
              onDiscard={() => void post("/plan", { decision: "cancel" })}
            />
          )}

          {!awaitingPlan && <LiveSourceList sources={run.sources} className="mt-2" />}

          {run.error && (
            <p role="status" className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">
              {run.error}
            </p>
          )}
          {notice && (
            <p role="status" className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">
              {notice}
            </p>
          )}

          {run.live && !awaitingPlan && (
            <SteerControls
              constraints={run.plan.constraints}
              paused={paused}
              busy={busy}
              onSteer={(body) => post("/steer", body)}
              onControl={(action) => void post("/control", { action })}
            />
          )}
        </div>
      )}
    </section>
  );
}
