import {
  EMPTY_PLAN,
  MAX_FOLLOW_UP_ROUNDS,
  MAX_REVISION_ROUNDS,
  MAX_CONSTRAINT_CHARS,
  MAX_PLAN_CONSTRAINTS,
  MAX_PLAN_QUERIES,
  MAX_PINNED_SOURCES,
  RESEARCH_WORKER_LEASE_MS,
  buildResearchObjectives,
  RESEARCH_LIVE_STATES,
  budgetAllows,
  budgetExhausted,
  budgetStopState,
  budgetForEffort,
  fallbackResearchQueries,
  investigationElapsedMs,
  COVERAGE_TARGET,
  MAX_DELEGATIONS_PER_ROUND,
  MAX_RESEARCH_ROUNDS,
  SATURATION_NEW_CLAIM_SHARE,
  isBlockedResearchState,
  isPausable,
  isResearchState,
  isTerminalResearchState,
  isWorkingResearchState,
  parseClarificationAnswers,
  parsePlan,
  planIsConfirmed,
  planBudget,
  resumeStateFor,
  transitionAllowed,
  BRIEF_OUTPUT_TOKENS,
  BRIEF_PROMPT_CHARS,
  CLARIFY_OUTPUT_TOKENS,
  CLARIFY_PROMPT_CHARS,
  DEFAULT_RESEARCH_EFFORT,
  MAX_CLARIFICATIONS,
  CORPUS_PER_SOURCE_CHARS,
  CORPUS_PREAMBLE_CHARS,
  EXPANSION_OUTPUT_TOKENS,
  EXPANSION_PROMPT_CHARS,
  JUDGE_OUTPUT_TOKENS,
  JUDGE_PASSAGE_CHARS,
  JUDGE_PROMPT_OVERHEAD_CHARS,
  MAX_JUDGE_CALLS,
  modelCallEstimateMicroUsd,
  PAGE_FETCH_FEE_MICRO_USD,
  PLANNER_OUTPUT_TOKENS,
  PLANNER_PROMPT_CHARS,
  REVISION_REPORT_CHARS,
  RESEARCH_SNAPSHOT_CHARS,
  SEARCH_FEE_MICRO_USD,
  SYNTHESIS_OUTPUT_TOKENS,
  SYSTEM_PROMPT_CHARS,
  VENDOR_ESTIMATE_MARGIN,
  MAX_CONFLICTS,
  MAX_ROUND_OPEN_QUESTIONS,
  MAX_UNREADABLE_SOURCES,
  MAX_WORKER_QUERIES,
  reviewEstimateMicroUsd,
  workerEstimateMicroUsd,
  MAX_PLAN_REVISIONS,
  MAX_STEERING_ENTRIES,
  MAX_STEERING_CHARS,
  MAX_RESEARCH_OBJECTIVES,
  MAX_QUERY_CHARS,
  MAX_PLAN_CONTEXT_CHARS,
  budgetFromEnvelope,
  nearestEffort,
  planIsRevising,
  type ResearchClarification,
  type ResearchPlanRevision,
  type ResearchEventKind,
  type ResearchModelRates,
  type ResearchObjectiveStatus,
  type ResearchRoundReview,
  type ResearchCoverageEntry,
  type ResearchConflict,
  type ResearchDelegation,
  type ResearchRound,
  type ResearchPlan,
  type ResearchEffort,
  type ResearchProgress,
  type ResearchState,
  type ResearchTerminalState,
} from "@/lib/research/domain";
import {
  hostOfUrl,
  contentTokens,
  detectSyndication,
  scoreSource,
  sourceTypeMatchesRequirement,
  sourceTypeOf,
  tokenCoverage,
  type ResearchSourceType,
} from "@/lib/research/claim-analysis";
// Not from search-engine.ts: that module is `server-only` and importing it here
// would put the whole state machine out of reach of `tsx --test`. url-safety.ts
// exists precisely so the canonical-URL rule has one definition that both sides
// of that line can use.
import { canonicalUrl } from "@/lib/search/url-safety";
import {
  CHUNK_PREVIEW_CHARS,
  chunkText,
  chunkOrdinal,
  compileFindPattern,
  type ResearchFindingRow,
  type ReviewRoundInput,
  type ReviewRoundOutput,
  type RunWorkerInput,
  type WorkerResult,
  type WorkerStopReason,
  type WorkerTools,
} from "@/lib/research/agents/protocol";
import { HostLimiter, isAbortError, runAll } from "@/lib/research/agents/scheduler";
import { RESEARCH_LEASE_RENEW_MS, withHeartbeat } from "@/lib/research/lease-core";
import {
  contentLanguage,
  isTinyScope,
  languageName,
  plannedResearch,
  revisionForPlanner,
  todayLine,
  type PlannerDraft,
} from "@/lib/research/planner";
import type { ResearchBudgetRefusal } from "@/lib/research/envelope";
import { RESEARCH_REFUSAL_COPY } from "@/lib/research/entitlement";
import { estimateFor } from "@/lib/research/estimate";
import { isUsableReport, parseWriterOutput } from "@/lib/research/report-structure";
import type { ResearchEnvelope, ResearchEstimate, ResearchEstimateCaps, ResearchScope } from "@/types/research";

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
 *
 * No `server-only` here, and that is the reason the Prisma store lives next
 * door in `run.ts` rather than at the bottom of this file: `server-only`
 * throws the moment a plain Node process imports it, which is every test in
 * `tests/`. The same split, for the same reason, as
 * `src/lib/work/serializers.ts` against `src/lib/work/store.ts`.
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
  /** Additive field; old test stores and old rows may not expose it. */
  reportRevision?: number;
  /** Additive lease fields; old test stores and old rows may not expose them. */
  workerLeaseOwner?: string | null;
  workerLeaseUntil?: Date | null;
  lastHeartbeatAt?: Date | null;
  /** The completion message this run wrote (§9.6.3). Absent on stores that do not keep it. */
  assistantMessageId?: string | null;
}
export interface ResearchSourceRow {
  id: string;
  url: string;
  title: string;
  contentHash: string | null;
  snapshot: string | null;
  publishedAt: Date | null;
  authority: number | null;
  freshness?: number | null;
  directness?: number | null;
  independence?: number | null;
  composite?: number | null;
  sourceType?: ResearchSourceType | string | null;
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
  createRun(input: {
    userId: string;
    goal: string;
    conversationId: string | null;
    budgetMicroUsd: bigint | null;
    plan: ResearchPlan;
  }): Promise<ResearchRunRow>;
  loadRun(runId: string, userId: string): Promise<ResearchRunRow | null>;
  /** Atomically acquires or renews a restart-safe worker lease. */
  claimRun?(input: {
    runId: string;
    userId: string;
    workerId: string;
    leaseMs?: number;
  }): Promise<ResearchRunRow | null>;
  /**
   * Lets go of a lease this worker holds (B1). Optional: a store without
   * leases has nothing to release. Conditional on the owner, so a release
   * never frees a lease somebody else has since taken.
   */
  releaseRun?(input: { runId: string; userId: string; workerId: string }): Promise<void>;
  /**
   * Conditional state write: moves the run only if it is still in one of
   * `from`. Returns the new row, or null when somebody else moved it first.
   * `budgetMicroUsd` freezes the envelope's ceiling on the row at confirmation.
   */
  moveState(input: {
    runId: string;
    userId: string;
    from: readonly ResearchState[];
    to: ResearchState;
    patch?: { plan?: ResearchPlan; error?: string | null; report?: string | null; budgetMicroUsd?: bigint | null };
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
    publishedAt?: Date | null;
    /**
     * Only ever set together with `contentHash`, and only by a stage that
     * actually fetched the body. `ResearchSource` has no snippet column, so the
     * temptation is to park the search-result blurb in `snapshot` — which would
     * make every source found look like a source read, and put a 200-character
     * teaser under a hash claiming to attest to the page.
     */
    contentHash?: string | null;
    snapshot?: string | null;
    authority?: number | null;
    freshness?: number | null;
    directness?: number | null;
    independence?: number | null;
    composite?: number | null;
    sourceType?: ResearchSourceType | string | null;
  }): Promise<{ id: string; created: boolean }>;
  savePassages(input: {
    userId: string;
    sourceId: string;
    passages: Array<{ text: string; locator?: string | null; ordinal: number }>;
  }): Promise<number>;
  listSources(runId: string, userId: string): Promise<ResearchSourceRow[]>;
  /**
   * One row by URL, or null.
   *
   * Optional, with `listSources` as the fallback, because the in-memory test
   * stores predate it — but the production store must implement it. Every
   * worker tool call used to look its URL up by loading the whole corpus,
   * snapshots included: a few hundred rows of up to 12,000 characters, several
   * megabytes, hundreds of times per round. The store already keys rows by
   * `canonicalUrl`, so the narrow read is one indexed lookup.
   */
  findSourceByUrl?(runId: string, userId: string, url: string): Promise<ResearchSourceRow | null>;
  /**
   * Every row's URL and how much text it holds, and nothing else. What the
   * worker's `search` tool needs to mark results the run has already read, for
   * the same reason as above: it needs a URL and a length, not the corpus.
   */
  listSourceUrls?(runId: string, userId: string): Promise<Array<{ url: string; snapshotChars: number }>>;
  /**
   * A worker's finding: a claim, the quote behind it, the page it came from.
   *
   * Optional because the in-memory test stores predate the agent round and a
   * store without findings simply runs no workers — the sweep still produces
   * a corpus, findings are what make the report cite by claim rather than by
   * page.
   */
  addFinding?(input: {
    runId: string;
    userId: string;
    workerId: string;
    round: number;
    objectiveId: string | null;
    sourceId: string | null;
    url: string;
    claim: string;
    quote: string;
    locator: string | null;
    confidence: number | null;
  }): Promise<{ id: string }>;
  listFindings?(runId: string, userId: string): Promise<ResearchFindingRow[]>;
  /** Adds to `costMicroUsd` and returns the new total. */
  /** `kind` distinguishes a vendor fee, which has no model behind it and so
   *  needs the store to write the ledger row, from a model call that already
   *  recorded its own spend. */
  addSpend(input: {
    runId: string;
    userId: string;
    microUsd: number;
    kind: "search" | "model";
  }): Promise<bigint>;
}

// ---------------------------------------------------------------------------
// The work the engine farms out
// ---------------------------------------------------------------------------

export interface ResearchHit {
  url: string;
  title: string;
  snippet: string;
  publishedAt?: Date | null;
  /** Full page text when the backend returned it in the same call. */
  rawContent?: string;
}

/**
 * What one search backend did for one query.
 *
 * The fan-out used to swallow this entirely — a revoked key, an exhausted free
 * tier and a healthy-but-quiet engine all looked identical from here, which is
 * how a user ends up with a thin report and no way to find out why. Structural
 * on purpose: the timeline renders it, so it has to be data rather than a log
 * line nobody reading the run can see.
 */
export interface ResearchEngineReport {
  name: string;
  results: number;
  status: string;
  httpStatus?: number;
}

/** Whether this deployment is searching a real index or scraped endpoints. */
export interface ResearchProviderStatus {
  keyed: string[];
  keyless: string[];
  selfHostedSearxng: boolean;
  hasGoodIndex: boolean;
}

/** A link a fetched page pointed at, for the bounded hop stage. */
export interface ResearchPageLink {
  href: string;
  text: string;
}

/** A page that could not be turned into text, and the reason a user can act on. */
export interface ResearchPageSkipped {
  skipped: string;
  detail?: string;
  /** For `http_error`: the status, which is what decides whether a retry could ever help. */
  httpStatus?: number;
}

export type ResearchPageResult =
  | {
      title: string;
      text: string;
      costMicroUsd: number;
      links?: ResearchPageLink[];
      /** The date the page claims for itself, when the extractor found one. */
      publishedAt?: Date | null;
    }
  | ResearchPageSkipped;

export function pageWasSkipped(page: ResearchPageResult | null): page is ResearchPageSkipped {
  return !!page && "skipped" in page;
}

/** Plain English for the timeline. The machine-readable reason travels beside it. */
export function pageSkipMessage(page: ResearchPageSkipped): string {
  switch (page.skipped) {
    case "unsupported_content_type":
      return `This build cannot extract text from ${page.detail ?? "that file type"}.`;
    case "blocked_host":
      return "That address is not one this app is allowed to fetch.";
    case "redirect_limit":
      return "That address redirected too many times to read safely.";
    case "http_error":
      return `The site refused the request${page.detail ? ` (${page.detail})` : ""}.`;
    case "response_too_large":
      return `The page was larger than the ${page.detail ?? "allowed"} byte research limit.`;
    case "empty_document":
      return "The page loaded but contained no readable text.";
    case "pdf_unreadable":
      /*
       * A PDF gets four sentences rather than one because the four failures send
       * the reader somewhere completely different: a password-protected filing
       * needs credentials we will never have, an oversized one needs a smaller
       * copy, a damaged one needs a different mirror, and a mislabelled one was
       * never a PDF at all. Folding them into the shared default ("Could not be
       * read.") was the previous behaviour, and it made a run that skipped an
       * encrypted SEC filing indistinguishable from one that hit a truncated
       * download — so nobody could tell which skips were worth acting on.
       *
       * `detail` is the machine-readable `PdfFailureReason` minus `no_text_layer`
       * (which reports as `empty_document` above, since the file parsed fine).
       * The default stays because this switches on a plain string: a reason added
       * to pdf-text.ts and not to this list must degrade to something true rather
       * than crash a timeline render.
       */
      switch (page.detail) {
        case "encrypted":
          return "That PDF is password-protected.";
        case "too_large":
          return "That PDF is too large to read in a run.";
        case "malformed":
          return "That PDF is damaged and could not be opened.";
        case "not_a_pdf":
          return "That link served something other than the PDF it advertised.";
        default:
          return "That PDF could not be read.";
      }
    case "headless_render_failed":
      return "The page needs a browser to render and this build has none.";
    case "aborted":
      return "The fetch was stopped before the page arrived.";
    default:
      return "Could not be read.";
  }
}

/**
 * Whether a skip is a fact about the URL rather than about the moment.
 *
 * A follow-up pass through READ recomputed "needs fetching" from the rows
 * alone, so every URL that had failed was fetched again at the full timeout
 * and produced the same error line a second time. These reasons cannot change
 * between passes — a 404 stays a 404, a blocked host stays blocked, an
 * encrypted PDF stays encrypted, a JavaScript shell stays empty to a build
 * with no browser — so the run remembers them on the plan and reads the next
 * ranked source instead. A rate limit, a network failure and a server error
 * are left out: those are exactly the ones worth a second try.
 */
export function permanentSkip(page: ResearchPageSkipped): boolean {
  switch (page.skipped) {
    case "blocked_host":
    case "redirect_limit":
    case "unsupported_content_type":
    case "response_too_large":
    case "pdf_unreadable":
    case "empty_document":
      return true;
    case "http_error": {
      const status = page.httpStatus;
      if (typeof status !== "number" || status < 400 || status >= 500) return false;
      // 408, 425 and 429 are the client errors that mean "not now", not "not ever".
      return status !== 408 && status !== 425 && status !== 429;
    }
    default:
      return false;
  }
}

export interface ResearchDeps {
  store: ResearchStore;
  /**
   * Reads the goal back and asks what it does not say. OPTIONAL: a deployment
   * with no clarifier, or a goal that needs nothing, skips straight to
   * planning — the run must never be blocked by a step that cannot run.
   */
  clarify?(input: {
    userId: string;
    goal: string;
    effort: ResearchEffort;
    signal?: AbortSignal;
  }): Promise<{ questions: ResearchClarification[]; costMicroUsd: number }>;
  /** Turns the goal (plus any steering constraints) into sub-questions. */
  plan(input: {
    userId: string;
    goal: string;
    constraints: string[];
    effort?: import("./domain").ResearchEffort;
    pinnedSources?: string[];
    signal?: AbortSignal;
  }): Promise<{
    queries: string[];
    /** The plan a person reads at the gate. See `ResearchPlan.steps`. */
    steps?: string[];
    costMicroUsd: number;
    objectives?: ResearchPlan["objectives"];
    /** The expanded brief, persisted so every worker and the lead read it. */
    brief?: string;
    /** The planner's reasoning for the gate. See `ResearchPlan.approach`. */
    approach?: string;
    successCriteria?: string[];
    risks?: string[];
  }>;
  search(input: {
    userId: string;
    query: string;
    /** Results wanted after the merge — the tier's `resultsPerQuery`. */
    count?: number;
    signal?: AbortSignal;
  }): Promise<{
    hits: ResearchHit[];
    costMicroUsd: number;
    /** Optional: backends that can say how each engine did, do. */
    engines?: ResearchEngineReport[];
    providers?: ResearchProviderStatus;
  }>;
  /** Fetches a page the search backend did not return text for (pinned sources). */
  fetchPage(input: { userId: string; url: string; signal?: AbortSignal }): Promise<ResearchPageResult | null>;
  /**
   * Turns coverage gaps into genuinely NEW queries.
   *
   * Optional, and the templated follow-ups below remain the fallback — but the
   * templates are the reason a follow-up round so often re-fetched the pages the
   * original query already found: `"<objective> primary source evidence"` is a
   * paraphrase of the query that produced the gap, and a paraphrase hits the
   * same index entries. A model that is shown WHICH requirement went unmet and
   * what has already been asked can go somewhere else.
   */
  expandQueries?(input: {
    userId: string;
    goal: string;
    gaps: Array<{ question: string; status: string; missingReason?: string }>;
    alreadyIssued: string[];
    limit: number;
    signal?: AbortSignal;
  }): Promise<{ queries: string[]; costMicroUsd: number }>;
  /**
   * One research worker: a model driving the worker tools against the run.
   *
   * Optional, and the whole agent round is skipped without it — the sweep
   * above still gathers a corpus. Wired by run.ts to agents/worker.ts.
   */
  runWorker?(input: RunWorkerInput): Promise<WorkerResult>;
  /** The lead's review between rounds. Optional; a deterministic review stands in. */
  reviewRound?(input: ReviewRoundInput): Promise<ReviewRoundOutput>;
  /** Writes the report. Optional: the chat path streams synthesis itself. */
  synthesize?(input: {
    userId: string;
    goal: string;
    plan: ResearchPlan;
    sources: ResearchSourceRow[];
    /** The workers' findings, when the store keeps them. */
    findings?: ResearchFindingRow[];
    signal?: AbortSignal;
    /** Present only for the one bounded citation-driven rewrite. */
    revision?: {
      report: string;
      round: number;
    };
    /**
     * Share of the packed corpus budget to use: 1 on the first attempt, 0.7 on
     * the one retry after an empty or unusable report (B6).
     */
    corpusScale?: number;
    /** The writer's timebox: a quarter of the run's clock, at most six minutes. */
    timeoutMs?: number;
  }): Promise<{ report: string; costMicroUsd: number }>;
  /**
   * The merged clarify-and-plan call (SPEC §9.5, B5): one structured reply
   * with the questions, up to three optional clarifications, the searches,
   * the source kinds and the scope. When wired it replaces `clarify` and
   * `plan`, and a run never parks at `awaiting_clarification`.
   */
  draftPlan?(input: {
    userId: string;
    goal: string;
    /** The conversation before the request, already wrapped as untrusted (B20). */
    context?: string | null;
    constraints: string[];
    pinnedSources: string[];
    /** `plan.today`. */
    dateLine: string;
    /** The explicit content language, as a name ("French"), when there is one. */
    languageName?: string | null;
    /** The reader's edits at the gate, for a revision. */
    revision?: { questions: string[]; answers: Array<{ question: string; answer: string }> } | null;
    /** The lead model the run was sized for, when it has been. */
    leadModel?: string | null;
    signal?: AbortSignal;
  }): Promise<PlannerDraft>;
  /**
   * Sizes the run from its scope (SPEC §9.2): the server gathers the plan,
   * the month, the rates, the roster and the counts and calls
   * `researchBudgetFor`. `preview` sizes the card's estimate; `confirm` is the
   * envelope that gets frozen. Optional: without it (the tests, and runs
   * started before envelopes) a run keeps its legacy tier budget.
   */
  sizeRun?(input: {
    run: ResearchRunRow;
    plan: ResearchPlan;
    scope: ResearchScope;
    purpose: "preview" | "confirm";
  }): Promise<ResearchEnvelope | ResearchBudgetRefusal>;
  /**
   * The web completion (SPEC §9.6.3): one assistant message, its report
   * artifact, `lastMessageAt`, the run's pointer and its terminal state, in
   * one transaction. Optional: without it (native, the tests) the run simply
   * finishes. `raced` means another path finished the run first and nothing
   * was written.
   */
  complete?(input: {
    run: ResearchRunRow;
    plan: ResearchPlan;
    report: string;
    sources: ResearchSourceRow[];
    to: "completed" | "partially_completed";
    error: string | null;
  }): Promise<{ messageId: string | null; raced: boolean; sourceOrder?: string[] }>;
  /** Validates and, when safe, repairs a draft before the run becomes final. */
  validateReport?(input: {
    userId: string;
    runId: string;
    goal: string;
    plan: ResearchPlan;
    report: string;
    sources: ResearchSourceRow[];
    signal?: AbortSignal;
  }): Promise<ResearchValidationResult | null>;
  /**
   * What the worker and lead models charge, for the per-round reservation.
   *
   * Optional, and absent in the tests: without it a round reserves only its
   * vendor fees, which is the floor the ledger can prove. The model half of a
   * worker is billed when the worker RETURNS, so a run with a ceiling could
   * overshoot it by a whole round of worker calls that nothing had reserved.
   * run.ts reads these from the model catalogue, so a cheap worker is priced
   * as the cheap model it is rather than at the reference ceiling — which
   * would refuse whole rounds on an ordinary budget.
   */
  modelRates?: { worker?: ResearchModelRates; lead?: ResearchModelRates };
  /** Stable hash of fetched text, so a report stays auditable after the page changes. */
  hash(text: string): string;
  now(): Date;
  /** How often a long stage renews its lease. 45 s in production; the tests shorten it (B3). */
  heartbeatMs?: number;
}

export interface ResearchValidationResult {
  report: string;
  repaired: boolean;
  /**
   * What the validator's own model calls cost, micro-USD.
   *
   * The citation audit is one utility-model call per undecided claim, and this
   * contract had no cost channel at all — so the engine could not bill what it
   * was never told, and a run's reported cost under-stated it by the whole
   * stage. Optional because a validator may be purely deterministic (no model,
   * nothing to bill) and because the contract predates this; omitted is read as
   * zero, never as "unknown, so skip the check" — the reservation below is made
   * before the call either way, so a validator that under-reports cannot cross
   * the ceiling by more than its own reservation.
   */
  costMicroUsd?: number;
  /** A compact summary suitable for a user receipt and the event log. */
  summary: {
    claims: number;
    supported: number;
    partiallySupported: number;
    unsupported: number;
    contradicted: number;
    unverified: number;
    duplicateSources: number;
  };
}

// ---------------------------------------------------------------------------
// Cost estimates used for the pre-spend check
// ---------------------------------------------------------------------------

/*
 * Estimates, not prices. `budgetAllows` needs a number BEFORE the call is made,
 * and the only alternative — spend first, compare after — is not a ceiling at
 * all.
 *
 * Every one of them is now derived from what the stage actually bills (see the
 * cost section of domain.ts) rather than picked. They used to be four literals,
 * and "deliberately generous" turned out to mean two of them were an order of
 * magnitude out in OPPOSITE directions:
 *
 *   SEARCH  10,000 against a recorded 1,000 — 10x. `affordableCount` multiplies
 *           this by the wave width, so a run stopped after roughly a tenth of
 *           the queries its budget could pay for. Recursive query expansion,
 *           link hops and 20-50 sources per deep run were all being throttled
 *           by this one number, and from inside the run it looked exactly like
 *           a budget that had run out.
 *   READ     2,000 against a recorded 500 — 4x, same mechanism, applied to
 *           every page of every wave.
 *   PLAN     5,000 against two model calls whose prompt and reply caps come to
 *           ~35,000 at the dearest utility model. UNDER, not over: a run could
 *           blow its ceiling on its very first act, which is precisely the
 *           failure budgetAllows exists to stop.
 *   SYNTH  120,000 flat, for a call whose prompt is the whole corpus. Thirty
 *           full sources bill ~535,000 — four times the reservation — while
 *           three short ones are nowhere near it. A constant cannot be right
 *           about both, so this one is computed from the corpus at the point of
 *           use (see `doSynthesis`).
 *
 * The remaining margins are stated, not incidental: VENDOR_ESTIMATE_MARGIN for
 * the flat fees, and the reference model rate plus MODEL_ESTIMATE_MARGIN for
 * the token-priced stages.
 *
 * Exported for the same reason SEARCH_CONCURRENCY is: the budget tests assert
 * boundaries that are only boundaries relative to these numbers. A test holding
 * its own copy of 10,000 kept passing, with the wrong meaning, for exactly as
 * long as this file disagreed with tools.ts.
 */
export const SEARCH_ESTIMATE_MICRO_USD = SEARCH_FEE_MICRO_USD * VENDOR_ESTIMATE_MARGIN;
export const READ_ESTIMATE_MICRO_USD = PAGE_FETCH_FEE_MICRO_USD * VENDOR_ESTIMATE_MARGIN;
/**
 * The brief every worker and the lead read: the expanded brief, then the
 * planner's approach and its bar for done. A worker that knows how evidence
 * will be judged spends its calls on evidence that will count.
 */
export function researchBriefText(plan: ResearchPlan): string {
  // Approach and criteria FIRST: the worker and the lead truncate this text
  // (2,000 / 1,500 chars) and the expanded brief alone can fill that, so the
  // judgement rules go where a cut cannot reach them.
  const parts = [
    plan.approach ? `Approach: ${plan.approach}` : "",
    plan.successCriteria?.length ? `A complete answer includes:\n${plan.successCriteria.map((c) => `- ${c}`).join("\n")}` : "",
    plan.brief ?? "",
  ].filter(Boolean);
  return parts.join("\n\n");
}

/**
 * The clarify call: the goal in, at most four short questions out.
 *
 * Deliberately the cheapest gate in the engine. It reserves against the goal
 * rather than the planner's prompt because that is all it is shown, and a run
 * whose ceiling cannot cover this one small completion skips the questions and
 * plans anyway rather than stopping — the budget stops SPENDING, and refusing
 * to ask is not the same as refusing to research.
 */
export const CLARIFY_ESTIMATE_MICRO_USD = modelCallEstimateMicroUsd(
  CLARIFY_PROMPT_CHARS + SYSTEM_PROMPT_CHARS,
  CLARIFY_OUTPUT_TOKENS,
);

/** Both calls `planResearchQueries` makes: the brief expansion, then the planner. */
export const PLAN_ESTIMATE_MICRO_USD =
  modelCallEstimateMicroUsd(BRIEF_PROMPT_CHARS + SYSTEM_PROMPT_CHARS, BRIEF_OUTPUT_TOKENS) +
  modelCallEstimateMicroUsd(PLANNER_PROMPT_CHARS + SYSTEM_PROMPT_CHARS, PLANNER_OUTPUT_TOKENS);
/**
 * The coverage-gap expansion, which is billed as `plan` but is a third of it:
 * one call, a 512-token reply. Gating it on PLAN_ESTIMATE reserved 3.4x what it
 * can cost, and the thing being refused was the run's only mechanism for going
 * at an unmet objective from a new direction — the last stage that should lose
 * a coin toss against an over-estimate.
 */
export const EXPANSION_ESTIMATE_MICRO_USD = modelCallEstimateMicroUsd(
  EXPANSION_PROMPT_CHARS + SYSTEM_PROMPT_CHARS,
  EXPANSION_OUTPUT_TOKENS
);

/**
 * The citation audit: `MAX_JUDGE_CALLS` judge calls at their own caps.
 *
 * PER-AUDIT, not per-claim, and the choice is forced rather than stylistic.
 * The stage's cost does scale with the number of claims — which is what makes
 * it worth reserving for at all — but the claim count is NOT its upper bound:
 * `recordCitationAudit` walks a claim's ranked candidate passages until one
 * comes back supported, so a single stubborn claim can spend several judge
 * calls. The only true bound is the audit-wide `MAX_JUDGE_CALLS` cap, so that
 * is what the reservation is built from. Reserving claims × one call would have
 * UNDER-reserved exactly the reports that cost the most, and under-reserving is
 * the one direction a pre-spend check may never be wrong in.
 *
 * It is also the only figure available in time. The claim count comes out of
 * `extractClaims`, which runs inside the audit — the engine would have to do
 * the extraction itself, before the stage, to price per claim, and then the
 * reservation and the bill would be counting claims with two different copies
 * of that parser.
 *
 * The price of that choice is stated: a two-claim report reserves the same as a
 * forty-claim one. It is a single check once per run, at a stage that only ever
 * happens after synthesis has already been paid for, so what it can cost is a
 * slice of one run's remaining headroom — the same trade PLAN takes, and the
 * opposite of the SEARCH over-estimate that was throttling every wave.
 */
export const CITATION_AUDIT_ESTIMATE_MICRO_USD =
  MAX_JUDGE_CALLS *
  modelCallEstimateMicroUsd(
    JUDGE_PASSAGE_CHARS + JUDGE_PROMPT_OVERHEAD_CHARS + SYSTEM_PROMPT_CHARS,
    JUDGE_OUTPUT_TOKENS
  );

/**
 * What the writer will be handed, so the reservation matches this run's corpus.
 *
 * `writeResearchReport` drops sources with no snapshot and builds the prompt
 * from the rest, so the estimate counts exactly those. A revision additionally
 * carries the previous draft back in, and that draft is up to 48,000 characters
 * of prompt nobody was reserving for.
 */
export const synthesisEstimateMicroUsd = (
  sources: readonly ResearchSourceRow[],
  revising: boolean
): number => {
  const corpusChars = sources
    .filter((source) => source.snapshot)
    .reduce(
      (total, source) =>
        total + Math.min(source.snapshot?.length ?? 0, SNAPSHOT_CHARS) + CORPUS_PER_SOURCE_CHARS,
      CORPUS_PREAMBLE_CHARS + (revising ? REVISION_REPORT_CHARS : 0)
    );
  return modelCallEstimateMicroUsd(corpusChars, SYNTHESIS_OUTPUT_TOKENS);
};

/** Sources carried into synthesis. Beyond this the corpus stops fitting. */
export const MAX_SOURCES = 250;
/** Sources whose full text is stored as a snapshot. */
const MAX_READ_SOURCES = 250;

/**
 * The sources a report may cite, in the order it numbers them.
 *
 * ONE function owns the numbering, because two did and they disagreed. The
 * writer numbered the rows that have a snapshot; the citation audit was handed
 * every row, read or not, and numbered those. `listSources` orders by creation,
 * and read and unread rows interleave from the first search wave, so the two
 * numberings diverged at the first unread row — on essentially every run.
 * Every citation was then judged against the wrong page: an unread row has no
 * passages, a claim with no passages resolves `unsupported`, and the repair
 * pass rewrote true sentences as "The cited evidence is insufficient" before
 * sending the report round for a revision it did not need. Synthesis and
 * validation both call this, on the same rows, and get the same list.
 */
export function citableSources<T extends Pick<ResearchSourceRow, "snapshot">>(sources: readonly T[]): T[] {
  return sources.filter((source) => !!source.snapshot).slice(0, MAX_SOURCES);
}

/**
 * How the tier's page ceiling is split between the seed sweep and the team.
 *
 * The sweep used to size its ranked reads at the whole ceiling, and the agent
 * layer's first gate — "has the run read its pages yet?" — then broke out
 * before a single worker was dispatched. On a plain-HTTP deployment the
 * workers ran only because some fetches failed, and shared the leftovers; on
 * a backend that returns page bodies with its results they never ran on any
 * tier. The sweep is a seed: a quarter of the pages for its ranked reads, a
 * tenth for the link hop that follows their citations, and the team keeps the
 * rest — which is where the depth this whole module exists for comes from.
 * Exported for the same reason SEARCH_CONCURRENCY is: the tests assert the
 * split, and a test holding its own copy of 0.25 would keep passing with the
 * wrong meaning the day the share changed.
 */
export const SEED_PAGE_SHARE = 0.25;
export const HOP_PAGE_SHARE = 0.1;
/** Fetches in flight against one host, across the sweep and every worker together. */
const FETCH_PER_HOST = 2;
/**
 * How much of a page is stored, and therefore how much reaches synthesis.
 *
 * This was 8_000 against a fetcher that returns 16_000 and a corpus builder that
 * re-sliced at 16_000 — so half of every document was thrown away at the store
 * and the corpus cap was dead code. It is exported and `buildResearchCorpus`
 * uses it, because a storage cap and a prompt cap that disagree is exactly the
 * kind of drift that silently halves what a report is written from. The number
 * did not go all the way to 16k: 250 sources × 16k is a corpus no synthesis
 * context holds, and the main-content extraction added alongside this means 12k
 * of a stripped page is worth more than 16k of one with the nav bar still in it.
 */
export const SNAPSHOT_CHARS = RESEARCH_SNAPSHOT_CHARS;
/**
 * Below this, what a search engine handed back is a preview rather than a page,
 * and the source is worth opening properly. Set well under `SNAPSHOT_CHARS` so a
 * genuinely short page is not re-fetched on every run for nothing.
 */
const DEEPEN_BELOW_CHARS = 2_000;
/** How many previews one run will pay to turn into real pages. */
const MAX_DEEPENED_SOURCES = 40;
const PASSAGE_CHARS = 1_200;
const MAX_PASSAGES_PER_SOURCE = 6;
/** Guard against a driver looping forever on a state that never advances. */
const MAX_STEPS = 40;
/** The goal is a prompt, not an essay; the column is Text but the bill is not. */
const MAX_GOAL_CHARS = 8_000;

/**
 * How many pages READ opens at once, and why there is a number here at all.
 *
 * The counts above have allowed 250 sources for a while; a run never got near
 * them, and the reason was not a cap — it was that READ was a
 * `for (… of …) await` loop over a 25s-per-page fetch timeout. A couple of
 * hundred pages one at a time is most of an hour of wall clock, and a run that
 * cannot physically reach its own source ceiling has a clock for a ceiling, not
 * a number. This is the change that makes the other limits in this file mean
 * something.
 *
 * Eight rather than more because these are fetches against arbitrary third
 * parties: past this, a run looks like a scraper to the sites it is reading and
 * starts collecting 429s instead of documents.
 */
const READ_CONCURRENCY = 8;
/**
 * How many queries SEARCH issues at once.
 *
 * Half of READ's width, and not because a sweep is less urgent. One "query"
 * here is not one request: `searchTheWeb` fans it out to every configured
 * backend at once, so four queries in flight is already a couple of dozen
 * outbound calls, and the keyless providers in that roster are the ones that
 * start returning 429s first. Four is the width at which a fourteen-query plan
 * costs four round trips instead of fourteen without turning the roster hostile.
 *
 * Exported because `tests/research-run.test.ts` pins the cancel and ceiling
 * boundaries at exactly one wave. A test that hard-coded 4 would keep passing
 * with the wrong meaning the day this number changes; one that imports it keeps
 * asserting "one wave", which is the property.
 */
export const SEARCH_CONCURRENCY = 4;
/**
 * Outbound links one READ stage will follow.
 *
 * The hop is deliberately ONE deep and small. Following links transitively is
 * a crawler, and a crawler is how a research run turns into an unbounded bill
 * against a budget that was set for a report.
 */
const MAX_HOP_SOURCES = 24;
/**
 * How much of a link's anchor text has to be about an unmet objective.
 *
 * Anchor text is short, so this is measured as the fraction of the ANCHOR's
 * tokens that appear in the objective rather than the other way round — "read
 * the full 2024 methodology" scores well against a methodology question, while
 * "privacy policy" scores zero against everything.
 */
const HOP_MIN_OVERLAP = 0.34;

/**
 * Runs `items` in waves of `size`, in order, awaiting each wave.
 *
 * A rolling window would keep utilisation marginally higher, but every caller
 * here has to check two things between units of work — has the user cancelled,
 * and can the budget still pay — and both need a barrier to be checked against
 * a consistent state. A wave IS that barrier. With a rolling window the budget
 * pre-check races its own in-flight calls and the batch overshoots the ceiling
 * by however many requests were already dispatched.
 */
function waves<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface CoverageComputation {
  objectives: ResearchPlan["objectives"];
  coverage: ResearchCoverageEntry[];
  conflicts: ResearchConflict[];
  /** Deterministic, templated follow-ups. The fallback when no expander is wired. */
  followUps: string[];
  /** The same gaps, unrendered, for an expander that can write better queries. */
  gaps: Array<{ question: string; status: string; missingReason?: string }>;
  policyExcluded: number;
}

const SOURCE_TYPES = new Set<ResearchSourceType>([
  "official",
  "primary",
  "reputable_secondary",
  "general",
  "user_generated",
  "unknown",
]);

function classifiedSourceType(source: ResearchSourceRow): ResearchSourceType {
  return source.sourceType && SOURCE_TYPES.has(source.sourceType as ResearchSourceType)
    ? (source.sourceType as ResearchSourceType)
    : sourceTypeOf({ url: source.url, text: source.snapshot ?? "", authority: source.authority });
}

function freshnessMatches(rule: string | undefined, publishedAt: Date | null): boolean {
  const normalized = rule?.trim().toLowerCase() ?? "";
  if (!normalized) return true;
  if (!publishedAt) return false;
  const year = normalized.match(/\b(19|20)\d{2}\b/);
  if (year && /\b(?:after|since|from|in|>=|latest)\b/.test(normalized)) {
    const minimumYear = Number(year[0]);
    return publishedAt.getUTCFullYear() >= minimumYear;
  }
  const relative = normalized.match(/\b(?:within|last|past)\s+(\d+)\s*(day|days|week|weeks|month|months|year|years)\b/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].replace(/s$/, "");
    const days = unit === "day" ? amount : unit === "week" ? amount * 7 : unit === "month" ? amount * 31 : amount * 365;
    return Date.now() - publishedAt.getTime() <= days * 86_400_000;
  }
  if (/\b(?:recent|current|latest)\b/.test(normalized)) {
    return Date.now() - publishedAt.getTime() <= 365 * 86_400_000;
  }
  // A provider may emit a human rule we do not understand yet. Do not silently
  // discard the source; the persisted rule remains visible for a later policy
  // version and the known constraints above still fail closed.
  return true;
}

function jurisdictionMatches(jurisdiction: string | undefined, source: ResearchSourceRow): boolean {
  const wanted = jurisdiction?.trim().toLowerCase() ?? "";
  if (!wanted) return true;
  const host = hostOfUrl(source.url);
  if (/\b(?:uk|united kingdom|britain)\b/.test(wanted) && host.endsWith(".gov.uk")) return true;
  if (/\b(?:us|usa|united states)\b/.test(wanted) && /(?:^|\.)gov(?:\.|$)/.test(host)) return true;
  if (/\b(?:eu|european union)\b/.test(wanted) && host.endsWith("europa.eu")) return true;
  const sourceTokens = contentTokens(`${source.url} ${source.title} ${source.snapshot ?? ""}`);
  const jurisdictionTokens = contentTokens(wanted);
  return jurisdictionTokens.size === 0 || [...jurisdictionTokens].every((token) => sourceTokens.has(token));
}

/**
 * How strongly a page answers a question, judged passage by passage.
 *
 * Token overlap over a whole 12,000-character snapshot is nearly always high
 * for any page on the topic — a question's handful of content words all
 * appear somewhere in it — so the gate said "satisfied" for every on-topic
 * source and never scheduled a follow-up. Scored over the same chunks a
 * worker cites from, the number means what it is used for: how much of the
 * question the best single passage actually addresses.
 */
function passageStrength(question: string, snapshot: string): number {
  let best = 0;
  for (const chunk of chunkText(snapshot)) {
    best = Math.max(best, tokenCoverage(question, chunk.text));
    if (best >= 1) break;
  }
  return best;
}

/** The lead's 0..1 score as an objective status, the same rule `doWorkerRounds` applies. */
function leadStatus(score: number): ResearchObjectiveStatus {
  return score >= COVERAGE_TARGET ? "covered" : score > 0 ? "partially_covered" : "open";
}

/**
 * Cheap, deterministic coverage before synthesis. It is deliberately not a
 * claim judge: at this stage there is no report claim to judge. Its job is to
 * stop a plan that has only collected vaguely related pages from declaring
 * itself ready, and to leave a durable matrix the user can inspect.
 *
 * When the lead has reviewed a round, its scores decide the objective statuses
 * and which gaps get a follow-up; the heuristic keeps computing the
 * requirement-level matrix for the panel. The heuristic used to recompute the
 * statuses on top of the lead's and overwrite them, so the lead's judgement
 * never decided whether a follow-up ran and the panel could say "satisfied"
 * beside a lead score of 0.2.
 */
function computeCoverage(plan: ResearchPlan, sources: ResearchSourceRow[], review?: ResearchRoundReview): CoverageComputation {
  const objectives = plan.objectives.length
    ? plan.objectives
    : buildResearchObjectives("", plan.queries);
  const coverage: ResearchCoverageEntry[] = [];
  let policyExcluded = 0;
  const updatedObjectives = objectives.map((objective) => {
    const requirements = objective.evidenceRequirements.length
      ? objective.evidenceRequirements
      : buildResearchObjectives(objective.question, [objective.question])[0]?.evidenceRequirements ?? [];
    const nextRequirements = requirements.map((requirement) => {
      const scored = sources
        .filter((source) => !!source.snapshot)
        .map((source) => {
          const sourceType = classifiedSourceType(source);
          const typeAllowed = sourceTypeMatchesRequirement(
            sourceType,
            requirement.preferredSourceTypes,
            requirement.requiresPrimarySource
          );
          const freshEnough = freshnessMatches(requirement.freshnessRule, source.publishedAt);
          const jurisdictionAllowed = jurisdictionMatches(requirement.jurisdiction, source);
          const eligible = typeAllowed && freshEnough && jurisdictionAllowed;
          if (!eligible) policyExcluded += 1;
          return {
            source,
            strength: passageStrength(objective.question, source.snapshot ?? ""),
            eligible,
          };
        })
        .filter((entry) => entry.eligible)
        .sort((a, b) => b.strength - a.strength);
      const supporting = scored.filter((entry) => entry.strength >= 0.42);
      const weak = scored.filter((entry) => entry.strength >= 0.22);
      const independentHosts = new Set(
        supporting
          .filter((entry) => entry.source.independence !== 0)
          .map((entry) => hostOfUrl(entry.source.url))
          .filter(Boolean)
      );
      const best = scored[0]?.strength ?? 0;
      let status: ResearchCoverageEntry["status"] = "missing";
      let missingReason = "No read source directly addresses this requirement.";
      if (supporting.length > 0 && independentHosts.size >= requirement.minimumIndependentSources) {
        status = "satisfied";
        missingReason = "";
      } else if (weak.length > 0) {
        status = "weak";
        missingReason = "The sources are related, but the evidence is not direct or independent enough yet.";
      } else if (sources.some((source) => !!source.snapshot)) {
        missingReason = "Read sources were excluded by the requirement's source type, freshness, or jurisdiction policy.";
      }
      const entry: ResearchCoverageEntry = {
        objectiveId: objective.id,
        requirementId: requirement.id,
        status,
        supportingSourceIds: supporting.slice(0, 8).map((item) => item.source.id),
        contradictingSourceIds: [],
        independentSourceCount: independentHosts.size,
        evidenceStrength: best,
        ...(missingReason ? { missingReason } : {}),
      };
      coverage.push(entry);
      return { ...requirement, status };
    });
    const statuses = nextRequirements.map((requirement) => requirement.status);
    const heuristic: ResearchObjectiveStatus =
      statuses.length > 0 && statuses.every((value) => value === "satisfied")
        ? "covered"
        : statuses.some((value) => (value as string) === "conflicted")
        ? "blocked"
        : statuses.some((value) => value === "satisfied" || value === "weak")
        ? "partially_covered"
        : "open";
    const score = review?.coverage[objective.id];
    const status = typeof score === "number" ? leadStatus(score) : heuristic;
    return { ...objective, status, evidenceRequirements: nextRequirements };
  });

  const conflicts: ResearchConflict[] = [];
  const byHash = new Map<string, string[]>();
  for (const source of sources) {
    if (!source.contentHash) continue;
    byHash.set(source.contentHash, [...(byHash.get(source.contentHash) ?? []), source.id]);
  }
  for (const [hash, sourceIds] of byHash) {
    if (sourceIds.length < 2) continue;
    conflicts.push({
      id: `duplicate-${hash.slice(0, 12)}`,
      kind: "duplicate_source",
      sourceIds: sourceIds.slice(0, 8),
      description: "Multiple results contain the same fetched content and count as one independent witness.",
      severity: "medium",
      resolved: false,
    });
  }
  const hosts = new Set(sources.map((source) => hostOfUrl(source.url)).filter(Boolean));
  if (sources.length >= 2 && hosts.size === 1) {
    conflicts.push({
      id: "source-monoculture",
      kind: "source_monoculture",
      sourceIds: sources.slice(0, 8).map((source) => source.id),
      description: "The gathered evidence comes from one publisher host; an independent source is still needed.",
      severity: "medium",
      resolved: false,
    });
  }

  const alreadyPlanned = new Set(plan.queries.map((query) => query.toLowerCase()));
  const followUps: string[] = [];
  const gaps: CoverageComputation["gaps"] = [];
  /*
   * One follow-up per UNCOVERED objective, not one per round.
   *
   * There was a `break` after the first, so a plan with six unmet objectives
   * chased exactly one of them and then paid for a whole sequential search
   * sweep to do it — with four rounds available, a run could add at most four
   * queries and could not possibly close six gaps. The bound that matters is
   * MAX_FOLLOW_UP_ROUNDS (rounds cost a re-entry into gathering) and the free
   * slots in MAX_PLAN_QUERIES, and `doCoverage` applies both; widening the
   * round itself costs nothing extra because the queries in it run together.
   */
  for (const objective of updatedObjectives) {
    const score = review?.coverage[objective.id];
    let gap: CoverageComputation["gaps"][number];
    if (typeof score === "number") {
      // The lead scored this one. Below the target it is a gap whatever the
      // token heuristic thinks of the pages, and the lead's own reason travels
      // to the expander when it gave one.
      if (score >= COVERAGE_TARGET) continue;
      const named = review?.gaps.find((item) => item.objectiveId === objective.id);
      gap = {
        question: objective.question,
        status: score > 0 ? "weak" : "missing",
        missingReason: named?.reason || `The lead scored this sub-question ${Math.round(score * 100)}% answered by sourced findings.`,
      };
    } else {
      const entry = coverage.find(
        (item) => item.objectiveId === objective.id && (item.status === "missing" || item.status === "weak")
      );
      if (!entry) continue;
      gap = {
        question: objective.question,
        status: entry.status,
        ...(entry.missingReason ? { missingReason: entry.missingReason } : {}),
      };
    }
    gaps.push(gap);
    const suffix = gap.status === "missing" ? "primary source evidence" : "independent source and counter evidence";
    const query = `${objective.question} ${suffix}`.replace(/\s+/g, " ").trim().slice(0, 400);
    if (alreadyPlanned.has(query.toLowerCase())) continue;
    alreadyPlanned.add(query.toLowerCase());
    followUps.push(query);
  }
  if (followUps.length === 0 && conflicts.some((conflict) => conflict.kind === "source_monoculture")) {
    const objective = updatedObjectives.find((item) => item.status !== "covered");
    if (objective) {
      const query = `${objective.question} independent reporting different perspective`.slice(0, 400);
      if (!alreadyPlanned.has(query.toLowerCase())) followUps.push(query);
    }
  }

  return {
    objectives: updatedObjectives,
    coverage,
    conflicts: conflicts.slice(0, 24),
    followUps,
    gaps,
    policyExcluded,
  };
}

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
  /** Frozen into the plan with its page/tool/time ceilings at creation. */
  effort?: ResearchEffort;
  /** `auto` skips the confirmation gate — see `ResearchPlan.confirmation`. */
  confirmation?: "auto" | "required";
  constraints?: string[];
  pinnedSources?: string[];
  /*
   * The rework's start facts (SPEC §9.3, §9.5), frozen on the plan.
   */
  /** The conversation before the request, wrapped as untrusted (B20). The goal stays the user's words. */
  context?: string | null;
  /** The requester's IANA zone and UI locale (§2.1). */
  timeZone?: string | null;
  locale?: string | null;
  /** The explicit response-language setting, when it is not "auto" (D-1 option C). */
  language?: string | null;
  /** The chat's selected model, preferred as the lead when the plan's class allows it (§9.5.1). */
  preferredModel?: string | null;
}

export type ControlReason =
  | "not_found"
  | "not_pausable"
  | "not_paused"
  | "already_finished"
  | "not_awaiting_plan"
  /** Answers arrived for a run that is not at the clarify gate. */
  | "not_awaiting_clarification"
  /** Finish or guidance for a run that is not working (it waits at a gate). */
  | "not_running"
  /** A sixth revision of one plan (§9.4). */
  | "revise_limit"
  /** Sizing refused the confirmed scope: see `refusal`. */
  | "refused";

export interface ControlResult {
  ok: boolean;
  /** Present whether or not the control applied, so a caller can report truth. */
  state: string;
  /** Set when `ok` is false: why the control did not apply. */
  reason?: ControlReason;
  /** With `reason: "refused"`: what sizing said. */
  refusal?: ResearchBudgetRefusal;
  /** Guidance was queued for the next round boundary (§9.4 steer). */
  queued?: boolean;
}

export interface ResearchEngine {
  start(input: StartRunInput): Promise<ResearchRunRow>;
  /** Runs steps until the run blocks, finishes, or reaches `until`. */
  drive(input: {
    runId: string;
    userId: string;
    signal?: AbortSignal;
    /** Stable process identity used to fence concurrent/restarted workers. */
    workerId?: string;
    /** Stop cleanly once the run enters this state, leaving it live. */
    until?: ResearchState;
    /**
     * Keep the lease when stopping at `until` (B2): the native hand-off
     * renews it from the chat route while the chat model writes, so the run
     * is never claimable in between. Every other stop releases it (B1).
     */
    holdLeaseAtUntil?: boolean;
  }): Promise<ResearchRunRow | null>;
  decidePlan(input: {
    runId: string;
    userId: string;
    decision: "confirm" | "cancel" | "revise";
    /** The plan as the user left it at the gate. See `ResearchPlan.steps`. */
    steps?: string[];
    queries?: string[];
    constraints?: string[];
    pinnedSources?: string[];
    /** The questions as the reader left them on the card; a row without an id is new (§9.4). */
    questions?: Array<{ id?: string; question: string }>;
    /** Answers to the planner's optional questions, by id. */
    answers?: Record<string, string>;
  }): Promise<ControlResult>;
  /**
   * Runs the planner again with the reader's edits, for a `revise` decision
   * (§9.4). The card stays mounted while it runs; a revision whose run moved
   * on (confirmed, cancelled) in the meantime is dropped.
   */
  revisePlan(input: { runId: string; userId: string; signal?: AbortSignal }): Promise<ControlResult>;
  /** "Finish now": the engine writes with what it has at the next round boundary (§9.7). */
  requestFinish(input: { runId: string; userId: string }): Promise<ControlResult>;
  /**
   * Answers to the clarify gate's questions, or a decision to skip them.
   *
   * Answering is never mandatory: an empty map is a valid submission and means
   * "research it as I wrote it". That is why there is no `decision` argument
   * the way `decidePlan` has one — there is nothing here to decline, only
   * detail to add or withhold.
   */
  answerClarifications(input: {
    runId: string;
    userId: string;
    /** Answer text by question id. Missing or empty entries were skipped. */
    answers: Record<string, string>;
  }): Promise<ControlResult>;
  steer(input: {
    runId: string;
    userId: string;
    constraint?: string;
    sourceUrl?: string;
    /** Guidance for the next round boundary (§9.4, §9.7), queued on `plan.steering`. */
    guidance?: string;
  }): Promise<ControlResult>;
  pause(input: { runId: string; userId: string }): Promise<ControlResult>;
  resume(input: { runId: string; userId: string }): Promise<ControlResult>;
  /** `reason` is recorded on the event: "chat_stopped" when the chat that started it stopped (B2). */
  cancel(input: { runId: string; userId: string; reason?: string }): Promise<ControlResult>;
}

export function createResearchEngine(deps: ResearchDeps): ResearchEngine {
  const { store } = deps;
  const heartbeatMs = deps.heartbeatMs ?? RESEARCH_LEASE_RENEW_MS;
  /** A model stage, with the lease renewed underneath it (B3). */
  const beat = <T>(fn: () => Promise<T>, heartbeat?: () => Promise<void>): Promise<T> => withHeartbeat(fn, heartbeat, heartbeatMs);

  const append = (runId: string, userId: string, events: readonly ResearchEventInput[]) =>
    store.appendEvents({ runId, userId, events });

  /**
   * Every page fetch in the run goes through one per-host gate.
   *
   * The scheduler's `HostLimiter` was written for exactly this — "a dozen
   * workers opening pages on the same site is a scraper as far as that site is
   * concerned" — and was then used only by its own test: the sweep's eight-wide
   * waves and the round's parallel workers hit whichever host held the answers
   * as fast as they could. One limiter for the whole engine, because the sweep
   * and the workers are the same run to the site being read. An abort while
   * waiting for a slot is answered like a page that never arrived, since every
   * caller already handles null.
   */
  const hosts = new HostLimiter(FETCH_PER_HOST);
  const fetchPage = async (userId: string, url: string, signal?: AbortSignal): Promise<ResearchPageResult | null> => {
    let release: () => void;
    try {
      release = await hosts.acquire(url, signal);
    } catch (error) {
      if (isAbortError(error)) return null;
      throw error;
    }
    try {
      return await deps.fetchPage({ userId, url, signal });
    } finally {
      release();
    }
  };

  /**
   * Marks syndicated copies while the run can still act on it.
   *
   * `detectSyndication` only ever ran inside the citation audit, after the
   * report was written; during the run the only duplicate test was an exact
   * hash match, which two 12,000-character reprints never satisfy. So every
   * row carried `independence: 1`, the coverage gate's independence filter
   * excluded nothing, and two reprints of one wire story satisfied "two
   * independent sources". Run after the sweep and again after the workers, it
   * zeroes the copies' independence so ranking, coverage and the writer all
   * count a story once, and records the group on the plan so the evidence
   * panel shows it. `duplicateOfId` is left to the audit, which owns it.
   */
  const markSyndicatedCopies = async (run: ResearchRunRow): Promise<ResearchRunRow> => {
    const rows = citableSources(await store.listSources(run.id, run.userId));
    if (rows.length < 2) return run;
    const copies = detectSyndication(
      rows.map((source) => ({
        id: source.id,
        url: source.url,
        title: source.title,
        text: source.snapshot ?? "",
        publishedAt: source.publishedAt,
      }))
    );
    if (copies.size === 0) return run;
    const byId = new Map(rows.map((source) => [source.id, source]));
    const groups = new Map<string, string[]>();
    for (const [copyId, canonicalId] of copies) groups.set(canonicalId, [...(groups.get(canonicalId) ?? []), copyId]);
    const latest = (await store.loadRun(run.id, run.userId)) ?? run;
    const plan = parsePlan(latest.plan);
    const known = new Set((plan.conflicts ?? []).map((conflict) => conflict.id));
    const added: ResearchConflict[] = [];
    for (const [canonicalId, copyIds] of groups) {
      const canonical = byId.get(canonicalId);
      if (!canonical) continue;
      for (const copyId of copyIds) {
        const copy = byId.get(copyId);
        if (!copy || copy.independence === 0) continue;
        await store.upsertSource({
          runId: run.id,
          userId: run.userId,
          url: copy.url,
          title: copy.title,
          independence: 0,
          composite: 0,
        });
      }
      const id = `duplicate-${canonicalId}`;
      if (known.has(id)) continue;
      const sourceIds = [canonicalId, ...copyIds].slice(0, 8);
      const urls = sourceIds.map((sourceId) => byId.get(sourceId)?.url).filter((url): url is string => !!url);
      added.push({
        id,
        kind: "duplicate_source",
        sourceIds,
        description: `${copyIds.length} other ${copyIds.length === 1 ? "source repeats" : "sources repeat"} the text of ${hostOfUrl(canonical.url)}; together they count as one witness.`,
        severity: "medium",
        resolved: false,
      });
      await append(run.id, run.userId, [
        { kind: "conflict_found", payload: { kind: "duplicate_content", sourceIds, urls, canonical: canonical.url } },
      ]);
    }
    if (added.length === 0) return latest;
    const saved = await store.savePlan({
      runId: run.id,
      userId: run.userId,
      plan: { ...plan, conflicts: [...(plan.conflicts ?? []), ...added].slice(0, MAX_CONFLICTS) },
    });
    return saved ?? latest;
  };

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
    patch?: { plan?: ResearchPlan; error?: string | null; report?: string | null; budgetMicroUsd?: bigint | null },
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
    await announceFinish(run, from, to, detail);
    return moved;
  };

  /**
   * The events and the push that follow a terminal move, wherever it was
   * written — `finish` above, or the web completion's own transaction.
   *
   * No push for a cancel (B19): a discarded plan or a stopped run is the
   * person's own decision, and the old push told them "Research report
   * complete" about a run that wrote nothing.
   */
  const announceFinish = async (
    run: ResearchRunRow,
    from: string,
    to: ResearchTerminalState,
    detail: { error?: string | null; reason?: string },
    extra: readonly ResearchEventInput[] = []
  ): Promise<void> => {
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
      ...extra,
    ]);
    if (to === "cancelled") return;
    void import("@/lib/apns")
      .then(({ sendTaskCompletionPushNotification }) =>
        sendTaskCompletionPushNotification({
          userId: run.userId,
          taskId: run.id,
          title: run.goal || "Research",
          status: to === "failed" ? "failed" : "completed",
          summary: detail.error || (to === "failed" ? "Research task failed" : "Research report complete"),
        })
      )
      .catch(() => {});
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

  /**
   * How many of `wanted` calls at `unit` each the run can still pay for.
   *
   * The whole point of dispatching a wave is that `affordable` is checked ONCE,
   * before any of it goes out. Checking per call and then firing them in
   * parallel is not a ceiling: eight requests already in flight against a budget
   * with room for two is an overshoot no later check can undo. One read of the
   * live spend, then arithmetic.
   */
  const affordableCount = async (run: ResearchRunRow, unit: number, wanted: number, reserveMicroUsd = 0): Promise<number> => {
    if (wanted <= 0) return 0;
    const fresh = await store.loadRun(run.id, run.userId);
    const spent = fresh?.costMicroUsd ?? run.costMicroUsd;
    const budget = fresh?.budgetMicroUsd ?? run.budgetMicroUsd;
    let n = wanted;
    while (n > 0 && !budgetAllows(spent, budget, unit * n + reserveMicroUsd)) n -= 1;
    return n;
  };

  /**
   * What must stay unspent before another round goes out (B8): the writer's
   * and the audit's reservations, frozen on the envelope. A round that eats
   * into them leaves a run that gathered everything and cannot pay to write
   * it — `partially_completed` with no report. A run without an envelope
   * (started before them) reserves nothing here, exactly as before.
   */
  const writerReserve = (plan: ResearchPlan): number =>
    plan.envelope ? plan.envelope.reserve.writerMicroUsd + plan.envelope.reserve.auditMicroUsd : 0;

  /**
   * Guidance queued since the last boundary becomes constraints now (§9.4):
   * constraints already reach every worker brief, the lead's review and the
   * writer, so this is the whole of "applied at the next round". Each entry
   * is stamped with the round it took effect in, which the panel shows.
   */
  const applySteering = async (run: ResearchRunRow, round: number): Promise<ResearchRunRow> => {
    const latest = (await store.loadRun(run.id, run.userId)) ?? run;
    const plan = parsePlan(latest.plan);
    const pending = (plan.steering ?? []).filter((entry) => entry.appliedAtRound === null);
    if (pending.length === 0) return latest;
    const constraints = [...plan.constraints, ...pending.map((entry) => entry.text.slice(0, MAX_CONSTRAINT_CHARS))].slice(-MAX_PLAN_CONSTRAINTS);
    const steering = (plan.steering ?? []).map((entry) => (entry.appliedAtRound === null ? { ...entry, appliedAtRound: round } : entry));
    const saved = await store.savePlan({ runId: latest.id, userId: latest.userId, plan: { ...plan, constraints, steering } });
    await append(latest.id, latest.userId, pending.map((entry) => ({ kind: "steering_applied" as const, payload: { guidance: entry.text, round, appliedAt: latest.state } })));
    return saved ?? latest;
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
    const error =
      to === "failed"
        ? "The per-run budget was too small to gather anything."
        : "Stopped at the per-run budget with the sources gathered so far.";
    // A run stopped with its report already written (the audit could not be
    // paid for) still delivers it: `partially_completed` with a report is the
    // same completion message, with the reader's "Stopped early" line (§9.6.3).
    if (deps.complete && to === "partially_completed" && run.report?.trim()) {
      const sources = citableSources(await store.listSources(run.id, run.userId));
      const completed = await deps.complete({ run, plan: parsePlan(run.plan), report: run.report, sources, to, error });
      if (completed.raced) return { kind: "raced" };
      await announceFinish(run, run.state, to, { reason: "budget_exhausted", error }, [
        { kind: "run_completed", payload: { messageId: completed.messageId, ...(completed.sourceOrder ? { sourceOrder: completed.sourceOrder } : {}) } },
      ]);
      return { kind: "finished", state: to };
    }
    const ended = await finish(run, to, { reason: "budget_exhausted", error });
    return ended ? { kind: "finished", state: to } : { kind: "raced" };
  };

/**
 * Steps whose cost is a VENDOR fee rather than a model call.
 *
 * `plan` and `synthesis` run a model and call recordSpend themselves, so
 * billing them here again would double-count the same tokens. `search` and
 * `fetch` are Tavily charges with no model behind them, which is exactly why
 * they were free to the ledger before: nothing else was ever going to write
 * the row. Listed explicitly rather than sniffed from the label, because a
 * new step name matching the wrong pattern would silently double-bill or
 * silently un-bill, and neither shows up as an error.
 */
const VENDOR_BILLED_STEPS = new Set(["search", "fetch"]);

  /** Bills what a farmed-out call actually cost, and says so in the log. */
  const bill = async (run: ResearchRunRow, microUsd: number, what: string): Promise<void> => {
    const rounded = Math.max(0, Math.round(microUsd));
    if (rounded === 0) return;
    // A search fee is a vendor charge with no model to bill it; the planner
    // and the report already call recordSpend themselves, so billing them
    // again here would double-count the same tokens.
    const total = await store.addSpend({
      runId: run.id,
      userId: run.userId,
      microUsd: rounded,
      kind: VENDOR_BILLED_STEPS.has(what) ? "search" : "model",
    });
    await append(run.id, run.userId, [
      {
        kind: "spend_recorded",
        payload: { step: what, microUsd: rounded, totalMicroUsd: total.toString() },
      },
    ]);
  };

  // ── the individual stages ───────────────────────────────────────────────

  /**
   * CLARIFY — ask what the goal leaves open, before anything is planned.
   *
   * Three ways this costs nothing and one way it earns its keep.
   *
   * It does not run at all on the chat path (`confirmation: "auto"`): there the
   * per-send toggle IS the whole interaction, the user is mid-conversation, and
   * stopping to ask four questions would be an ambush. It does not run when no
   * clarifier is wired. And it does not block when the clarifier comes back
   * with nothing — a goal specific enough to need no questions falls through to
   * planning in the same step, having spent one small completion.
   *
   * When it does ask, the answers land in `constraints`, which the brief, the
   * planner and every worker brief already read. So an answer shapes the whole
   * run without a single new code path downstream — the questions and answers
   * are kept alongside only so the UI can show an exchange rather than a list
   * of anonymous constraints, and so a resumed run knows it has already asked.
   */
  const doClarifying = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    const plan = parsePlan(run.plan);
    const skip = async (): Promise<StepOutcome> => {
      const moved = await advance(run, "planning");
      return moved ? { kind: "advanced", state: "planning" } : { kind: "raced" };
    };
    // The merged gate (§9.5): with the structured planner wired, its optional
    // questions ride the scope card, and no run ever parks on a clarify form.
    if (deps.draftPlan || !deps.clarify || plan.confirmation === "auto" || plan.clarifiedAt) return skip();
    if (!(await affordable(run, CLARIFY_ESTIMATE_MICRO_USD))) return skip();

    let drafted: { questions: ResearchClarification[]; costMicroUsd: number };
    try {
      drafted = await beat(
        () =>
          deps.clarify!({
            userId: run.userId,
            goal: run.goal,
            effort: plan.effort ?? DEFAULT_RESEARCH_EFFORT,
            signal,
          }),
        heartbeat
      );
    } catch (error) {
      // A clarifier that fails must cost the run nothing but a few seconds.
      console.error("[research] clarify failed", { runId: run.id, error });
      return skip();
    }
    await bill(run, drafted.costMicroUsd, "clarify");
    const questions = drafted.questions.slice(0, MAX_CLARIFICATIONS);
    if (questions.length === 0) {
      const next: ResearchPlan = { ...plan, clarifiedAt: deps.now().toISOString() };
      await store.savePlan({ runId: run.id, userId: run.userId, plan: next });
      const reloaded = (await store.loadRun(run.id, run.userId)) ?? run;
      const moved = await advance(reloaded, "planning");
      return moved ? { kind: "advanced", state: "planning" } : { kind: "raced" };
    }

    const next: ResearchPlan = { ...plan, clarifications: questions };
    await store.savePlan({ runId: run.id, userId: run.userId, plan: next });
    const reloaded = (await store.loadRun(run.id, run.userId)) ?? run;
    const moved = await advance(reloaded, "awaiting_clarification", undefined, [
      {
        kind: "clarification_requested",
        payload: { questions: questions.map((q) => ({ id: q.id, question: q.question, why: q.why ?? null })) },
      },
    ]);
    return moved ? { kind: "blocked", state: "awaiting_clarification" } : { kind: "raced" };
  };

  // ── sizing and the structured planner (SPEC §9.2, §9.5) ─────────────────

  /** The card's estimate caps for a run nothing sizes: its own tier's ceilings. */
  const legacyEstimateCaps = (plan: ResearchPlan): ResearchEstimateCaps => {
    const budget = planBudget(plan);
    return {
      maxWorkers: budget.workers,
      maxRounds: budget.rounds,
      maxPages: budget.pages,
      maxMinutes: Math.max(1, Math.round(budget.wallClockMs / 60_000)),
      secondsPerPage: 9,
      fixedMinutes: 2,
    };
  };

  /**
   * The envelope frozen on the plan (§9.2, INV-22): the engine reads every
   * limit from `plan.envelope`; `budget` and `effort` beside it are the
   * previous build's copy — the envelope's own numbers under the nearest
   * tier's name, which the DTO never shows.
   */
  const frozenWith = (plan: ResearchPlan, envelope: ResearchEnvelope): ResearchPlan => ({
    ...plan,
    envelope,
    effort: nearestEffort(envelope),
    budget: { ...budgetFromEnvelope(envelope), ...(plan.budget?.startedAt ? { startedAt: plan.budget.startedAt } : {}) },
    estimateCaps: envelope.caps,
  });

  const sizeFor = async (
    run: ResearchRunRow,
    plan: ResearchPlan,
    purpose: "preview" | "confirm"
  ): Promise<ResearchEnvelope | ResearchBudgetRefusal | null> =>
    deps.sizeRun && plan.scope ? deps.sizeRun({ run, plan, scope: plan.scope, purpose }) : null;

  const isRefusal = (value: ResearchEnvelope | ResearchBudgetRefusal | null): value is ResearchBudgetRefusal =>
    !!value && "refused" in value;

  /** Ends a run sizing refused before any paid work: the reason is the refusal's. */
  const refuseRun = async (run: ResearchRunRow, refusal: ResearchBudgetRefusal): Promise<StepOutcome> => {
    await append(run.id, run.userId, [{ kind: "budget_exhausted", payload: { refusal: refusal.reason, params: refusal.params } }]);
    const ended = await finish(run, "failed", {
      reason: `refused_${refusal.reason}`,
      error: REFUSAL_ERROR[refusal.reason],
    });
    return ended ? { kind: "finished", state: "failed" } : { kind: "raced" };
  };

  /** One structured planner call, at the lead's rates when the catalogue knows them. */
  const plannerEstimate = () =>
    modelCallEstimateMicroUsd(PLANNER_PROMPT_CHARS + SYSTEM_PROMPT_CHARS, PLANNER_OUTPUT_TOKENS, deps.modelRates?.lead);

  /**
   * PLANNING, merged (§9.5, DECISIONS R2): one call returns the questions,
   * up to three optional clarifications, the searches and the scope. The
   * reply is structured and validated; a reply that does not validate twice
   * fails the run as `planner_invalid` — a truncated object is never searched
   * as if it were a list of queries (B5).
   *
   * A web run then waits at the scope card with its estimate; a tiny scope
   * (one question, at most three minutes, nothing to ask) and the native path
   * (`confirmation: "auto"`) confirm on their own, sized and frozen here.
   */
  const doStructuredPlanning = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    const plan = parsePlan(run.plan);
    const estimate = plannerEstimate();
    if (!(await affordable(run, estimate))) return stopForBudget(run, estimate);
    const dateLine = plan.today ?? todayLine(run.createdAt, plan.timeZone);
    let drafted: PlannerDraft;
    try {
      drafted = await beat(
        () =>
          deps.draftPlan!({
            userId: run.userId,
            goal: run.goal,
            context: plan.context ?? null,
            constraints: plan.constraints,
            pinnedSources: plan.pinnedSources,
            dateLine,
            languageName: plan.language ? languageName(plan.language) : null,
            leadModel: plan.envelope?.leadModel ?? null,
            signal,
          }),
        heartbeat
      );
    } catch (error) {
      console.error("[research] planner failed", { runId: run.id, error });
      drafted = { ok: false, reason: "planner_invalid", costMicroUsd: 0 };
    }
    await bill(run, drafted.costMicroUsd, "plan");
    if (!drafted.ok) {
      const ended = await finish(run, "failed", {
        reason: "planner_invalid",
        error: "The research planner could not draft a plan for this question. Try again, or rephrase the goal.",
      });
      return ended ? { kind: "finished", state: "failed" } : { kind: "raced" };
    }

    const planned = plannedResearch(drafted.output);
    const now = deps.now().toISOString();
    let next: ResearchPlan = {
      ...plan,
      ...(planned.title ? { title: planned.title } : {}),
      ...(planned.approach ? { approach: planned.approach } : {}),
      // The steps are the questions, so a client that still reads the
      // pre-rework gate shows the plan a person is about to approve.
      steps: planned.objectives.map((objective) => objective.question),
      objectives: planned.objectives,
      queries: planned.queries,
      clarifications: planned.clarifications,
      ...(planned.sourceKinds.length ? { sourceKinds: planned.sourceKinds } : {}),
      scope: planned.scope,
      language: contentLanguage({ explicit: plan.language, planner: planned.language, uiLocale: plan.locale }),
      today: dateLine,
      draftedAt: now,
      issuedQueries: [],
      followUpRound: 0,
      coverage: [],
      conflicts: [],
    };

    const auto = next.confirmation === "auto";
    let sized: ResearchEnvelope | ResearchBudgetRefusal | null = null;
    let tiny = false;
    if (!auto) {
      const preview = await sizeFor(run, next, "preview");
      if (isRefusal(preview)) return refuseRun(run, preview);
      const caps = preview ? preview.caps : legacyEstimateCaps(next);
      const estimateLine: ResearchEstimate = preview ? preview.estimate : estimateFor(planned.scope, caps);
      next = { ...next, estimateCaps: caps };
      tiny = isTinyScope(planned.scope, estimateLine, planned.clarifications.length);
      if (tiny) sized = preview;
    }
    if (auto || tiny) {
      if (auto || !sized) sized = await sizeFor(run, next, "confirm");
      if (isRefusal(sized)) return refuseRun(run, sized);
      next = { ...(sized ? frozenWith(next, sized) : next), confirmedAt: now, confirmation: "auto" };
    }

    const drafted_ = {
      queries: next.queries,
      objectives: next.objectives.length,
      steps: next.steps ?? [],
      ...(next.approach ? { approach: next.approach } : {}),
      ...(next.title ? { title: next.title } : {}),
      clarifications: next.clarifications?.length ?? 0,
    };
    await store.savePlan({ runId: run.id, userId: run.userId, plan: next });
    await store.recordQueries({ runId: run.id, userId: run.userId, queries: next.queries });
    const reloaded = (await store.loadRun(run.id, run.userId)) ?? run;
    if (planIsConfirmed(next)) {
      const moved = await advance(
        reloaded,
        "investigating",
        sized && !isRefusal(sized) ? { budgetMicroUsd: BigInt(sized.ceilingMicroUsd) } : undefined,
        [
          { kind: "plan_drafted", payload: drafted_ },
          { kind: "plan_confirmed", payload: { by: "auto", ...(tiny ? { tiny: true } : {}) } },
        ]
      );
      return moved ? { kind: "advanced", state: "investigating" } : { kind: "raced" };
    }
    const moved = await advance(reloaded, "awaiting_plan_confirmation", undefined, [{ kind: "plan_drafted", payload: drafted_ }]);
    return moved ? { kind: "blocked", state: "awaiting_plan_confirmation" } : { kind: "raced" };
  };

  const doPlanning = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    if (deps.draftPlan) return doStructuredPlanning(run, signal, heartbeat);
    const plan = parsePlan(run.plan);
    if (!(await affordable(run, PLAN_ESTIMATE_MICRO_USD))) {
      return stopForBudget(run, PLAN_ESTIMATE_MICRO_USD);
    }
    const drafted = await beat(
      () =>
        deps.plan({
          userId: run.userId,
          goal: run.goal,
          constraints: plan.constraints,
          effort: plan.effort,
          pinnedSources: plan.pinnedSources,
          signal,
        }),
      heartbeat
    );
    await bill(run, drafted.costMicroUsd, "plan");
    /*
     * A RUN WITH NO PLAN IS NOT A RESEARCH RUN, so it stops here.
     *
     * What used to happen: a planner that returned nothing — a timeout, a
     * model that ignored the output shape, a provider briefly down — fell
     * through to `fallbackResearchQueries`, which is the user's own sentence
     * with fourteen suffixes bolted on ("… explained", "… pros and cons", "…
     * latest news 2026"). Those were then SAVED AS THE PLAN, shown at the
     * confirmation gate for a person to approve, and used to synthesise the
     * objectives every worker is briefed from.
     *
     * Every part of that is wrong, and the visible symptom was exactly what
     * it sounds like: a deep research run that searches one sentence a dozen
     * ways. The template cannot decompose a question, so the objectives built
     * from it are the same sentence again; workers briefed on those overlap
     * completely; the review round finds no gaps because there were never any
     * distinct questions to have gaps in. A thin report was the LEAST of it.
     *
     * `planResearchQueries` already retries once before giving up (see
     * tools.ts), so reaching here means two attempts produced nothing. That
     * is a real outage, and saying so costs the user a retry instead of the
     * price of a full run they will not trust.
     *
     * The templates are still the floor for a run that HAS a plan and is
     * merely short of searches — see `doSearching`, which is the one caller
     * left.
     */
    if (drafted.queries.length === 0) {
      const ended = await finish(run, "failed", {
        reason: "no_plan",
        error: "The research planner could not draft a plan for this question. Try again, or rephrase the goal.",
      });
      return ended ? { kind: "finished", state: "failed" } : { kind: "raced" };
    }
    // A planner that wrote SOME queries is trusted as written — a quick tier
    // is told to draft a handful, and topping it up would override that.
    const queries = drafted.queries.slice(0, MAX_PLAN_QUERIES);
    const objectives = drafted.objectives?.length
      ? drafted.objectives
      : buildResearchObjectives(run.goal, queries);
    const next: ResearchPlan = {
      ...plan,
      // Absent rather than empty when the planner gave none — the gate reads
      // "no steps" as "fall back to the query list", which is what every plan
      // drafted before steps existed does.
      ...(drafted.steps?.length ? { steps: drafted.steps } : {}),
      ...(drafted.brief ? { brief: drafted.brief } : {}),
      ...(drafted.approach ? { approach: drafted.approach } : {}),
      ...(drafted.successCriteria?.length ? { successCriteria: drafted.successCriteria } : {}),
      ...(drafted.risks?.length ? { risks: drafted.risks } : {}),
      queries,
      objectives,
      issuedQueries: [],
      followUpRound: 0,
      coverage: [],
      conflicts: [],
    };
    if (plan.confirmation === "auto" && !planIsConfirmed(next)) {
      next.confirmedAt = deps.now().toISOString();
    }
    await store.savePlan({ runId: run.id, userId: run.userId, plan: next });
    await store.recordQueries({ runId: run.id, userId: run.userId, queries });

    const reloaded = (await store.loadRun(run.id, run.userId)) ?? run;
    // The timeline narrates the plan from this payload: how many questions
    // the run will answer and the planner's one-paragraph approach.
    const drafted_ = {
      queries,
      objectives: objectives.length,
      steps: next.steps ?? [],
      ...(next.approach ? { approach: next.approach } : {}),
    };
    if (planIsConfirmed(next)) {
      const moved = await advance(reloaded, "investigating", undefined, [
        { kind: "plan_drafted", payload: drafted_ },
        { kind: "plan_confirmed", payload: { by: "auto" } },
      ]);
      return moved ? { kind: "advanced", state: "investigating" } : { kind: "raced" };
    }
    const moved = await advance(reloaded, "awaiting_plan_confirmation", undefined, [
      { kind: "plan_drafted", payload: drafted_ },
    ]);
    return moved
      ? { kind: "blocked", state: "awaiting_plan_confirmation" }
      : { kind: "raced" };
  };

  const doSearching = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    const plan = parsePlan(run.plan);
    const queries = plan.queries.length ? plan.queries : fallbackResearchQueries(run.goal, plan.effort);
    const resultsPerQuery = planBudget(plan).resultsPerQuery;
    const plannedIssued = new Set(plan.issuedQueries ?? []);
    // Legacy runs did not persist issuedQueries. Treat their first resumed
    // search as unissued so a schema rollout cannot silently skip gathering.
    const pending = plan.issuedQueries === undefined ? queries : queries.filter((query) => !plannedIssued.has(query));
    let current = run;
    const issued = new Set(plannedIssued);
    // The provider roster is a property of the deployment, not of the query, so
    // it rides the FIRST query of the sweep only. Repeating it on every event
    // would be the same fact a dozen times in a timeline a person has to read.
    let providersAnnounced = plannedIssued.size > 0;

    /*
     * SEARCH dispatches in waves, the same shape READ uses, and the two
     * properties that used to justify keeping it serial are why the wave is
     * sized the way it is rather than partitioned up front.
     *
     * `waves()` is deliberately NOT used here. It cuts a fixed partition, so a
     * ceiling that can only afford one query of a four-wide slice would drop
     * the other three on the floor and stop — which is how a 17k budget that
     * paid for two queries serially came back paying for one. The cursor below
     * re-asks `affordableCount` from the LIVE spend on every pass, so the wave
     * is exactly as wide as the projection can cover and the queries it could
     * not take are reconsidered against the money the last wave actually cost.
     * That is what keeps "the ceiling stops the sweep midway" true query for
     * query, not merely wave for wave.
     *
     * Cancellation moves from a per-query boundary to a per-wave one, and that
     * is the honest cost of parallelism: four calls handed to Promise.all are
     * four calls paid for whatever the next check would have said. What still
     * holds — and is what the user is actually owed — is that a cancel stops
     * the run before it pays for the NEXT wave, because the state re-read at
     * the top of the loop happens before anything is dispatched.
     */
    let cursor = 0;
    while (cursor < pending.length) {
      const fresh = await store.loadRun(current.id, current.userId);
      if (!fresh || fresh.state !== "investigating") return { kind: "raced" };
      current = fresh;
      // A long sweep can outlast the worker lease on its own, and a lease that
      // expires mid-step is a second worker adopting a run that is still being
      // driven — the same queries, billed twice.
      await heartbeat?.();

      // One budget decision for the whole wave, taken BEFORE anything goes out.
      // Checking per query and then firing four in parallel is not a ceiling:
      // requests already in flight cannot be recalled.
      const allowed = await affordableCount(
        current,
        SEARCH_ESTIMATE_MICRO_USD,
        Math.min(SEARCH_CONCURRENCY, pending.length - cursor)
      );
      if (allowed === 0) return stopForBudget(current, SEARCH_ESTIMATE_MICRO_USD);
      const wave = pending.slice(cursor, cursor + allowed);
      cursor += allowed;

      const found = await Promise.all(
        wave.map(async (query) => ({
          query,
          result: await deps.search({ userId: run.userId, query, count: resultsPerQuery, signal }),
        }))
      );

      // Persisting is sequential on purpose — the same reason READ gives. The
      // parallel part is the network; the ledger, the event seq and the plan
      // row are per-run serial resources, and interleaving writes to them buys
      // nothing and races.
      for (const { query, result } of found) {
        await bill(current, result.costMicroUsd, "search");
        await append(run.id, run.userId, [
          {
            kind: "query_issued",
            payload: {
              query,
              results: result.hits.length,
              ...(result.engines?.length ? { engines: result.engines } : {}),
              ...(!providersAnnounced && result.providers ? { providers: result.providers } : {}),
            },
          },
        ]);
        providersAnnounced = true;
        for (const hit of result.hits.slice(0, MAX_SOURCES)) {
          // Search backends that return the page body in the same call (Tavily's
          // `include_raw_content`) have already been paid for it. Storing the
          // snapshot here is what stops READ fetching the identical page a second
          // time and billing the run twice for one document.
          const body = hit.rawContent?.trim() ? hit.rawContent.slice(0, SNAPSHOT_CHARS) : null;
          const score = scoreSource({
            url: hit.url,
            text: body ?? hit.snippet,
            publishedAt: hit.publishedAt,
          });
          const sourceType = sourceTypeOf({ url: hit.url, text: body ?? hit.snippet, authority: score.authority });
          const stored = await store.upsertSource({
            runId: run.id,
            userId: run.userId,
            url: hit.url,
            title: hit.title,
            publishedAt: hit.publishedAt,
            ...(body ? { snapshot: body, contentHash: deps.hash(body) } : {}),
            ...score,
            sourceType,
          });
          if (stored.created) {
            await append(run.id, run.userId, [
              { kind: "source_found", payload: { url: hit.url, title: hit.title, query } },
            ]);
          }
        }
        issued.add(query);
        // Per query rather than once per wave: a worker killed between two
        // members of a wave has already been billed for the ones behind it, and
        // a resumed run that re-issued them would pay the vendor twice for the
        // same results.
        const latest = (await store.loadRun(current.id, current.userId)) ?? current;
        const latestPlan = parsePlan(latest.plan);
        await store.savePlan({
          runId: current.id,
          userId: current.userId,
          plan: { ...latestPlan, issuedQueries: [...issued] },
        });
      }
    }
    // Searching, pinned-source ingestion and reading are one investigation
    // round now. The coordinator below calls the remaining two legs before it
    // hands the corpus to the lead for review.
    return { kind: "advanced", state: "investigating" };
  };

  /**
   * BROWSE: the user's pinned sources.
   *
   * Separate from SEARCH because a pinned source is not a search result — it
   * is an instruction, and it must be read whether or not any query surfaced
   * it. This is also the stage steering lands in, which is why a run steered
   * with a new URL resumes here rather than re-planning.
   */
  const doBrowsing = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    const plan = parsePlan(run.plan);
    let current = run;
    for (const url of plan.pinnedSources.slice(0, Math.min(MAX_PINNED_SOURCES, planBudget(plan).pages))) {
      if (!(await affordable(current, READ_ESTIMATE_MICRO_USD))) {
        return stopForBudget(current, READ_ESTIMATE_MICRO_USD);
      }
      const fresh = await store.loadRun(current.id, current.userId);
      if (!fresh || fresh.state !== "investigating") return { kind: "raced" };
      current = fresh;
      await heartbeat?.();

      const page = await fetchPage(run.userId, url, signal);
      if (!page || pageWasSkipped(page)) {
        // A pinned source that will not load is worth saying out loud: the user
        // chose it, and silently proceeding without it produces a report that
        // looks like it considered something it never saw. The reason matters
        // as much as the fact — "that URL is a PDF and this build cannot read
        // one" is actionable; "could not be read" is not.
        await append(run.id, run.userId, [
          {
            kind: "error",
            payload: {
              scope: "pinned_source",
              url,
              message: page ? pageSkipMessage(page) : "Could not be read.",
              ...(page ? { reason: page.skipped } : {}),
            },
          },
        ]);
        continue;
      }
      await bill(current, page.costMicroUsd, "fetch");
      const text = page.text.slice(0, SNAPSHOT_CHARS);
      const score = scoreSource({ url, text, publishedAt: page.publishedAt ?? null });
      const stored = await store.upsertSource({
        runId: run.id,
        userId: run.userId,
        url,
        title: page.title || url,
        // Only when the page carries one: a null here would clear a date a
        // search result had already supplied for the same row.
        ...(page.publishedAt ? { publishedAt: page.publishedAt } : {}),
        contentHash: deps.hash(text),
        snapshot: text,
        // Pinned by the user, so it outranks anything the search backend
        // surfaced; the number is recorded so a reader can see why.
        authority: 1,
        freshness: score.freshness,
        directness: score.directness,
        independence: score.independence,
        composite: score.composite,
        sourceType: sourceTypeOf({ url, text, authority: 1 }),
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
    return { kind: "advanced", state: "investigating" };
  };

  /**
   * HOP: follow the links a page it just read pointed at.
   *
   * Every fetched page was already being parsed into markdown with its `<a>`
   * tags turned into `[text](url)` — and then the links were dropped on the
   * floor. Nothing in the run had ever followed one, which meant the corpus was
   * strictly whatever a search index happened to rank: the primary source an
   * article cites, the specification a summary links to, the dataset behind a
   * chart, were all one click away and none of them reachable.
   *
   * Three things keep this from becoming a crawler. It runs ONE hop, from pages
   * this stage opened, never from pages discovered by a previous hop. Candidates
   * must earn it — the anchor text has to be about an objective, and an off-host
   * link scores higher because a link to another page of the same site is the
   * one least likely to add an independent witness. And it is bounded by
   * `MAX_HOP_SOURCES`, by the run's remaining source budget, and by money: a hop
   * the budget cannot pay for is skipped silently rather than ending the run,
   * because unlike a source with no text at all, this was always optional.
   */
  const doLinkHop = async (
    run: ResearchRunRow,
    existing: ReadonlyArray<{ source: ResearchSourceRow }>,
    discovered: ReadonlyArray<{ from: string; link: ResearchPageLink }>,
    hopPages: number,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<{ run: ResearchRunRow; outcome?: StepOutcome; added: number; fetched: number; passages: number }> => {
    /*
     * The hop's own allowance, handed in by READ out of the seed share. It
     * used to be computed as the page budget minus the number of source ROWS,
     * read or not — and every tier discovers more rows than it has pages, so
     * the room was negative on every production run and this stage returned
     * before ranking a single link. `MAX_SOURCES` no longer figures here
     * either: it bounds the synthesis corpus, not fetches, and `known` below
     * already dedupes against the rows the run holds.
     */
    const room = Math.min(MAX_HOP_SOURCES, Math.max(0, Math.floor(hopPages)));
    if (discovered.length === 0 || room <= 0) return { run, added: 0, fetched: 0, passages: 0 };

    const plan = parsePlan(run.plan);
    const wanted = contentTokens(
      [...plan.objectives.map((objective) => objective.question), ...plan.queries].join(" ")
    );
    if (wanted.size === 0) return { run, added: 0, fetched: 0, passages: 0 };

    const known = new Set(existing.map(({ source }) => canonicalUrl(source.url)));
    const ranked: Array<{ href: string; text: string; from: string; score: number }> = [];
    for (const { from, link } of discovered) {
      const key = canonicalUrl(link.href);
      if (known.has(key)) continue;
      known.add(key);
      // The path segments count as anchor text: plenty of citation links are
      // bare URLs or read "here", and `/reports/2024-emissions-methodology` is
      // the only thing about them that says what they are.
      let path = "";
      try {
        path = decodeURIComponent(new URL(link.href).pathname).replace(/[-_/.]+/g, " ");
      } catch {
        continue;
      }
      const anchorTokens = contentTokens(`${link.text} ${path}`);
      if (anchorTokens.size < 2) continue;
      let matched = 0;
      for (const token of anchorTokens) if (wanted.has(token)) matched += 1;
      let score = matched / anchorTokens.size;
      if (hostOfUrl(link.href) !== hostOfUrl(from)) score += 0.15;
      if (score < HOP_MIN_OVERLAP) continue;
      ranked.push({ href: link.href, text: link.text, from, score });
    }
    if (ranked.length === 0) return { run, added: 0, fetched: 0, passages: 0 };

    const targets = ranked.sort((a, b) => b.score - a.score).slice(0, room);
    let current = run;
    let added = 0;
    let fetched = 0;
    let passages = 0;

    for (const wave of waves(targets, READ_CONCURRENCY)) {
      const fresh = await store.loadRun(current.id, current.userId);
      if (!fresh || fresh.state !== "investigating") return { run: current, outcome: { kind: "raced" }, added, fetched, passages };
      current = fresh;
      await heartbeat?.();

      const allowed = await affordableCount(current, READ_ESTIMATE_MICRO_USD, wave.length);
      if (allowed === 0) break;

      const dispatched = wave.slice(0, allowed);
      const pages = await Promise.all(
        dispatched.map(async (target) => ({
          target,
          page: await fetchPage(run.userId, target.href, signal),
        }))
      );

      for (const { target, page } of pages) {
        // A link that will not load is not worth an event: unlike a pinned
        // source or a ranked search result, nobody asked for this one and a
        // timeline full of "a link failed" is noise around the real findings.
        if (!page || pageWasSkipped(page)) continue;
        await bill(current, page.costMicroUsd, "fetch");
        const text = page.text.slice(0, SNAPSHOT_CHARS);
        if (!text) continue;
        const score = scoreSource({ url: target.href, text, publishedAt: page.publishedAt ?? null });
        const stored = await store.upsertSource({
          runId: run.id,
          userId: run.userId,
          url: target.href,
          title: page.title || target.text || target.href,
          ...(page.publishedAt ? { publishedAt: page.publishedAt } : {}),
          contentHash: deps.hash(text),
          snapshot: text,
          ...score,
          sourceType: sourceTypeOf({ url: target.href, text, authority: score.authority }),
        });
        fetched += 1;
        if (stored.created) added += 1;
        passages += await store.savePassages({
          userId: run.userId,
          sourceId: stored.id,
          passages: splitPassages(text),
        });
        await append(run.id, run.userId, [
          {
            kind: "source_found",
            payload: { url: target.href, title: page.title, via: target.from, hop: 1 },
          },
          { kind: "source_read", payload: { url: target.href, title: page.title, hop: 1 } },
        ]);
      }

      if (allowed < wave.length) break;
    }

    return { run: current, added, fetched, passages };
  };

  /**
   * READ: fetch whatever has no stored body, then cut every body into passages.
   *
   * Passages are what a claim gets cited against, so they are extracted here
   * rather than at the moment the text arrived — a source whose snapshot came
   * back with the search results has never been through this stage, and a
   * corpus where half the sources have passages and half do not is a report
   * that can only cite half of what it read.
   */
  const doReading = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    const sources = (await store.listSources(run.id, run.userId))
      .map((source) => {
        const score = scoreSource({
          url: source.url,
          text: source.snapshot ?? "",
          publishedAt: source.publishedAt,
        });
        return {
          source,
          sourceType: classifiedSourceType(source),
          score: {
            authority: source.authority ?? score.authority,
            freshness: source.freshness ?? score.freshness,
            directness: source.directness ?? score.directness,
            independence: source.independence ?? score.independence,
            composite: source.composite ?? score.composite,
          },
        };
      })
      .sort(
        (a, b) =>
          b.score.composite - a.score.composite ||
          b.score.authority - a.score.authority ||
          a.source.fetchedAt.getTime() - b.source.fetchedAt.getTime()
      );
    await append(run.id, run.userId, [
      {
        kind: "source_ranked",
        payload: {
          order: sources.slice(0, MAX_READ_SOURCES).map(({ source, sourceType, score }) => ({
            sourceId: source.id,
            host: hostOfUrl(source.url),
            sourceType,
            ...score,
          })),
        },
      },
    ]);
    let current = run;
    let fetched = 0;
    let passages = 0;
    /** Outbound links from pages this stage actually opened, for the hop below. */
    const discovered: Array<{ from: string; link: ResearchPageLink }> = [];

    const plan = parsePlan(run.plan);
    const budget = planBudget(plan);
    // A quarter of the tier's pages, not all of them — see SEED_PAGE_SHARE.
    // URLs an earlier pass found dead for good are skipped, so a follow-up
    // reads the next ranked source instead of paying their timeouts again.
    const seedPages = Math.ceil(budget.pages * SEED_PAGE_SHARE);
    const unreadable = new Set((plan.unreadable ?? []).map((url) => canonicalUrl(url)));
    const targets = sources
      .filter(({ source }) => !unreadable.has(canonicalUrl(source.url)))
      .slice(0, Math.min(MAX_READ_SOURCES, seedPages));
    /** URLs this pass found dead for good, appended to the plan below. */
    const dead: string[] = [];
    for (const wave of waves(targets, READ_CONCURRENCY)) {
      const fresh = await store.loadRun(current.id, current.userId);
      if (!fresh || fresh.state !== "investigating") return { kind: "raced" };
      current = fresh;
      // A wave of eight fetches at a 25s timeout each can outlive the two-minute
      // worker lease on its own; without this the sweeper adopts a run that is
      // still being driven and re-fetches every page against the same budget.
      await heartbeat?.();

      /**
       * DEEPEN: open a page the search engine only skimmed.
       *
       * A search backend that returns page text (Tavily's `include_raw_content`,
       * Exa's `text`) has its result stored as the snapshot during SEARCH, and
       * this stage then treated any snapshot at all as "already read" and never
       * fetched the page. That is the difference between a search result and a
       * source: those payloads are frequently a few hundred characters of lede,
       * and the whole run — the corpus, the passages, every citation checked
       * against them — was built on the preview rather than the document.
       *
       * It is the same move as the `open_page` step that follows `search` in
       * every comparable agent loop, and it is deliberately RANKED rather than
       * universal: only sources good enough to be worth the fetch, and only when
       * what we hold is too thin to be the real page. A run whose budget runs out
       * mid-deepening still has the snippets and still answers.
       */
      const jobs = wave.map(({ source }) => {
        const text = source.snapshot ?? "";
        return {
          source,
          text,
          required: text.length === 0,
          deepen: text.length > 0 && text.length < DEEPEN_BELOW_CHARS,
        };
      });
      const required = jobs.filter((job) => job.required);
      const deepenSlots = Math.max(0, MAX_DEEPENED_SOURCES - fetched);
      const deepening = jobs.filter((job) => job.deepen).slice(0, deepenSlots);

      // One budget decision for the whole wave, taken BEFORE anything is
      // dispatched. Checking per fetch and then firing eight in parallel is not
      // a ceiling — the requests already in flight cannot be recalled. Required
      // fetches are served first: a source with no text at all is the
      // difference between a source and a link, while a deepen is an upgrade
      // the run can live without.
      const allowed = await affordableCount(
        current,
        READ_ESTIMATE_MICRO_USD,
        required.length + deepening.length
      );
      // Sequential reading stopped the run at the first required fetch it could
      // not project paying for. Preserve that exactly: pay for as many of this
      // wave's required fetches as the ceiling allows, then stop — rather than
      // skipping the rest of the wave and carrying on into the next one, which
      // would silently leave read-able sources unread with no receipt anywhere.
      const budgetShort = allowed < required.length;
      const dispatch = budgetShort
        ? required.slice(0, allowed)
        : [...required, ...deepening.slice(0, allowed - required.length)];
      const pages = new Map<string, ResearchPageResult | null>();
      await Promise.all(
        dispatch.map(async (job) => {
          pages.set(job.source.id, await fetchPage(run.userId, job.source.url, signal));
        })
      );

      // Persisting is sequential on purpose. The parallel part is the network;
      // the ledger, the event seq and the plan row are all per-run serial
      // resources, and interleaving writes to them buys nothing and races.
      for (const job of jobs) {
        let text = job.text;
        const page = pages.get(job.source.id) ?? null;

        if (job.required) {
          if (!page || pageWasSkipped(page)) {
            if (page) {
              await append(run.id, run.userId, [
                {
                  kind: "error",
                  payload: {
                    scope: "source",
                    url: job.source.url,
                    message: pageSkipMessage(page),
                    reason: page.skipped,
                  },
                },
              ]);
              if (permanentSkip(page)) dead.push(job.source.url);
            }
            continue;
          }
          await bill(current, page.costMicroUsd, "fetch");
          text = page.text.slice(0, SNAPSHOT_CHARS);
          const publishedAt = page.publishedAt ?? job.source.publishedAt;
          const score = scoreSource({ url: job.source.url, text, publishedAt });
          await store.upsertSource({
            runId: run.id,
            userId: run.userId,
            url: job.source.url,
            title: page.title || job.source.title,
            publishedAt,
            contentHash: deps.hash(text),
            snapshot: text,
            ...score,
            sourceType: sourceTypeOf({ url: job.source.url, text, authority: score.authority }),
          });
          fetched += 1;
          for (const link of page.links ?? []) discovered.push({ from: job.source.url, link });
          await append(run.id, run.userId, [
            { kind: "source_read", payload: { url: job.source.url, title: page.title } },
          ]);
        } else if (page && !pageWasSkipped(page) && page.text.length > text.length) {
          // Only take the deeper copy if it IS deeper; a paywall or a consent wall
          // returns a short body, and overwriting a usable snippet with it would
          // lose the only text this source ever had.
          await bill(current, page.costMicroUsd, "fetch");
          text = page.text.slice(0, SNAPSHOT_CHARS);
          const publishedAt = page.publishedAt ?? job.source.publishedAt;
          const score = scoreSource({ url: job.source.url, text, publishedAt });
          await store.upsertSource({
            runId: run.id,
            userId: run.userId,
            url: job.source.url,
            title: page.title || job.source.title,
            publishedAt,
            contentHash: deps.hash(text),
            snapshot: text,
            ...score,
            sourceType: sourceTypeOf({ url: job.source.url, text, authority: score.authority }),
          });
          fetched += 1;
          for (const link of page.links ?? []) discovered.push({ from: job.source.url, link });
          await append(run.id, run.userId, [
            { kind: "source_read", payload: { url: job.source.url, title: page.title, deepened: true } },
          ]);
        }

        passages += await store.savePassages({
          userId: run.userId,
          sourceId: job.source.id,
          passages: splitPassages(text),
        });
        await append(run.id, run.userId, [
          { kind: "source_read", payload: { url: job.source.url, title: job.source.title, ranked: true } },
        ]);
      }

      if (budgetShort) return stopForBudget(current, READ_ESTIMATE_MICRO_USD);
    }

    const hop = await doLinkHop(current, sources, discovered, Math.ceil(budget.pages * HOP_PAGE_SHARE), signal, heartbeat);
    if (hop.outcome) return hop.outcome;
    current = hop.run;
    fetched += hop.fetched;
    passages += hop.passages;

    // What this pass fetched goes on the plan — the rows cannot say which of
    // them cost a fetch — and so do the URLs it found dead for good.
    const latest = (await store.loadRun(current.id, current.userId)) ?? current;
    const latestPlan = parsePlan(latest.plan);
    const unreadableNow = [...(latestPlan.unreadable ?? []), ...dead];
    const saved = await store.savePlan({
      runId: current.id,
      userId: current.userId,
      plan: {
        ...latestPlan,
        seedPagesRead: (latestPlan.seedPagesRead ?? 0) + fetched,
        ...(unreadableNow.length ? { unreadable: unreadableNow.slice(-MAX_UNREADABLE_SOURCES) } : {}),
      },
    });
    current = saved ?? latest;

    await append(run.id, run.userId, [
      {
        kind: "passages_extracted",
        payload: {
          fetched,
          passages,
          sourcesTotal: sources.length + hop.added,
          ...(hop.added > 0 ? { followedLinks: hop.added } : {}),
        },
      },
    ]);

    // Two reprints of one story must not satisfy "two independent sources"
    // before the team has even been briefed.
    current = await markSyndicatedCopies(current);

    // The sweep seeded the corpus; now the team goes to work on it.
    const agents = await doWorkerRounds(current, signal, heartbeat);
    if (agents.outcome) return agents.outcome;
    current = agents.run;

    const moved = await advance(current, "reviewing");
    return moved ? { kind: "advanced", state: "reviewing" } : { kind: "raced" };
  };

  // ── the agent rounds ────────────────────────────────────────────────────

  /**
   * The briefs for the first round: one worker per sub-question, and when the
   * tier affords more workers than there are sub-questions, the most important
   * ones get a second worker sent along a different axis — counter-evidence,
   * the latest developments, primary records — so two workers on one question
   * never read the same pages.
   */
  const initialDelegations = (plan: ResearchPlan, workers: number): ResearchDelegation[] => {
    const objectives = plan.objectives.length ? plan.objectives : buildResearchObjectives("", plan.queries);
    const ranked = [...objectives].sort((a, b) => b.importance - a.importance);
    const out: ResearchDelegation[] = [];
    const limit = Math.min(workers, MAX_DELEGATIONS_PER_ROUND);
    for (const objective of ranked) {
      if (out.length >= limit) break;
      const requirements = objective.evidenceRequirements.map((r) => r.description).filter(Boolean);
      out.push({
        workerId: `w1-${out.length + 1}`,
        objectiveId: objective.id,
        objective: objective.question,
        whatToFind: [
          `Establish, with quotes from authoritative pages, what is known about: ${objective.question}.`,
          ...(requirements.length ? [`Evidence needed: ${requirements.slice(0, 3).join("; ")}.`] : []),
          "Prefer official documentation, primary sources, regulators and peer-reviewed or reputable trade reporting; note the date of every figure.",
        ].join(" "),
        boundaries: "Other workers cover the other sub-questions; stay on this one.",
      });
    }
    const axes = [
      {
        label: "counter-evidence",
        find: "Find the strongest disagreement, criticism, failure cases and conflicting numbers about: {q}. Look for sceptical experts, independent audits, complaints, retractions and second opinions.",
        bounds: "Another worker is collecting the mainstream account and official figures; do not repeat it.",
      },
      {
        label: "recent developments",
        find: "Find the most recent developments, announcements, releases, rulings and data about: {q}. Prioritise the last twelve months and record exact dates.",
        bounds: "Another worker covers background and the established record; only bring back what is new.",
      },
      {
        label: "primary records",
        find: "Find the primary records behind: {q} — original studies, filings, specifications, datasets, official statistics, court or regulator documents — and quote the figures directly from them.",
        bounds: "Another worker covers secondary reporting; skip news summaries unless they link to the primary document.",
      },
    ];
    let axis = 0;
    for (const objective of ranked) {
      if (out.length >= limit) break;
      const a = axes[axis % axes.length]!;
      axis += 1;
      out.push({
        workerId: `w1-${out.length + 1}`,
        objectiveId: objective.id,
        objective: objective.question,
        whatToFind: a.find.replace("{q}", objective.question),
        boundaries: a.bounds,
      });
    }
    return out;
  };

  /**
   * The lead's fallback review, when no reviewer is wired.
   *
   * Counts independent hosts behind each sub-question's findings and keeps
   * going only while a round is still adding claims — the saturation rule
   * `SATURATION_NEW_CLAIM_SHARE` states.
   */
  const fallbackReview = (input: ReviewRoundInput): ReviewRoundOutput => {
    const coverage: Record<string, number> = {};
    const gaps: ReviewRoundOutput["gaps"] = [];
    for (const objective of input.objectives) {
      const own = input.findings.filter((finding) => finding.objectiveId === objective.id);
      const hosts = new Set(own.map((finding) => hostOfUrl(finding.url)));
      const score = Math.min(1, hosts.size * 0.4 + Math.min(own.length, 6) * 0.05);
      coverage[objective.id] = Number(score.toFixed(2));
      if (score < COVERAGE_TARGET) {
        gaps.push({
          objectiveId: objective.id,
          reason: own.length === 0 ? "No sourced finding answers this yet." : "Only one line of evidence so far.",
          whatToFind: `Find independent, primary evidence for: ${objective.question}. Go somewhere the last round did not: a different kind of source, a specific dataset or filing, the field's own vocabulary.`,
          boundaries: "Do not re-read pages the run has already opened unless you need a specific figure from them.",
        });
      }
    }
    const newThisRound = input.findings.filter((finding) => finding.round === input.round).length;
    const saturated = input.round > 1 && newThisRound < Math.max(2, input.findings.length * SATURATION_NEW_CLAIM_SHARE);
    const decision = gaps.length > 0 && input.roundsLeft > 0 && input.pagesLeft > 0 && !saturated ? "continue" : "synthesize";
    return {
      coverage,
      gaps: decision === "continue" ? gaps : [],
      contradictions: [],
      decision,
      reason:
        decision === "continue"
          ? `${gaps.length} sub-question${gaps.length === 1 ? "" : "s"} still short of evidence.`
          : saturated
            ? "The last round added little that was new."
            : gaps.length === 0
              ? "Every sub-question has independent, sourced evidence."
              : "No rounds or pages left for the remaining gaps.",
      costMicroUsd: 0,
    };
  };

  /**
   * The tools one worker holds, bound to this run.
   *
   * The engine implements them rather than the worker because the engine owns
   * the money and the corpus: every search is billed and its hits become
   * sources, every page opened is stored with its passages so the citation
   * audit can later check a claim against the bytes the worker saw, and every
   * finding lands in the shared table the lead reviews. The per-run counters
   * (`pagesRead`, `spent`) are shared across the round's workers on purpose —
   * the tier's page ceiling is a ceiling on the RUN.
   */
  const bindWorkerTools = (
    run: ResearchRunRow,
    workerId: string,
    round: number,
    objectiveId: string,
    shared: {
      pagesRead: number;
      toolCalls: number;
      pageCeiling: number;
      resultsPerQuery: number;
      /** Every query the round's workers issued, for the plan's ledger. */
      queries: string[];
      /** Canonical URLs an earlier pass found dead for good. */
      unreadable: ReadonlySet<string>;
    },
    perWorker: { maxToolCalls: number; deadline: number },
    signal?: AbortSignal
  ): WorkerTools => {
    let calls = 0;
    const tick = async (tool: string, arg: string, startedAt: number, ok: boolean) => {
      calls += 1;
      shared.toolCalls += 1;
      await append(run.id, run.userId, [
        {
          kind: "worker_tool_call",
          payload: { workerId, round, tool, arg: arg.slice(0, 200), ms: Date.now() - startedAt, ok },
        },
      ]);
    };
    /** The stop the NEXT call would hit, decided after this one ran. */
    const stopAfter = async (): Promise<WorkerStopReason | undefined> => {
      if (signal?.aborted) return "aborted";
      if (calls >= perWorker.maxToolCalls) return "tool_limit";
      if (Date.now() >= perWorker.deadline) return "time_limit";
      const fresh = await store.loadRun(run.id, run.userId);
      if (!fresh || fresh.state !== "investigating") return "aborted";
      if (budgetExhausted(fresh.costMicroUsd, fresh.budgetMicroUsd)) return "budget";
      return undefined;
    };
    // One indexed row where the store offers it; the corpus scan is the
    // fallback for the test stores only. See `ResearchStore.findSourceByUrl`.
    const sourceByUrl = async (url: string): Promise<ResearchSourceRow | null> => {
      if (store.findSourceByUrl) return store.findSourceByUrl(run.id, run.userId, url);
      const key = canonicalUrl(url);
      return (await store.listSources(run.id, run.userId)).find((source) => canonicalUrl(source.url) === key) ?? null;
    };
    const digestOf = (source: ResearchSourceRow, alreadyRead: boolean) => {
      const text = source.snapshot ?? "";
      const chunks = chunkText(text);
      return {
        ok: true as const,
        sourceId: source.id,
        url: source.url,
        title: source.title,
        summary: text.slice(0, 700).replace(/\s+/g, " "),
        chunkCount: chunks.length,
        chunks: chunks.map((chunk) => ({ ordinal: chunk.ordinal, preview: chunk.text.slice(0, CHUNK_PREVIEW_CHARS).replace(/\s+/g, " ") })),
        alreadyRead,
      };
    };

    return {
      async search(query) {
        const startedAt = Date.now();
        if (!(await affordable(run, SEARCH_ESTIMATE_MICRO_USD))) {
          await tick("search", query, startedAt, false);
          return { result: { hits: [], note: "The run's budget cannot pay for another search." }, stop: "budget" };
        }
        const result = await deps.search({ userId: run.userId, query, count: shared.resultsPerQuery, signal });
        await bill(run, result.costMicroUsd, "search");
        // On the round's shared list, not written to the plan here: workers run
        // in parallel and a read-modify-write of the plan JSON from each call
        // would lose updates. `doWorkerRounds` persists the list once with the
        // round, which is what lets the gap expander see what the team tried.
        shared.queries.push(query);
        await append(run.id, run.userId, [
          { kind: "query_issued", payload: { query, results: result.hits.length, workerId, round, ...(result.engines?.length ? { engines: result.engines } : {}) } },
        ]);
        // What the run already holds, by URL and text length only: this map
        // marks results the run has read, and loading every snapshot to build
        // it was the whole corpus per search.
        const known = new Map<string, number>(
          store.listSourceUrls
            ? (await store.listSourceUrls(run.id, run.userId)).map((source) => [canonicalUrl(source.url), source.snapshotChars])
            : (await store.listSources(run.id, run.userId)).map((source) => [canonicalUrl(source.url), source.snapshot?.length ?? 0])
        );
        const hits = [];
        for (const hit of result.hits) {
          const knownChars = known.get(canonicalUrl(hit.url));
          if (knownChars === undefined) {
            const body = hit.rawContent?.trim() ? hit.rawContent.slice(0, SNAPSHOT_CHARS) : null;
            const score = scoreSource({ url: hit.url, text: body ?? hit.snippet, publishedAt: hit.publishedAt });
            const stored = await store.upsertSource({
              runId: run.id,
              userId: run.userId,
              url: hit.url,
              title: hit.title,
              publishedAt: hit.publishedAt,
              ...(body ? { snapshot: body, contentHash: deps.hash(body) } : {}),
              ...score,
              sourceType: sourceTypeOf({ url: hit.url, text: body ?? hit.snippet, authority: score.authority }),
            });
            if (stored.created) {
              await append(run.id, run.userId, [{ kind: "source_found", payload: { url: hit.url, title: hit.title, query, workerId } }]);
            }
            known.set(canonicalUrl(hit.url), body?.length ?? 0);
          }
          hits.push({ url: hit.url, title: hit.title, snippet: hit.snippet.slice(0, 300), read: (knownChars ?? 0) >= 2_000 });
        }
        await tick("search", query, startedAt, true);
        return { result: { hits }, stop: await stopAfter() };
      },

      async openPage(url) {
        const startedAt = Date.now();
        const existing = await sourceByUrl(url);
        if (existing?.snapshot && existing.snapshot.length >= 2_000) {
          await tick("open_page", url, startedAt, true);
          return { result: digestOf(existing, true), stop: await stopAfter() };
        }
        if (shared.unreadable.has(canonicalUrl(url))) {
          await tick("open_page", url, startedAt, false);
          return { result: { ok: false, url, reason: "that page could not be read earlier in this run" }, stop: await stopAfter() };
        }
        if (shared.pagesRead >= shared.pageCeiling) {
          await tick("open_page", url, startedAt, false);
          return { result: { ok: false, url, reason: "the run has read every page its tier allows" }, stop: "page_limit" };
        }
        if (!(await affordable(run, READ_ESTIMATE_MICRO_USD))) {
          await tick("open_page", url, startedAt, false);
          return { result: { ok: false, url, reason: "the run's budget cannot pay for another page" }, stop: "budget" };
        }
        const page = await fetchPage(run.userId, url, signal);
        if (!page || pageWasSkipped(page)) {
          await tick("open_page", url, startedAt, false);
          if (page) {
            await append(run.id, run.userId, [
              { kind: "error", payload: { scope: "source", url, message: pageSkipMessage(page), reason: page.skipped, workerId } },
            ]);
          }
          return { result: { ok: false, url, reason: page ? pageSkipMessage(page) : "the page returned no readable text" }, stop: await stopAfter() };
        }
        await bill(run, page.costMicroUsd, "fetch");
        const text = page.text.slice(0, SNAPSHOT_CHARS);
        const publishedAt = page.publishedAt ?? existing?.publishedAt ?? null;
        const score = scoreSource({ url, text, publishedAt });
        const stored = await store.upsertSource({
          runId: run.id,
          userId: run.userId,
          url,
          title: page.title || existing?.title || url,
          publishedAt,
          contentHash: deps.hash(text),
          snapshot: text,
          ...score,
          sourceType: sourceTypeOf({ url, text, authority: score.authority }),
        });
        await store.savePassages({ userId: run.userId, sourceId: stored.id, passages: splitPassages(text) });
        shared.pagesRead += 1;
        await append(run.id, run.userId, [{ kind: "source_read", payload: { url, title: page.title, workerId, round } }]);
        await tick("open_page", url, startedAt, true);
        // Built from what was just stored, not read back: the text in hand is
        // the text on the row, and a second corpus load per open was the
        // dearest part of the tool.
        const row: ResearchSourceRow = {
          ...(existing ?? { contentHash: null, authority: null, fetchedAt: deps.now() }),
          id: stored.id,
          url,
          title: page.title || existing?.title || url,
          publishedAt,
          snapshot: text,
        };
        return { result: digestOf(row, false), stop: await stopAfter() };
      },

      async findInPage(url, pattern) {
        const startedAt = Date.now();
        const source = await sourceByUrl(url);
        if (!source?.snapshot) {
          await tick("find_in_page", pattern, startedAt, false);
          return { result: { ok: false, matches: [], reason: "open the page first" }, stop: await stopAfter() };
        }
        const regex = compileFindPattern(pattern);
        const matches = chunkText(source.snapshot)
          .filter((chunk) => regex.test(chunk.text))
          .slice(0, 6)
          .map((chunk) => ({ ordinal: chunk.ordinal, text: chunk.text }));
        await tick("find_in_page", pattern, startedAt, true);
        return { result: { ok: true, matches }, stop: await stopAfter() };
      },

      async noteFinding(finding) {
        const startedAt = Date.now();
        const source = await sourceByUrl(finding.url);
        if (!source) {
          await tick("note_finding", finding.claim, startedAt, false);
          return { result: { ok: false, reason: "cite a page you opened in this run" }, stop: await stopAfter() };
        }
        // The quote has to be IN the page. A worker that paraphrases and calls
        // it a quote has produced a claim the citation audit will reject later;
        // catching it here costs one string search and teaches the worker.
        const haystack = (source.snapshot ?? "").replace(/\s+/g, " ").toLowerCase();
        if (!haystack) {
          // A row with no body is a search hit, not a page: every result the
          // run has ever seen has one. Skipping the check for those — which
          // this used to do — let a worker note any quote against any URL it
          // had merely seen in a result list, and the check's whole purpose is
          // that a finding is a quote from a page the worker read.
          await tick("note_finding", finding.claim, startedAt, false);
          return { result: { ok: false, reason: "open that page with open_page before citing it" }, stop: await stopAfter() };
        }
        const needle = finding.quote.replace(/\s+/g, " ").toLowerCase();
        const probe = needle.length > 80 ? needle.slice(0, 80) : needle;
        if (!haystack.includes(probe)) {
          await tick("note_finding", finding.claim, startedAt, false);
          return { result: { ok: false, reason: "the quote does not appear verbatim on that page — use find_in_page and quote exactly" }, stop: await stopAfter() };
        }
        if (store.addFinding) {
          await store.addFinding({
            runId: run.id,
            userId: run.userId,
            workerId,
            round,
            objectiveId,
            sourceId: source.id,
            url: source.url,
            claim: finding.claim,
            quote: finding.quote,
            locator: chunkOrdinal(finding.locator) !== null ? finding.locator! : null,
            confidence: finding.confidence ?? null,
          });
        }
        await tick("note_finding", finding.claim, startedAt, true);
        return { result: { ok: true }, stop: await stopAfter() };
      },
    };
  };

  /**
   * The agent rounds: a team of workers, a lead's review, repeat.
   *
   * Runs inside the `investigating` step after the sweep has seeded the
   * corpus. Each round dispatches the tier's worker count in parallel, each
   * with its own brief and its own tool loop, then hands what they noted to
   * the lead, who scores every sub-question and either writes the next
   * round's briefs or declares the corpus ready. Rounds are recorded on the
   * plan as they finish, so a driver that resumes the run picks up at the
   * round after the last one recorded rather than paying for it twice.
   *
   * Skipped entirely when no worker is wired (the test engines), and bounded
   * in every unit the tier names: workers per round, rounds, tool calls per
   * worker, pages for the run, wall clock for the run and per worker, money.
   */
  const doWorkerRounds = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<{ run: ResearchRunRow; outcome?: StepOutcome }> => {
    if (!deps.runWorker) return { run };
    let current = run;
    let plan = parsePlan(current.plan);
    const budget = planBudget(plan);
    const startedAt = plan.budget?.startedAt ?? deps.now().toISOString();
    if (!plan.budget?.startedAt) {
      plan = { ...plan, budget: { ...budget, startedAt } };
      current = (await store.savePlan({ runId: run.id, userId: run.userId, plan })) ?? current;
    }
    const totalRounds = Math.min(budget.rounds, MAX_RESEARCH_ROUNDS);
    let delegations: ResearchDelegation[] = [];
    const lastRecorded = plan.rounds?.[plan.rounds.length - 1];
    if (lastRecorded?.review?.decision === "synthesize") return { run: current };
    let round = (plan.rounds?.length ?? 0) + 1;
    if (round > totalRounds) return { run: current };
    const workerTokens = { used: plan.rounds?.reduce((n, r) => n + r.tokens, 0) ?? 0 };
    /** Whether any workers went out, so the syndication pass below runs only over pages they could have added. */
    let ranARound = false;

    while (round <= totalRounds) {
      const fresh = await store.loadRun(current.id, current.userId);
      if (!fresh || fresh.state !== "investigating") return { run: current, outcome: { kind: "raced" } };
      current = fresh;
      plan = parsePlan(current.plan);
      await heartbeat?.();

      // A round boundary: "Finish now" stops the rounds (§9.7), and guidance
      // queued since the last boundary becomes constraints before the briefs
      // are written (§9.4).
      if (plan.finishRequestedAt) break;
      if ((plan.steering ?? []).some((entry) => entry.appliedAtRound === null)) {
        current = await applySteering(current, round);
        plan = parsePlan(current.plan);
      }

      if (investigationElapsedMs(plan, deps.now()) >= budget.wallClockMs) break;
      if (workerTokens.used >= budget.tokens) break;

      /*
       * Pages READ means pages FETCHED: the sweep's, from the plan, plus what
       * every recorded round's workers opened. It used to be the count of rows
       * with a snapshot, which a search backend that returns page bodies fills
       * to several hundred before anything has been fetched — so this gate
       * broke out here on every tier and the team never ran. See
       * `ResearchPlan.seedPagesRead`.
       */
      const readNow = (plan.seedPagesRead ?? 0) + (plan.rounds ?? []).reduce((n, item) => n + item.pagesRead, 0);
      const pageCeiling = Math.min(MAX_SOURCES, budget.pages);
      if (readNow >= pageCeiling) break;

      if (delegations.length === 0) {
        const previous = plan.rounds?.[plan.rounds.length - 1]?.review;
        // A resumed run rebuilds the next round's briefs from the recorded
        // review; a fresh one sends the first team out on the plan itself.
        delegations = previous && round > 1
          ? previous.gaps.map((gap, i) => {
              const objective = plan.objectives.find((item) => item.id === gap.objectiveId);
              return {
                workerId: `w${round}-${i + 1}`,
                objectiveId: gap.objectiveId,
                objective: objective?.question ?? gap.objectiveId,
                whatToFind: `Close this gap: ${gap.reason} Go somewhere the last round did not — a different kind of source, a specific dataset or filing, the field's own vocabulary.`,
                boundaries: "Do not re-read pages the run has already opened unless you need a specific figure from them.",
              };
            })
          : initialDelegations(plan, budget.workers);
      }
      delegations = delegations.slice(0, Math.min(budget.workers, MAX_DELEGATIONS_PER_ROUND));
      if (delegations.length === 0) break;

      /*
       * One budget decision for the whole round, taken BEFORE any worker
       * starts, at the worker's worst case: its whole tool loop at the worker
       * model's own rates, plus a vendor fee per call. It was an ad-hoc
       * formula — a search fee for every third tool call — that reserved about
       * a third of the vendor fees alone and nothing for the model, whose
       * spend only reaches the ledger when the worker returns; a budgeted run
       * could overshoot its ceiling by a full round of worker calls. Without
       * rates (the tests) the vendor fees are the floor.
       */
      const perWorkerEstimate = deps.modelRates?.worker
        ? workerEstimateMicroUsd(budget, deps.modelRates.worker)
        : budget.toolCallsPerWorker * Math.max(SEARCH_FEE_MICRO_USD, PAGE_FETCH_FEE_MICRO_USD) * VENDOR_ESTIMATE_MARGIN;
      // B8: the round is priced with the writer's and the audit's reservation
      // held back, so investigation can never starve the report.
      const affordableWorkers = await affordableCount(current, perWorkerEstimate, delegations.length, writerReserve(plan));
      if (affordableWorkers === 0) break;
      delegations = delegations.slice(0, affordableWorkers);

      const roundStartedAt = deps.now().toISOString();
      const findingsBefore = store.listFindings ? await store.listFindings(current.id, current.userId) : [];
      const citedBefore = new Set(findingsBefore.map((finding) => canonicalUrl(finding.url)));
      const shared = {
        pagesRead: readNow,
        toolCalls: 0,
        pageCeiling,
        resultsPerQuery: budget.resultsPerQuery,
        queries: [] as string[],
        unreadable: new Set((plan.unreadable ?? []).map((url) => canonicalUrl(url))),
      };
      // URLs with text, for the brief; by URL and length only, since the
      // snapshots themselves are not needed to tell a worker what to skip.
      const visited = store.listSourceUrls
        ? (await store.listSourceUrls(current.id, current.userId)).filter((source) => source.snapshotChars > 0).map((source) => source.url)
        : (await store.listSources(current.id, current.userId)).filter((source) => source.snapshot).map((source) => source.url);
      const recentQueries = [...(plan.issuedQueries ?? []), ...(plan.workerQueries ?? [])].slice(-24);
      const roundDeadline = Date.now() + Math.min(budget.workerWallClockMs, Math.max(30_000, budget.wallClockMs - investigationElapsedMs(plan, deps.now())));

      await append(current.id, current.userId, [
        ...delegations.map((delegation) => ({
          kind: "worker_spawned" as const,
          payload: {
            workerId: delegation.workerId,
            round,
            objectiveId: delegation.objectiveId,
            objective: delegation.objective,
            whatToFind: delegation.whatToFind.slice(0, 400),
          },
        })),
      ]);

      // Workers run in parallel up to the tier's width; the heartbeat keeps the
      // lease alive underneath them, since a round comfortably outlives it.
      const pulse = setInterval(() => void heartbeat?.().catch(() => undefined), heartbeatMs);
      let settled: Awaited<ReturnType<typeof runAll<ResearchDelegation, WorkerResult>>>;
      try {
        settled = await runAll(
          delegations,
          budget.workers,
          async (delegation) => {
            const tools = bindWorkerTools(
              current,
              delegation.workerId,
              round,
              delegation.objectiveId,
              shared,
              { maxToolCalls: budget.toolCallsPerWorker, deadline: roundDeadline },
              signal
            );
            return deps.runWorker!({
              userId: current.userId,
              brief: {
                delegation,
                round,
                goal: current.goal,
                brief: researchBriefText(plan),
                constraints: plan.constraints,
                visited,
                recentQueries,
                ...(plan.today ? { today: plan.today } : {}),
              },
              tools,
              limits: { maxToolCalls: budget.toolCallsPerWorker, wallClockMs: Math.max(30_000, roundDeadline - Date.now()) },
              signal,
            });
          },
          signal
        );
      } finally {
        clearInterval(pulse);
      }
      ranARound = true;

      const reports: ReviewRoundInput["workerReports"] = [];
      let roundTokens = 0;
      let roundCalls = 0;
      /** Why each worker stopped, for the all-failed check after the loop. */
      const roundResults: WorkerResult["reason"][] = [];
      for (let i = 0; i < delegations.length; i += 1) {
        const delegation = delegations[i]!;
        const outcome = settled[i]!;
        const result: WorkerResult = outcome.ok
          ? outcome.value
          : { summary: "", openQuestions: [], followUps: [], tokens: 0, costMicroUsd: 0, reason: "error", toolCalls: 0, elapsedMs: 0 };
        roundTokens += result.tokens;
        roundCalls += result.toolCalls;
        roundResults.push(result.reason);
        await bill(current, result.costMicroUsd, "worker");
        reports.push({
          workerId: delegation.workerId,
          objectiveId: delegation.objectiveId,
          summary: result.summary,
          openQuestions: result.openQuestions,
          followUps: result.followUps,
        });
        await append(current.id, current.userId, [
          {
            kind: "worker_finished",
            payload: {
              workerId: delegation.workerId,
              round,
              objectiveId: delegation.objectiveId,
              reason: result.reason,
              toolCalls: result.toolCalls,
              tokens: result.tokens,
              ms: result.elapsedMs,
              summary: result.summary.slice(0, 600),
              openQuestions: result.openQuestions.slice(0, 4),
            },
          },
        ]);
      }
      workerTokens.used += roundTokens;

      /*
       * EVERY WORKER FAILED TO START — stop, and say so.
       *
       * `model_unavailable` is `runResearchWorker` reporting that it could not
       * build an adapter at all: no configured provider serves a model this
       * loop can drive. That is a deployment fact, so it will be just as true
       * for round two and round three; without this the run walked the whole
       * ladder spawning workers that returned instantly, reviewed rounds with
       * no findings in them, and ended with a report written from the seed
       * sweep alone — which is a shallow run that never once said why.
       *
       * An `error` reason is NOT this case: that is a worker whose model call
       * failed mid-loop, which is worth retrying in the next round.
       */
      if (roundResults.length > 0 && roundResults.every((reason) => reason === "model_unavailable")) {
        await append(current.id, current.userId, [
          {
            kind: "error",
            payload: {
              stage: "investigating",
              recoverable: true,
              message:
                "No configured model can run a research worker, so this run gathered sources without the agent team. Configure a provider with an agentic chat model for a full investigation.",
            },
          },
        ]);
        break;
      }
      /*
       * EVERY WORKER STAYED IDLE — the same shape as above, one layer up. An
       * `idle` worker had a model but never called a tool: it answered every
       * turn in prose through every nudge. A whole round of that has produced
       * nothing to review, and a model that ignores its tools once will do it
       * again next round, so the ladder stops here and says so rather than
       * paying to review empty rounds while the timeline shows each worker
       * as "done".
       */
      if (roundResults.length > 0 && roundResults.every((reason) => reason === "idle")) {
        await append(current.id, current.userId, [
          {
            kind: "error",
            payload: {
              stage: "investigating",
              recoverable: true,
              message:
                "Every research worker in this round answered in prose without searching or opening a page, so the round produced no findings. The report is written from the sources gathered so far.",
            },
          },
        ]);
        break;
      }

      const findings = store.listFindings ? await store.listFindings(current.id, current.userId) : [];
      const roundFindings = findings.filter((finding) => finding.round === round);
      const newClaims = roundFindings.filter((finding) => !citedBefore.has(canonicalUrl(finding.url))).length;

      // The lead reviews the round — on its model when the ceiling can cover
      // the call, and deterministically when it cannot, rather than skipping
      // the review or auditing on credit.
      const latestPlan = parsePlan(((await store.loadRun(current.id, current.userId)) ?? current).plan);
      const reviewInput: ReviewRoundInput = {
        userId: current.userId,
        goal: current.goal,
        brief: researchBriefText(latestPlan),
        constraints: latestPlan.constraints,
        objectives: latestPlan.objectives,
        findings,
        workerReports: reports,
        round,
        roundsLeft: totalRounds - round,
        pagesLeft: Math.max(0, pageCeiling - shared.pagesRead),
        previous: latestPlan.rounds?.[latestPlan.rounds.length - 1]?.review,
        ...(latestPlan.today ? { today: latestPlan.today } : {}),
        ...(latestPlan.envelope?.leadModel ? { leadModelId: latestPlan.envelope.leadModel } : {}),
        signal,
      };
      const leadAffordable =
        !deps.modelRates?.lead || (await affordable(current, reviewEstimateMicroUsd(deps.modelRates.lead)));
      let review: ReviewRoundOutput;
      try {
        review =
          deps.reviewRound && leadAffordable
            ? await beat(() => deps.reviewRound!(reviewInput), heartbeat)
            : fallbackReview(reviewInput);
      } catch (error) {
        console.error("[research] round review failed", { runId: current.id, error });
        review = fallbackReview(reviewInput);
      }
      await bill(current, review.costMicroUsd, "review");

      // Contradictions the lead named become conflicts the report must address.
      const conflicts: ResearchConflict[] = [
        ...(latestPlan.conflicts ?? []),
        ...review.contradictions.map((item, i) => ({
          id: `lead-r${round}-${i + 1}`,
          kind: "contradictory_evidence" as const,
          ...(item.objectiveId ? { objectiveId: item.objectiveId } : {}),
          sourceIds: item.sourceIds,
          description: item.description,
          severity: "medium" as const,
          resolved: false,
        })),
      ];
      for (const item of review.contradictions) {
        await append(current.id, current.userId, [
          { kind: "conflict_found", payload: { kind: "contradictory_evidence", description: item.description, sourceIds: item.sourceIds, round } },
        ]);
      }

      const objectives = latestPlan.objectives.map((objective) => {
        const score = review.coverage[objective.id] ?? 0;
        return {
          ...objective,
          status: score >= COVERAGE_TARGET ? ("covered" as const) : score > 0 ? ("partially_covered" as const) : objective.status,
        };
      });
      const openQuestions: string[] = [];
      const seenQuestions = new Set<string>();
      for (const report of reports) {
        for (const question of report.openQuestions) {
          const key = question.toLowerCase();
          if (seenQuestions.has(key)) continue;
          seenQuestions.add(key);
          openQuestions.push(question);
        }
      }
      const recorded: ResearchRound = {
        round,
        delegations,
        pagesRead: shared.pagesRead - readNow,
        toolCalls: roundCalls || shared.toolCalls,
        tokens: roundTokens,
        claims: roundFindings.length,
        newClaims,
        startedAt: roundStartedAt,
        finishedAt: deps.now().toISOString(),
        review: {
          coverage: review.coverage,
          gaps: review.gaps.map((gap) => ({ objectiveId: gap.objectiveId, reason: gap.reason })),
          contradictions: review.contradictions.length,
          decision: review.decision,
          reason: review.reason,
        },
        ...(openQuestions.length ? { openQuestions: openQuestions.slice(0, MAX_ROUND_OPEN_QUESTIONS) } : {}),
      };
      const rounds = [...(latestPlan.rounds ?? []).filter((item) => item.round !== round), recorded];
      const workerQueries = [...(latestPlan.workerQueries ?? []), ...shared.queries].slice(-MAX_WORKER_QUERIES);
      const saved = await store.savePlan({
        runId: current.id,
        userId: current.userId,
        plan: { ...latestPlan, objectives, conflicts, rounds, ...(workerQueries.length ? { workerQueries } : {}) },
      });
      current = saved ?? current;

      await append(current.id, current.userId, [
        {
          kind: "round_reviewed",
          payload: {
            round,
            decision: review.decision,
            reason: review.reason,
            coverage: review.coverage,
            gaps: review.gaps.map((gap) => ({ objectiveId: gap.objectiveId, reason: gap.reason })),
            contradictions: review.contradictions.length,
            claims: roundFindings.length,
            newClaims,
          },
        },
        {
          kind: "budget_checkpoint",
          payload: {
            round,
            pagesRead: shared.pagesRead,
            pageCeiling,
            toolCalls: roundCalls || shared.toolCalls,
            tokens: workerTokens.used,
            tokenCeiling: budget.tokens,
            elapsedMs: investigationElapsedMs(parsePlan(current.plan), deps.now()),
            wallClockMs: budget.wallClockMs,
            spentMicroUsd: current.costMicroUsd.toString(),
            budgetMicroUsd: current.budgetMicroUsd === null ? null : current.budgetMicroUsd.toString(),
          },
        },
      ]);

      if (review.decision !== "continue" || review.gaps.length === 0) break;
      // Saturation is the lead's call, but the arithmetic backstops it: a
      // round that added almost nothing new is not worth paying for again.
      if (round > 1 && findings.length > 0 && newClaims < findings.length * SATURATION_NEW_CLAIM_SHARE) break;
      delegations = review.gaps.map((gap, i) => {
        const objective = objectives.find((item) => item.id === gap.objectiveId);
        return {
          workerId: `w${round + 1}-${i + 1}`,
          objectiveId: gap.objectiveId,
          objective: objective?.question ?? gap.objectiveId,
          whatToFind: gap.whatToFind,
          boundaries: gap.boundaries,
        };
      });
      round += 1;
    }
    const finished = (await store.loadRun(current.id, current.userId)) ?? current;
    // The workers' pages can be reprints of each other just as the sweep's
    // could; mark them before the corpus is judged and written.
    return { run: ranARound ? await markSyndicatedCopies(finished) : finished };
  };

  /**
   * COVERAGE: persist the evidence matrix and schedule a bounded follow-up.
   *
   * This is intentionally separate from the post-synthesis citation audit. A
   * plan can have plenty of sources and still miss one of its questions; the
   * controller must discover that while there is still budget to search.
   */
  const doCoverage = async (
    runAtStart: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    // A round boundary: guidance queued since the last one takes effect now.
    const run = await applySteering(runAtStart, (parsePlan(runAtStart.plan).rounds?.length ?? 0) + 1);
    const progress = await store.progress(run.id, run.userId);
    const plan = parsePlan(run.plan);
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

    // The lead's latest review, when there is one, decides the statuses and
    // the gaps; the heuristic decides only when no worker round has run.
    const computed = computeCoverage(
      plan,
      await store.listSources(run.id, run.userId),
      plan.rounds?.[plan.rounds.length - 1]?.review
    );
    // Merged, not replaced: the conflicts already on the plan are the lead's
    // contradictions and the syndication groups, and replacing them with the
    // heuristic's exact-hash duplicates here used to erase them one stage
    // before the writer would have seen them.
    const knownConflicts = new Set((plan.conflicts ?? []).map((conflict) => conflict.id));
    const nextPlan: ResearchPlan = {
      ...plan,
      objectives: computed.objectives,
      coverage: computed.coverage,
      conflicts: [
        ...(plan.conflicts ?? []),
        ...computed.conflicts.filter((conflict) => !knownConflicts.has(conflict.id)),
      ].slice(0, MAX_CONFLICTS),
    };
    const round = plan.followUpRound ?? 0;
    const availableSlots = Math.max(0, MAX_PLAN_QUERIES - nextPlan.queries.length);
    /*
     * Ask the model for the follow-ups when there is one wired, and fall back
     * to the templates when there is not.
     *
     * The templates are `"<objective question> primary source evidence"` — a
     * paraphrase of the query that produced the gap, which is why a follow-up
     * round so often came back with the pages the first round had already
     * found. A model that is told which requirement went unmet and what has
     * already been asked can go at the gap from a different direction, which is
     * the entire point of a follow-up. It is billed as `plan` because that is
     * what it is, it is skipped rather than fatal when the budget is tight, and
     * a failure falls through to the templates rather than ending the round.
     */
    const roundLimit = Math.min(MAX_FOLLOW_UP_ROUNDS, Math.max(0, planBudget(plan).rounds - 1));
    let followUps = round < roundLimit ? computed.followUps.slice(0, availableSlots) : [];
    // "Finish now" stops the rounds here (§9.7), and so does a follow-up sweep
    // that would eat the writer's and the audit's reservation (B8).
    if (plan.finishRequestedAt) followUps = [];
    const reserve = writerReserve(plan);
    if (followUps.length > 0 && reserve > 0 && !(await affordable(run, reserve + followUps.length * SEARCH_ESTIMATE_MICRO_USD))) {
      followUps = [];
    }
    if (
      deps.expandQueries &&
      followUps.length > 0 &&
      computed.gaps.length > 0 &&
      (await affordable(run, EXPANSION_ESTIMATE_MICRO_USD + reserve))
    ) {
      const expanded = await beat(
        () =>
          deps.expandQueries!({
            userId: run.userId,
            goal: run.goal,
            gaps: computed.gaps,
            // The sweep's queries and then the workers', newest last, so the
            // expander is told what the team actually tried and not only the
            // seed list it was told about last round.
            alreadyIssued: [...nextPlan.queries, ...(plan.issuedQueries ?? []), ...(plan.workerQueries ?? [])],
            limit: availableSlots,
            signal,
          }),
        heartbeat
      );
      await bill(run, expanded.costMicroUsd, "plan");
      const seen = new Set(nextPlan.queries.map((query) => query.toLowerCase()));
      const fresh = expanded.queries
        .map((query) => query.replace(/\s+/g, " ").trim().slice(0, 400))
        .filter((query) => {
          const key = query.toLowerCase();
          if (query.length < 8 || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, availableSlots);
      if (fresh.length > 0) followUps = fresh;
    }
    await store.savePlan({
      runId: run.id,
      userId: run.userId,
      plan: {
        ...nextPlan,
        queries: [...nextPlan.queries, ...followUps],
        followUpRound: followUps.length > 0 ? round + 1 : round,
      },
    });
    if (followUps.length > 0) {
      await store.recordQueries({
        runId: run.id,
        userId: run.userId,
        queries: [...nextPlan.queries, ...followUps],
      });
    }
    await append(run.id, run.userId, [
      {
        kind: "coverage_matrix_updated",
        payload: {
          objectives: computed.objectives.map((objective) => ({
            id: objective.id,
            question: objective.question,
            status: objective.status,
          })),
          coverage: computed.coverage,
          conflicts: nextPlan.conflicts,
          policyExcluded: computed.policyExcluded,
        },
      },
    ]);
    if (followUps.length > 0) {
      await append(run.id, run.userId, [
        {
          kind: "follow_up_scheduled",
          payload: { round: round + 1, queries: followUps, reason: "coverage_insufficient" },
        },
      ]);
      const searching = await advance(
        (await store.loadRun(run.id, run.userId)) ?? run,
        "investigating"
      );
      return searching ? { kind: "advanced", state: "investigating" } : { kind: "raced" };
    }
    const moved = await advance(run, "synthesizing");
    return moved ? { kind: "advanced", state: "synthesizing" } : { kind: "raced" };
  };

  /**
   * One durable investigation round.
   *
   * The prior engine persisted separate `searching`, `browsing`, and
   * `reading_documents` states. Those are implementation details of a worker
   * round, not user-visible decision points. Keep the proven ingestion code,
   * but execute its three legs under the single `investigating` lease and only
   * expose the handoff to the lead as `reviewing`.
   */
  const doInvestigating = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    const searched = await doSearching(run, signal, heartbeat);
    if (searched.kind === "raced" || searched.kind === "finished" || searched.kind === "blocked") return searched;
    const freshAfterSearch = (await store.loadRun(run.id, run.userId)) ?? run;
    if (freshAfterSearch.state !== "investigating") return { kind: "raced" };

    const browsed = await doBrowsing(freshAfterSearch, signal, heartbeat);
    if (browsed.kind === "raced" || browsed.kind === "finished" || browsed.kind === "blocked") return browsed;
    const freshAfterBrowse = (await store.loadRun(run.id, run.userId)) ?? freshAfterSearch;
    if (freshAfterBrowse.state !== "investigating") return { kind: "raced" };

    return doReading(freshAfterBrowse, signal, heartbeat);
  };

  const doSynthesis = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    // No writer wired in: this is the chat path, where the route streams the
    // report through the user's own model. The job's work is done, and the run
    // waits at `synthesizing` for the caller that asked to be handed the
    // corpus. `drive({ until: "synthesizing" })` is how that caller stops here.
    if (!deps.synthesize) return { kind: "blocked", state: "synthesizing" };
    const plan = parsePlan(run.plan);
    const revisionRound = plan.revisionRound ?? 0;
    const revision =
      revisionRound > 0 && run.report?.trim()
        ? { report: run.report, round: revisionRound }
        : undefined;
    // The corpus is loaded BEFORE the ceiling check, which is the reverse of
    // every other stage here and is the point: synthesis is the one call whose
    // price is set by how much this particular run gathered, and a flat
    // reservation is simultaneously far too much for a three-source run and not
    // half enough for a fifty-source one. `listSources` is a single indexed read
    // and the run is about to make it anyway. Filtered to the citable rows
    // BEFORE the cap, so a readable row past position 250 is not dropped by a
    // slice that counted unread rows ahead of it.
    const sources = citableSources(await store.listSources(run.id, run.userId));
    const estimate = synthesisEstimateMicroUsd(sources, !!revision);
    if (!(await affordable(run, estimate))) {
      return stopForBudget(run, estimate);
    }
    const findings = store.listFindings ? await store.listFindings(run.id, run.userId) : [];
    // The writer is timeboxed to a quarter of the run's clock, six minutes at
    // most, and heartbeats the lease while it writes (B3, R8).
    const timeoutMs = Math.max(60_000, Math.min(WRITER_TIMEBOX_MAX_MS, Math.floor(planBudget(plan).wallClockMs * 0.25)));
    const write = async (corpusScale: number) => {
      const written = await beat(
        () =>
          deps.synthesize!({
            userId: run.userId,
            goal: run.goal,
            plan,
            sources,
            findings,
            signal,
            ...(revision ? { revision } : {}),
            corpusScale,
            timeoutMs,
          }),
        heartbeat
      );
      await bill(run, written.costMicroUsd, "synthesis");
      return written;
    };

    let written = await write(1);
    let parts = writerParts(written.report);
    /*
     * B6: an empty or unusable report is not a report. It used to advance
     * with `report: ""`, skip the audit (nothing to check) and finish
     * `completed` — a finished run with nothing in it. One retry on a corpus
     * packed 30% smaller (the usual cause is a prompt the provider refused or
     * cut short), then the run fails and says why. A revision keeps its
     * audited draft instead, as it always has.
     */
    if (!revision && !isUsableReport(parts.report)) {
      const fresh = (await store.loadRun(run.id, run.userId)) ?? run;
      if (fresh.state !== "synthesizing") return { kind: "raced" };
      const retryEstimate = Math.ceil(estimate * WRITER_RETRY_CORPUS_SCALE);
      if (await affordable(fresh, retryEstimate)) {
        await append(run.id, run.userId, [
          { kind: "error", payload: { scope: "writer", recoverable: true, message: "The report came back empty; writing it again from a smaller corpus." } },
        ]);
        written = await write(WRITER_RETRY_CORPUS_SCALE);
        parts = writerParts(written.report);
      }
      if (!isUsableReport(parts.report)) {
        const latest = (await store.loadRun(run.id, run.userId)) ?? fresh;
        const ended = await finish(latest, "failed", {
          reason: "writer_empty",
          error: "The report could not be written from the sources gathered.",
        });
        return ended ? { kind: "finished", state: "failed" } : { kind: "raced" };
      }
    }
    const fresh = (await store.loadRun(run.id, run.userId)) ?? run;
    if (fresh.state !== "synthesizing") return { kind: "raced" };
    // A failed rewrite must not erase the already audited report.
    const report = parts.report.trim() || revision?.report || "";
    const latestPlan = parsePlan(fresh.plan);
    const planPatch =
      parts.summary || parts.title
        ? {
            ...latestPlan,
            ...(parts.summary ? { summary: parts.summary } : {}),
            ...(parts.title ? { title: parts.title } : {}),
          }
        : undefined;
    const moved = await advance(fresh, "validating_citations", { report, ...(planPatch ? { plan: planPatch } : {}) }, [
      {
        kind: "report_ready",
        payload: { chars: report.length, ...(revision ? { revisionRound } : {}) },
      },
    ]);
    return moved ? { kind: "advanced", state: "validating_citations" } : { kind: "raced" };
  };

  /**
   * VALIDATE: every [n] in the report has to point at a source that exists.
   *
   * A citation to source 14 of a 9-source corpus is the failure this catches,
   * and it is a failure the synthesis model makes often enough to be worth a
   * deterministic check. The validator may repair the draft; the bounded
   * revision branch below then gives the writer one chance to produce a clean
   * replacement before the run becomes terminal.
   */
  const doValidation = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    // The identical list the writer numbered — see `citableSources`. Handing
    // the audit every row put an unread row at index 1 of most runs, and
    // every citation was then judged against a page with no passages.
    const sources = citableSources(await store.listSources(run.id, run.userId));
    let report = run.report ?? "";
    let auditDegraded = false;
    let validation: ResearchValidationResult | null = null;
    if (deps.validateReport && report.trim()) {
      /*
       * The audit is a model stage, so it is gated like one. It used to be the
       * last un-gated cost path in a run: the judge's spend never reached the
       * ledger, so `affordable` could not see it and a run could cross its
       * ceiling by an entire stage — after synthesis, the most expensive call
       * it makes, had already been paid for.
       *
       * A stop here is honest rather than destructive: the draft is already
       * durable (synthesis wrote it into the row on the way in), so the run
       * ends `partially_completed` holding a readable report whose citations
       * nobody checked. The alternative — audit anyway and bill past the
       * ceiling — is the behaviour the column exists to prevent, and silently
       * skipping the audit while reporting `completed` would tell the reader
       * every citation had been verified when none had.
       */
      // A run with an envelope reserved its audit at its own judge budget
      // (B22); older runs keep the audit-wide reservation.
      const auditPlan = parsePlan(run.plan);
      const auditEstimate = auditPlan.envelope ? auditPlan.envelope.reserve.auditMicroUsd : CITATION_AUDIT_ESTIMATE_MICRO_USD;
      if (!(await affordable(run, auditEstimate))) {
        return stopForBudget(run, auditEstimate);
      }
      await append(run.id, run.userId, [{ kind: "citation_audit_started", payload: { sources: sources.length } }]);
      try {
        validation = await beat(
          () =>
            deps.validateReport!({
              userId: run.userId,
              runId: run.id,
              goal: run.goal,
              plan: parsePlan(run.plan),
              report,
              signal,
              sources,
            }),
          heartbeat
        );
        if (validation) {
          report = validation.report;
          // Same path every other stage bills through — `bill` → `addSpend`,
          // one writer. `citation_audit` is not in VENDOR_BILLED_STEPS because
          // the tokens are a model's, not a vendor's, which is the same reason
          // `plan` and `synthesis` are not.
          await bill(run, validation.costMicroUsd ?? 0, "citation_audit");
          await append(run.id, run.userId, [
            {
              kind: "citation_audit_completed",
              payload: validation.summary,
            },
            ...(validation.repaired
              ? [{ kind: "report_repaired" as const, payload: { reason: "citation_validation" } }]
              : []),
          ]);
        } else {
          auditDegraded = true;
          await append(run.id, run.userId, [
            {
              kind: "error",
              payload: {
                scope: "citation_audit",
                message: "Citation validation returned no result; claims remain unverified.",
              },
            },
          ]);
        }
      } catch (error) {
        /*
         * A validator that throws mid-audit loses whatever it had already spent
         * on the judge: the cost rides on the RESULT, and a rejected promise
         * carries no result to carry it. Accepted rather than papered over,
         * because the alternative is a second cost channel (a callback in the
         * deps contract) feeding the same ledger from two directions, which is
         * the shape that lets a stage get billed twice. The exposure is bounded
         * by the reservation already taken above: the ceiling was checked for
         * the whole stage before any of it ran.
         */
        auditDegraded = true;
        await append(run.id, run.userId, [
          {
            kind: "error",
            payload: {
              scope: "citation_audit",
              message: error instanceof Error ? error.message : "Citation validation failed.",
            },
          },
        ]);
      }
    }
    const cited = new Set<number>(citationMarkersOutsideCode(report));
    const dangling = [...cited].filter((n) => n < 1 || n > sources.length);
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

    /*
     * A repaired report is evidence that the writer's first pass was not good
     * enough. Send it back through the same durable synthesis stage once, then
     * validate the replacement again. `revisionRound` lives in the plan JSON so
     * a worker crash between these two transitions cannot reopen an unbounded
     * paid loop. The repaired report is patched together with the state move,
     * so the next worker has a useful draft even if it starts at synthesizing.
     */
    const plan = parsePlan(run.plan);
    const revisionRound = plan.revisionRound ?? 0;
    const shouldRevise =
      !!deps.synthesize &&
      !!validation &&
      report.trim().length > 0 &&
      revisionRound < MAX_REVISION_ROUNDS &&
      (validation.repaired || dangling.length > 0);
    if (shouldRevise && validation) {
      const nextPlan = parsePlan({ ...plan, revisionRound: revisionRound + 1 });
      const moved = await advance(
        run,
        "synthesizing",
        { plan: nextPlan, report },
        [
          {
            kind: "report_revision",
            payload: {
              phase: "requested",
              round: nextPlan.revisionRound,
              reason: "citation_validation",
              danglingCitations: dangling,
              ...validation.summary,
            },
          },
        ]
      );
      return moved ? { kind: "advanced", state: "synthesizing" } : { kind: "raced" };
    }
    const to = (dangling.length > 0 || auditDegraded ? "partially_completed" : "completed") as "completed" | "partially_completed";
    const reason =
      dangling.length > 0 ? "citations_unverified" : auditDegraded ? "citation_audit_degraded" : "completed";
    const error =
      dangling.length > 0
        ? "Some citations in the report do not match a gathered source."
        : auditDegraded
          ? "Citation validation was unavailable; the report is usable but not fully verified."
          : null;

    /*
     * The web completion (§9.6.3, INV-14): the message, its report artifact,
     * the conversation's lastMessageAt, the run's pointer and this terminal
     * move are one transaction, written by `complete`. The events follow it,
     * and `run_completed` tells the panel which message now holds the report.
     */
    if (deps.complete && report.trim()) {
      const completed = await deps.complete({ run, plan: parsePlan(run.plan), report, sources, to, error });
      if (completed.raced) return { kind: "raced" };
      await announceFinish(run, run.state, to, { reason, error }, [
        {
          kind: "run_completed",
          payload: {
            messageId: completed.messageId,
            ...(completed.sourceOrder ? { sourceOrder: completed.sourceOrder } : {}),
          },
        },
      ]);
      return { kind: "finished", state: to };
    }

    const ended = await finish(run, to, { reason, report, error });
    return ended ? { kind: "finished", state: to } : { kind: "raced" };
  };

  const step = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
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
      // Always through `clarifying`, even when it will skip: one place decides
      // whether a run asks, and it is the stage itself rather than a condition
      // duplicated at every caller that starts a run.
      const moved = await advance(run, "clarifying");
      return moved ? { kind: "advanced", state: "clarifying" } : { kind: "raced" };
    }
    if (!isWorkingResearchState(run.state)) return { kind: "raced" };
    // Every stage gets the heartbeat (B3): a model call that outlives the
    // lease is a second driver running the same stage and billing it twice.
    switch (run.state) {
      case "clarifying":
        return doClarifying(run, signal, heartbeat);
      case "planning":
        return doPlanning(run, signal, heartbeat);
      case "investigating":
        return doInvestigating(run, signal, heartbeat);
      case "reviewing":
        return doCoverage(run, signal, heartbeat);
      case "synthesizing":
        return doSynthesis(run, signal, heartbeat);
      case "validating_citations":
        return doValidation(run, signal, heartbeat);
    }
  };

  /**
   * The reader's questions as objectives: a row with an id (or the same text)
   * keeps its objective and evidence contract; a reworded one keeps its id
   * and is searched in its new words; a new one gets a fresh id. Order is the
   * reader's, and so is importance.
   */
  const objectivesFromRows = (
    goal: string,
    existing: readonly ResearchPlan["objectives"][number][],
    rows: ReadonlyArray<{ id?: string; question: string }>
  ): { objectives: ResearchPlan["objectives"]; changed: boolean; newQuestions: string[] } => {
    const byId = new Map(existing.map((objective) => [objective.id, objective]));
    const byText = new Map(existing.map((objective) => [objective.question.trim().toLowerCase(), objective]));
    const used = new Set<string>();
    const objectives: ResearchPlan["objectives"] = [];
    const newQuestions: string[] = [];
    let serial = existing.length;
    for (const row of rows) {
      if (objectives.length >= MAX_RESEARCH_OBJECTIVES) break;
      const text = row.question.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
      if (text.length < 3) continue;
      let base = (row.id ? byId.get(row.id) : undefined) ?? byText.get(text.toLowerCase());
      if (base && used.has(base.id)) base = undefined;
      const importance = Math.max(0.5, 1 - objectives.length * 0.1);
      if (base) {
        used.add(base.id);
        const reworded = base.question !== text;
        if (reworded) newQuestions.push(text);
        objectives.push(reworded ? { ...base, question: text, status: "open", importance } : { ...base, importance });
        continue;
      }
      let id = `objective-${(serial += 1)}`;
      while (byId.has(id) || used.has(id)) id = `objective-${(serial += 1)}`;
      used.add(id);
      const [fresh] = buildResearchObjectives(goal, [text]);
      objectives.push({
        ...fresh,
        id,
        importance,
        evidenceRequirements: fresh.evidenceRequirements.map((requirement, i) => ({ ...requirement, id: `${id}-evidence-${i + 1}` })),
      });
      newQuestions.push(text);
    }
    const changed =
      objectives.length !== existing.length ||
      objectives.some((objective, i) => objective.id !== existing[i]?.id || objective.question !== existing[i]?.question);
    return { objectives: objectives.length ? objectives : [...existing], changed: objectives.length ? changed : false, newQuestions };
  };

  /**
   * CONFIRM at the scope card (§9.4): the answers become constraints (as the
   * clarify gate's always did), the questions as the reader left them become
   * the objectives, the scope follows the edit, and the envelope is computed
   * NOW, from that scope, and frozen on the run with its ceiling. A refusal
   * leaves the card where it is and says why.
   */
  const confirmScopedPlan = async (
    run: ResearchRunRow,
    current: ResearchPlan,
    edits: {
      questions?: Array<{ id?: string; question: string }>;
      answers?: Record<string, string>;
      steps?: string[];
      queries?: string[];
      constraints?: string[];
      pinnedSources?: string[];
      now: Date;
    }
  ): Promise<ControlResult> => {
    const sameList = (a: readonly string[], b: readonly string[]) =>
      a.length === b.length && a.every((value, i) => value.trim() === (b[i] ?? "").trim());
    const asked = current.clarifications ?? [];
    const known = new Set(asked.map((question) => question.id));
    const clean = parseClarificationAnswers(edits.answers ?? {});
    const answered: Record<string, string> = { ...(current.clarificationAnswers ?? {}) };
    for (const [id, answer] of Object.entries(clean)) if (known.has(id)) answered[id] = answer;
    const added = asked
      .filter((question) => known.has(question.id) && clean[question.id])
      .map((question) => `${question.question} ${clean[question.id]}`.slice(0, MAX_CONSTRAINT_CHARS));

    // The reader's questions; from a pre-rework gate, its edited steps are the questions.
    const currentQuestions = current.objectives.map((objective) => objective.question);
    const rows =
      edits.questions ??
      (edits.steps && !sameList(edits.steps, currentQuestions) ? edits.steps.map((question) => ({ question })) : undefined);
    let objectives = current.objectives;
    let queries = edits.queries ?? current.queries;
    let edited = edits.queries !== undefined && !sameList(edits.queries, current.queries);
    if (rows) {
      const rebuilt = objectivesFromRows(run.goal, current.objectives, rows);
      if (rebuilt.changed) {
        edited = true;
        objectives = rebuilt.objectives;
        const seen = new Set(queries.map((query) => query.toLowerCase()));
        queries = [...queries, ...rebuilt.newQuestions.filter((question) => !seen.has(question.toLowerCase()))].slice(0, MAX_PLAN_QUERIES);
      }
    }
    const nowIso = edits.now.toISOString();
    const scope: ResearchScope = {
      ...(current.scope ?? { breadth: "broad", freshness: "any", primarySources: false, quick: false }),
      questions: Math.max(1, objectives.length),
    };
    let next: ResearchPlan = {
      ...current,
      objectives,
      queries,
      steps: objectives.map((objective) => objective.question),
      scope,
      constraints: [...(edits.constraints ?? current.constraints), ...added].slice(0, MAX_PLAN_CONSTRAINTS),
      pinnedSources: (edits.pinnedSources ?? current.pinnedSources).slice(0, MAX_PINNED_SOURCES),
      ...(Object.keys(answered).length ? { clarificationAnswers: answered } : {}),
      clarifiedAt: nowIso,
      confirmedAt: nowIso,
      revising: false,
      revisingAt: undefined,
      pendingRevision: undefined,
      ...(edited ? { issuedQueries: [], followUpRound: 0, coverage: [], conflicts: [] } : {}),
    };
    const sized = await sizeFor(run, next, "confirm");
    if (isRefusal(sized)) return { ok: false, state: run.state, reason: "refused", refusal: sized };
    if (sized) next = frozenWith(next, sized);
    const saved = await store.savePlan({ runId: run.id, userId: run.userId, plan: next });
    await store.recordQueries({ runId: run.id, userId: run.userId, queries: next.queries });
    const moved = await advance(saved ?? run, "investigating", sized ? { budgetMicroUsd: BigInt(sized.ceilingMicroUsd) } : undefined, [
      {
        kind: "plan_confirmed",
        payload: { by: "user", queries: next.queries, edited, questions: objectives.length, answered: added.length },
      },
    ]);
    return moved ? { ok: true, state: "investigating" } : { ok: false, state: run.state, reason: "not_awaiting_plan" };
  };

  return {
    async start(input) {
      const createdAt = deps.now();
      const explicitLanguage = input.language?.trim();
      const plan: ResearchPlan = {
        ...EMPTY_PLAN,
        effort: input.effort ?? "standard",
        budget: budgetForEffort(input.effort ?? "standard"),
        confirmation: input.confirmation ?? "required",
        constraints: (input.constraints ?? []).slice(0, MAX_PLAN_CONSTRAINTS),
        pinnedSources: (input.pinnedSources ?? []).slice(0, MAX_PINNED_SOURCES),
        // Frozen at start (§9.3, §9.5): the date line every prompt carries, the
        // requester's zone and locale, the conversation around the request as
        // untrusted reference, and an explicit content language when set.
        today: todayLine(createdAt, input.timeZone),
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
        ...(input.locale ? { locale: input.locale } : {}),
        ...(input.context?.trim() ? { context: input.context.slice(0, MAX_PLAN_CONTEXT_CHARS) } : {}),
        ...(explicitLanguage && explicitLanguage !== "auto" ? { language: explicitLanguage } : {}),
        ...(input.preferredModel ? { preferredLead: input.preferredModel } : {}),
      };
      const created = await store.createRun({
        userId: input.userId,
        goal: input.goal.slice(0, MAX_GOAL_CHARS),
        conversationId: input.conversationId ?? null,
        budgetMicroUsd: input.budgetMicroUsd ?? null,
        plan,
      });
      await append(created.id, created.userId, [
        {
          kind: "run_started",
          payload: {
            goal: created.goal,
            confirmation: plan.confirmation,
            budgetMicroUsd: created.budgetMicroUsd === null ? null : created.budgetMicroUsd.toString(),
          },
        },
      ]);
      return created;
    },

    async drive({ runId, userId, signal, until, workerId, holdLeaseAtUntil }) {
      let run = await store.loadRun(runId, userId);
      if (!run) return null;
      let leaseAnnounced = false;
      let holding = false;
      /**
       * Renews the lease from INSIDE a long stage.
       *
       * The lease was taken once per state-machine step, and a single reading
       * step now dispatches waves of fetches that comfortably outlast
       * RESEARCH_WORKER_LEASE_MS. An expired lease is not a stalled run — it is
       * the sweeper adopting a run that is still being driven, issuing the same
       * queries and billing them a second time. `claimRun` is idempotent for the
       * same owner (its WHERE matches an unheld lease OR one this worker already
       * holds), so calling it mid-stage extends rather than fights.
       */
      const heartbeat = async () => {
        if (!store.claimRun || !workerId) return;
        await store.claimRun({ runId, userId, workerId, leaseMs: RESEARCH_WORKER_LEASE_MS });
      };
      /**
       * Every non-terminal return lets the lease go (B1). A drive that stopped
       * at the plan gate used to keep it for its full two minutes, so the
       * nudge after "Start" — a different owner — could not claim the run, and
       * the person watched a confirmed plan sit still until the PM2 sweep came
       * round. The one exception is the native hand-off, whose caller renews
       * the lease itself while the chat model writes (B2).
       */
      const leave = async (row: ResearchRunRow | null, reason: "until" | "other" = "other"): Promise<ResearchRunRow | null> => {
        if (holding && workerId && store.releaseRun && !(reason === "until" && holdLeaseAtUntil)) {
          await store.releaseRun({ runId, userId, workerId }).catch((error: unknown) => {
            console.error("[research] lease release failed", { runId, error });
          });
        }
        return row;
      };
      for (let i = 0; i < MAX_STEPS; i += 1) {
        if (store.claimRun && workerId) {
          const claimed = await store.claimRun({
            runId,
            userId,
            workerId,
            leaseMs: RESEARCH_WORKER_LEASE_MS,
          });
          // Not claimable: somebody else holds it, or the run moved to a state
          // no driver works in (a pause). Only a lease this drive held earlier
          // is let go, and the release is conditional on the owner anyway.
          if (!claimed) return leave((await store.loadRun(runId, userId)) ?? run);
          holding = true;
          run = claimed;
          if (!leaseAnnounced) {
            await append(run.id, run.userId, [
              {
                kind: "worker_lease_acquired",
                payload: {
                  workerId,
                  leaseUntil: run.workerLeaseUntil?.toISOString() ?? null,
                },
              },
            ]);
            leaseAnnounced = true;
          }
        }
        if (signal?.aborted) return leave(run);
        if (until && run.state === until) return leave(run, "until");
        const outcome = await step(run, signal, heartbeat);
        if (outcome.kind === "finished" || outcome.kind === "blocked") {
          return leave((await store.loadRun(runId, userId)) ?? run);
        }
        const fresh = await store.loadRun(runId, userId);
        if (!fresh) return leave(run);
        // A `raced` outcome is not an error: a pause or a cancel landing
        // mid-step is exactly what it looks like. Reload and let the loop
        // re-decide — the next pass sees `paused` or `cancelled` and stops.
        if (outcome.kind === "raced" && fresh.state === run.state) return leave(fresh);
        run = fresh;
      }
      // MAX_STEPS reached. Something is cycling; stopping with what we have is
      // better than a job that bills forever.
      await finish(run, "partially_completed", {
        reason: "step_limit",
        error: "The run stopped making progress and was halted.",
      });
      return leave(await store.loadRun(runId, userId));
    },

    async decidePlan({ runId, userId, decision, steps, queries, constraints, pinnedSources, questions, answers }) {
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
        // No push (B19): discarding a plan is the person's own decision.
        const ended = await finish(run, "cancelled", { reason: "plan_rejected" });
        return ended
          ? { ok: true, state: "cancelled" }
          : { ok: false, state: run.state, reason: "already_finished" };
      }
      const current = parsePlan(run.plan);
      const now = deps.now();

      /*
       * REVISE (§9.4): the run stays at the gate, busy, while the planner
       * reruns with the reader's edits as input — the card never falls back to
       * a skeleton. Five per run; each is a paid planner call. A revise while
       * one is already in flight is the same request, not a second one.
       */
      if (decision === "revise") {
        if (planIsRevising(current, now)) return { ok: true, state: run.state };
        if ((current.revisions ?? 0) >= MAX_PLAN_REVISIONS) {
          return { ok: false, state: run.state, reason: "revise_limit" };
        }
        const pendingRevision: ResearchPlanRevision = {
          ...(questions?.length ? { questions: questions.map((q) => ({ ...(q.id ? { id: q.id } : {}), question: q.question })) } : {}),
          ...(answers && Object.keys(answers).length ? { answers } : {}),
        };
        const next = parsePlan({
          ...current,
          revising: true,
          revisingAt: now.toISOString(),
          revisions: (current.revisions ?? 0) + 1,
          ...(pendingRevision.questions || pendingRevision.answers ? { pendingRevision } : {}),
        });
        await store.savePlan({ runId, userId, plan: next });
        await append(runId, userId, [
          { kind: "plan_revision_requested", payload: { revision: next.revisions ?? 1, questions: questions?.length ?? null } },
        ]);
        return { ok: true, state: run.state };
      }

      const sameList = (a: readonly string[], b: readonly string[]) =>
        a.length === b.length && a.every((value, i) => value.trim() === (b[i] ?? "").trim());

      if (current.scope || questions || answers) {
        return confirmScopedPlan(run, current, { questions, answers, steps, queries, constraints, pinnedSources, now });
      }

      const editedQueries = queries ?? current.queries;
      const editedSteps = steps ?? current.steps ?? [];
      // An edit is a CHANGE, not a round trip. The gate posts the lists back
      // whether or not the user touched them, and rebuilding the evidence
      // contract on an untouched plan threw away the planner's structured
      // objectives — the sub-questions, their rationale and their evidence
      // requirements — for the mechanical one-objective-per-line fallback.
      const planEdit =
        (queries !== undefined && !sameList(queries, current.queries)) ||
        (steps !== undefined && !sameList(steps, current.steps ?? []));
      /*
       * WHAT THE EVIDENCE CONTRACT IS REBUILT FROM, and why steps win.
       *
       * A confirmed plan may be edited before any paid work starts, and the
       * objectives have to be rebuilt from the edit or coverage and follow-ups
       * keep pursuing the draft the user just discarded. What changed is which
       * text they are built from: the steps are the plan the user actually read
       * and rewrote, and they are written as questions about the subject, while
       * the queries are search strings. Objectives built from search strings
       * gave the coverage pass targets like "claude max vs chatgpt pro price"
       * to satisfy — an objective that is really a keyword bag, which is why an
       * edited step used to change the label on the gate and nothing else.
       * Steps first, queries as the fallback for plans that have none.
       */
      const objectiveSource = editedSteps.length ? editedSteps : editedQueries;
      const edited: ResearchPlan = parsePlan({
        ...current,
        ...(editedSteps.length ? { steps: editedSteps } : {}),
        queries: editedQueries,
        ...(planEdit
          ? {
              objectives: buildResearchObjectives(run.goal, objectiveSource),
              issuedQueries: [],
              followUpRound: 0,
              coverage: [],
              conflicts: [],
            }
          : {}),
        constraints: constraints ?? current.constraints,
        pinnedSources: pinnedSources ?? current.pinnedSources,
        confirmedAt: now.toISOString(),
      });
      const saved = await store.savePlan({ runId, userId, plan: edited });
      await store.recordQueries({ runId, userId, queries: edited.queries });
      const moved = await advance(saved ?? run, "investigating", undefined, [
        {
          kind: "plan_confirmed",
          payload: { by: "user", queries: edited.queries, edited: planEdit },
        },
      ]);
      return moved
        ? { ok: true, state: "investigating" }
        : { ok: false, state: run.state, reason: "not_awaiting_plan" };
    },

    async revisePlan({ runId, userId, signal }) {
      const run = await store.loadRun(runId, userId);
      if (!run) return { ok: false, state: "", reason: "not_found" };
      if (run.state !== "awaiting_plan_confirmation") return { ok: false, state: run.state, reason: "not_awaiting_plan" };
      const plan = parsePlan(run.plan);
      if (!plan.revising || !deps.draftPlan) return { ok: true, state: run.state };
      const asked = plan.clarifications ?? [];
      const revision = revisionForPlanner(plan.pendingRevision ?? {}, asked);
      let drafted: PlannerDraft;
      try {
        drafted = await deps.draftPlan({
          userId,
          goal: run.goal,
          context: plan.context ?? null,
          constraints: plan.constraints,
          pinnedSources: plan.pinnedSources,
          dateLine: plan.today ?? todayLine(run.createdAt, plan.timeZone),
          languageName: plan.language ? languageName(plan.language) : null,
          revision,
          leadModel: plan.envelope?.leadModel ?? null,
          signal,
        });
      } catch (error) {
        console.error("[research] plan revision failed", { runId, error });
        drafted = { ok: false, reason: "planner_invalid", costMicroUsd: 0 };
      }
      await bill(run, drafted.costMicroUsd, "plan");

      // The person may have started, discarded or re-asked while the planner
      // ran; whatever they did last wins, and this revision is dropped.
      const latest = await store.loadRun(runId, userId);
      if (!latest || latest.state !== "awaiting_plan_confirmation") {
        return { ok: false, state: latest?.state ?? "", reason: "not_awaiting_plan" };
      }
      const latestPlan = parsePlan(latest.plan);
      if (!latestPlan.revising) return { ok: true, state: latest.state };
      const settled = { ...latestPlan, revising: false, revisingAt: undefined, pendingRevision: undefined };
      if (!drafted.ok) {
        await store.savePlan({ runId, userId, plan: settled });
        await append(runId, userId, [
          {
            kind: "error",
            payload: { scope: "planner", recoverable: true, message: "The plan could not be revised. The previous plan is still here." },
          },
        ]);
        return { ok: true, state: latest.state };
      }
      const keepIds = (plan.pendingRevision?.questions ?? []).map((q) => q.id);
      const planned = plannedResearch(drafted.output, { keepIds });
      const known = new Set(asked.map((c) => c.id));
      const kept = Object.fromEntries(Object.entries(plan.pendingRevision?.answers ?? {}).filter(([id]) => known.has(id)));
      let next: ResearchPlan = {
        ...settled,
        ...(planned.title ? { title: planned.title } : {}),
        ...(planned.approach ? { approach: planned.approach } : {}),
        steps: planned.objectives.map((objective) => objective.question),
        objectives: planned.objectives,
        queries: planned.queries,
        clarifications: planned.clarifications,
        ...(planned.sourceKinds.length ? { sourceKinds: planned.sourceKinds } : {}),
        scope: planned.scope,
        ...(Object.keys(kept).length ? { clarificationAnswers: { ...(latestPlan.clarificationAnswers ?? {}), ...kept } } : {}),
        draftedAt: deps.now().toISOString(),
      };
      const preview = await sizeFor(latest, next, "preview");
      next = { ...next, estimateCaps: preview && !isRefusal(preview) ? preview.caps : legacyEstimateCaps(next) };
      await store.savePlan({ runId, userId, plan: next });
      await store.recordQueries({ runId, userId, queries: next.queries });
      await append(runId, userId, [
        {
          kind: "plan_revised",
          payload: { revision: next.revisions ?? 1, objectives: next.objectives.length, queries: next.queries.length, ...(next.title ? { title: next.title } : {}) },
        },
      ]);
      return { ok: true, state: latest.state };
    },

    async requestFinish({ runId, userId }) {
      const run = await store.loadRun(runId, userId);
      if (!run) return { ok: false, state: "", reason: "not_found" };
      if (isTerminalResearchState(run.state)) return { ok: false, state: run.state, reason: "already_finished" };
      // Already writing: nothing left to stop (§9.4).
      if (run.state === "synthesizing" || run.state === "validating_citations") return { ok: true, state: run.state };
      if (!isWorkingResearchState(run.state) && run.state !== "paused" && run.state !== "accepted") {
        return { ok: false, state: run.state, reason: "not_running" };
      }
      const plan = parsePlan(run.plan);
      if (!plan.finishRequestedAt) {
        await store.savePlan({ runId, userId, plan: { ...plan, finishRequestedAt: deps.now().toISOString() } });
        await append(runId, userId, [{ kind: "finish_requested", payload: { state: run.state } }]);
      }
      return { ok: true, state: run.state };
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
    async answerClarifications({ runId, userId, answers }) {
      const run = await store.loadRun(runId, userId);
      if (!run) return { ok: false, state: "", reason: "not_found" };
      if (run.state !== "awaiting_clarification") {
        return { ok: false, state: run.state, reason: "not_awaiting_clarification" };
      }
      const plan = parsePlan(run.plan);
      const asked = plan.clarifications ?? [];
      const clean = parseClarificationAnswers(answers);
      // Only answers to questions this run actually asked. A client that posts
      // arbitrary keys must not be able to write arbitrary constraints.
      const known = new Set(asked.map((q) => q.id));
      const kept: Record<string, string> = {};
      for (const [id, answer] of Object.entries(clean)) if (known.has(id)) kept[id] = answer;

      /*
       * THE ANSWERS BECOME CONSTRAINTS, and that is the whole integration.
       *
       * `constraints` is already read by the brief expansion, the planner's
       * request and every worker brief, so an answer that lands there shapes
       * the entire run with no new plumbing. Written as "question — answer"
       * rather than as the bare answer, because a constraint reading "the EU
       * and the UK" tells a worker nothing on its own; it needs the question
       * it answers to mean anything.
       */
      const added = asked
        .filter((q) => kept[q.id])
        .map((q) => `${q.question} ${kept[q.id]}`.slice(0, MAX_CONSTRAINT_CHARS));
      const next: ResearchPlan = {
        ...plan,
        constraints: [...plan.constraints, ...added].slice(0, MAX_PLAN_CONSTRAINTS),
        ...(Object.keys(kept).length ? { clarificationAnswers: kept } : {}),
        clarifiedAt: deps.now().toISOString(),
      };
      await store.savePlan({ runId, userId, plan: next });
      const reloaded = (await store.loadRun(runId, userId)) ?? run;
      const moved = await advance(reloaded, "planning", undefined, [
        {
          kind: "clarification_answered",
          payload: { asked: asked.length, answered: Object.keys(kept).length, skipped: asked.length - Object.keys(kept).length },
        },
      ]);
      return moved
        ? { ok: true, state: "planning" }
        : { ok: false, state: reloaded.state, reason: "not_awaiting_clarification" };
    },
    async steer({ runId, userId, constraint, sourceUrl, guidance }) {
      const run = await store.loadRun(runId, userId);
      if (!run) return { ok: false, state: "", reason: "not_found" };
      if (isTerminalResearchState(run.state)) {
        return { ok: false, state: run.state, reason: "already_finished" };
      }
      /*
       * GUIDANCE (§9.4, §9.7) is queued, not applied: it lands on
       * `plan.steering` and takes effect at the next round boundary, where it
       * becomes a constraint every later brief, review and the writer read.
       * Accepted while the run works or is paused — never at a gate, where
       * the scope card is the place to change the plan.
       */
      if (guidance?.trim()) {
        if (!isWorkingResearchState(run.state) && run.state !== "paused") {
          return { ok: false, state: run.state, reason: "not_running" };
        }
        const queuedPlan = parsePlan(run.plan);
        const entry = { text: guidance.replace(/\s+/g, " ").trim().slice(0, MAX_STEERING_CHARS), appliedAtRound: null, createdAt: deps.now().toISOString() };
        const steering = [...(queuedPlan.steering ?? []), entry].slice(-MAX_STEERING_ENTRIES);
        await store.savePlan({ runId, userId, plan: { ...queuedPlan, steering } });
        await append(runId, userId, [{ kind: "steering_queued", payload: { guidance: entry.text, state: run.state } }]);
        if (!constraint && !sourceUrl) return { ok: true, state: run.state, queued: true };
      }
      const plan = parsePlan((await store.loadRun(runId, userId))?.plan ?? run.plan);
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
        const moved = await advance(run, "investigating");
        if (moved) return { ok: true, state: "investigating" };
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
      // When and from where (B12, B13): the clocks stop counting from here,
      // and resume goes back to a gate, or to the writer, rather than into a
      // paid stage the run had already left. Written after the move, onto the
      // plan as it now stands, so a driver's last save is not overwritten.
      const pausedPlan = parsePlan(moved.plan);
      await store.savePlan({ runId, userId, plan: { ...pausedPlan, pausedAt: deps.now().toISOString(), pausedFrom: run.state } });
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
      const plan = parsePlan(run.plan);
      const progress = await store.progress(runId, userId);
      const from = plan.pausedFrom;
      const lastReview = plan.rounds?.[plan.rounds.length - 1]?.review;
      // B12: back to the gate a person was reading, or to the writer when the
      // run had finished investigating — never a paid re-plan over a plan a
      // person had not yet approved, never another round after "Finish now".
      const to: ResearchState =
        from === "awaiting_clarification" && !plan.clarifiedAt
          ? "awaiting_clarification"
          : resumeStateFor({
              ...progress,
              planDrafted: !!plan.draftedAt && !planIsConfirmed(plan),
              readyToWrite:
                !!plan.finishRequestedAt ||
                from === "synthesizing" ||
                from === "validating_citations" ||
                (from === "reviewing" && lastReview?.decision === "synthesize"),
            });
      // B13: the paused span stops counting against the investigation clock.
      const pausedAt = plan.pausedAt ? Date.parse(plan.pausedAt) : NaN;
      const pausedSpan = Number.isFinite(pausedAt) ? Math.max(0, deps.now().getTime() - pausedAt) : 0;
      const resumedPlan: ResearchPlan = {
        ...plan,
        pausedMs: (plan.pausedMs ?? 0) + pausedSpan,
        pausedAt: undefined,
        pausedFrom: undefined,
      };
      const moved = await store.moveState({ runId, userId, from: ["paused"], to, patch: { plan: resumedPlan } });
      if (!moved) return { ok: false, state: run.state, reason: "not_paused" };
      await append(runId, userId, [
        { kind: "state_changed", payload: { from: "paused", state: to } },
        { kind: "resumed", payload: { actor: "user", state: to } },
      ]);
      return { ok: true, state: to };
    },

    async cancel({ runId, userId, reason }) {
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
          payload: {
            actor: reason === "chat_stopped" ? "chat" : "user",
            from: run.state,
            sources: progress.sourceCount,
            ...(reason ? { reason } : {}),
          },
        },
        { kind: "run_finished", payload: { state: "cancelled", reason: reason ?? "cancelled" } },
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

/** The writer's timebox ceiling (R8): a quarter of the run's clock, never more than this. */
export const WRITER_TIMEBOX_MAX_MS = 6 * 60_000;
/** The corpus share the one retry after an unusable report is packed to (B6). */
export const WRITER_RETRY_CORPUS_SCALE = 0.7;

/**
 * The writer's reply as the run stores it: the report (what the audit checks
 * and the reader reads), and beside it on the plan the summary and title the
 * structured writer puts ahead of it (§9.6.3). A reply with no markers is all
 * report, as every writer's was before.
 */
function writerParts(text: string): { summary: string; title: string; report: string } {
  if (!/<!--\s*juno:(report|summary)/i.test(text)) return { summary: "", title: "", report: text.trim() };
  const parsed = parseWriterOutput(text);
  return { summary: parsed.summary, title: parsed.title, report: parsed.report };
}

/** The run's recorded error when sizing refuses it: the same lines the chat and the API show (§9.9). */
const REFUSAL_ERROR: Record<ResearchBudgetRefusal["reason"], string> = RESEARCH_REFUSAL_COPY.reasons;

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
  "reviewing",
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

/**
 * Citation markers that a reader can actually see.
 *
 * Code fences frequently contain examples such as `const source = "[100]"`.
 * Treating those as report citations creates a false partial-completion result;
 * strip fenced blocks before matching, while allowing the three-digit source
 * indices that deep runs can legitimately produce.
 */
export function citationMarkersOutsideCode(markdown: string): number[] {
  const visible = markdown.replace(/(^|\n)```[\s\S]*?```(?=\n|$)/g, "$1");
  const markers = new Set<number>();
  for (const match of visible.matchAll(/\[(\d{1,3})\]/g)) markers.add(Number(match[1]));
  return [...markers];
}
