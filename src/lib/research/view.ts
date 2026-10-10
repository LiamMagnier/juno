/**
 * The run as the API shows it (SPEC §9.4): the rework's DTO additions,
 * derived from the plan, the rows and the latest events. Pure — `run.ts`
 * reads the database and hands the facts here — so the phase table, the
 * counts and the clocks are tested without Postgres.
 */

import {
  isTerminalResearchState,
  isWorkingResearchState,
  planIsConfirmed,
  planIsRevising,
  type ResearchPlan,
  type ResearchState,
} from "@/lib/research/domain";
import { estimateFor } from "@/lib/research/estimate";
import type { ResearchFindingRow } from "@/lib/research/agents/protocol";
import type {
  ResearchClarificationView,
  ResearchEmergingAnswer,
  ResearchEstimate,
  ResearchFinding,
  ResearchPhase,
  ResearchQuestionStatus,
  ResearchQuestionView,
  ResearchModelLabel,
  ResearchRunCounts,
  ResearchRunModels,
  ResearchRunSummary,
} from "@/types/research";

/** The event kinds that say what an investigating run is doing right now. */
export const PHASE_EVENT_KINDS = ["query_issued", "follow_up_scheduled", "source_read", "passages_extracted", "worker_spawned"] as const;

export interface LatestPhaseEvent {
  kind: string;
  payload: Record<string, unknown>;
}

/**
 * The phase from the state and the latest telling event (§9.11.1): the
 * client maps it to a glyph and a line with one table. A partially completed
 * run that delivered its report is `done`; one that did not, `stopped`.
 */
export function researchPhaseFor(state: string, latest: LatestPhaseEvent | null, hasReport: boolean): ResearchPhase {
  switch (state as ResearchState) {
    case "accepted":
    case "clarifying":
    case "awaiting_clarification":
    case "planning":
      return "planning";
    case "awaiting_plan_confirmation":
      return "awaiting_start";
    case "investigating":
    case "awaiting_user_input":
      return latest && (latest.kind === "source_read" || latest.kind === "passages_extracted") ? "reading" : "searching";
    case "reviewing":
      return "reviewing";
    case "synthesizing":
      return "writing";
    case "validating_citations":
      return "checking";
    case "paused":
      return "paused";
    case "completed":
      return "done";
    case "partially_completed":
      return hasReport ? "done" : "stopped";
    case "cancelled":
      return "stopped";
    case "failed":
    default:
      return "failed";
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** What the phase sentence names: the query being searched, or the site being read. */
export function phaseDetailFor(phase: ResearchPhase, latest: LatestPhaseEvent | null): { query?: string; domain?: string } | null {
  if (!latest) return null;
  if (phase === "searching") {
    const query =
      typeof latest.payload.query === "string"
        ? latest.payload.query
        : Array.isArray(latest.payload.queries) && typeof latest.payload.queries[0] === "string"
          ? latest.payload.queries[0]
          : "";
    return query ? { query: query.replace(/\s+/g, " ").trim().slice(0, 200) } : null;
  }
  if (phase === "reading" && typeof latest.payload.url === "string") {
    const domain = hostOf(latest.payload.url);
    return domain ? { domain } : null;
  }
  return null;
}

const QUESTION_STATUS: Record<string, ResearchQuestionStatus> = {
  covered: "covered",
  partially_covered: "partial",
  blocked: "thin",
};

/** The plan's questions with their status for the panel (§9.4). */
/**
 * The question's line under it on every surface: the planner's rationale and,
 * for a protocol vector, the figures it must produce and what it verifies.
 * Folded into the existing `rationale` string so the web card and the native
 * live views show the vector without a wire change.
 */
export function rationaleWithVector(objective: ResearchPlan["objectives"][number]): string {
  const vector = objective.vector;
  const parts = [
    objective.rationale ?? "",
    vector?.metrics.length ? `Figures: ${vector.metrics.slice(0, 4).join("; ")}.` : "",
    vector?.verify.length ? `Verify: ${vector.verify.slice(0, 2).join("; ")}.` : "",
  ].filter(Boolean);
  const text = parts.join(" ");
  return text.length > 400 ? `${text.slice(0, 399).trimEnd()}…` : text;
}

export function questionViews(plan: ResearchPlan, state: string): ResearchQuestionView[] {
  const working = state === "investigating" || state === "reviewing";
  return plan.objectives.map((objective) => {
    const mapped = QUESTION_STATUS[objective.status];
    const status: ResearchQuestionStatus =
      mapped ??
      (isTerminalResearchState(state) || state === "synthesizing" || state === "validating_citations"
        ? "thin"
        : working
          ? "searching"
          : "pending");
    const rationale = rationaleWithVector(objective);
    return {
      id: objective.id,
      question: objective.question,
      ...(rationale ? { rationale } : {}),
      status,
    };
  });
}

export function clarificationViews(plan: ResearchPlan): ResearchClarificationView[] {
  const answers = plan.clarificationAnswers ?? {};
  return (plan.clarifications ?? []).map((clarification) => ({
    id: clarification.id,
    question: clarification.question,
    ...(clarification.suggestions?.length ? { options: clarification.suggestions } : {}),
    ...(answers[clarification.id] ? { answer: answers[clarification.id] } : {}),
  }));
}

/** Pages the run fetched: the sweep's plus every recorded round's. */
export function pagesReadOf(plan: ResearchPlan): number {
  return (plan.seedPagesRead ?? 0) + (plan.rounds ?? []).reduce((total, round) => total + round.pagesRead, 0);
}

/**
 * The longest silence that still counts as work.
 *
 * Every stage writes events as it goes: a researcher's every search and page,
 * a round's review, the report. The longest single quiet stretch in a healthy
 * run is the writer's call, timeboxed at six minutes. A longer silence is not
 * work: it is a run nobody was driving (a restart, a deploy, a lease waiting
 * to be adopted), and counting it is how a run that worked for fifteen
 * minutes came to read "30 h 27 min".
 */
export const RESEARCH_IDLE_GAP_MS = 8 * 60_000;

/** One event as the clock reads it: when, and the state it moved to if it moved one. */
export interface ResearchClockEvent {
  at: Date;
  /** The new state, for a `state_changed` event; absent for every other kind. */
  state?: string | null;
}

/**
 * Time the run actually spent working (§9.4), from its own event log.
 *
 * From `startedAt` to `end` (the finish, or now while it runs), it counts only
 * the stretches spent in a working state (so the plan gate, a pause and the
 * queue before a driver claimed the run are left out), and caps each quiet
 * stretch between two events at `RESEARCH_IDLE_GAP_MS` (so time with nobody
 * driving the run is left out too). Completed duration is therefore
 * completedAt − startedAt with the waiting removed, never wall-clock time
 * since the run was created.
 */
export function activeWorkingMs(input: {
  startedAt: Date;
  end: Date;
  /** Oldest first. */
  events: readonly ResearchClockEvent[];
  /** The state at `startedAt`; runs are created `accepted`. */
  initialState?: string;
  idleGapMs?: number;
}): number {
  const cap = input.idleGapMs ?? RESEARCH_IDLE_GAP_MS;
  const endMs = input.end.getTime();
  let state = input.initialState ?? "accepted";
  let since = input.startedAt.getTime();
  let total = 0;
  const span = (until: number) => {
    if (!isWorkingResearchState(state)) return;
    const gap = Math.min(until, endMs) - since;
    if (gap > 0) total += Math.min(gap, cap);
  };
  for (const event of input.events) {
    const at = event.at.getTime();
    if (!Number.isFinite(at) || at < since) {
      if (event.state) state = event.state;
      continue;
    }
    span(at);
    since = Math.min(at, endMs);
    if (event.state) state = event.state;
  }
  span(endMs);
  return Math.max(0, Math.round(total));
}

/**
 * Which models did the work, as the run recorded them (never guessed).
 *
 * `leadModel` is the "Written by" line: the model recorded as having written
 * the report, and nothing else. A run sized before the envelope recorded its
 * models, or a report that is the evidence digest, has no recorded writer and
 * shows none; a wrong name is worse than no name.
 */
export function runModelsOf(
  plan: ResearchPlan,
  labelOf: (id: string) => string
): { leadModel: ResearchModelLabel | null; models: ResearchRunModels | null } {
  const label = (id: string | null | undefined): ResearchModelLabel | null => (id ? { id, label: labelOf(id) } : null);
  const writer = plan.digest ? null : label(plan.writtenBy);
  const envelope = plan.envelope;
  if (!envelope?.workerModel || !envelope.leadModel) return { leadModel: writer, models: null };
  return {
    leadModel: writer,
    models: {
      lead: { id: envelope.leadModel, label: labelOf(envelope.leadModel) },
      worker: label(envelope.workerModel),
      workerNote: envelope.workerNote ?? null,
      writer,
      chosen: !!envelope.chosen,
    },
  };
}

/**
 * Working time (§9.4): from creation to now (or the finish), less the time
 * the plan waited at the gate for a person and less every pause (B13).
 *
 * The fallback for a run whose event log could not be read; `activeWorkingMs`
 * is the figure every view shows.
 */
export function workingMsOf(
  run: { createdAt: Date; finishedAt: Date | null; state: string },
  plan: ResearchPlan,
  now: Date
): number {
  const end = run.finishedAt ?? now;
  let working = end.getTime() - run.createdAt.getTime();
  const drafted = plan.draftedAt ? Date.parse(plan.draftedAt) : NaN;
  if (Number.isFinite(drafted)) {
    const confirmed = plan.confirmedAt ? Date.parse(plan.confirmedAt) : NaN;
    // Still at the gate: the clock stopped when the card appeared.
    const gateEnd = planIsConfirmed(plan) && Number.isFinite(confirmed) ? confirmed : end.getTime();
    if (gateEnd > drafted) working -= gateEnd - drafted;
  }
  working -= plan.pausedMs ?? 0;
  const pausedAt = plan.pausedAt ? Date.parse(plan.pausedAt) : NaN;
  if (Number.isFinite(pausedAt)) working -= Math.max(0, end.getTime() - pausedAt);
  return Math.max(0, Math.round(working));
}

/** The estimate line's figures: the frozen envelope's, else recomputed from the card's scope and caps. */
export function estimateOf(plan: ResearchPlan): ResearchEstimate | null {
  if (plan.envelope) return plan.envelope.estimate;
  if (plan.scope && plan.estimateCaps) return estimateFor(plan.scope, plan.estimateCaps);
  return null;
}

/** One count vocabulary (§9.4): found → read → cited, and the work behind them. */
export function countsOf(input: {
  plan: ResearchPlan;
  sources: ReadonlyArray<{ read: boolean }>;
  cited: number;
}): ResearchRunCounts {
  return {
    found: input.sources.length,
    read: input.sources.filter((source) => source.read).length,
    cited: input.cited,
    searches: (input.plan.issuedQueries?.length ?? 0) + (input.plan.workerQueries?.length ?? 0),
    pages: pagesReadOf(input.plan),
  };
}

/** The five newest findings, with the page each quotes (§9.4 "Found so far"). */
export function latestFindingsOf(
  findings: readonly ResearchFindingRow[],
  sources: ReadonlyArray<{ id: string; url: string; title: string }>
): ResearchFinding[] {
  const byId = new Map(sources.map((source) => [source.id, source]));
  return [...findings]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 5)
    .map((finding) => {
      const source = finding.sourceId ? byId.get(finding.sourceId) : undefined;
      return {
        id: finding.id,
        claim: finding.claim,
        quote: finding.quote,
        url: source?.url ?? finding.url,
        title: source?.title ?? hostOf(finding.url),
      };
    });
}

/**
 * What the evidence says so far, question by question (RESEARCH_V2 §3): for
 * each question with a note, the strongest one — highest confidence, then
 * newest — with the page it quotes, and how many distinct pages are behind
 * the question's notes. In the plan's order; questions without a note are
 * left out rather than padded.
 */
export function emergingAnswersOf(
  findings: ReadonlyArray<Pick<ResearchFindingRow, "objectiveId" | "sourceId" | "claim" | "confidence" | "createdAt" | "url">>,
  sources: ReadonlyArray<{ id: string; url: string; title: string }>,
  objectives: ReadonlyArray<{ id: string }>
): ResearchEmergingAnswer[] {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const rank = (f: (typeof findings)[number]) => [f.confidence ?? 0.5, f.createdAt.getTime()] as const;
  const out: ResearchEmergingAnswer[] = [];
  for (const objective of objectives) {
    const notes = findings.filter((finding) => finding.objectiveId === objective.id && finding.claim.trim());
    if (notes.length === 0) continue;
    const best = notes.reduce((a, b) => {
      const [ca, ta] = rank(a);
      const [cb, tb] = rank(b);
      return cb > ca || (cb === ca && tb > ta) ? b : a;
    });
    const source = best.sourceId ? byId.get(best.sourceId) : undefined;
    const pages = new Set(notes.map((note) => note.sourceId ?? note.url).filter(Boolean));
    out.push({
      questionId: objective.id,
      claim: best.claim.replace(/\s+/g, " ").trim(),
      url: source?.url ?? best.url,
      title: source?.title ?? hostOf(best.url),
      sources: pages.size,
    });
  }
  return out;
}

/**
 * The DTO's `plan.effort` (§9.4): null for every run sized by scope, so no
 * web component ever sees "deep" or "max". The stored value exists only for
 * the previous build (INV-22).
 */
export function dtoEffort<T>(plan: ResearchPlan & { effort?: T }): T | null {
  if (plan.envelope || plan.scope) return null;
  return plan.effort ?? null;
}

export function revisingOf(plan: ResearchPlan, now: Date): boolean {
  return planIsRevising(plan, now);
}

/** A title for a list row: the report's, else the planner's, else the goal's first line. */
export function runTitleOf(plan: ResearchPlan, goal: string): string | null {
  if (plan.title) return plan.title;
  const line = goal.split("\n")[0]?.trim() ?? "";
  return line ? line.slice(0, 80) : null;
}

/** One row of `GET /api/research?conversationId=` and `?live=1` (§9.4). */
export function summaryOf(input: {
  id: string;
  conversationId: string | null;
  state: string;
  plan: ResearchPlan;
  goal: string;
  createdAt: Date;
  finishedAt: Date | null;
  assistantMessageId: string | null;
  hasReport: boolean;
  latest: LatestPhaseEvent | null;
}): ResearchRunSummary {
  return {
    id: input.id,
    conversationId: input.conversationId,
    state: input.state as ResearchRunSummary["state"],
    phase: researchPhaseFor(input.state, input.latest, input.hasReport),
    title: runTitleOf(input.plan, input.goal),
    createdAt: input.createdAt.toISOString(),
    finishedAt: input.finishedAt?.toISOString() ?? null,
    live: !isTerminalResearchState(input.state),
    assistantMessageId: input.assistantMessageId,
  };
}

/** How recently a finished run still counts as "live" for `?live=1`: ten minutes (§9.4). */
export const RECENTLY_FINISHED_MS = 10 * 60_000;
