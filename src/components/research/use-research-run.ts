"use client";

import type { PrivateSourceOption } from "@/lib/research/private-sources";
import * as React from "react";
import {
  EMPTY_SNAPSHOT,
  IDLE_POLL_MS,
  WORKING_POLL_MS,
  createResearchRunStore,
  type PostResult,
  type ResearchRunStore,
  type RunSnapshot,
} from "@/components/research/research-run-store";
import type { ResearchClarification, ResearchEffort, ResearchEventDTO } from "@/lib/research/domain";
import { publishResearchPhase } from "@/lib/run/store";
import type { ResearchPhase, ResearchRunViewAdditions } from "@/types/research";

/**
 * One research run, kept fresh — the client half of GET /api/research/[id].
 *
 * Extracted from the chat panel when /research shipped: the panel beside a
 * conversation and the standalone reader are two views of the same durable row,
 * and the polling cadence, the terminal-stop rule and the "server's own words"
 * error contract must not fork between them. The hook owns the client's wire
 * types too, so a field added to the API view lands in every surface at once;
 * the rework's additions are declared once in `@/types/research` and extended
 * here (SPEC §9.4).
 *
 * The poller itself lives in `research-run-store.ts`, one per run however many
 * surfaces read it (the scope card, the row, the panel and the report card
 * each call this hook with the same id).
 */

export interface ResearchSourceView {
  id: string;
  url: string;
  title: string;
  read: boolean;
  contentHash: string | null;
  fetchedAt: string;
  /** As the source claims; distinct from the date of the event it describes. */
  publishedAt: string | null;
  /**
   * The four gathering-time scores and their weighted roll-up, 0..1.
   *
   * NULL IS NOT ZERO, and this is the whole reason the source graph could not
   * be drawn before these landed. A row written before the scoring columns
   * existed — or by a legacy write path — has never been scored; folding that
   * into 0 lets a graph draw a confident "we measured this and it is worthless"
   * about a source nobody ever measured. Every consumer must branch on null and
   * render the node AS unscored, and none of them may recompute a substitute:
   * the client has neither the snapshot nor the scorer, so any number it
   * invented would be a different quantity wearing the same name.
   *
   * `composite` is the one to size a node by — the other four are what it is
   * made of, and showing all five at node scale says nothing.
   */
  authority: number | null;
  freshness: number | null;
  directness: number | null;
  independence: number | null;
  composite: number | null;
  /**
   * official | primary | reputable_secondary | general | user_generated |
   * unknown — how the source was classified when it was gathered, and the
   * single fact that says what the four scores above are worth.
   *
   * Null and `"unknown"` are different answers and must not be merged: null is
   * "never classified" (the same legacy rows the scores are null on), while
   * `"unknown"` is the classifier looking at the page and declining to place
   * it. A graph that merges them turns "we did not look" into a verdict.
   */
  sourceType: string | null;
  /**
   * The source's number in the report's citations (`[n]`), when the run
   * carries the writer's ordered cited list (§9.6.3); absent or null for a
   * source the report does not cite, and on runs from before the rework.
   */
  citedIndex?: number | null;
}

export interface ResearchRunView extends ResearchRunViewAdditions {
  id: string;
  conversationId?: string | null;
  goal: string;
  state: string;
  /**
   * How the run was sized, for the Plan and Details tabs: workers and rounds
   * from the frozen envelope, and what bounded it (`scope` when nothing did).
   * Optional and not yet in the §9.4 DTO list; absent, the tabs leave the
   * lines out rather than guess.
   */
  sizing?: { workers: number; rounds: number; limitedBy: "scope" | "plan" | "month" | "window" } | null;
  /** Bumped each time the report is rewritten after the audit. */
  reportRevision?: number;
  plan: {
    /**
     * The kinds of source the planner said it will favour ("peer-reviewed
     * studies", "official statistics"), for the scope card's quiet chips.
     * Optional: absent on runs planned before the structured planner.
     */
    sourceKinds?: string[];
    /**
     * The plan a person reads at the gate: ordered sentences naming what the
     * run will investigate. Empty on runs drafted before steps existed and on
     * planners that returned none — the gate falls back to `queries`, which is
     * what it used to show outright. See `ResearchPlan.steps`.
     */
    steps: string[];
    queries: string[];
    constraints: string[];
    pinnedSources: string[];
    confirmed: boolean;
    /** What the run asked before it planned, and what came back. */
    clarifications?: ResearchClarification[];
    clarificationAnswers?: Record<string, string>;
    /** The expanded brief the planner wrote from the goal. */
    brief?: string;
    /** The planner's one-paragraph reasoning: how the question will be attacked. */
    approach?: string;
    /** What a complete answer must contain, in the planner's words. */
    successCriteria?: string[];
    /** Where the planner expects evidence to be thin or disputed. */
    risks?: string[];
    objectives?: Array<{
      id: string;
      question: string;
      status: string;
      rationale?: string;
      importance?: number;
      evidenceRequirements?: Array<{
        id: string;
        description: string;
        preferredSourceTypes?: string[];
        minimumIndependentSources?: number;
        requiresPrimarySource?: boolean;
        freshnessRule?: string;
        status?: string;
      }>;
    }>;
    coverage?: Array<{
      objectiveId: string;
      requirementId: string;
      status: string;
      /**
       * Which sources actually satisfy this requirement — the one honest
       * objective→source edge the run persists. It has always been on the wire
       * (run.ts serialises the whole ResearchCoverageEntry); this interface
       * omitted it, which is why the panel could show that an objective was
       * "covered" but never what covered it.
       *
       * `contradictingSourceIds` is deliberately NOT declared beside it. The
       * engine hardcodes it to `[]` and nothing ever computes a contradiction
       * edge, so a field here would invite a "disputed by" line that is empty
       * when it is right and a lie when it is not.
       */
      supportingSourceIds: string[];
      independentSourceCount: number;
      evidenceStrength: number;
      missingReason?: string;
    }>;
    conflicts?: Array<{
      id: string;
      kind: string;
      objectiveId?: string;
      /** The sources the conflict is between — `ResearchSource.id`, joinable to `sources[]`. */
      sourceIds: string[];
      description: string;
      severity: string;
      resolved: boolean;
    }>;
    followUpRound?: number;
    /** The tier the run was started at, for the plan gate to state what it is asking approval for. */
    effort?: ResearchEffort | null;
    /** What the run reads: the web and the person's own sources, offered and switched on. */
    sources?: { web: boolean; enabled: string[]; options: PrivateSourceOption[] };
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
  createdAt?: string;
  finishedAt?: string | null;
  sources: ResearchSourceView[];
}

export interface RunPayload {
  run: ResearchRunView;
  /**
   * Every event this hook has seen for the run, oldest first.
   *
   * The API has always returned the page next to the run state — the hook threw
   * it away, which is why the panel could only ever draw the five-rung stage
   * rail over a gather phase that runs for minutes. It is accumulated rather
   * than replaced because the response only carries what is newer than the
   * cursor.
   */
  events: ResearchEventDTO[];
  /**
   * The last row OF THIS PAGE, server-side — a true cursor now, where it used
   * to be max(seq) over the whole run. The hook still does not read it; see
   * `absorb` for the one case where trusting it would be wrong.
   */
  lastSeq: number;
  /**
   * Where the run has actually got to. `cursor < maxSeq` means the server is
   * holding at least one more page, which is the difference between "nothing
   * has happened yet" and "we are behind" — and those want opposite behaviour:
   * sleep out the poll interval, or come straight back for the next page.
   */
  maxSeq: number;
}

export { WORKING_POLL_MS, IDLE_POLL_MS };

let shared: ResearchRunStore | null = null;

/**
 * The one store the app's hooks share. Built on first use, in the browser:
 * `fetch` is read through `window` on every call, so a page that shims it (the
 * `/dev/research` gallery) is honoured, and the phase goes to the announcer.
 */
export function researchRunStore(): ResearchRunStore {
  shared ??= createResearchRunStore({
    fetch: (input, init) => window.fetch(input, init),
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (timer) => window.clearTimeout(timer as number),
    onPhase: publishResearchPhase,
  });
  return shared;
}

/** One frozen array, so `events` is referentially stable before the first page. */
const EMPTY_EVENTS: ResearchEventDTO[] = [];
const noop = () => () => {};

export type ResearchControl = "pause" | "resume" | "finish" | "cancel";

export interface ResearchRunHandle {
  payload: RunPayload | null;
  run: ResearchRunView | null;
  events: ResearchEventDTO[];
  failed: boolean;
  disconnected: boolean;
  busy: boolean;
  notice: string | null;
  /** POST to a run sub-route. Resolves true only when the server accepted it. */
  post: (path: string, body: Record<string, unknown>) => Promise<boolean>;
  reload: () => Promise<RunPayload | null>;
  /** When the payload was fetched: the row's clock extrapolates from it (§9.11.3). */
  fetchedAt: number | null;
  /** The run's phase as the reader sees it, or null before the first response. */
  phase: ResearchPhase | null;
  /** The same POST, with the server's words from the response (research-UI bug 26). */
  act: (path: string, body: Record<string, unknown>) => Promise<PostResult>;
  control: (action: ResearchControl) => Promise<PostResult>;
  /** Guidance, applied at the next round boundary (§9.7). */
  steer: (guidance: string) => Promise<PostResult>;
}

export function useResearchRun(runId: string | null): ResearchRunHandle {
  const store = researchRunStore();
  const subscribe = React.useCallback(
    (onChange: () => void) => (runId ? store.subscribe(runId, onChange) : noop()),
    [store, runId],
  );
  const read = React.useCallback((): RunSnapshot => (runId ? store.get(runId) : EMPTY_SNAPSHOT), [store, runId]);
  const snapshot = React.useSyncExternalStore(subscribe, read, () => EMPTY_SNAPSHOT);

  const act = React.useCallback(
    (path: string, body: Record<string, unknown>): Promise<PostResult> =>
      runId ? store.post(runId, path, body) : Promise.resolve({ ok: false, notice: null, data: {} }),
    [store, runId],
  );
  const post = React.useCallback(async (path: string, body: Record<string, unknown>) => (await act(path, body)).ok, [act]);
  const reload = React.useCallback(() => (runId ? store.refresh(runId) : Promise.resolve(null)), [store, runId]);
  const control = React.useCallback((action: ResearchControl) => act("/control", { action }), [act]);
  const steer = React.useCallback((guidance: string) => act("/steer", { guidance: guidance.trim() }), [act]);

  const payload = snapshot.payload?.run.id === runId ? snapshot.payload : null;
  return {
    payload,
    run: payload?.run ?? null,
    events: payload?.events ?? EMPTY_EVENTS,
    failed: snapshot.failed,
    disconnected: snapshot.disconnected,
    busy: snapshot.busy,
    notice: snapshot.notice,
    post,
    reload,
    fetchedAt: snapshot.fetchedAt,
    phase: payload ? snapshot.phase : null,
    act,
    control,
    steer,
  };
}
