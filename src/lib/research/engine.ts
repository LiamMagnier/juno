import {
  EMPTY_PLAN,
  MAX_FOLLOW_UP_ROUNDS,
  MAX_REVISION_ROUNDS,
  MAX_PLAN_CONSTRAINTS,
  MAX_PLAN_QUERIES,
  MAX_PINNED_SOURCES,
  RESEARCH_WORKER_LEASE_MS,
  buildResearchObjectives,
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
  BRIEF_OUTPUT_TOKENS,
  BRIEF_PROMPT_CHARS,
  CORPUS_PER_SOURCE_CHARS,
  CORPUS_PREAMBLE_CHARS,
  EXPANSION_OUTPUT_TOKENS,
  EXPANSION_PROMPT_CHARS,
  modelCallEstimateMicroUsd,
  PAGE_FETCH_FEE_MICRO_USD,
  PLANNER_OUTPUT_TOKENS,
  PLANNER_PROMPT_CHARS,
  REVISION_REPORT_CHARS,
  SEARCH_FEE_MICRO_USD,
  SYNTHESIS_OUTPUT_TOKENS,
  SYSTEM_PROMPT_CHARS,
  VENDOR_ESTIMATE_MARGIN,
  type ResearchEventKind,
  type ResearchCoverageEntry,
  type ResearchConflict,
  type ResearchPlan,
  type ResearchProgress,
  type ResearchState,
  type ResearchTerminalState,
} from "@/lib/research/domain";
import {
  hostOfUrl,
  contentTokens,
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
}

export type ResearchPageResult =
  | { title: string; text: string; costMicroUsd: number; links?: ResearchPageLink[] }
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
    case "http_error":
      return `The site refused the request${page.detail ? ` (${page.detail})` : ""}.`;
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
    default:
      return "Could not be read.";
  }
}

export interface ResearchDeps {
  store: ResearchStore;
  /** Turns the goal (plus any steering constraints) into sub-questions. */
  plan(input: {
    userId: string;
    goal: string;
    constraints: string[];
    signal?: AbortSignal;
  }): Promise<{
    queries: string[];
    /** The plan a person reads at the gate. See `ResearchPlan.steps`. */
    steps?: string[];
    costMicroUsd: number;
    objectives?: ResearchPlan["objectives"];
  }>;
  search(input: { userId: string; query: string; signal?: AbortSignal }): Promise<{
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
  /** Writes the report. Optional: the chat path streams synthesis itself. */
  synthesize?(input: {
    userId: string;
    goal: string;
    plan: ResearchPlan;
    sources: ResearchSourceRow[];
    signal?: AbortSignal;
    /** Present only for the one bounded citation-driven rewrite. */
    revision?: {
      report: string;
      round: number;
    };
  }): Promise<{ report: string; costMicroUsd: number }>;
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
  /** Stable hash of fetched text, so a report stays auditable after the page changes. */
  hash(text: string): string;
  now(): Date;
}

export interface ResearchValidationResult {
  report: string;
  repaired: boolean;
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
const MAX_SOURCES = 250;
/** Sources whose full text is stored as a snapshot. */
const MAX_READ_SOURCES = 250;
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
export const SNAPSHOT_CHARS = 12_000;
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
 * Cheap, deterministic coverage before synthesis. It is deliberately not a
 * claim judge: at this stage there is no report claim to judge. Its job is to
 * stop a plan that has only collected vaguely related pages from declaring
 * itself ready, and to leave a durable matrix the user can inspect.
 */
function computeCoverage(plan: ResearchPlan, sources: ResearchSourceRow[]): CoverageComputation {
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
            strength: tokenCoverage(objective.question, source.snapshot ?? ""),
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
    const status: ResearchPlan["objectives"][number]["status"] =
      statuses.length > 0 && statuses.every((value) => value === "satisfied")
        ? "covered"
        : statuses.some((value) => (value as string) === "conflicted")
        ? "blocked"
        : statuses.some((value) => value === "satisfied" || value === "weak")
        ? "partially_covered"
        : "open";
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
    const entry = coverage.find(
      (item) => item.objectiveId === objective.id && (item.status === "missing" || item.status === "weak")
    );
    if (!entry) continue;
    gaps.push({
      question: objective.question,
      status: entry.status,
      ...(entry.missingReason ? { missingReason: entry.missingReason } : {}),
    });
    const suffix = entry.status === "missing" ? "primary source evidence" : "independent source and counter evidence";
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
    /** Stable process identity used to fence concurrent/restarted workers. */
    workerId?: string;
    /** Stop cleanly once the run enters this state, leaving it live. */
    until?: ResearchState;
  }): Promise<ResearchRunRow | null>;
  decidePlan(input: {
    runId: string;
    userId: string;
    decision: "confirm" | "cancel";
    /** The plan as the user left it at the gate. See `ResearchPlan.steps`. */
    steps?: string[];
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

  /**
   * How many of `wanted` calls at `unit` each the run can still pay for.
   *
   * The whole point of dispatching a wave is that `affordable` is checked ONCE,
   * before any of it goes out. Checking per call and then firing them in
   * parallel is not a ceiling: eight requests already in flight against a budget
   * with room for two is an overshoot no later check can undo. One read of the
   * live spend, then arithmetic.
   */
  const affordableCount = async (run: ResearchRunRow, unit: number, wanted: number): Promise<number> => {
    if (wanted <= 0) return 0;
    const fresh = await store.loadRun(run.id, run.userId);
    const spent = fresh?.costMicroUsd ?? run.costMicroUsd;
    const budget = fresh?.budgetMicroUsd ?? run.budgetMicroUsd;
    let n = wanted;
    while (n > 0 && !budgetAllows(spent, budget, unit * n)) n -= 1;
    return n;
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
    const objectives = drafted.objectives?.length
      ? drafted.objectives
      : buildResearchObjectives(run.goal, queries);
    const next: ResearchPlan = {
      ...plan,
      // Absent rather than empty when the planner gave none — the gate reads
      // "no steps" as "fall back to the query list", which is what every plan
      // drafted before steps existed does.
      ...(drafted.steps?.length ? { steps: drafted.steps } : {}),
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

  const doSearching = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    const plan = parsePlan(run.plan);
    const queries = plan.queries.length ? plan.queries : [run.goal];
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
      if (!fresh || fresh.state !== "searching") return { kind: "raced" };
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
          result: await deps.search({ userId: run.userId, query, signal }),
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
  const doBrowsing = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    const plan = parsePlan(run.plan);
    let current = run;
    for (const url of plan.pinnedSources.slice(0, MAX_PINNED_SOURCES)) {
      if (!(await affordable(current, READ_ESTIMATE_MICRO_USD))) {
        return stopForBudget(current, READ_ESTIMATE_MICRO_USD);
      }
      const fresh = await store.loadRun(current.id, current.userId);
      if (!fresh || fresh.state !== "browsing") return { kind: "raced" };
      current = fresh;
      await heartbeat?.();

      const page = await deps.fetchPage({ userId: run.userId, url, signal });
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
      const score = scoreSource({ url, text });
      const stored = await store.upsertSource({
        runId: run.id,
        userId: run.userId,
        url,
        title: page.title || url,
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
    const moved = await advance(current, "reading_documents");
    return moved ? { kind: "advanced", state: "reading_documents" } : { kind: "raced" };
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
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<{ run: ResearchRunRow; outcome?: StepOutcome; added: number; fetched: number; passages: number }> => {
    const room = Math.min(MAX_HOP_SOURCES, MAX_SOURCES - existing.length);
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
      if (!fresh || fresh.state !== "reading_documents") return { run: current, outcome: { kind: "raced" }, added, fetched, passages };
      current = fresh;
      await heartbeat?.();

      const allowed = await affordableCount(current, READ_ESTIMATE_MICRO_USD, wave.length);
      if (allowed === 0) break;

      const dispatched = wave.slice(0, allowed);
      const pages = await Promise.all(
        dispatched.map(async (target) => ({
          target,
          page: await deps.fetchPage({ userId: run.userId, url: target.href, signal }),
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
        const score = scoreSource({ url: target.href, text });
        const stored = await store.upsertSource({
          runId: run.id,
          userId: run.userId,
          url: target.href,
          title: page.title || target.text || target.href,
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

    const targets = sources.slice(0, MAX_READ_SOURCES);
    for (const wave of waves(targets, READ_CONCURRENCY)) {
      const fresh = await store.loadRun(current.id, current.userId);
      if (!fresh || fresh.state !== "reading_documents") return { kind: "raced" };
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
          pages.set(job.source.id, await deps.fetchPage({ userId: run.userId, url: job.source.url, signal }));
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
            }
            continue;
          }
          await bill(current, page.costMicroUsd, "fetch");
          text = page.text.slice(0, SNAPSHOT_CHARS);
          const score = scoreSource({ url: job.source.url, text, publishedAt: job.source.publishedAt });
          await store.upsertSource({
            runId: run.id,
            userId: run.userId,
            url: job.source.url,
            title: page.title || job.source.title,
            publishedAt: job.source.publishedAt,
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
          const score = scoreSource({ url: job.source.url, text, publishedAt: job.source.publishedAt });
          await store.upsertSource({
            runId: run.id,
            userId: run.userId,
            url: job.source.url,
            title: page.title || job.source.title,
            publishedAt: job.source.publishedAt,
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

    const hop = await doLinkHop(current, sources, discovered, signal, heartbeat);
    if (hop.outcome) return hop.outcome;
    current = hop.run;
    fetched += hop.fetched;
    passages += hop.passages;

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
    const moved = await advance(current, "checking_coverage");
    return moved ? { kind: "advanced", state: "checking_coverage" } : { kind: "raced" };
  };

  /**
   * COVERAGE: persist the evidence matrix and schedule a bounded follow-up.
   *
   * This is intentionally separate from the post-synthesis citation audit. A
   * plan can have plenty of sources and still miss one of its questions; the
   * controller must discover that while there is still budget to search.
   */
  const doCoverage = async (run: ResearchRunRow, signal?: AbortSignal): Promise<StepOutcome> => {
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

    const computed = computeCoverage(plan, await store.listSources(run.id, run.userId));
    const nextPlan: ResearchPlan = {
      ...plan,
      objectives: computed.objectives,
      coverage: computed.coverage,
      conflicts: computed.conflicts,
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
    let followUps = round < MAX_FOLLOW_UP_ROUNDS ? computed.followUps.slice(0, availableSlots) : [];
    if (
      deps.expandQueries &&
      followUps.length > 0 &&
      computed.gaps.length > 0 &&
      (await affordable(run, EXPANSION_ESTIMATE_MICRO_USD))
    ) {
      const expanded = await deps.expandQueries({
        userId: run.userId,
        goal: run.goal,
        gaps: computed.gaps,
        alreadyIssued: [...nextPlan.queries, ...(plan.issuedQueries ?? [])],
        limit: availableSlots,
        signal,
      });
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
          conflicts: computed.conflicts,
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
        "searching"
      );
      return searching ? { kind: "advanced", state: "searching" } : { kind: "raced" };
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
    // and the run is about to make it anyway.
    const sources = (await store.listSources(run.id, run.userId)).slice(0, MAX_SOURCES);
    const estimate = synthesisEstimateMicroUsd(sources, !!revision);
    if (!(await affordable(run, estimate))) {
      return stopForBudget(run, estimate);
    }
    const written = await deps.synthesize({
      userId: run.userId,
      goal: run.goal,
      plan,
      sources,
      signal,
      ...(revision ? { revision } : {}),
    });
    await bill(run, written.costMicroUsd, "synthesis");
    const fresh = (await store.loadRun(run.id, run.userId)) ?? run;
    if (fresh.state !== "synthesizing") return { kind: "raced" };
    // A failed rewrite must not erase the already audited report. Initial
    // synthesis keeps its historical behavior (an empty writer result remains
    // empty), while a revision falls back to the evidence-backed draft.
    const report = written.report.trim() || revision?.report || "";
    const moved = await advance(fresh, "validating_citations", { report }, [
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
  const doValidation = async (run: ResearchRunRow, signal?: AbortSignal): Promise<StepOutcome> => {
    const sources = await store.listSources(run.id, run.userId);
    let report = run.report ?? "";
    let auditDegraded = false;
    let validation: ResearchValidationResult | null = null;
    if (deps.validateReport && report.trim()) {
      await append(run.id, run.userId, [{ kind: "citation_audit_started", payload: { sources: sources.length } }]);
      try {
        validation = await deps.validateReport({
          userId: run.userId,
          runId: run.id,
          goal: run.goal,
          plan: parsePlan(run.plan),
          report,
          signal,
          sources,
        });
        if (validation) {
          report = validation.report;
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
    const to: ResearchTerminalState = dangling.length > 0 || auditDegraded ? "partially_completed" : "completed";
    const ended = await finish(run, to, {
      reason:
        dangling.length > 0 ? "citations_unverified" : auditDegraded ? "citation_audit_degraded" : "completed",
      report,
      error:
        dangling.length > 0
          ? "Some citations in the report do not match a gathered source."
          : auditDegraded
            ? "Citation validation was unavailable; the report is usable but not fully verified."
            : null,
    });
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
      const moved = await advance(run, "planning");
      return moved ? { kind: "advanced", state: "planning" } : { kind: "raced" };
    }
    if (!isWorkingResearchState(run.state)) return { kind: "raced" };
    switch (run.state) {
      case "planning":
        return doPlanning(run, signal);
      case "searching":
        return doSearching(run, signal, heartbeat);
      case "browsing":
        return doBrowsing(run, signal, heartbeat);
      case "reading_documents":
        return doReading(run, signal, heartbeat);
      case "checking_coverage":
        return doCoverage(run, signal);
      case "resolving_conflicts":
        return doConflicts(run);
      case "synthesizing":
        return doSynthesis(run, signal);
      case "validating_citations":
        return doValidation(run, signal);
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

    async drive({ runId, userId, signal, until, workerId }) {
      let run = await store.loadRun(runId, userId);
      if (!run) return null;
      let leaseAnnounced = false;
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
      for (let i = 0; i < MAX_STEPS; i += 1) {
        if (store.claimRun && workerId) {
          const claimed = await store.claimRun({
            runId,
            userId,
            workerId,
            leaseMs: RESEARCH_WORKER_LEASE_MS,
          });
          if (!claimed) return (await store.loadRun(runId, userId)) ?? run;
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
        if (signal?.aborted) return run;
        if (until && run.state === until) return run;
        const outcome = await step(run, signal, heartbeat);
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

    async decidePlan({ runId, userId, decision, steps, queries, constraints, pinnedSources }) {
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
      const editedQueries = queries ?? current.queries;
      const editedSteps = steps ?? current.steps ?? [];
      const planEdit = queries !== undefined || steps !== undefined;
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
