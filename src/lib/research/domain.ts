/**
 * The durable research vocabulary.
 *
 * Every state, event kind and stage a research run can be in is declared once
 * here, exactly as `src/lib/work/domain.ts` does for Work. The Prisma columns
 * holding them are TEXT; this file is what makes them a type.
 *
 * Deliberately free of `server-only`, Prisma and SDK imports. The engine, the
 * route handlers, the client panel and the tests all need this vocabulary, and
 * two of those four cannot import a Prisma client. It is also why the state
 * machine itself lives here rather than next to the persistence: a transition
 * table you cannot exercise without a database is a transition table nobody
 * tests, and the whole point of this slice is that the transitions are law.
 */

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/**
 * The states a run passes through while it is still going.
 *
 * The order of the working states below is the pipeline order, and
 * `PIPELINE` depends on it — a state inserted in the wrong place here silently
 * changes what a resumed run does next. The list is the one written into the
 * `ResearchRun.state` schema comment; it is reproduced rather than referenced
 * because Prisma comments are not values.
 */
export const RESEARCH_WORKING_STATES = [
  "planning",
  "searching",
  "browsing",
  "reading_documents",
  "checking_coverage",
  "resolving_conflicts",
  "synthesizing",
  "validating_citations",
] as const;

/**
 * States that cannot progress without a human.
 *
 * Kept apart from the working states because the difference decides whether a
 * driver should pick the run up. A driver that treats `awaiting_plan_confirmation`
 * as work to do starts spending money on a plan the user has not agreed to,
 * which is the single failure this slice exists to prevent.
 */
export const RESEARCH_BLOCKED_STATES = [
  /** Drafted a plan and stopped, because the next step costs real money. */
  "awaiting_plan_confirmation",
  /** Stopped to ask the user something it cannot decide alone. */
  "awaiting_user_input",
  /** Stopped by the user, resumable. */
  "paused",
] as const;

export const RESEARCH_LIVE_STATES = [
  /** Row exists, nothing has been spent. */
  "accepted",
  ...RESEARCH_WORKING_STATES,
  ...RESEARCH_BLOCKED_STATES,
] as const;

export const RESEARCH_TERMINAL_STATES = [
  "completed",
  /**
   * Stopped early with usable material — the per-run budget ran out, or the
   * user cancelled after sources had landed. Distinct from `failed` because
   * the sources, passages and partial report are all still worth showing, and
   * a UI that calls this a failure throws away work the user paid for.
   */
  "partially_completed",
  "failed",
  "cancelled",
] as const;

export const RESEARCH_STATES = [...RESEARCH_LIVE_STATES, ...RESEARCH_TERMINAL_STATES] as const;

export type ResearchWorkingState = (typeof RESEARCH_WORKING_STATES)[number];
export type ResearchBlockedState = (typeof RESEARCH_BLOCKED_STATES)[number];
export type ResearchLiveState = (typeof RESEARCH_LIVE_STATES)[number];
export type ResearchTerminalState = (typeof RESEARCH_TERMINAL_STATES)[number];
export type ResearchState = (typeof RESEARCH_STATES)[number];

const LIVE = new Set<string>(RESEARCH_LIVE_STATES);
const TERMINAL = new Set<string>(RESEARCH_TERMINAL_STATES);
const WORKING = new Set<string>(RESEARCH_WORKING_STATES);
const BLOCKED = new Set<string>(RESEARCH_BLOCKED_STATES);

export function isResearchState(value: string): value is ResearchState {
  return LIVE.has(value) || TERMINAL.has(value);
}

export function isLiveResearchState(value: string): value is ResearchLiveState {
  return LIVE.has(value);
}

export function isTerminalResearchState(value: string): value is ResearchTerminalState {
  return TERMINAL.has(value);
}

/** True when a driver may pick this run up and spend money on it. */
export function isWorkingResearchState(value: string): value is ResearchWorkingState {
  return WORKING.has(value);
}

/** True when only a person can move the run on. */
export function isBlockedResearchState(value: string): value is ResearchBlockedState {
  return BLOCKED.has(value);
}

/**
 * The happy path, in order. `nextPipelineState` walks it and
 * `resumeStateFor` measures against it.
 */
const PIPELINE: readonly ResearchWorkingState[] = RESEARCH_WORKING_STATES;

/** The state that follows `state` when its work finished cleanly. */
export function nextPipelineState(state: ResearchWorkingState): ResearchWorkingState | "completed" {
  const at = PIPELINE.indexOf(state);
  return at >= 0 && at < PIPELINE.length - 1 ? PIPELINE[at + 1] : "completed";
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Every move the machine allows, as an explicit table.
 *
 * Explicit rather than derived, because the interesting transitions are the
 * ones that are NOT the pipeline: a pause from anywhere live, a resume back to
 * wherever the persisted work had got to, a cancel that must win from every
 * live state, and a budget stop that lands on `partially_completed` from the
 * middle of the pipeline. Deriving those from an ordering produces a machine
 * that is right about the boring cases and quietly wrong about all of them.
 *
 * Terminal states have no outgoing edges at all, and that absence is the
 * property `transitionAllowed` is really enforcing: a late event from a driver
 * that did not notice a cancel must not drag a finished run back to life.
 */
const TRANSITIONS: Record<ResearchState, readonly ResearchState[]> = {
  accepted: ["planning", "paused", "cancelled", "failed"],
  planning: [
    "awaiting_plan_confirmation",
    // Straight past confirmation when the caller pre-confirmed the plan — a
    // chat turn where the user already opted into research per-send.
    "searching",
    "paused",
    "cancelled",
    "failed",
    "partially_completed",
  ],
  awaiting_plan_confirmation: ["planning", "searching", "paused", "cancelled", "failed"],
  searching: [
    "browsing",
    "paused",
    "awaiting_user_input",
    "cancelled",
    "failed",
    "partially_completed",
  ],
  browsing: [
    "reading_documents",
    "paused",
    "awaiting_user_input",
    "cancelled",
    "failed",
    "partially_completed",
  ],
  reading_documents: [
    "checking_coverage",
    // Steering pinned a source mid-run: back to gathering so it is actually
    // fetched, rather than recorded in the plan and never read.
    "searching",
    "paused",
    "awaiting_user_input",
    "cancelled",
    "failed",
    "partially_completed",
  ],
  checking_coverage: [
    "resolving_conflicts",
    // Coverage came back thin: go round again with the queries steering added.
    "searching",
    "paused",
    "awaiting_user_input",
    "cancelled",
    "failed",
    "partially_completed",
  ],
  resolving_conflicts: [
    "synthesizing",
    /** Same steering path as `reading_documents`. */
    "searching",
    "paused",
    "awaiting_user_input",
    "cancelled",
    "failed",
    "partially_completed",
  ],
  synthesizing: ["validating_citations", "paused", "cancelled", "failed", "partially_completed"],
  validating_citations: [
    "completed",
    // The validator can send the report back to be rewritten once.
    "synthesizing",
    "paused",
    "cancelled",
    "failed",
    "partially_completed",
  ],
  awaiting_user_input: [...RESEARCH_WORKING_STATES, "paused", "cancelled", "failed"],
  paused: [...RESEARCH_WORKING_STATES, "cancelled", "failed", "partially_completed"],
  completed: [],
  partially_completed: [],
  failed: [],
  cancelled: [],
};

export function transitionAllowed(from: ResearchState, to: ResearchState): boolean {
  if (from === to) return false;
  return TRANSITIONS[from].includes(to);
}

/** The states a run may be paused from — every live state except `paused`. */
export function isPausable(state: string): boolean {
  return isLiveResearchState(state) && state !== "paused";
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

/** What a run has actually persisted, which is what decides where it resumes. */
export interface ResearchProgress {
  /** The plan has been drafted and confirmed. */
  planConfirmed: boolean;
  queryCount: number;
  sourceCount: number;
  /** Sources with a stored snapshot — the ones actually read, not just found. */
  readCount: number;
  passageCount: number;
  hasReport: boolean;
}

/**
 * Where a run picks up, computed from what is on disk rather than remembered.
 *
 * This is one mechanism doing two jobs on purpose. A user pressing Resume and
 * a driver finding a run whose process died mid-flight are the same problem —
 * "what has actually been done?" — and the only trustworthy answer to it is
 * the persisted rows, not a `pausedFrom` column written by the process that
 * then disappeared. Deriving it also means a run steered while paused resumes
 * into the stage the new constraint belongs in rather than the stage it left.
 */
export function resumeStateFor(progress: ResearchProgress): ResearchWorkingState {
  if (!progress.planConfirmed || progress.queryCount === 0) return "planning";
  if (progress.sourceCount === 0) return "searching";
  if (progress.readCount === 0) return "browsing";
  if (progress.passageCount === 0) return "reading_documents";
  if (!progress.hasReport) return "checking_coverage";
  return "validating_citations";
}

// ---------------------------------------------------------------------------
// Stages — what the user is shown
// ---------------------------------------------------------------------------

export const RESEARCH_STAGES = ["plan", "gather", "read", "crosscheck", "write", "done"] as const;
export type ResearchStage = (typeof RESEARCH_STAGES)[number];

/**
 * The state → stage collapse.
 *
 * Eight working states is an implementation detail; a person watching wants to
 * know whether Juno is still finding things or already writing. The panel
 * groups by stage for the same reason the chat timeline shows phases instead
 * of raw tool calls — the earlier version of this surface streamed every
 * query and every fetch as its own line, and a fifty-line wall of "Searching
 * the web" reads as noise, not as progress.
 */
const STAGE_OF: Record<ResearchState, ResearchStage> = {
  accepted: "plan",
  planning: "plan",
  awaiting_plan_confirmation: "plan",
  searching: "gather",
  browsing: "gather",
  reading_documents: "read",
  checking_coverage: "crosscheck",
  resolving_conflicts: "crosscheck",
  validating_citations: "crosscheck",
  synthesizing: "write",
  awaiting_user_input: "gather",
  paused: "gather",
  completed: "done",
  partially_completed: "done",
  failed: "done",
  cancelled: "done",
};

export function stageForState(state: ResearchState): ResearchStage {
  return STAGE_OF[state];
}

/** Stage headings. Written as copy because the panel renders them verbatim. */
export const RESEARCH_STAGE_LABEL: Record<ResearchStage, string> = {
  plan: "Planning",
  gather: "Finding sources",
  read: "Reading sources",
  crosscheck: "Cross-checking",
  write: "Writing the report",
  done: "Finished",
};

/** One sentence per state, for the live line above the stage list. */
export const RESEARCH_STATE_MESSAGE: Record<ResearchState, string> = {
  accepted: "Getting ready",
  planning: "Working out what to look up",
  awaiting_plan_confirmation: "Waiting for you to confirm the plan",
  searching: "Searching the web",
  browsing: "Opening the most promising results",
  reading_documents: "Reading the sources in full",
  checking_coverage: "Checking the plan is covered",
  resolving_conflicts: "Working out where sources disagree",
  synthesizing: "Writing the report",
  validating_citations: "Checking every citation against its source",
  awaiting_user_input: "Waiting for your answer",
  paused: "Paused",
  completed: "Finished",
  partially_completed: "Stopped early with what it had",
  failed: "Stopped after an error",
  cancelled: "Cancelled",
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Everything a run can say about itself.
 *
 * The kinds are coarse deliberately. One row per fetched page was the original
 * shape and it made the event log both enormous and useless — a client
 * resuming from a cursor had to replay hundreds of rows to learn one thing.
 */
export const RESEARCH_EVENT_KINDS = [
  "run_started",
  "plan_drafted",
  "plan_confirmed",
  "plan_revised",
  /** The only kind the stage list is built from. Payload carries `state`. */
  "state_changed",
  "query_issued",
  "source_found",
  "source_read",
  "passages_extracted",
  "coverage_checked",
  "conflict_found",
  /** A constraint or a source the user added while the run was going. */
  "steering_applied",
  "spend_recorded",
  "budget_exhausted",
  "paused",
  "resumed",
  "cancelled",
  "error",
  "report_ready",
  "run_finished",
] as const;

export type ResearchEventKind = (typeof RESEARCH_EVENT_KINDS)[number];

const EVENT_KINDS = new Set<string>(RESEARCH_EVENT_KINDS);

export function isResearchEventKind(value: string): value is ResearchEventKind {
  return EVENT_KINDS.has(value);
}

/** One event as the API serialises it. `seq` is the client's cursor. */
export interface ResearchEventDTO {
  id: string;
  seq: number;
  kind: ResearchEventKind;
  payload: Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * The editable plan, as stored in `ResearchRun.plan`.
 *
 * `constraints` and `pinnedSources` are what steering writes into. They are
 * part of the plan rather than a column of their own because a constraint
 * added at minute four has to survive into the synthesis prompt exactly like
 * one written at minute zero — a run that quietly forgets a mid-run constraint
 * once the searching stage is over is worse than one that refuses it.
 */
export interface ResearchPlan {
  /** Sub-questions the run will search for. The user may edit these. */
  queries: string[];
  /** Free-text steering: "only sources after 2023", "ignore press releases". */
  constraints: string[];
  /** URLs the user insisted on, always read regardless of search ranking. */
  pinnedSources: string[];
  /**
   * Whether the plan must be confirmed before anything expensive happens.
   * `auto` is the chat path, where the per-send toggle IS the confirmation;
   * `required` is the research surface, where the run is started from a goal
   * and the user has not yet seen what it intends to do.
   */
  confirmation: "auto" | "required";
  /** Set once the user (or `auto`) has agreed to it. */
  confirmedAt?: string;
}

export const EMPTY_PLAN: ResearchPlan = {
  queries: [],
  constraints: [],
  pinnedSources: [],
  confirmation: "required",
};

/** Bounds, applied on every write so a stored plan can never be unbounded. */
export const MAX_PLAN_QUERIES = 8;
export const MAX_PLAN_CONSTRAINTS = 12;
export const MAX_PINNED_SOURCES = 12;
export const MAX_QUERY_CHARS = 400;
export const MAX_CONSTRAINT_CHARS = 300;

function cleanList(value: unknown, max: number, chars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim().slice(0, chars);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Reads whatever is in the `plan` Json column back as a plan.
 *
 * Total, never throwing: the column is `Json?` and holds rows written by every
 * version of this code that has ever shipped. A run whose plan blob cannot be
 * parsed must still be pausable, cancellable and readable — losing the queries
 * is recoverable, refusing to load the run is not.
 */
export function parsePlan(value: unknown): ResearchPlan {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_PLAN };
  const raw = value as Record<string, unknown>;
  const confirmation = raw.confirmation === "auto" ? "auto" : "required";
  return {
    queries: cleanList(raw.queries, MAX_PLAN_QUERIES, MAX_QUERY_CHARS),
    constraints: cleanList(raw.constraints, MAX_PLAN_CONSTRAINTS, MAX_CONSTRAINT_CHARS),
    pinnedSources: cleanList(raw.pinnedSources, MAX_PINNED_SOURCES, MAX_QUERY_CHARS),
    confirmation,
    confirmedAt: typeof raw.confirmedAt === "string" ? raw.confirmedAt : undefined,
  };
}

export function planIsConfirmed(plan: ResearchPlan): boolean {
  return typeof plan.confirmedAt === "string" && plan.confirmedAt.length > 0;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * Whether a step costing `estimateMicroUsd` may run.
 *
 * Checked BEFORE the spend, not after. A ceiling enforced only after the fact
 * is not a ceiling — the most expensive single call a research run makes is
 * the synthesis, and discovering afterwards that it took the run 40% over is
 * exactly the bill this column exists to prevent. `null` means the caller set
 * no per-run ceiling and the account-level cap is the only limit.
 */
export function budgetAllows(
  spentMicroUsd: bigint,
  budgetMicroUsd: bigint | null,
  estimateMicroUsd: number
): boolean {
  if (budgetMicroUsd === null) return true;
  const estimate = BigInt(Math.max(0, Math.ceil(estimateMicroUsd)));
  return spentMicroUsd + estimate <= budgetMicroUsd;
}

/** True once the run has no room left for even a free step's follow-up. */
export function budgetExhausted(spentMicroUsd: bigint, budgetMicroUsd: bigint | null): boolean {
  return budgetMicroUsd !== null && spentMicroUsd >= budgetMicroUsd;
}

/**
 * Where a budget stop lands.
 *
 * `partially_completed` when anything at all was gathered, `failed` when the
 * ceiling was so low that nothing happened. The distinction matters to the UI:
 * the first has sources to show and the second has a misconfiguration to
 * report, and collapsing them tells a user with twelve good sources that their
 * run failed.
 */
export function budgetStopState(progress: ResearchProgress): ResearchTerminalState {
  return progress.sourceCount > 0 ? "partially_completed" : "failed";
}
