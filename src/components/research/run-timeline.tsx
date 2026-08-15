"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { WebSearchBlock, type WebSearchSite } from "@/components/aicss/web-search";
import { hostOf, isRenderableSourceUrl } from "@/components/chat/source-chip";
import { formatMicroUsd } from "@/components/research/run-format";
import { StatusIcons } from "@/lib/app-icons";
import { formatSpan } from "@/lib/run-receipt";
import { cn, truncate } from "@/lib/utils";
import type { ResearchEventDTO } from "@/lib/research/domain";

/**
 * What the run actually did, step by step — the half the stage rail cannot say.
 *
 * The rail answers "how far along is it"; over a gather phase that runs for
 * minutes across a dozen queries and forty fetches it does not move, and the
 * panel reads as stalled. This answers "what is it doing right now, and what has
 * it already tried" from the durable event log, so it survives a reload the way
 * the chat timeline does not.
 *
 * TWO RULES, both learned the hard way and both recorded next to the code that
 * enforces them (domain.ts's event-kind comment, stage-rail.tsx's header):
 *
 *  1. Not every kind is rendered. A flat wall of "Searching the web" lines was
 *     the earlier design and it read as tool spam, not as progress. The kinds
 *     below are the ones a person watching actually reads, and the mapping is
 *     deliberately as coarse as `toActivity()` in src/lib/deep-research.ts —
 *     which is the same editorial judgement for the chat path.
 *  2. Sources group under the query that found them, and each group collapses.
 *     `source_found` carries its query, so the nesting is a real edge rather
 *     than an adjacency guess.
 *
 * Nothing here is on a timer. A row is `done` because a `source_read` landed for
 * that URL and `pending` because one never did — the same found-versus-read
 * distinction `LiveSourceList` draws, and the reason `loading` is never used:
 * the log has no "about to fetch this" event, so a spinning row would be a state
 * this app cannot observe drawn in the shape that says it did.
 */

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * Phrases composed with counts at runtime. Template literals are invisible to
 * scripts/generate-i18n-catalog.mjs, so the fixed halves live in a const whose
 * name ends in `COPY` — the same reason AUDIT_COPY exists in citation-audit.tsx.
 */
export const TIMELINE_COPY = {
  heading: "Steps",
  searches: "searches",
  oneSearch: "search",
  sourcesRead: "sources read",
  oneSourceRead: "source read",
  show: "Show what it did",
  hide: "Hide what it did",
  pinnedRead: "Opened a source you pinned",
  passages: "Read the pages in full",
  passagesDetail: "passages kept from",
  sourcesConsidered: "sources considered",
  pagesFetched: "pages fetched",
  coverage: "Checked the plan is covered",
  queries: "queries",
  sourcesFound: "sources found",
  read: "read",
  followUp: "Following an evidence gap",
  round: "Round",
  of4: "of 4",
  andMore: "more",
  duplicate: "Two sources carry the same text",
  conflict: "Sources conflict",
  auditStarted: "Checking every citation against its source",
  auditSources: "sources",
  results: "results",
  auditDone: "Citation check complete",
  budget: "Stopped at the research budget",
  spentOf: "of",
  readFailed: "A source could not be read",
  errored: "Something went wrong",
  paused: "Paused",
  resumed: "Resumed",
  cancelled: "Cancelled",
  earlierSteps: "earlier steps not shown",
} as const;

/**
 * How many steps are drawn at once.
 *
 * A four-round run can issue thirty queries, and thirty collapsed groups is the
 * wall this component exists not to be. The most recent window is what a person
 * watching wants; the truncation is LABELLED rather than silent, for the same
 * reason `LiveSourceList` labels its own — a list that stops without saying so
 * looks like a run that stopped.
 */
const MAX_STEPS = 20;

// ---------------------------------------------------------------------------
// Events → steps
// ---------------------------------------------------------------------------

const str = (payload: Record<string, unknown>, key: string): string =>
  typeof payload[key] === "string" ? (payload[key] as string) : "";

const int = (payload: Record<string, unknown>, key: string): number | null => {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const strings = (payload: Record<string, unknown>, key: string): string[] =>
  Array.isArray(payload[key]) ? (payload[key] as unknown[]).filter((v): v is string => typeof v === "string") : [];

type StepTone = "muted" | "warning";

interface SearchStep {
  kind: "search";
  key: string;
  at: number;
  query: string;
  results: number | null;
  sites: WebSearchSite[];
}

interface NoteStep {
  kind: "note";
  key: string;
  at: number;
  title: string;
  detail: string | null;
  tone: StepTone;
}

type Step = (SearchStep | NoteStep) & { durationMs: number | null };

function timeOf(event: ResearchEventDTO): number {
  const t = Date.parse(event.createdAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * The one place an event becomes a row.
 *
 * Two passes on purpose. `source_read` is what turns a found row into a read
 * one, and it can land many events after the `source_found` it answers, so the
 * read set has to be known before the rows are built rather than patched into
 * them afterwards.
 */
export function toRunSteps(events: ResearchEventDTO[], live: boolean): Step[] {
  const readUrls = new Set<string>();
  for (const event of events) {
    if (event.kind === "source_read") {
      const url = str(event.payload, "url");
      if (url) readUrls.add(url);
    }
  }

  const ordered: Array<SearchStep | NoteStep> = [];
  // Keyed by the query verbatim, not by position: a source rediscovered by a
  // later query keeps its FIRST parent (the engine emits `source_found` only on
  // create), so one query owns a source and no source is claimed twice.
  const byQuery = new Map<string, SearchStep>();

  const note = (event: ResearchEventDTO, title: string, detail: string | null, tone: StepTone = "muted") => {
    ordered.push({ kind: "note", key: event.id, at: timeOf(event), title, detail, tone });
  };

  for (const event of events) {
    const payload = event.payload;
    switch (event.kind) {
      case "query_issued": {
        const query = str(payload, "query");
        if (!query || byQuery.has(query)) break;
        const step: SearchStep = {
          kind: "search",
          key: event.id,
          at: timeOf(event),
          query,
          results: int(payload, "results"),
          sites: [],
        };
        byQuery.set(query, step);
        ordered.push(step);
        break;
      }
      case "source_found": {
        const url = str(payload, "url");
        // `WebSearchBlock` turns every `done` row into an anchor, and these URLs
        // came out of a search vendor's JSON. `isRenderableSourceUrl` is the
        // render chokepoint for exactly that, so a `javascript:` or `data:`
        // source never reaches the row — it is still listed, as plain text,
        // by `LiveSourceList` under this timeline.
        if (!url || !isRenderableSourceUrl(url)) break;
        const parent = byQuery.get(str(payload, "query"));
        // No parent means the query that found it is older than the events this
        // client holds. The source is not invented into a group it may not
        // belong to — it still shows up in the source list below the timeline.
        if (!parent) break;
        parent.sites.push({
          title: str(payload, "title") || url,
          // Host alone, not host+path: this panel is half the width of the chat
          // transcript the AIcss row was drawn for, and a long path pushed the
          // title out of the row entirely.
          label: hostOf(url),
          url,
          state: readUrls.has(url) ? "done" : "pending",
        });
        break;
      }
      case "source_read": {
        // Only the pinned read gets a row of its own. The ranked and deepened
        // reads are already visible as the rows they resolve inside their
        // query's group; a pinned source has no query, because the user chose it.
        if (payload.pinned !== true) break;
        const url = str(payload, "url");
        note(event, TIMELINE_COPY.pinnedRead, str(payload, "title") || hostOf(url));
        break;
      }
      case "passages_extracted": {
        const passages = int(payload, "passages") ?? 0;
        const total = int(payload, "sourcesTotal") ?? 0;
        const fetched = int(payload, "fetched") ?? 0;
        note(
          event,
          TIMELINE_COPY.passages,
          `${passages} ${TIMELINE_COPY.passagesDetail} ${total} ${TIMELINE_COPY.sourcesConsidered} · ${fetched} ${TIMELINE_COPY.pagesFetched}`
        );
        break;
      }
      case "coverage_checked": {
        note(
          event,
          TIMELINE_COPY.coverage,
          `${int(payload, "queries") ?? 0} ${TIMELINE_COPY.queries} · ${int(payload, "sources") ?? 0} ${TIMELINE_COPY.sourcesFound} · ${int(payload, "read") ?? 0} ${TIMELINE_COPY.read}`
        );
        break;
      }
      case "follow_up_scheduled": {
        const queries = strings(payload, "queries");
        const extra = queries.length > 1 ? ` · +${queries.length - 1} ${TIMELINE_COPY.andMore}` : "";
        note(
          event,
          TIMELINE_COPY.followUp,
          `${TIMELINE_COPY.round} ${int(payload, "round") ?? 1} ${TIMELINE_COPY.of4} · ${truncate(queries[0] ?? "", 64)}${extra}`
        );
        break;
      }
      case "conflict_found": {
        const urls = strings(payload, "urls");
        const hosts = [...new Set(urls.map(hostOf))].join(" · ");
        note(
          event,
          str(payload, "kind") === "duplicate_content" ? TIMELINE_COPY.duplicate : TIMELINE_COPY.conflict,
          hosts || null,
          "warning"
        );
        break;
      }
      case "citation_audit_started": {
        const sources = int(payload, "sources");
        note(event, TIMELINE_COPY.auditStarted, sources === null ? null : `${sources} ${TIMELINE_COPY.auditSources}`);
        break;
      }
      case "citation_audit_completed":
      case "citation_audit":
        note(event, TIMELINE_COPY.auditDone, null);
        break;
      case "budget_exhausted": {
        const spent = str(payload, "spentMicroUsd");
        const budget = str(payload, "budgetMicroUsd");
        note(
          event,
          TIMELINE_COPY.budget,
          spent && budget ? `${formatMicroUsd(spent)} ${TIMELINE_COPY.spentOf} ${formatMicroUsd(budget)}` : null,
          "warning"
        );
        break;
      }
      case "error": {
        const url = str(payload, "url");
        const message = str(payload, "message");
        note(
          event,
          url ? TIMELINE_COPY.readFailed : TIMELINE_COPY.errored,
          [url ? hostOf(url) : "", message].filter(Boolean).join(" · ") || null,
          "warning"
        );
        break;
      }
      case "paused":
        note(event, TIMELINE_COPY.paused, null);
        break;
      case "resumed":
        note(event, TIMELINE_COPY.resumed, null);
        break;
      case "cancelled":
        note(event, TIMELINE_COPY.cancelled, null);
        break;
      default:
        // Everything else is deliberately dropped. `state_changed` belongs to
        // the stage rail (and is the ONLY kind the stage may be derived from),
        // `spend_recorded` to the cost figure in the header, `source_ranked`
        // and the plan/report/lease kinds to no reader at all.
        break;
    }
  }

  // Durations, measured rather than estimated: a run is driven one step at a
  // time by a single worker, so the gap between one step's first event and the
  // next step's is how long that step took. The final step of a live run has no
  // end instant yet and is left blank rather than counted against `now` — a
  // number that grows while nothing is happening is worse than no number.
  const lastAt = events.length > 0 ? timeOf(events[events.length - 1]!) : 0;
  return ordered.map((step, i) => {
    const next = ordered[i + 1];
    const end = next ? next.at : live ? null : lastAt;
    const durationMs = end === null ? null : Math.max(0, end - step.at);
    return { ...step, durationMs };
  });
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function StepDuration({ ms }: { ms: number | null }) {
  if (ms === null || ms < 1000) return null;
  return (
    <span className="shrink-0 font-mono text-micro tabular-nums text-muted-foreground/70">{formatSpan(ms)}</span>
  );
}

function NoteRow({ step }: { step: NoteStep & { durationMs: number | null } }) {
  return (
    <li className="flex min-w-0 items-start gap-2 py-1">
      <span className="mt-1 flex size-3 shrink-0 items-center justify-center">
        {step.tone === "warning" ? (
          <StatusIcons.warning aria-hidden className="size-3 text-warning-foreground" />
        ) : (
          <span aria-hidden className="size-1.5 rounded-full bg-border" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-caption",
            step.tone === "warning" ? "text-warning-foreground" : "text-foreground/80"
          )}
        >
          {step.title}
        </span>
        {step.detail && (
          <span className="mt-0.5 block truncate font-mono text-micro text-muted-foreground">{step.detail}</span>
        )}
      </span>
      <StepDuration ms={step.durationMs} />
    </li>
  );
}

export function RunTimeline({
  events,
  live,
  className,
}: {
  events: ResearchEventDTO[];
  live: boolean;
  className?: string;
}) {
  // A run still working opens itself: the whole point is that the gather phase
  // stops looking like an unmoving bar. A finished run mounts shut — its report
  // and its citation audit are what a reader has come back for, and twenty
  // collapsed steps stacked above them is furniture. It is initial state rather
  // than an effect on `live` so that a run finishing under the reader's eyes
  // does not slam the list they were reading.
  const [open, setOpen] = React.useState(live);
  const listId = React.useId();

  const steps = React.useMemo(() => toRunSteps(events, live), [events, live]);
  const searches = steps.filter((step): step is SearchStep & { durationMs: number | null } => step.kind === "search");
  const readCount = searches.reduce(
    (total, step) => total + step.sites.filter((site) => site.state === "done").length,
    0
  );

  if (steps.length === 0) return null;

  const hidden = Math.max(0, steps.length - MAX_STEPS);
  const visible = steps.slice(hidden);
  const lastStepKey = steps[steps.length - 1]?.key;

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={listId}
        className={cn(
          "flex w-full items-center gap-2 rounded-control px-1.5 py-1 text-left",
          "transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
          "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "coarse:min-h-11"
        )}
      >
        <span className="font-mono text-micro uppercase tracking-wider text-muted-foreground">
          {TIMELINE_COPY.heading}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-micro tabular-nums text-muted-foreground">
          {searches.length} {searches.length === 1 ? TIMELINE_COPY.oneSearch : TIMELINE_COPY.searches} ·{" "}
          {readCount} {readCount === 1 ? TIMELINE_COPY.oneSourceRead : TIMELINE_COPY.sourcesRead}
        </span>
        <span className="sr-only">{open ? TIMELINE_COPY.hide : TIMELINE_COPY.show}</span>
        <ChevronDown
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-base ease-out-soft motion-reduce:transition-none",
            open && "rotate-180"
          )}
        />
      </button>

      <div
        id={listId}
        className={cn(
          "grid transition-[grid-template-rows] duration-base ease-out-soft motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden" inert={!open}>
          <ul className="mt-1 space-y-1 px-1.5">
            {hidden > 0 && (
              <li className="font-mono text-micro tabular-nums text-muted-foreground">
                + {hidden} {TIMELINE_COPY.earlierSteps}
              </li>
            )}
            {visible.map((step) =>
              step.kind === "search" ? (
                <li key={step.key} className="flex min-w-0 items-start gap-2 py-0.5">
                  <div className="min-w-0 flex-1">
                    <WebSearchBlock
                      // The newest group is open, every older one is shut — and
                      // the key carries that fact so the block REMOUNTS when a
                      // newer step arrives. `defaultOpen` seeds local state
                      // once, so without this every group a run ever opened
                      // stayed open and a twenty-query run ended as the wall of
                      // rows this component exists not to be.
                      key={`${step.key}:${step.key === lastStepKey}`}
                      query={step.query}
                      sites={step.sites}
                      // The label stops shimmering as soon as a later step
                      // exists: the search it names is provably over.
                      settled={!live || step.key !== lastStepKey}
                      defaultOpen={live && step.key === lastStepKey}
                    />
                  </div>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {step.results !== null && (
                      <span className="font-mono text-micro tabular-nums text-muted-foreground/70">
                        {step.results} {TIMELINE_COPY.results}
                      </span>
                    )}
                    <StepDuration ms={step.durationMs} />
                  </span>
                </li>
              ) : (
                <NoteRow key={step.key} step={step} />
              )
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
