"use client";

import * as React from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { cn, truncate } from "@/lib/utils";
import { auditHeadline } from "@/components/chat/citation-audit";
import { hostOf } from "@/components/chat/source-chip";
import { PlanReview, SteerControls } from "@/components/research/run-controls";
import { formatMicroUsd } from "@/components/research/run-format";
import { RunStateBadge } from "@/components/research/run-state-badge";
import { RunTimeline } from "@/components/research/run-timeline";
import { SourceGraph } from "@/components/research/source-graph";
import { LiveSourceList } from "@/components/research/source-list";
import { StageRail } from "@/components/research/stage-rail";
import { useResearchRun, type ResearchRunView } from "@/components/research/use-research-run";
import {
  RESEARCH_STATE_MESSAGE,
  isResearchState,
  isWorkingResearchState,
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
 * in src/components/research/. There is no longer a standalone research surface
 * to share them with: a run is read where it was asked for, and the report it
 * produces is a canvas artifact on the message rather than a page of its own.
 * This panel is the run's machinery — plan, sources, cost, steering — and the
 * artifact beside it is the run's output.
 */

/**
 * The halves this panel composes with counts at runtime. A template literal is
 * invisible to scripts/generate-i18n-catalog.mjs, so they live in a const whose
 * name ends in `COPY` — the same reason AUDIT_COPY exists in citation-audit.tsx.
 */
const PANEL_COPY = {
  round: "Round",
  requirementsMet: "evidence requirements met",
  source: "source",
  sources: "sources",
  severity: "severity",
  betweenSources: "between",
} as const;

/**
 * Why one objective still reads the way it does.
 *
 * Every number here comes off `plan.coverage`, which the server has always
 * sent whole: `supportingSourceIds` is the run's only honest objective→source
 * edge, and `missingReason` is written by the coverage step in plain English.
 * `contradictingSourceIds` is deliberately not read — the engine hardcodes it
 * to `[]`, so a "disputed by" line would be empty when it was right and a lie
 * the moment anything started writing it.
 */
function coverageNote(objectiveId: string, coverage: ResearchRunView["plan"]["coverage"]): string | null {
  const entries = (coverage ?? []).filter((entry) => entry.objectiveId === objectiveId);
  if (entries.length === 0) return null;
  const satisfied = entries.filter((entry) => entry.status === "satisfied").length;
  const supporting = new Set(entries.flatMap((entry) => entry.supportingSourceIds));
  const parts = [`${satisfied}/${entries.length} ${PANEL_COPY.requirementsMet}`];
  if (supporting.size > 0) {
    parts.push(`${supporting.size} ${supporting.size === 1 ? PANEL_COPY.source : PANEL_COPY.sources}`);
  }
  const missing = entries.find((entry) => entry.missingReason)?.missingReason;
  if (missing) parts.push(missing);
  return parts.join(" · ");
}

/** A conflict's severity, and the hosts it is actually between. */
function conflictDetail(
  conflict: NonNullable<ResearchRunView["plan"]["conflicts"]>[number],
  sources: ResearchRunView["sources"]
): string {
  const hosts = [
    ...new Set(
      conflict.sourceIds
        .map((id) => sources.find((source) => source.id === id))
        .filter((source): source is ResearchRunView["sources"][number] => !!source)
        .map((source) => hostOf(source.url))
    ),
  ];
  const severity = `${conflict.severity} ${PANEL_COPY.severity}`;
  return hosts.length > 0 ? `${severity} · ${PANEL_COPY.betweenSources} ${hosts.join(", ")}` : severity;
}

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

  const { run, events, busy, notice, post } = useResearchRun(runId);
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
  // Resolved conflicts are dropped, not struck through: the matrix keeps them so
  // a later pass can tell it already looked, and a reader who is shown a
  // resolved duplicate reads it as a live problem with the evidence.
  const conflicts = (run.plan.conflicts ?? []).filter((conflict) => !conflict.resolved);

  return (
    <section
      aria-label="Deep Research Run"
      className={cn(
        "mx-auto my-2 w-[calc(100%-1rem)] max-w-4xl rounded-surface border border-border/60 bg-card/80 p-3.5 backdrop-blur-md sm:w-[calc(100%-2rem)] sm:p-4",
        // On the ladder rather than beside it. `rounded-2xl`/`shadow-sm` and a
        // hand-written `duration-300` are Tailwind defaults, and the files this
        // panel composes — source-list.tsx, sources-pill.tsx, citation-audit.tsx
        // — all draw their radius, elevation and duration from the tokens, so
        // the container was the one surface off the scale. Nothing here animates
        // its size, so the transition is scoped to colour rather than `all`,
        // which was also tweening the backdrop blur on every repaint.
        "shadow-soft transition-colors duration-base ease-out-soft motion-reduce:transition-none"
      )}
    >
      <header className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {/* `run.live` is "not terminal", which is a wider set than "working":
              it includes paused and both waiting states, so a run stopped dead
              waiting for its owner spun this spinner as though a worker were
              still on it. And the else-branch was an unconditional success
              tick, which put a green check on FAILED and on CANCELLED — the
              panel's most prominent glyph telling the opposite of what
              happened. Both now come off the state itself. */}
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-full",
              state === "failed" ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary"
            )}
          >
            {isWorkingResearchState(state) ? (
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            ) : state === "completed" ? (
              <StatusIcons.success className="size-4" />
            ) : state === "failed" ? (
              <StatusIcons.error className="size-4" />
            ) : (
              // Paused, cancelled, partially completed, awaiting the user: none
              // of these is a success and none is a failure. The badge beside
              // this says which one it is in words.
              <StatusIcons.info className="size-4" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-micro font-semibold uppercase tracking-wider text-primary">
                Deep Research
              </span>
              {/* One badge, from `runBadge`, rather than the two hand-rolled
                  chips that used to live here. They could say "Live" and
                  "Review plan" and nothing else: every terminal state — failed,
                  cancelled, stopped early at the budget — rendered no chip at
                  all, so the header of a run that died looked like the header
                  of a run that finished. RunStateBadge already covered all of
                  them and was sitting unused. */}
              <RunStateBadge state={run.state} />
            </div>
            <p className="mt-0.5 truncate text-ui font-medium text-foreground">{truncate(run.goal, 100)}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={expanded ? "Hide research details" : "Show research details"}
            className="pressable inline-flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform duration-base ease-out-soft motion-reduce:transition-none",
                expanded && "rotate-180"
              )}
            />
          </button>
          {!run.live && (
            <button
              type="button"
              onClick={() => setDismissed(run.id)}
              aria-label="Hide this research run"
              className="pressable inline-flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ActionIcons.dismiss className="size-3.5" />
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
            <div className="rounded-field border border-border/40 bg-secondary/50 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="font-mono text-micro uppercase tracking-wider text-muted-foreground">Research Objectives</p>
                {run.plan.followUpRound ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-1.5 py-0.5 font-mono text-micro text-primary">
                    {PANEL_COPY.round} {run.plan.followUpRound} / 4
                  </span>
                ) : null}
              </div>
              <ul className="mt-1.5 space-y-1.5">
                {run.plan.objectives.slice(0, 6).map((objective) => {
                  const status = objective.status.replace("_", " ");
                  const note = coverageNote(objective.id, run.plan.coverage);
                  return (
                    <li key={objective.id} className="min-w-0 text-ui">
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            objective.status === "covered" ? "bg-primary" : "bg-warning"
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate text-foreground/80">{objective.question}</span>
                        <span className="shrink-0 font-mono text-micro text-muted-foreground">{status}</span>
                      </div>
                      {/* The word alone never said WHY an objective was still
                          open, so "open" read as "Juno has not got to it yet"
                          when it usually means the sources it did read were not
                          direct or independent enough. The matrix has carried
                          the reason and the supporting sources all along. */}
                      {note && (
                        <p className="mt-0.5 pl-3.5 font-mono text-micro leading-snug text-muted-foreground">{note}</p>
                      )}
                    </li>
                  );
                })}
              </ul>

              {/* A conflict is not an error, which is why it sits with the
                  objectives rather than in the error slot below: two copies of
                  one wire story is a fact about the evidence, and hiding it is
                  what makes three sources look like three witnesses. */}
              {conflicts.length > 0 && (
                <ul className="mt-2 space-y-1 border-t border-border/40 pt-2">
                  {conflicts.slice(0, 4).map((conflict) => (
                    <li key={conflict.id} className="flex min-w-0 items-start gap-2 text-ui">
                      <StatusIcons.warning aria-hidden className="mt-0.5 size-3 shrink-0 text-warning-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block leading-snug text-warning-foreground">{conflict.description}</span>
                        <span className="mt-0.5 block truncate font-mono text-micro text-muted-foreground">
                          {conflictDetail(conflict, run.sources)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* What the citation check made of the report it drove. The panel has
              been fetching this on every poll and rendering none of it — the
              one place a reader can see the verdict was the chat message, which
              is exactly what this panel is meant to outlive. */}
          {run.auditSummary && !awaitingPlan && (
            <div className="flex items-center gap-2 rounded-field border border-border/40 bg-secondary/50 px-2.5 py-2">
              <span
                aria-hidden
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  run.auditSummary.contradicted + run.auditSummary.unsupported > 0 ? "bg-warning" : "bg-success"
                )}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-micro text-muted-foreground">
                {auditHeadline(run.auditSummary)}
              </span>
            </div>
          )}

          {/* The picture of the same matrix the objective list above counts.
              "2/3 requirements met · 4 sources" cannot say whether those four
              are regulators or forum posts, and that is the question a reader
              of the report actually has. It is drawn from the score columns the
              run view now carries and from nothing else. */}
          {!awaitingPlan && (
            <SourceGraph
              sources={run.sources}
              objectives={run.plan.objectives ?? []}
              coverage={run.plan.coverage ?? []}
              conflicts={conflicts}
            />
          )}

          {!awaitingPlan && <RunTimeline events={events} live={run.live} />}

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
            <p role="status" className="rounded-field bg-destructive/10 p-2 text-ui text-destructive">
              {run.error}
            </p>
          )}
          {notice && (
            <p role="status" className="rounded-field bg-destructive/10 p-2 text-ui text-destructive">
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
