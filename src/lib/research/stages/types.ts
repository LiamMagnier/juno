/*
 * Research engine — the rows, store port, dependencies and page results the
 * engine works with, and the engine's public interface. Split out of engine.ts
 * (docs/rework/program/ORCHESTRATION.md); engine.ts re-exports the public names.
 */
import type { ResearchFootprint } from "@/lib/research/depth";
import type { PlannerDraft } from "@/lib/research/planner";
import type { ResearchBudgetRefusal } from "@/lib/research/envelope";
import type {
  ResearchClarification,
  ResearchEffort,
  ResearchEventKind,
  ResearchModelRates,
  ResearchPlan,
  ResearchProgress,
  ResearchState,
  ResearchTerminalState,
} from "@/lib/research/domain";
import type { ResearchEnvelope, ResearchScope } from "@/types/research";
import type {
  ResearchFindingRow,
  ReviewRoundInput,
  ReviewRoundOutput,
  RunWorkerInput,
  WorkerResult,
} from "@/lib/research/agents/protocol";
import type { ResearchSourceType } from "@/lib/research/claim-analysis";
import type { PrivateSourceKind, PrivateSourceOption, ResearchSourceSelection } from "@/lib/research/private-sources";

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
    case "private_source":
      return "That is one of your own sources; it is read from your account, never fetched.";
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

/**
 * One passage from the person's own sources, ready to store as a source row.
 * `url` is a `https://private.invalid/` address (private-sources.ts); `title` is what it is
 * cited by (file and page, subject and date, event and date).
 */
export interface PrivateResearchHit {
  url: string;
  title: string;
  text: string;
  kind: PrivateSourceKind;
  /** The option it came from (`PrivateSourceOption.key`). */
  optionKey: string;
  /** The record's own date: when the mail was sent, when the event is, when the file was indexed. */
  publishedAt?: Date | null;
}

export interface ResearchDeps {
  store: ResearchStore;
  /**
   * The person's own sources this run could read, offered at the gate.
   * Optional: without it a run reads the web only, exactly as before. Called
   * once, at start; a failure offers nothing rather than failing the start.
   */
  privateSourceOptions?(input: { userId: string; conversationId: string | null }): Promise<PrivateSourceOption[]>;
  /**
   * Searches the ENABLED private sources for the run's questions. Never
   * called with a selection that enables nothing, and never handed a key the
   * run did not offer (the engine intersects). Read-only by contract: the
   * implementation may only call read tools, unattended, so an action that
   * would need approval is refused rather than asked for.
   */
  searchPrivate?(input: {
    userId: string;
    runId: string;
    conversationId: string | null;
    options: PrivateSourceOption[];
    questions: string[];
    selection: ResearchSourceSelection;
    timeZone?: string | null;
    signal?: AbortSignal;
  }): Promise<{ hits: PrivateResearchHit[]; skipped: Array<{ key: string; reason: string }> }>;
  /**
   * Reads the goal back and asks what it does not say. OPTIONAL: a deployment
   * with no clarifier, or a goal that needs nothing, skips straight to
   * planning — the run must never be blocked by a step that cannot run.
   */
  clarify?(input: {
    userId: string;
    goal: string;
    effort: ResearchEffort;
    /** The run's lead model (the envelope's, else the person's choice); absent: the strongest configured. */
    modelId?: string | null;
    signal?: AbortSignal;
  }): Promise<{ questions: ResearchClarification[]; costMicroUsd: number }>;
  /** Turns the goal (plus any steering constraints) into sub-questions. */
  plan(input: {
    userId: string;
    goal: string;
    constraints: string[];
    effort?: import("@/lib/research/domain").ResearchEffort;
    pinnedSources?: string[];
    /** The run's lead model (the envelope's, else the person's choice); absent: the strongest configured. */
    modelId?: string | null;
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
    /** The run's lead model (the envelope's, else the person's choice); absent: the strongest configured. */
    modelId?: string | null;
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
  /**
   * One cheap-model pass per round over the round's findings, for what the
   * deterministic gap audit and lead patterns cannot read: a metric stated
   * in words the normaliser does not fold, and leads in a phrasing or
   * language the patterns miss. Optional, batched (one call per round), only
   * made when there is something ambiguous to read and the ceiling can pay
   * for it with the writer's reserve held back. Its answers only REMOVE gaps
   * (each confirmation must name a finding that carries a figure) and only
   * ADD leads that pass the same dedupe and caps as pattern leads.
   */
  auditAssist?(input: AuditAssistInput): Promise<AuditAssistOutput>;
  /** Writes the report. Optional: the chat path streams synthesis itself. */
  synthesize?(input: {
    userId: string;
    goal: string;
    plan: ResearchPlan;
    sources: ResearchSourceRow[];
    /** What the run found and read, for the methodology (`depth.ts`). */
    footprint?: ResearchFootprint;
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
  }): Promise<{
    report: string;
    costMicroUsd: number;
    /** The model that wrote it, recorded on the plan as `writtenBy`. */
    model?: string;
  }>;
  /**
   * The merged clarify-and-plan call (SPEC §9.5, B5): one structured reply
   * with the questions, up to three optional clarifications, the searches,
   * the source kinds and the scope. When wired it replaces `clarify` and
   * `plan`, and a run never parks at `awaiting_clarification`.
   */
  /**
   * Whether the account's five-hour or weekly usage window is spent
   * (RESEARCH_V2 §6). Asked at round boundaries; true stops the rounds and
   * the run writes with what it has. Optional: without it nothing is asked.
   */
  windowSpent?(input: { userId: string; runId: string }): Promise<boolean>;
  draftPlan?(input: {
    userId: string;
    goal: string;
    /** The conversation before the request, already wrapped as untrusted (B20). */
    context?: string | null;
    constraints: string[];
    pinnedSources: string[];
    /** The person's own sources switched on for this run, by name, so vectors can target them. */
    privateSources?: string[];
    /** `plan.today`. */
    dateLine: string;
    /** The explicit content language, as a name ("French"), when there is one. */
    languageName?: string | null;
    /** The reader's edits at the gate, for a revision. */
    revision?: { questions: string[]; answers: Array<{ question: string; answer: string }> } | null;
    /** The lead model the run was sized for, when it has been. */
    leadModel?: string | null;
    /**
     * The model the person chose in the composer, for a run not sized yet:
     * the planner runs on it when the account can use it.
     */
    preferredLead?: string | null;
    signal?: AbortSignal;
    /** Each step down the planner's ladder (F3, F4), for the live narration. */
    onFallback?: (step: "second_model" | "lines") => Promise<void> | void;
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
  /** `background`: an app's chat handed the run off and ended (§9.6.1) — see `ResearchPlan.delivery`. */
  delivery?: "background";
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
    /** The sources the reader left switched on at the gate. Only offered keys apply. */
    sources?: { web?: boolean; enabled?: string[] };
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

/** What the per-round audit assist reads (`ResearchDeps.auditAssist`). */
export interface AuditAssistInput {
  userId: string;
  goal: string;
  /** The report's language, for the leads' wording. */
  language?: string | null;
  /** Each vector and the figures the deterministic audit could not find. */
  objectives: Array<{ id: string; question: string; missing: string[] }>;
  /** Numbered findings: this round's, plus earlier ones on vectors with a missing figure. */
  findings: Array<{ index: number; objectiveId: string | null; claim: string; quote: string; url: string }>;
  /** Searches already made, so leads do not repeat them. */
  issued: string[];
  /** The run's researcher model, frozen on its envelope; absent on older runs. */
  modelId?: string;
  signal?: AbortSignal;
}

export interface AuditAssistOutput {
  /** A missing metric that finding `finding` does state. */
  confirmed: Array<{ objectiveId: string; metric: string; finding: number }>;
  /** A micro-query a finding opens. */
  leads: Array<{ objectiveId: string; query: string; signal: string; finding: number }>;
  costMicroUsd: number;
}
