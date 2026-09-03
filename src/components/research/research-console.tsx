"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { EvidencePanel } from "@/components/research/evidence-panel";
import { PlanReview } from "@/components/research/run-controls";
import { formatMicroUsd } from "@/components/research/run-format";
import { RunSpine, type StageYield } from "@/components/research/run-spine";
import { RunTimeline } from "@/components/research/run-timeline";
import { SourceDeck } from "@/components/research/source-deck";
import { SourceRail } from "@/components/research/source-rail";
import { hostOf } from "@/components/chat/source-chip";
import { cn } from "@/lib/utils";
import { formatSpan } from "@/lib/run-receipt";
import { isWorkingResearchState, type ResearchEventDTO, type ResearchState } from "@/lib/research/domain";
import type { ResearchRunView } from "@/components/research/use-research-run";

/**
 * A run while it is running.
 *
 * THE SURFACE THIS REPLACES rendered nine stacked blocks at once, permanently —
 * a stage ladder, a status line, an objective list, a coverage note per
 * objective, an audit strip, a scatter plot with a three-line legend, a step
 * log, a source list and a steering form — most of it set in uppercase mono at
 * 10.5px. Two things were wrong and only one of them was density.
 *
 * The density problem: depth was being confused with disclosure. Everything the
 * run knew was on screen simultaneously, so nothing was emphasised.
 *
 * The register problem, which is the one that made it read as machine output:
 * the surface was dressed as a terminal. Mono, uppercase and tracking are the
 * house's METADATA voice — a model id, a token count, a timestamp — and using
 * them for headings, statuses and body copy turns a product into a log viewer.
 * Almost nothing here is mono now. The question is set in the serif, because a
 * research question is continuous human language and that is precisely what the
 * two-face system reserves the serif for; the stages, statuses and counts are in
 * the interface face; and the one letterspaced label on the card appears exactly
 * once, as an editorial kicker rather than as decoration on every heading.
 *
 * THE SHAPE, top to bottom, is the order the questions arrive in:
 *
 *   kicker + elapsed/cost   what this is, what it has cost so far
 *   the question            in the serif, whole, never truncated — the hero
 *   the spine               five acts, the live one open (RunSpine)
 *   the publishers          whose evidence this is (SourceRail)
 *   ── disclosure ──        Activity · Sources · Evidence, closed by default
 *
 * Everything below the publishers is closed unless the run needs the reader. The
 * plan gate is the one exception and it pre-empts the whole layout: nothing
 * expensive has happened yet, so the queries about to be issued outrank a
 * progress display for a run that has not started.
 *
 * NO TRANSPORT CONTROLS. There was a "Steer this run" field with its own Pause
 * and Stop buttons here — a second text input and a second set of transport
 * controls a few hundred pixels above the real ones, for the same conversation.
 * Both jobs belong to the composer now: typing while a run gathers adds a
 * constraint (or pins a source, if it is a URL), and the composer's Stop face
 * ends the run as well as the stream. See the `steering` prop in composer.tsx.
 */

/**
 * Composed with counts at runtime, so the fixed halves live in a `COPY` const:
 * template literals are invisible to scripts/generate-i18n-catalog.mjs.
 */
const CONSOLE_COPY = {
  kicker: "Deep research",
  activity: "Activity",
  sources: "Sources",
  evidence: "Evidence",
  details: "Run detail",
  hide: "Hide detail",
  show: "Show detail",
  collapse: "Hide this research run",
  round: "Round",
  of4: "of 4",
  queries: "queries",
  oneQuery: "query",
  found: "found",
  read: "read",
  checked: "checked",
  leaveHint: "Keeps running if you close this — the report will be here.",
} as const;

type Tab = "activity" | "sources" | "evidence";

/**
 * What the live stage is touching this second.
 *
 * Read from the tail of the event log rather than from the run row, because the
 * row carries a STATE ("browsing") and the reader's proof that something is
 * happening is a name changing every few seconds.
 *
 * NO VERB. This is the object of the sentence beside it — the state message
 * already supplies "Reading the sources in full" — so a "Reading" prefix here
 * produced "Reading the sources in full — Reading news.ycombinator.com". A query
 * keeps its quotes, because a bare search string reads as a sentence fragment
 * without them; a hostname needs nothing.
 */
function liveDetail(events: ResearchEventDTO[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === "source_read" || event.kind === "source_found") {
      const url = typeof event.payload.url === "string" ? event.payload.url : "";
      const host = url ? hostOf(url) : "";
      if (host) return host;
    }
    if (event.kind === "query_issued") {
      const query = typeof event.payload.query === "string" ? event.payload.query : "";
      if (query) return `“${query}”`;
    }
  }
  return null;
}

/** Wall clock since the run row was created, ticking only while it is live. */
function useElapsed(createdAt: string | undefined, live: boolean): string | null {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);
  if (!createdAt) return null;
  const started = Date.parse(createdAt);
  if (!Number.isFinite(started)) return null;
  return formatSpan(Math.max(0, now - started), { live: true });
}

/**
 * What each finished stage produced, for the right-hand column of the spine.
 *
 * Every figure is one the run actually persists. A stage with nothing to report
 * gets null and prints nothing, rather than a zero — "0 found" on a stage that
 * has not run yet is a claim about a search nobody made.
 */
export function stageYields(run: ResearchRunView): StageYield {
  const read = run.sources.filter((source) => source.read).length;
  const queries = run.plan.queries.length;
  const coverage = run.plan.coverage ?? [];
  const satisfied = coverage.filter((entry) => entry.status === "satisfied").length;
  return {
    plan: queries > 0 ? `${queries} ${queries === 1 ? CONSOLE_COPY.oneQuery : CONSOLE_COPY.queries}` : null,
    gather: run.sources.length > 0 ? `${run.sources.length} ${CONSOLE_COPY.found}` : null,
    read: read > 0 ? `${read} ${CONSOLE_COPY.read}` : null,
    crosscheck: coverage.length > 0 ? `${satisfied}/${coverage.length} ${CONSOLE_COPY.checked}` : null,
    write: null,
  };
}

export function ResearchConsole({
  run,
  state,
  events,
  busy,
  notice,
  post,
  onDismiss,
  className,
}: {
  run: ResearchRunView;
  state: ResearchState;
  events: ResearchEventDTO[];
  busy: boolean;
  notice: string | null;
  post: (path: string, body: Record<string, unknown>) => Promise<boolean>;
  onDismiss?: () => void;
  className?: string;
}) {
  const awaitingPlan = state === "awaiting_plan_confirmation";
  const needsYou = awaitingPlan || state === "awaiting_user_input";
  const working = isWorkingResearchState(state);

  // Closed unless the run needs a decision. The reader who wants the machinery
  // asks for it; the reader who wants to know it is working gets the spine.
  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState<Tab>("activity");

  const elapsed = useElapsed(run.createdAt, run.live);
  const detail = React.useMemo(() => liveDetail(events), [events]);
  const yields = React.useMemo(() => stageYields(run), [run]);

  // Resolved conflicts are dropped rather than struck through: a reader shown a
  // resolved duplicate reads it as a live problem with the evidence.
  const conflicts = (run.plan.conflicts ?? []).filter((conflict) => !conflict.resolved);
  const objectives = run.plan.objectives ?? [];

  const tabs: SegmentedOption<Tab>[] = [
    { value: "activity", label: CONSOLE_COPY.activity },
    { value: "sources", label: CONSOLE_COPY.sources },
    ...(objectives.length > 0 || conflicts.length > 0
      ? [{ value: "evidence" as const, label: CONSOLE_COPY.evidence }]
      : []),
  ];

  return (
    <section
      aria-label={CONSOLE_COPY.kicker}
      className={cn(
        "relative overflow-hidden rounded-surface border border-border/50 bg-card px-5 py-5 shadow-soft sm:px-6",
        className
      )}
    >
      {/* The only "this is alive" decoration on the card, and it is light: one
          soft wash of the accent bleeding in from the top-left corner while a
          worker is actually spending. It leaves the moment the run stops, which
          is the point — a finished run should not glow. */}
      {working && (
        <span
          aria-hidden
          className="pointer-events-none absolute -left-24 -top-28 size-64 rounded-full bg-primary/[0.07] blur-3xl motion-safe:animate-status-glow"
        />
      )}

      <header className="relative flex items-start justify-between gap-4">
        <div className="min-w-0">
          {/* Sentence case, and no `text-label`. That rung carries 0.10em of
              tracking because it was drawn for caps, and letterspacing applied
              to lowercase is what makes a word look like a machine printed it.
              Nothing in this product is set in full uppercase. */}
          <p className="text-caption font-medium text-primary">{CONSOLE_COPY.kicker}</p>
          {/* The question, in the serif, whole. It used to be
              `truncate(goal, 100)` inside a one-line clamp — the thing the run
              exists to answer, cut off mid-word, in the most prominent slot. */}
          <h3 className="mt-2 text-balance font-sans text-title text-foreground">{run.goal}</h3>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <div className="hidden text-right leading-tight sm:block">
            {elapsed && <p className="text-ui tabular-nums text-foreground/80">{elapsed}</p>}
            <p className="text-caption tabular-nums text-muted-foreground">{formatMicroUsd(run.costMicroUsd)}</p>
          </div>
          {onDismiss && !run.live && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label={CONSOLE_COPY.collapse}
              className="pressable inline-flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ActionIcons.dismiss className="size-3.5" />
            </button>
          )}
        </div>
      </header>

      {/* Follow-up rounds are a fact about gathering that has already happened,
          so they cannot be true at the gate — a plan waiting for approval has
          run nothing. */}
      {!awaitingPlan && run.plan.followUpRound ? (
        <p className="relative mt-1.5 text-caption tabular-nums text-muted-foreground">
          {CONSOLE_COPY.round} {run.plan.followUpRound} {CONSOLE_COPY.of4}
        </p>
      ) : null}

      {awaitingPlan ? (
        // The gate pre-empts everything. Nothing expensive has happened yet and
        // these are the queries that will actually be issued.
        <div className="relative mt-5">
          <PlanReview
            steps={run.plan.steps ?? []}
            queries={run.plan.queries}
            busy={busy}
            onConfirm={(plan) => void post("/plan", { decision: "confirm", ...plan })}
            onDiscard={() => void post("/plan", { decision: "cancel" })}
          />
        </div>
      ) : (
        <>
          <RunSpine state={state} live={run.live} detail={detail} yields={yields} className="relative mt-5" />

          <div className="relative mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <SourceRail sources={run.sources} />
            {run.live && !needsYou && (
              // Said once, quietly. It is what stops a person sitting on the
              // page for four minutes wondering whether closing the tab throws
              // the money away.
              <p className="text-caption text-muted-foreground/70">{CONSOLE_COPY.leaveHint}</p>
            )}
          </div>
        </>
      )}

      {!awaitingPlan && (
        <div className="relative mt-5 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="pressable -ml-1 inline-flex items-center gap-1 rounded-control px-1 py-0.5 text-ui text-muted-foreground hover:text-foreground"
          >
            {open ? CONSOLE_COPY.hide : CONSOLE_COPY.show}
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3.5 transition-transform duration-base ease-out-soft motion-reduce:transition-none",
                open && "rotate-180"
              )}
            />
          </button>

          {open && (
            <SegmentedControl
              value={tab}
              onChange={setTab}
              options={tabs}
              ariaLabel={CONSOLE_COPY.details}
              className="shrink-0"
              optionClassName="px-2.5 py-1 text-ui"
            />
          )}
        </div>
      )}

      {open && !awaitingPlan && (
        <div className="relative mt-4 border-t border-border/50 pt-4">
          {tab === "activity" && <RunTimeline events={events} live={run.live} />}
          {tab === "sources" && <SourceDeck sources={run.sources} />}
          {tab === "evidence" && (
            <EvidencePanel
              objectives={objectives}
              coverage={run.plan.coverage ?? []}
              conflicts={conflicts}
              sources={run.sources}
            />
          )}
        </div>
      )}

      {(run.error || notice) && (
        <p role="status" className="relative mt-4 rounded-field bg-destructive/10 px-3 py-2 text-ui text-destructive">
          {run.error ?? notice}
        </p>
      )}

    </section>
  );
}
