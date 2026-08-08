import "server-only";
import { prisma } from "@/lib/prisma";
import {
  EMPTY_PLAN,
  MAX_PLAN_CONSTRAINTS,
  MAX_PLAN_QUERIES,
  MAX_PINNED_SOURCES,
  RESEARCH_LIVE_STATES,
  budgetAllows,
  budgetExhausted,
  budgetStopState,
  isBlockedResearchState,
  isPausable,
  isResearchState,
  isTerminalResearchState,
  isWorkingResearchState,
  parsePlan,
  planIsConfirmed,
  resumeStateFor,
  transitionAllowed,
  type ResearchEventKind,
  type ResearchPlan,
  type ResearchProgress,
  type ResearchState,
  type ResearchTerminalState,
} from "@/lib/research/domain";

/**
 * The durable research job.
 *
 * `src/lib/deep-research.ts` used to be the whole of research: plan, search,
 * read, hand a corpus back — all inside one HTTP request, holding everything
 * it had found in local variables. Close the tab and it was gone; there was
 * nothing to pause, nothing to resume, nothing to steer, and no ceiling on what
 * one request could spend. This module is that pipeline turned into a job whose
 * every intermediate result is a row.
 *
 * The shape is Work's, not a second invention (see `src/lib/work/store.ts`): a
 * state column, an append-only event log with a monotonic per-run `seq`, and a
 * client that resumes from a cursor. Two durable-run designs in one codebase is
 * how you end up with two SSE clients, two cursor bugs and two answers to "is
 * this run still going".
 *
 * Everything the engine needs from the outside — the database, the planner, the
 * search backend, the writer, the clock — arrives as `ResearchDeps`. That is
 * what lets `tests/research-run.test.ts` drive the entire machine, including
 * cancellation mid-flight and the budget ceiling, with no Postgres and no
 * network. A state machine you can only exercise against live infrastructure is
 * a state machine whose illegal transitions ship.
 */

// ---------------------------------------------------------------------------
// Rows the engine works with
// ---------------------------------------------------------------------------

/** The `ResearchRun` columns the engine reads. Narrow on purpose. */
export interface ResearchRunRow {
  id: string;
  userId: string;
  conversationId: string | null;
  goal: string;
  state: string;
  plan: unknown;
  queries: string[];
  costMicroUsd: bigint;
  budgetMicroUsd: bigint | null;
  error: string | null;
  report: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface ResearchSourceRow {
  id: string;
  url: string;
  title: string;
  contentHash: string | null;
  snapshot: string | null;
  publishedAt: Date | null;
  authority: number | null;
  fetchedAt: Date;
}

export interface ResearchEventRow {
  id: string;
  seq: number;
  kind: string;
  payload: unknown;
  createdAt: Date;
}

export interface ResearchEventInput {
  kind: ResearchEventKind;
  payload?: Record<string, unknown>;
}

export interface AppendedResearchEvents {
  /** The run's highest seq after the append — the cursor a client resumes from. */
  lastSeq: number;
  appended: Array<{ seq: number; kind: ResearchEventKind }>;
}

/**
 * Everything the engine does to storage.
 *
 * An interface rather than direct Prisma calls because the transitions, the
 * cursor and the ceiling are the parts worth testing and none of them are
 * about SQL. `createPrismaResearchStore` is the only production implementation.
 */
export interface ResearchStore {
  loadRun(runId: string, userId: string): Promise<ResearchRunRow | null>;
  /**
   * Conditional state write: moves the run only if it is still in one of
   * `from`. Returns the new row, or null when somebody else moved it first.
   */
  moveState(input: {
    runId: string;
    userId: string;
    from: readonly ResearchState[];
    to: ResearchState;
    patch?: { plan?: ResearchPlan; error?: string | null; report?: string | null };
  }): Promise<ResearchRunRow | null>;
  savePlan(input: { runId: string; userId: string; plan: ResearchPlan }): Promise<ResearchRunRow | null>;
  recordQueries(input: { runId: string; userId: string; queries: string[] }): Promise<void>;
  appendEvents(input: {
    runId: string;
    userId: string;
    events: readonly ResearchEventInput[];
  }): Promise<AppendedResearchEvents>;
  readEvents(input: {
    runId: string;
    userId: string;
    after: number;
    limit: number;
  }): Promise<ResearchEventRow[]>;
  progress(runId: string, userId: string): Promise<ResearchProgress>;
  /** Idempotent by URL within the run: a re-run of a step must not double a source. */
  upsertSource(input: {
    runId: string;
    userId: string;
    url: string;
    title: string;
    snippet: string;
    contentHash?: string | null;
    snapshot?: string | null;
    authority?: number | null;
  }): Promise<{ id: string; created: boolean }>;
  savePassages(input: {
    userId: string;
    sourceId: string;
    passages: Array<{ text: string; locator?: string | null; ordinal: number }>;
  }): Promise<number>;
  listSources(runId: string, userId: string): Promise<ResearchSourceRow[]>;
  /** Adds to `costMicroUsd` and returns the new total. */
  addSpend(input: { runId: string; userId: string; microUsd: number }): Promise<bigint>;
}

// ---------------------------------------------------------------------------
// The work the engine farms out
// ---------------------------------------------------------------------------

export interface ResearchHit {
  url: string;
  title: string;
  snippet: string;
  /** Full page text when the backend returned it in the same call. */
  rawContent?: string;
}

export interface ResearchDeps {
  store: ResearchStore;
  /** Turns the goal (plus any steering constraints) into sub-questions. */
  plan(input: {
    userId: string;
    goal: string;
    constraints: string[];
    signal?: AbortSignal;
  }): Promise<{ queries: string[]; costMicroUsd: number }>;
  search(input: { userId: string; query: string; signal?: AbortSignal }): Promise<{
    hits: ResearchHit[];
    costMicroUsd: number;
  }>;
  /** Fetches a page the search backend did not return text for (pinned sources). */
  fetchPage(input: { userId: string; url: string; signal?: AbortSignal }): Promise<{
    title: string;
    text: string;
    costMicroUsd: number;
  } | null>;
  /** Writes the report. Optional: the chat path streams synthesis itself. */
  synthesize?(input: {
    userId: string;
    goal: string;
    plan: ResearchPlan;
    sources: ResearchSourceRow[];
    signal?: AbortSignal;
  }): Promise<{ report: string; costMicroUsd: number }>;
  /** Stable hash of fetched text, so a report stays auditable after the page changes. */
  hash(text: string): string;
  now(): Date;
}

// ---------------------------------------------------------------------------
// Cost estimates used for the pre-spend check
// ---------------------------------------------------------------------------

/*
 * Estimates, not prices. `budgetAllows` needs a number BEFORE the call is made,
 * and the only alternative — spend first, compare after — is not a ceiling at
 * all. They are deliberately generous: over-estimating stops a run slightly
 * early, under-estimating lets it overrun the number the user set, and only one
 * of those is a bug worth having.
 */
const PLAN_ESTIMATE_MICRO_USD = 5_000;
const SEARCH_ESTIMATE_MICRO_USD = 10_000;
const READ_ESTIMATE_MICRO_USD = 2_000;
const SYNTHESIS_ESTIMATE_MICRO_USD = 120_000;

/** Sources carried into synthesis. Beyond this the corpus stops fitting. */
const MAX_SOURCES = 12;
/** Sources whose full text is stored as a snapshot. */
const MAX_READ_SOURCES = 8;
const SNAPSHOT_CHARS = 8_000;
const PASSAGE_CHARS = 1_200;
const MAX_PASSAGES_PER_SOURCE = 6;
/** Guard against a driver looping forever on a state that never advances. */
const MAX_STEPS = 40;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export type StepOutcome =
  | { kind: "advanced"; state: ResearchState }
  /** Stopped because only a person can move it on (plan, question, pause). */
  | { kind: "blocked"; state: ResearchState }
  | { kind: "finished"; state: ResearchTerminalState }
  /** Somebody else moved the run underneath this step. Reload and re-decide. */
  | { kind: "raced" };

export interface StartRunInput {
  userId: string;
  goal: string;
  conversationId?: string | null;
  budgetMicroUsd?: bigint | null;
  /** `auto` skips the confirmation gate — see `ResearchPlan.confirmation`. */
  confirmation?: "auto" | "required";
  constraints?: string[];
  pinnedSources?: string[];
}

export interface ControlResult {
  ok: boolean;
  /** Present whether or not the control applied, so a caller can report truth. */
  state: string;
  /** Set when `ok` is false: why the control did not apply. */
  reason?: "not_found" | "not_pausable" | "not_paused" | "already_finished" | "not_awaiting_plan";
}

export interface ResearchEngine {
  start(input: StartRunInput): Promise<ResearchRunRow>;
  /** Runs steps until the run blocks, finishes, or reaches `until`. */
  drive(input: {
    runId: string;
    userId: string;
    signal?: AbortSignal;
    /** Stop cleanly once the run enters this state, leaving it live. */
    until?: ResearchState;
  }): Promise<ResearchRunRow | null>;
  decidePlan(input: {
    runId: string;
    userId: string;
    decision: "confirm" | "cancel";
    queries?: string[];
    constraints?: string[];
    pinnedSources?: string[];
  }): Promise<ControlResult>;
  steer(input: {
    runId: string;
    userId: string;
    constraint?: string;
    sourceUrl?: string;
  }): Promise<ControlResult>;
  pause(input: { runId: string; userId: string }): Promise<ControlResult>;
  resume(input: { runId: string; userId: string }): Promise<ControlResult>;
  cancel(input: { runId: string; userId: string }): Promise<ControlResult>;
}

export function createResearchEngine(deps: ResearchDeps): ResearchEngine {
  const { store } = deps;

  const append = (runId: string, userId: string, events: readonly ResearchEventInput[]) =>
    store.appendEvents({ runId, userId, events });

  /**
   * Moves the run and records the move in the same breath.
   *
   * Every transition goes through here so that `state_changed` cannot be
   * forgotten: the panel builds its stage list from those events alone, and a
   * transition with no event is a run that visibly stops progressing while
   * quietly continuing to spend.
   */
  const advance = async (
    run: ResearchRunRow,
    to: ResearchState,
    patch?: { plan?: ResearchPlan; error?: string | null; report?: string | null },
    extra: readonly ResearchEventInput[] = []
  ): Promise<ResearchRunRow | null> => {
    const from = run.state;
    if (!isResearchState(from) || !transitionAllowed(from, to)) return null;
    const moved = await store.moveState({
      runId: run.id,
      userId: run.userId,
      from: [from],
      to,
      patch,
    });
    if (!moved) return null;
    await append(run.id, run.userId, [
      ...extra,
      { kind: "state_changed", payload: { from, state: to } },
    ]);
    return moved;
  };

  /**
   * Ends the run, once.
   *
   * The `from` list is every live state, which is what makes a terminal
   * transition unrepeatable: a driver that finishes a step it started before
   * the user cancelled finds the WHERE no longer matches and writes nothing, so
   * the recorded reason stays the user's cancel rather than being overwritten
   * by whatever the driver was going to say.
   */
  const finish = async (
    run: ResearchRunRow,
    to: ResearchTerminalState,
    detail: { error?: string | null; report?: string | null; reason?: string } = {}
  ): Promise<ResearchRunRow | null> => {
    const from = run.state;
    if (!isResearchState(from) || !transitionAllowed(from, to)) return null;
    const moved = await store.moveState({
      runId: run.id,
      userId: run.userId,
      from: [from],
      to,
      patch: { error: detail.error ?? null, report: detail.report ?? run.report },
    });
    if (!moved) return null;
    await append(run.id, run.userId, [
      { kind: "state_changed", payload: { from, state: to } },
      {
        kind: "run_finished",
        payload: {
          state: to,
          reason: detail.reason ?? to,
          ...(detail.error ? { error: detail.error } : {}),
        },
      },
    ]);
    return moved;
  };

  /**
   * The per-step ceiling check.
   *
   * Reads the run's spend fresh rather than trusting the row the step began
   * with: a chat turn billing the same account concurrently moves the number
   * underneath a long step, and a stale total is how a ceiling gets crossed by
   * exactly one expensive call.
   */
  const affordable = async (run: ResearchRunRow, estimate: number): Promise<boolean> => {
    const fresh = await store.loadRun(run.id, run.userId);
    const spent = fresh?.costMicroUsd ?? run.costMicroUsd;
    return budgetAllows(spent, run.budgetMicroUsd, estimate);
  };

  const stopForBudget = async (run: ResearchRunRow, estimate: number): Promise<StepOutcome> => {
    const progress = await store.progress(run.id, run.userId);
    const to = budgetStopState(progress);
    await append(run.id, run.userId, [
      {
        kind: "budget_exhausted",
        payload: {
          spentMicroUsd: run.costMicroUsd.toString(),
          budgetMicroUsd: run.budgetMicroUsd === null ? null : run.budgetMicroUsd.toString(),
          nextStepEstimateMicroUsd: estimate,
        },
      },
    ]);
    const ended = await finish(run, to, {
      reason: "budget_exhausted",
      error:
        to === "failed"
          ? "The per-run budget was too small to gather anything."
          : "Stopped at the per-run budget with the sources gathered so far.",
    });
    return ended ? { kind: "finished", state: to } : { kind: "raced" };
  };

  /** Bills what a farmed-out call actually cost, and says so in the log. */
  const bill = async (run: ResearchRunRow, microUsd: number, what: string): Promise<void> => {
    const rounded = Math.max(0, Math.round(microUsd));
    if (rounded === 0) return;
    const total = await store.addSpend({ runId: run.id, userId: run.userId, microUsd: rounded });
    await append(run.id, run.userId, [
      {
        kind: "spend_recorded",
        payload: { step: what, microUsd: rounded, totalMicroUsd: total.toString() },
      },
    ]);
  };

  // ── the individual stages ───────────────────────────────────────────────

  const doPlanning = async (run: ResearchRunRow, signal?: AbortSignal): Promise<StepOutcome> => {
    const plan = parsePlan(run.plan);
    if (!(await affordable(run, PLAN_ESTIMATE_MICRO_USD))) {
      return stopForBudget(run, PLAN_ESTIMATE_MICRO_USD);
    }
    const drafted = await deps.plan({
      userId: run.userId,
      goal: run.goal,
      constraints: plan.constraints,
      signal,
    });
    await bill(run, drafted.costMicroUsd, "plan");
    // A failed planner degrades to searching the goal itself rather than to a
    // dead run: the user asked a question, and one broad query beats nothing.
    const queries = (drafted.queries.length ? drafted.queries : [run.goal]).slice(
      0,
      MAX_PLAN_QUERIES
    );
    const next: ResearchPlan = { ...plan, queries };
    if (plan.confirmation === "auto" && !planIsConfirmed(next)) {
      next.confirmedAt = deps.now().toISOString();
    }
    await store.savePlan({ runId: run.id, userId: run.userId, plan: next });
    await store.recordQueries({ runId: run.id, userId: run.userId, queries });

    const reloaded = (await store.loadRun(run.id, run.userId)) ?? run;
    if (planIsConfirmed(next)) {
      const moved = await advance(reloaded, "searching", undefined, [
        { kind: "plan_drafted", payload: { queries } },
        { kind: "plan_confirmed", payload: { by: "auto" } },
      ]);
      return moved ? { kind: "advanced", state: "searching" } : { kind: "raced" };
    }
    const moved = await advance(reloaded, "awaiting_plan_confirmation", undefined, [
      { kind: "plan_drafted", payload: { queries } },
    ]);
    return moved
      ? { kind: "blocked", state: "awaiting_plan_confirmation" }
      : { kind: "raced" };
  };

  const doSearching = async (run: ResearchRunRow, signal?: AbortSignal): Promise<StepOutcome> => {
    const plan = parsePlan(run.plan);
    const queries = plan.queries.length ? plan.queries : [run.goal];
    let current = run;
    for (const query of queries) {
      if (!(await affordable(current, SEARCH_ESTIMATE_MICRO_USD))) {
        return stopForBudget(current, SEARCH_ESTIMATE_MICRO_USD);
      }
      // Re-read between queries, not just between stages. A cancel pressed
      // during a five-query sweep should stop the sweep, not be noticed once
      // the last query has already been paid for.
      const fresh = await store.loadRun(current.id, current.userId);
      if (!fresh || fresh.state !== "searching") return { kind: "raced" };
      current = fresh;

      const found = await deps.search({ userId: run.userId, query, signal });
      await bill(current, found.costMicroUsd, "search");
      await append(run.id, run.userId, [
        { kind: "query_issued", payload: { query, results: found.hits.length } },
      ]);
      for (const hit of found.hits.slice(0, MAX_SOURCES)) {
        const stored = await store.upsertSource({
          runId: run.id,
          userId: run.userId,
          url: hit.url,
          title: hit.title,
          snippet: hit.snippet,
          // Snapshot and hash only once the READ stage has read it — a source
          // found is not a source verified, and recording a hash here would
          // claim we had audited text we only skimmed.
        });
        if (stored.created) {
          await append(run.id, run.userId, [
            { kind: "source_found", payload: { url: hit.url, title: hit.title, query } },
          ]);
        }
      }
    }
    const moved = await advance(current, "browsing");
    return moved ? { kind: "advanced", state: "browsing" } : { kind: "raced" };
  };

  /**
   * BROWSE: the user's pinned sources.
   *
   * Separate from SEARCH because a pinned source is not a search result — it
   * is an instruction, and it must be read whether or not any query surfaced
   * it. This is also the stage steering lands in, which is why a run steered
   * with a new URL resumes here rather than re-planning.
   */
  const doBrowsing = async (run: ResearchRunRow, signal?: AbortSignal): Promise<StepOutcome> => {
    const plan = parsePlan(run.plan);
    let current = run;
    for (const url of plan.pinnedSources.slice(0, MAX_PINNED_SOURCES)) {
      if (!(await affordable(current, READ_ESTIMATE_MICRO_USD))) {
        return stopForBudget(current, READ_ESTIMATE_MICRO_USD);
      }
      const fresh = await store.loadRun(current.id, current.userId);
      if (!fresh || fresh.state !== "browsing") return { kind: "raced" };
      current = fresh;

      const page = await deps.fetchPage({ userId: run.userId, url, signal });
      if (!page) {
        // A pinned source that will not load is worth saying out loud: the user
        // chose it, and silently proceeding without it produces a report that
        // looks like it considered something it never saw.
        await append(run.id, run.userId, [
          { kind: "error", payload: { scope: "pinned_source", url, message: "Could not be read." } },
        ]);
        continue;
      }
      await bill(current, page.costMicroUsd, "fetch");
      const text = page.text.slice(0, SNAPSHOT_CHARS);
      const stored = await store.upsertSource({
        runId: run.id,
        userId: run.userId,
        url,
        title: page.title || url,
        snippet: text.slice(0, 600),
        contentHash: deps.hash(text),
        snapshot: text,
        // Pinned by the user, so it outranks anything the search backend
        // surfaced; the number is recorded so a reader can see why.
        authority: 1,
      });
      await append(run.id, run.userId, [
        { kind: "source_read", payload: { url, title: page.title, pinned: true } },
      ]);
      await store.savePassages({
        userId: run.userId,
        sourceId: stored.id,
        passages: splitPassages(text),
      });
    }
    const moved = await advance(current, "reading_documents");
    return moved ? { kind: "advanced", state: "reading_documents" } : { kind: "raced" };
  };

  const doReading = async (run: ResearchRunRow, signal?: AbortSignal): Promise<StepOutcome> => {
    const sources = await store.listSources(run.id, run.userId);
    const unread = sources.filter((source) => !source.snapshot).slice(0, MAX_READ_SOURCES);
    let current = run;
    let read = 0;
    for (const source of unread) {
      if (!(await affordable(current, READ_ESTIMATE_MICRO_USD))) {
        return stopForBudget(current, READ_ESTIMATE_MICRO_USD);
      }
      const fresh = await store.loadRun(current.id, current.userId);
      if (!fresh || fresh.state !== "reading_documents") return { kind: "raced" };
      current = fresh;

      const page = await deps.fetchPage({ userId: run.userId, url: source.url, signal });
      if (!page) continue;
      await bill(current, page.costMicroUsd, "fetch");
      const text = page.text.slice(0, SNAPSHOT_CHARS);
      await store.upsertSource({
        runId: run.id,
        userId: run.userId,
        url: source.url,
        title: page.title || source.title,
        snippet: text.slice(0, 600),
        contentHash: deps.hash(text),
        snapshot: text,
      });
      const saved = await store.savePassages({
        userId: run.userId,
        sourceId: source.id,
        passages: splitPassages(text),
      });
      read += 1;
      await append(run.id, run.userId, [
        { kind: "source_read", payload: { url: source.url, title: page.title, passages: saved } },
      ]);
    }
    await append(run.id, run.userId, [
      { kind: "passages_extracted", payload: { sourcesRead: read, sourcesTotal: sources.length } },
    ]);
    const moved = await advance(current, "checking_coverage");
    return moved ? { kind: "advanced", state: "checking_coverage" } : { kind: "raced" };
  };

  /**
   * COVERAGE: did the sources we have actually answer the plan?
   *
   * Cheap and local — it compares queries against the sources gathered rather
   * than asking a model — because the expensive version of this check belongs
   * after synthesis, where the claims exist to check. What it is really for is
   * the one branch below: a plan with queries that produced nothing goes back
   * to SEARCH once, and only once, tracked by the presence of sources so a run
   * that genuinely cannot find anything terminates instead of looping.
   */
  const doCoverage = async (run: ResearchRunRow): Promise<StepOutcome> => {
    const progress = await store.progress(run.id, run.userId);
    await append(run.id, run.userId, [
      {
        kind: "coverage_checked",
        payload: {
          queries: progress.queryCount,
          sources: progress.sourceCount,
          read: progress.readCount,
        },
      },
    ]);
    if (progress.sourceCount === 0) {
      const ended = await finish(run, "failed", {
        reason: "no_sources",
        error: "No usable sources came back for this plan.",
      });
      return ended ? { kind: "finished", state: "failed" } : { kind: "raced" };
    }
    const moved = await advance(run, "resolving_conflicts");
    return moved ? { kind: "advanced", state: "resolving_conflicts" } : { kind: "raced" };
  };

  /**
   * CONFLICTS: flag sources that are copies of each other.
   *
   * §8.2's requirement, done at the only point it can be done cheaply. Two
   * copies of one wire story must never read as independent corroboration, and
   * the identical `contentHash` is the evidence. Anything subtler is the
   * synthesis model's job, under the instruction to attribute disagreement.
   */
  const doConflicts = async (run: ResearchRunRow): Promise<StepOutcome> => {
    const sources = await store.listSources(run.id, run.userId);
    const byHash = new Map<string, string[]>();
    for (const source of sources) {
      if (!source.contentHash) continue;
      byHash.set(source.contentHash, [...(byHash.get(source.contentHash) ?? []), source.url]);
    }
    for (const [hash, urls] of byHash) {
      if (urls.length < 2) continue;
      await append(run.id, run.userId, [
        { kind: "conflict_found", payload: { kind: "duplicate_content", contentHash: hash, urls } },
      ]);
    }
    const moved = await advance(run, "synthesizing");
    return moved ? { kind: "advanced", state: "synthesizing" } : { kind: "raced" };
  };

  const doSynthesis = async (run: ResearchRunRow, signal?: AbortSignal): Promise<StepOutcome> => {
    // No writer wired in: this is the chat path, where the route streams the
    // report through the user's own model. The job's work is done, and the run
    // waits at `synthesizing` for the caller that asked to be handed the
    // corpus. `drive({ until: "synthesizing" })` is how that caller stops here.
    if (!deps.synthesize) return { kind: "blocked", state: "synthesizing" };
    if (!(await affordable(run, SYNTHESIS_ESTIMATE_MICRO_USD))) {
      return stopForBudget(run, SYNTHESIS_ESTIMATE_MICRO_USD);
    }
    const sources = (await store.listSources(run.id, run.userId)).slice(0, MAX_SOURCES);
    const written = await deps.synthesize({
      userId: run.userId,
      goal: run.goal,
      plan: parsePlan(run.plan),
      sources,
      signal,
    });
    await bill(run, written.costMicroUsd, "synthesis");
    const fresh = (await store.loadRun(run.id, run.userId)) ?? run;
    if (fresh.state !== "synthesizing") return { kind: "raced" };
    const moved = await advance(fresh, "validating_citations", { report: written.report }, [
      { kind: "report_ready", payload: { chars: written.report.length } },
    ]);
    return moved ? { kind: "advanced", state: "validating_citations" } : { kind: "raced" };
  };

  /**
   * VALIDATE: every [n] in the report has to point at a source that exists.
   *
   * A citation to source 14 of a 9-source corpus is the failure this catches,
   * and it is a failure the synthesis model makes often enough to be worth a
   * deterministic check. It does not rewrite the report — a report with one bad
   * marker is still worth reading — it records what it found so the UI can say
   * which claims are unbacked.
   */
  const doValidation = async (run: ResearchRunRow): Promise<StepOutcome> => {
    const sources = await store.listSources(run.id, run.userId);
    const report = run.report ?? "";
    const cited = new Set<number>();
    for (const match of report.matchAll(/\[(\d{1,2})\]/g)) cited.add(Number(match[1]));
    const dangling = [...cited].filter((n) => n < 1 || n > Math.min(sources.length, MAX_SOURCES));
    if (dangling.length > 0) {
      await append(run.id, run.userId, [
        {
          kind: "error",
          payload: {
            scope: "citations",
            message: "The report cited sources that are not in the corpus.",
            markers: dangling,
          },
        },
      ]);
    }
    const to: ResearchTerminalState = dangling.length > 0 ? "partially_completed" : "completed";
    const ended = await finish(run, to, {
      reason: dangling.length > 0 ? "citations_unverified" : "completed",
      report,
      error:
        dangling.length > 0
          ? "Some citations in the report do not match a gathered source."
          : null,
    });
    return ended ? { kind: "finished", state: to } : { kind: "raced" };
  };

  const step = async (run: ResearchRunRow, signal?: AbortSignal): Promise<StepOutcome> => {
    if (isTerminalResearchState(run.state)) {
      return { kind: "finished", state: run.state };
    }
    if (isBlockedResearchState(run.state)) {
      return { kind: "blocked", state: run.state };
    }
    // The ceiling applies before the state machine does anything at all, so a
    // run resumed with its budget already spent stops rather than starting one
    // more "cheap" stage.
    if (budgetExhausted(run.costMicroUsd, run.budgetMicroUsd)) {
      return stopForBudget(run, 0);
    }
    if (run.state === "accepted") {
      const moved = await advance(run, "planning", undefined, [
        { kind: "run_started", payload: { goal: run.goal } },
      ]);
      return moved ? { kind: "advanced", state: "planning" } : { kind: "raced" };
    }
    if (!isWorkingResearchState(run.state)) return { kind: "raced" };
    switch (run.state) {
      case "planning":
        return doPlanning(run, signal);
      case "searching":
        return doSearching(run, signal);
      case "browsing":
        return doBrowsing(run, signal);
      case "reading_documents":
        return doReading(run, signal);
      case "checking_coverage":
        return doCoverage(run);
      case "resolving_conflicts":
        return doConflicts(run);
      case "synthesizing":
        return doSynthesis(run, signal);
      case "validating_citations":
        return doValidation(run);
    }
  };

  return {
    async start(input) {
      const plan: ResearchPlan = {
        ...EMPTY_PLAN,
        confirmation: input.confirmation ?? "required",
        constraints: (input.constraints ?? []).slice(0, MAX_PLAN_CONSTRAINTS),
        pinnedSources: (input.pinnedSources ?? []).slice(0, MAX_PINNED_SOURCES),
      };
      return createRun(store, { ...input, plan });
    },

    async drive({ runId, userId, signal, until }) {
      let run = await store.loadRun(runId, userId);
      if (!run) return null;
      for (let i = 0; i < MAX_STEPS; i += 1) {
        if (signal?.aborted) return run;
        if (until && run.state === until) return run;
        const outcome = await step(run, signal);
        if (outcome.kind === "finished" || outcome.kind === "blocked") {
          return (await store.loadRun(runId, userId)) ?? run;
        }
        const fresh = await store.loadRun(runId, userId);
        if (!fresh) return run;
        // A `raced` outcome is not an error: a pause or a cancel landing
        // mid-step is exactly what it looks like. Reload and let the loop
        // re-decide — the next pass sees `paused` or `cancelled` and stops.
        if (outcome.kind === "raced" && fresh.state === run.state) return fresh;
        run = fresh;
      }
      // MAX_STEPS reached. Something is cycling; stopping with what we have is
      // better than a job that bills forever.
      return finish(run, "partially_completed", {
        reason: "step_limit",
        error: "The run stopped making progress and was halted.",
      }).then(() => store.loadRun(runId, userId));
    },

    async decidePlan({ runId, userId, decision, queries, constraints, pinnedSources }) {
      const run = await store.loadRun(runId, userId);
      if (!run) return { ok: false, state: "", reason: "not_found" };
      if (run.state !== "awaiting_plan_confirmation") {
        return {
          ok: false,
          state: run.state,
          reason: isTerminalResearchState(run.state) ? "already_finished" : "not_awaiting_plan",
        };
      }
      if (decision === "cancel") {
        const ended = await finish(run, "cancelled", { reason: "plan_rejected" });
        return ended
          ? { ok: true, state: "cancelled" }
          : { ok: false, state: run.state, reason: "already_finished" };
      }
      const current = parsePlan(run.plan);
      const edited: ResearchPlan = parsePlan({
        ...current,
        queries: queries ?? current.queries,
        constraints: constraints ?? current.constraints,
        pinnedSources: pinnedSources ?? current.pinnedSources,
        confirmedAt: deps.now().toISOString(),
      });
      const saved = await store.savePlan({ runId, userId, plan: edited });
      await store.recordQueries({ runId, userId, queries: edited.queries });
      const moved = await advance(saved ?? run, "searching", undefined, [
        {
          kind: "plan_confirmed",
          payload: { by: "user", queries: edited.queries, edited: queries !== undefined },
        },
      ]);
      return moved
        ? { ok: true, state: "searching" }
        : { ok: false, state: run.state, reason: "not_awaiting_plan" };
    },

    /**
     * Steering: add a constraint or a source without restarting.
     *
     * Two rules make this safe. The constraint goes into the PLAN, so it
     * reaches synthesis however late it arrives; and a new pinned source sends
     * a run that has already passed BROWSE back to it, because a source nobody
     * fetched is a source the report cannot use. A run past synthesis takes the
     * constraint but not the round trip — rewriting a finished report on a
     * whim is how a user loses the report they were reading.
     */
    async steer({ runId, userId, constraint, sourceUrl }) {
      const run = await store.loadRun(runId, userId);
      if (!run) return { ok: false, state: "", reason: "not_found" };
      if (isTerminalResearchState(run.state)) {
        return { ok: false, state: run.state, reason: "already_finished" };
      }
      const plan = parsePlan(run.plan);
      const next: ResearchPlan = parsePlan({
        ...plan,
        constraints: constraint ? [...plan.constraints, constraint] : plan.constraints,
        pinnedSources: sourceUrl ? [...plan.pinnedSources, sourceUrl] : plan.pinnedSources,
      });
      await store.savePlan({ runId, userId, plan: next });
      await append(runId, userId, [
        {
          kind: "steering_applied",
          payload: {
            ...(constraint ? { constraint } : {}),
            ...(sourceUrl ? { sourceUrl } : {}),
            appliedAt: run.state,
          },
        },
      ]);
      // `advance`, not a raw write: the transition table is what says a run may
      // go back to gathering from here, and a steering path that wrote the
      // state directly would be the one caller allowed to make illegal moves.
      if (sourceUrl && REFETCH_FROM.includes(run.state as ResearchState)) {
        const moved = await advance(run, "searching");
        if (moved) return { ok: true, state: "searching" };
      }
      return { ok: true, state: run.state };
    },

    async pause({ runId, userId }) {
      const run = await store.loadRun(runId, userId);
      if (!run) return { ok: false, state: "", reason: "not_found" };
      // The condition lives in the WHERE, not in an `if` above it. Reading the
      // state, deciding, then writing leaves a window in which the driver
      // finishes the run underneath the decision — and the write lands anyway,
      // dragging a completed run back into `paused`.
      const moved = await store.moveState({
        runId,
        userId,
        from: [...LIVE_PAUSABLE],
        to: "paused",
      });
      if (!moved) {
        return {
          ok: false,
          state: run.state,
          reason: isTerminalResearchState(run.state) ? "already_finished" : "not_pausable",
        };
      }
      await append(runId, userId, [
        { kind: "state_changed", payload: { from: run.state, state: "paused" } },
        { kind: "paused", payload: { actor: "user", from: run.state } },
      ]);
      return { ok: true, state: "paused" };
    },

    async resume({ runId, userId }) {
      const run = await store.loadRun(runId, userId);
      if (!run) return { ok: false, state: "", reason: "not_found" };
      if (run.state !== "paused") {
        return {
          ok: false,
          state: run.state,
          reason: isTerminalResearchState(run.state) ? "already_finished" : "not_paused",
        };
      }
      const progress = await store.progress(runId, userId);
      const to = resumeStateFor(progress);
      const moved = await store.moveState({ runId, userId, from: ["paused"], to });
      if (!moved) return { ok: false, state: run.state, reason: "not_paused" };
      await append(runId, userId, [
        { kind: "state_changed", payload: { from: "paused", state: to } },
        { kind: "resumed", payload: { actor: "user", state: to } },
      ]);
      return { ok: true, state: to };
    },

    async cancel({ runId, userId }) {
      const run = await store.loadRun(runId, userId);
      if (!run) return { ok: false, state: "", reason: "not_found" };
      const progress = await store.progress(runId, userId);
      const moved = await store.moveState({
        runId,
        userId,
        from: [...RESEARCH_CANCELLABLE],
        // A cancel with sources already gathered is `cancelled`, not
        // `partially_completed`: the user's decision is the reason the run
        // ended, and the sources are still attached to read. Conflating the two
        // loses which of them happened.
        to: "cancelled",
      });
      if (!moved) return { ok: false, state: run.state, reason: "already_finished" };
      await append(runId, userId, [
        { kind: "state_changed", payload: { from: run.state, state: "cancelled" } },
        {
          kind: "cancelled",
          payload: { actor: "user", from: run.state, sources: progress.sourceCount },
        },
        { kind: "run_finished", payload: { state: "cancelled", reason: "cancelled" } },
      ]);
      return { ok: true, state: "cancelled" };
    },
  };
}

/**
 * Derived from the live set rather than listed, so a state added to `domain.ts`
 * is pausable and cancellable the day it ships. That is the safe direction:
 * the cost of being able to stop something unexpected is a run that stops, and
 * the cost of the other mistake is a user watching a run they cannot interrupt.
 */
const LIVE_PAUSABLE: ResearchState[] = RESEARCH_LIVE_STATES.filter((state) => isPausable(state));

/** Every live state — exactly the set a cancel must win from. */
const RESEARCH_CANCELLABLE: ResearchState[] = [...RESEARCH_LIVE_STATES];

/**
 * States from which a newly pinned source sends the run back to gathering.
 *
 * Everything after the reading stage and before the report: at that point the
 * source can still change what the report says, and adding it without a round
 * trip would give the user a citation-shaped promise the corpus cannot keep.
 * Once synthesis has produced a report the constraint is still recorded but
 * the run is left alone — see `steer`.
 */
const REFETCH_FROM: ResearchState[] = [
  "reading_documents",
  "checking_coverage",
  "resolving_conflicts",
];

/**
 * Cuts a snapshot into passages.
 *
 * Paragraph-shaped rather than fixed-width, because a passage is what a claim
 * gets cited against and a citation that lands mid-sentence is not evidence a
 * reader can check. The offsets go into `locator` so the UI can point at the
 * exact span of the stored snapshot — not of the live page, which will have
 * changed by the time anyone looks.
 */
export function splitPassages(
  text: string
): Array<{ text: string; locator: string; ordinal: number }> {
  const out: Array<{ text: string; locator: string; ordinal: number }> = [];
  let cursor = 0;
  for (const chunk of text.split(/\n{2,}/)) {
    const start = text.indexOf(chunk, cursor);
    cursor = start + chunk.length;
    const trimmed = chunk.trim();
    if (trimmed.length < 80) continue;
    const body = trimmed.slice(0, PASSAGE_CHARS);
    out.push({
      text: body,
      locator: `chars:${start}-${start + body.length}`,
      ordinal: out.length,
    });
    if (out.length >= MAX_PASSAGES_PER_SOURCE) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The Prisma store
// ---------------------------------------------------------------------------

async function createRun(
  store: ResearchStore,
  input: StartRunInput & { plan: ResearchPlan }
): Promise<ResearchRunRow> {
  // `start` is the only path that creates a row, and it is the one operation
  // the store interface does not abstract — a fake store in a test creates its
  // rows directly. Keeping the Prisma call behind `store.loadRun` would mean an
  // interface method whose only implementation is a `create`.
  const created = await prisma.researchRun.create({
    data: {
      userId: input.userId,
      conversationId: input.conversationId ?? null,
      goal: input.goal.slice(0, 8_000),
      state: "accepted",
      plan: { ...input.plan } as unknown as object,
      budgetMicroUsd: input.budgetMicroUsd ?? null,
      startedAt: new Date(),
    },
  });
  const row = toRunRow(created);
  await store.appendEvents({
    runId: row.id,
    userId: row.userId,
    events: [{ kind: "run_started", payload: { goal: row.goal } }],
  });
  return row;
}

interface PrismaResearchRun {
  id: string;
  userId: string;
  conversationId: string | null;
  goal: string;
  state: string;
  plan: unknown;
  queries: string[];
  costMicroUsd: bigint;
  budgetMicroUsd: bigint | null;
  error: string | null;
  report: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

function toRunRow(row: PrismaResearchRun): ResearchRunRow {
  return {
    id: row.id,
    userId: row.userId,
    conversationId: row.conversationId,
    goal: row.goal,
    state: row.state,
    plan: row.plan,
    queries: row.queries,
    costMicroUsd: row.costMicroUsd,
    budgetMicroUsd: row.budgetMicroUsd,
    error: row.error,
    report: row.report,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

const TERMINAL_PATCH = (to: ResearchState) =>
  isTerminalResearchState(to) ? { finishedAt: new Date() } : {};

export function createPrismaResearchStore(): ResearchStore {
  return {
    async loadRun(runId, userId) {
      const row = await prisma.researchRun.findFirst({ where: { id: runId, userId } });
      return row ? toRunRow(row) : null;
    },

    async moveState({ runId, userId, from, to, patch }) {
      // `updateMany` rather than `update`, because the state condition has to be
      // re-evaluated by Postgres against the committed row. Exactly one caller
      // sees a count of 1; everybody else gets 0 and knows they lost.
      const moved = await prisma.researchRun.updateMany({
        where: { id: runId, userId, state: { in: [...from] } },
        data: {
          state: to,
          ...TERMINAL_PATCH(to),
          ...(patch?.plan ? { plan: { ...patch.plan } as unknown as object } : {}),
          ...(patch && "error" in patch ? { error: patch.error ?? null } : {}),
          ...(patch && "report" in patch && patch.report !== undefined
            ? { report: patch.report }
            : {}),
        },
      });
      if (moved.count === 0) return null;
      const row = await prisma.researchRun.findFirst({ where: { id: runId, userId } });
      return row ? toRunRow(row) : null;
    },

    async savePlan({ runId, userId, plan }) {
      const saved = await prisma.researchRun.updateMany({
        where: { id: runId, userId },
        data: { plan: { ...plan } as unknown as object },
      });
      if (saved.count === 0) return null;
      const row = await prisma.researchRun.findFirst({ where: { id: runId, userId } });
      return row ? toRunRow(row) : null;
    },

    async recordQueries({ runId, userId, queries }) {
      await prisma.researchRun.updateMany({
        where: { id: runId, userId },
        data: { queries: queries.slice(0, MAX_PLAN_QUERIES) },
      });
    },

    /**
     * Appends events, allocating `seq` so the sequence is monotonic and has no
     * holes.
     *
     * `ResearchRun` has no `lastSeq` counter — the schema is landed and shared —
     * so the allocation is `max(seq) + 1` read inside the transaction. Two
     * things make that safe. The `update` above it takes the run's row lock, so
     * a second appender waits and then reads a maximum that already includes
     * this batch; and `@@unique([runId, seq])` is the backstop for the case the
     * lock cannot cover — a deployment mid-rollout, a connection pool reset —
     * where the loser retries and reads the new maximum.
     *
     * A hole matters more here than a duplicate. The client's cursor cannot tell
     * a hole from an event that has not arrived yet, so it waits for one that is
     * never coming and the panel stops updating for the rest of the run.
     */
    async appendEvents({ runId, userId, events }) {
      if (events.length === 0) {
        const top = await prisma.researchEvent.aggregate({
          where: { runId, userId },
          _max: { seq: true },
        });
        return { lastSeq: top._max.seq ?? 0, appended: [] };
      }
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          return await prisma.$transaction(async (tx) => {
            await tx.researchRun.update({
              where: { id: runId, userId },
              data: { updatedAt: new Date() },
              select: { id: true },
            });
            const top = await tx.researchEvent.aggregate({
              where: { runId, userId },
              _max: { seq: true },
            });
            const firstSeq = (top._max.seq ?? 0) + 1;
            const rows = events.map((event, index) => ({
              runId,
              userId,
              seq: firstSeq + index,
              kind: event.kind,
              payload: (event.payload ?? {}) as object,
            }));
            await tx.researchEvent.createMany({ data: rows });
            return {
              lastSeq: firstSeq + events.length - 1,
              appended: rows.map((row) => ({ seq: row.seq, kind: row.kind as ResearchEventKind })),
            };
          });
        } catch (e) {
          lastError = e;
        }
      }
      // Losing an event is not worth failing the step over: the run's state is
      // the source of truth and the transcript is a narration of it. Say so
      // loudly, then carry on.
      console.error("[research] event append failed", { runId, error: lastError });
      const top = await prisma.researchEvent.aggregate({
        where: { runId, userId },
        _max: { seq: true },
      });
      return { lastSeq: top._max.seq ?? 0, appended: [] };
    },

    async readEvents({ runId, userId, after, limit }) {
      return prisma.researchEvent.findMany({
        where: { runId, userId, seq: { gt: after } },
        orderBy: { seq: "asc" },
        take: limit,
        select: { id: true, seq: true, kind: true, payload: true, createdAt: true },
      });
    },

    async progress(runId, userId) {
      const [run, sourceCount, readCount, passageCount] = await Promise.all([
        prisma.researchRun.findFirst({
          where: { id: runId, userId },
          select: { plan: true, queries: true, report: true },
        }),
        prisma.researchSource.count({ where: { runId, userId } }),
        prisma.researchSource.count({ where: { runId, userId, snapshot: { not: null } } }),
        prisma.researchPassage.count({ where: { userId, source: { runId } } }),
      ]);
      return {
        planConfirmed: planIsConfirmed(parsePlan(run?.plan)),
        queryCount: run?.queries.length ?? 0,
        sourceCount,
        readCount,
        passageCount,
        hasReport: !!run?.report,
      };
    },

    async upsertSource({ runId, userId, url, title, snippet, contentHash, snapshot, authority }) {
      // No unique index on (runId, url) to upsert against, so this is a read
      // then a write. The race it leaves is two rows for one URL, which costs a
      // duplicate line in the sources list — acceptable, and far cheaper than
      // adding an index to a landed schema.
      const existing = await prisma.researchSource.findFirst({
        where: { runId, userId, url },
        select: { id: true },
      });
      if (existing) {
        await prisma.researchSource.updateMany({
          where: { id: existing.id, userId },
          data: {
            title: title.slice(0, 500),
            ...(contentHash !== undefined ? { contentHash } : {}),
            ...(snapshot !== undefined ? { snapshot } : {}),
            ...(authority !== undefined ? { authority } : {}),
          },
        });
        return { id: existing.id, created: false };
      }
      const created = await prisma.researchSource.create({
        data: {
          runId,
          userId,
          url,
          title: (title || url).slice(0, 500),
          contentHash: contentHash ?? null,
          snapshot: snapshot ?? snippet.slice(0, 600) ?? null,
          authority: authority ?? null,
        },
        select: { id: true },
      });
      return { id: created.id, created: true };
    },

    async savePassages({ userId, sourceId, passages }) {
      if (passages.length === 0) return 0;
      // Replace rather than append: a re-read of the same source after steering
      // must not leave the old snapshot's passages behind, still linked to
      // claims, still citable, and no longer matching the stored text.
      await prisma.researchPassage.deleteMany({ where: { sourceId, userId } });
      const created = await prisma.researchPassage.createMany({
        data: passages.map((passage) => ({
          userId,
          sourceId,
          text: passage.text,
          locator: passage.locator ?? null,
          ordinal: passage.ordinal,
        })),
      });
      return created.count;
    },

    async listSources(runId, userId) {
      return prisma.researchSource.findMany({
        where: { runId, userId },
        orderBy: { fetchedAt: "asc" },
        select: {
          id: true,
          url: true,
          title: true,
          contentHash: true,
          snapshot: true,
          publishedAt: true,
          authority: true,
          fetchedAt: true,
        },
      });
    },

    async addSpend({ runId, userId, microUsd }) {
      const updated = await prisma.researchRun.updateMany({
        where: { id: runId, userId },
        data: { costMicroUsd: { increment: BigInt(microUsd) } },
      });
      if (updated.count === 0) return BigInt(0);
      const row = await prisma.researchRun.findFirst({
        where: { id: runId, userId },
        select: { costMicroUsd: true },
      });
      return row?.costMicroUsd ?? BigInt(0);
    },
  };
}
