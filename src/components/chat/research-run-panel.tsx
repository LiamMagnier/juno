"use client";

import * as React from "react";
import Link from "next/link";
import { BookOpenText, Check, ChevronDown, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, truncate } from "@/lib/utils";
import { auditHeadline } from "@/components/chat/citation-audit";
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
      aria-label="Research run"
      className="mx-auto w-[calc(100%-1rem)] max-w-5xl rounded-card border border-border/75 bg-card p-3 shadow-none sm:w-[calc(100%-2rem)] sm:p-4"
    >
      <header className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10">
          {run.live ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary motion-reduce:animate-none" />
          ) : (
            <Check className="h-3.5 w-3.5 text-primary" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-xs font-semibold text-foreground">Deep Research</span>
            {/* Visible even collapsed: the whole run is waiting on this person,
                and a chip the collapse cannot hide is what makes the plan gate
                discoverable rather than a thing you find by reopening panels. */}
            {needsYou && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/35 bg-warning/10 px-2 py-0.5 font-mono text-micro uppercase text-warning-foreground">
                {awaitingPlan ? "Review the plan" : "Waiting for you"}
              </span>
            )}
            <span aria-hidden className="h-px min-w-3 flex-1 bg-border/70" />
          </div>
          <p className="mt-1 truncate text-sm font-medium text-foreground">{truncate(run.goal, 120)}</p>
          {/* The one line that changes as the run works — a plain verb plus the
              running counts, announced politely so a screen reader hears the
              stage change without losing its place. */}
          <p aria-live="polite" className="mt-0.5 truncate text-xs text-muted-foreground">
            {RESEARCH_STATE_MESSAGE[state]}
            {run.sources.length > 0
              ? ` · ${run.sources.length} ${run.sources.length === 1 ? "source" : "sources"}`
              : ""}{" "}
            · {formatMicroUsd(run.costMicroUsd)}
            {run.budgetMicroUsd ? ` of ${formatMicroUsd(run.budgetMicroUsd)}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={expanded ? "Hide research details" : "Show research details"}
            className="pressable inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground coarse:h-11 coarse:w-11"
          >
            <ChevronDown className={cn("h-4 w-4 transition-transform duration-base", expanded && "rotate-180")} />
          </button>
          {!run.live && (
            <button
              type="button"
              onClick={() => setDismissed(run.id)}
              aria-label="Hide this research run"
              className="pressable inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground coarse:h-11 coarse:w-11"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      <StageRail state={state} live={run.live} className="mt-3" />

      {/* The payoff, never hidden behind the collapse: a chat bubble is a bad
          place to read ten minutes of paid work, and /research/[id] is the
          document surface built for it. */}
      {run.report && (
        <div className="mt-3">
          <Button asChild size="sm" variant="outline" className="gap-1.5">
            <Link href={`/research/${run.id}`}>
              <BookOpenText className="size-3.5" aria-hidden />
              View full report
            </Link>
          </Button>
        </div>
      )}

      {expanded && (
        <>
          {/* One fill for the panel's nested wells. This one and the plan gate
              were `bg-background/35` and `bg-background/40` — the same role, 5% apart
              for no reason, and both resolving DARKER than the bg-card panel they sit
              inside, i.e. holes rather than nested panels. `bg-secondary` is the rung
              above card, which is what nesting is supposed to look like. */}
          {run.plan.objectives && run.plan.objectives.length > 0 && !awaitingPlan && (
            <div className="mt-3 rounded-field border border-border/50 bg-secondary p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-foreground">Evidence coverage</p>
                {run.plan.followUpRound ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 font-mono text-micro uppercase text-primary">
                    Deep Research: Round {run.plan.followUpRound} / 4
                  </span>
                ) : (
                  // `bg-accent`, not `bg-background/50`. This badge sits in the
                  // bg-secondary well, which sits in the bg-card panel — the page
                  // colour at half strength resolved BELOW both of them, so the one
                  // badge that says the run is active read as a hole. Its sibling
                  // above uses `bg-primary/10`; accent is the neutral equivalent,
                  // the rung above secondary.
                  <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-accent px-2 py-0.5 font-mono text-micro uppercase text-muted-foreground">
                    Deep Research Active
                  </span>
                )}
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
                      <span className="shrink-0 font-mono text-caption text-muted-foreground">{status}</span>
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
              Citation check: {auditHeadline(run.auditSummary)}
            </p>
          )}

          {awaitingPlan && (
            <div className="mt-3">
              <PlanReview
                queries={run.plan.queries}
                busy={busy}
                onConfirm={(queries) => void post("/plan", { decision: "confirm", queries })}
                onDiscard={() => void post("/plan", { decision: "cancel" })}
              />
            </div>
          )}

          {!awaitingPlan && <LiveSourceList sources={run.sources} className="mt-3" />}

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

          {run.live && !awaitingPlan && (
            <div className="mt-3">
              <SteerControls
                constraints={run.plan.constraints}
                paused={paused}
                busy={busy}
                onSteer={(body) => post("/steer", body)}
                onControl={(action) => void post("/control", { action })}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
