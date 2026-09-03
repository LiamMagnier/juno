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
  /**
   * Workers are out: a round of parallel sub-agents, each with its own brief
   * and its own tool loop, searching and reading against the shared corpus.
   * The former `searching` / `browsing` / `reading_documents` trio collapsed
   * into this one state because none of the three was a decision point any
   * more — the worker decides what to search and what to open, and the only
   * boundary a driver needs is "a round is running" versus "a round is over".
   * Pinned sources are still read first, inside the round, so `browsing`'s one
   * guarantee (the user's own URLs are in the corpus) survives the merge.
   */
  "investigating",
  /**
   * The lead is between rounds: scoring every sub-question against what the
   * workers brought back, naming the contradictions, and either writing the
   * next round's briefs or deciding the corpus is ready. Replaces
   * `checking_coverage` and `resolving_conflicts`, which were a token-overlap
   * heuristic and an identical-hash check — neither was a judgement.
   */
  "reviewing",
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
    "investigating",
    "paused",
    "cancelled",
    "failed",
    "partially_completed",
  ],
  awaiting_plan_confirmation: ["planning", "investigating", "paused", "cancelled", "failed"],
  investigating: [
    "reviewing",
    // A round that found the tier's wall clock or page ceiling already spent
    // has nothing left to review: it goes straight to the writer with what the
    // earlier rounds established, rather than paying for a review of nothing.
    "synthesizing",
    "paused",
    "awaiting_user_input",
    "cancelled",
    "failed",
    "partially_completed",
  ],
  reviewing: [
    // Gaps remain and the budget allows another round of workers on them.
    "investigating",
    "synthesizing",
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
  /**
   * Rounds of workers that have finished, as `plan.rounds` records them.
   *
   * Additive: a store written before rounds existed reports none, and the run
   * resumes into a fresh round — which is what it would have done anyway.
   */
  roundsCompleted?: number;
  /** True when the newest finished round has not yet been reviewed by the lead. */
  pendingReview?: boolean;
  /** Wall clock spent investigating so far, against the tier's ceiling. */
  elapsedMs?: number;
  wallClockMs?: number | null;
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
 *
 * The round ledger is what makes this honest under the agent loop. A run that
 * died with a round finished but unreviewed must resume in `reviewing`, not
 * spawn another round on top of findings nobody has scored; and a run whose
 * tier wall clock has already run out resumes at the writer, because more
 * investigation is exactly what the clock forbids.
 */
export function resumeStateFor(progress: ResearchProgress): ResearchWorkingState {
  if (!progress.planConfirmed || progress.queryCount === 0) return "planning";
  if (progress.hasReport) return "validating_citations";
  if (wallClockExceeded(progress) && progress.sourceCount > 0) return "synthesizing";
  if ((progress.roundsCompleted ?? 0) > 0 && progress.pendingReview) return "reviewing";
  return "investigating";
}

/** True once the tier's wall clock has been used up, when the run has one. */
export function wallClockExceeded(progress: Pick<ResearchProgress, "elapsedMs" | "wallClockMs">): boolean {
  return (
    typeof progress.wallClockMs === "number" &&
    progress.wallClockMs > 0 &&
    (progress.elapsedMs ?? 0) >= progress.wallClockMs
  );
}

// ---------------------------------------------------------------------------
// Stages — what the user is shown
// ---------------------------------------------------------------------------

export const RESEARCH_STAGES = ["plan", "investigate", "review", "write", "done"] as const;
export type ResearchStage = (typeof RESEARCH_STAGES)[number];

/**
 * The state → stage collapse.
 *
 * Working states are an implementation detail; a person watching wants to
 * know whether Juno is still finding things or already writing. The panel
 * groups by stage for the same reason the chat timeline shows phases instead
 * of raw tool calls — the earlier version of this surface streamed every
 * query and every fetch as its own line, and a fifty-line wall of "Searching
 * the web" reads as noise, not as progress.
 *
 * `validating_citations` sits under `write`: to a reader it is the tail of
 * writing — the draft exists and is being checked — not a return to review.
 */
const STAGE_OF: Record<ResearchState, ResearchStage> = {
  accepted: "plan",
  planning: "plan",
  awaiting_plan_confirmation: "plan",
  investigating: "investigate",
  reviewing: "review",
  synthesizing: "write",
  validating_citations: "write",
  awaiting_user_input: "investigate",
  paused: "investigate",
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
  investigate: "Investigating",
  review: "Reviewing the evidence",
  write: "Writing the report",
  done: "Finished",
};

/** One sentence per state, for the live line above the stage list. */
export const RESEARCH_STATE_MESSAGE: Record<ResearchState, string> = {
  accepted: "Getting ready",
  planning: "Working out what to look up",
  awaiting_plan_confirmation: "Waiting for you to confirm the plan",
  investigating: "Researchers are searching and reading",
  reviewing: "Reviewing what the researchers found",
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
  "source_ranked",
  "query_issued",
  "source_found",
  "source_read",
  "passages_extracted",
  "coverage_checked",
  "coverage_matrix_updated",
  "follow_up_scheduled",
  "conflict_found",
  // Legacy/chat audits use one durable receipt event; keep it in the shared
  // vocabulary so API consumers do not downgrade it to an unknown error.
  "citation_audit",
  "citation_audit_started",
  "citation_audit_completed",
  "report_repaired",
  "report_revision",
  "worker_lease_acquired",
  /*
   * The agent loop. One `worker_spawned` per delegation brief, one
   * `worker_tool_call` per tool the worker used (query or URL, and how long it
   * took), one `worker_finished` with what it brought back. The console draws
   * its parallel lanes from exactly these three.
   */
  "worker_spawned",
  "worker_tool_call",
  "worker_finished",
  /** The lead's verdict between rounds: coverage per sub-question, gaps, decision. */
  "round_reviewed",
  /** A page was condensed by the worker model on first open; `chars` is the summary's length. */
  "page_summarized",
  /** Pages, tool calls, tokens, money and wall clock against the tier, at each round boundary. */
  "budget_checkpoint",
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

export type ResearchObjectiveStatus = "open" | "partially_covered" | "covered" | "blocked";
export type EvidenceRequirementStatus = "missing" | "weak" | "satisfied" | "conflicted";

/** A durable, user-readable unit of research work. */
export interface ResearchObjective {
  id: string;
  question: string;
  importance: number;
  status: ResearchObjectiveStatus;
  evidenceRequirements: EvidenceRequirement[];
  childObjectiveIds: string[];
}

/** The evidence contract the controller must satisfy before it stops. */
export interface EvidenceRequirement {
  id: string;
  description: string;
  preferredSourceTypes: string[];
  minimumIndependentSources: number;
  requiresPrimarySource: boolean;
  freshnessRule?: string;
  jurisdiction?: string;
  status: EvidenceRequirementStatus;
}

/** Persisted coverage for one requirement, not just a source count. */
export interface ResearchCoverageEntry {
  objectiveId: string;
  requirementId: string;
  status: EvidenceRequirementStatus;
  supportingSourceIds: string[];
  contradictingSourceIds: string[];
  independentSourceCount: number;
  evidenceStrength: number;
  missingReason?: string;
}

export type ResearchConflictKind =
  | "duplicate_source"
  | "contradictory_evidence"
  | "source_monoculture";

/** A conflict stays visible even when the report has a preferred conclusion. */
export interface ResearchConflict {
  id: string;
  kind: ResearchConflictKind;
  objectiveId?: string;
  sourceIds: string[];
  description: string;
  severity: "low" | "medium" | "high";
  resolved: boolean;
}

export const MAX_RESEARCH_OBJECTIVES = 8;
export const MAX_EVIDENCE_REQUIREMENTS = 4;
export const MAX_COVERAGE_ENTRIES = 32;
export const MAX_CONFLICTS = 24;
/** Bounded follow-up rounds. Increased to 4 for OpenAI-style deep recursive research. */
export const MAX_FOLLOW_UP_ROUNDS = 4;
/**
 * Citation repair may send a report through the writer once more. Keeping this
 * in the durable plan, rather than in a worker-local counter, makes a restart
 * unable to turn a bad report into an unbounded paid loop.
 */
export const MAX_REVISION_ROUNDS = 1;
/** A crashed driver leaves a run claimable again after this interval. */
export const RESEARCH_WORKER_LEASE_MS = 2 * 60 * 1000;

function cleanStringArray(value: unknown, max: number, chars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim().slice(0, chars);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

function parseObjectiveStatus(value: unknown): ResearchObjectiveStatus {
  return value === "partially_covered" || value === "covered" || value === "blocked" ? value : "open";
}

function parseRequirementStatus(value: unknown): EvidenceRequirementStatus {
  return value === "weak" || value === "satisfied" || value === "conflicted" ? value : "missing";
}

/**
 * A safe fallback when a provider returns only legacy query lines. It gives the
 * controller a real evidence contract immediately, while richer planners may
 * provide the same shape directly.
 */
export function buildResearchObjectives(goal: string, queries: string[]): ResearchObjective[] {
  const questions = (queries.length ? queries : [goal]).slice(0, MAX_RESEARCH_OBJECTIVES);
  return questions.filter(Boolean).map((question, index) => {
    const id = `objective-${index + 1}`;
    const normalized = question.trim().slice(0, MAX_QUERY_CHARS);
    return {
      id,
      question: normalized,
      importance: index === 0 ? 1 : Math.max(0.5, 1 - index * 0.1),
      status: "open",
      evidenceRequirements: [
        {
          id: `${id}-evidence-1`,
          description: `Direct evidence answering: ${normalized}`,
          preferredSourceTypes: ["official", "primary", "reputable_secondary"],
          minimumIndependentSources: 1,
          requiresPrimarySource: false,
          status: "missing",
        },
      ],
      childObjectiveIds: [],
    };
  });
}

function parseObjectives(value: unknown): ResearchObjective[] {
  if (!Array.isArray(value)) return [];
  const out: ResearchObjective[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim().slice(0, 80) : `objective-${out.length + 1}`;
    if (seen.has(id)) continue;
    const question = typeof item.question === "string" ? item.question.trim().slice(0, MAX_QUERY_CHARS) : "";
    if (!question) continue;
    const requirements: EvidenceRequirement[] = [];
    if (Array.isArray(item.evidenceRequirements)) {
      for (const rawRequirement of item.evidenceRequirements.slice(0, MAX_EVIDENCE_REQUIREMENTS)) {
        if (!rawRequirement || typeof rawRequirement !== "object" || Array.isArray(rawRequirement)) continue;
        const requirement = rawRequirement as Record<string, unknown>;
        const requirementId =
          typeof requirement.id === "string" && requirement.id.trim()
            ? requirement.id.trim().slice(0, 80)
            : `${id}-evidence-${requirements.length + 1}`;
        const description =
          typeof requirement.description === "string" ? requirement.description.trim().slice(0, 400) : "";
        if (!description) continue;
        requirements.push({
          id: requirementId,
          description,
          preferredSourceTypes: cleanStringArray(requirement.preferredSourceTypes, 8, 80),
          minimumIndependentSources:
            typeof requirement.minimumIndependentSources === "number"
              ? Math.max(1, Math.min(4, Math.floor(requirement.minimumIndependentSources)))
              : 1,
          requiresPrimarySource: requirement.requiresPrimarySource === true,
          ...(typeof requirement.freshnessRule === "string"
            ? { freshnessRule: requirement.freshnessRule.slice(0, 160) }
            : {}),
          ...(typeof requirement.jurisdiction === "string"
            ? { jurisdiction: requirement.jurisdiction.slice(0, 160) }
            : {}),
          status: parseRequirementStatus(requirement.status),
        });
      }
    }
    out.push({
      id,
      question,
      importance:
        typeof item.importance === "number" && Number.isFinite(item.importance)
          ? Math.max(0, Math.min(1, item.importance))
          : Math.max(0.5, 1 - out.length * 0.1),
      status: parseObjectiveStatus(item.status),
      evidenceRequirements: requirements,
      childObjectiveIds: cleanStringArray(item.childObjectiveIds, MAX_RESEARCH_OBJECTIVES, 80),
    });
    seen.add(id);
    if (out.length >= MAX_RESEARCH_OBJECTIVES) break;
  }
  return out;
}

function parseCoverage(value: unknown): ResearchCoverageEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_COVERAGE_ENTRIES)
    .filter((raw): raw is Record<string, unknown> => !!raw && typeof raw === "object" && !Array.isArray(raw))
    .map((raw) => ({
      objectiveId: typeof raw.objectiveId === "string" ? raw.objectiveId.slice(0, 80) : "",
      requirementId: typeof raw.requirementId === "string" ? raw.requirementId.slice(0, 80) : "",
      status: parseRequirementStatus(raw.status),
      supportingSourceIds: cleanStringArray(raw.supportingSourceIds, 16, 80),
      contradictingSourceIds: cleanStringArray(raw.contradictingSourceIds, 16, 80),
      independentSourceCount:
        typeof raw.independentSourceCount === "number" ? Math.max(0, Math.min(16, Math.floor(raw.independentSourceCount))) : 0,
      evidenceStrength:
        typeof raw.evidenceStrength === "number" && Number.isFinite(raw.evidenceStrength)
          ? Math.max(0, Math.min(1, raw.evidenceStrength))
          : 0,
      ...(typeof raw.missingReason === "string" ? { missingReason: raw.missingReason.slice(0, 240) } : {}),
    }))
    .filter((entry) => entry.objectiveId && entry.requirementId);
}

function parseConflicts(value: unknown): ResearchConflict[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_CONFLICTS)
    .filter((raw): raw is Record<string, unknown> => !!raw && typeof raw === "object" && !Array.isArray(raw))
    .map((raw, index) => ({
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id.slice(0, 80) : `conflict-${index + 1}`,
      kind: (raw.kind === "contradictory_evidence" || raw.kind === "source_monoculture"
        ? raw.kind
        : "duplicate_source") as ResearchConflictKind,
      ...(typeof raw.objectiveId === "string" ? { objectiveId: raw.objectiveId.slice(0, 80) } : {}),
      sourceIds: cleanStringArray(raw.sourceIds, 16, 80),
      description: typeof raw.description === "string" ? raw.description.slice(0, 320) : "",
      severity: (raw.severity === "high" || raw.severity === "medium" ? raw.severity : "low") as
        | "low"
        | "medium"
        | "high",
      resolved: raw.resolved === true,
    }))
    .filter((entry) => entry.description && entry.sourceIds.length > 0);
}

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
  /**
   * The plan a PERSON reads, as ordered sentences: "Collect official pricing,
   * features and usage limits from vendor sites."
   *
   * Distinct from `queries`, and added because the two were being conflated at
   * the one moment that cannot afford it. The plan gate is where a user decides
   * whether to spend money, and what it had to show them was the raw query list
   * — "best AI subscription 2026", "claude max vs chatgpt pro price" — which is
   * the machine's shopping list, not a plan. Nobody can tell from a bag of
   * search strings whether the investigation will cover what they care about,
   * which is the only question the gate exists to ask.
   *
   * Steps describe INTENT and are what the gate renders; queries are how the
   * intent is executed and live behind a disclosure. The two are produced in one
   * planner call, so this costs nothing extra.
   *
   * Optional, and empty on every plan written before this existed. Consumers
   * fall back to the query list rather than showing an empty gate.
   */
  steps?: string[];
  /** Sub-questions the run will search for. The user may edit these. */
  queries: string[];
  /** Structured questions and evidence requirements behind the query list. */
  objectives: ResearchObjective[];
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
  /** Queries already paid for by the search stage. Additive for old plan JSON. */
  issuedQueries?: string[];
  /** Number of bounded evidence-driven search rounds already attempted. */
  followUpRound?: number;
  /** Number of citation-driven report rewrites already scheduled. */
  revisionRound?: number;
  /** Last coverage matrix written by the lead's round review. */
  coverage?: ResearchCoverageEntry[];
  /** Conflicts found while gathering or validating evidence. */
  conflicts?: ResearchConflict[];
  /**
   * The lead's research brief: what the question actually contains, restated
   * for the workers. Every delegation brief quotes it, so a worker never sees
   * only its own sub-question and drifts away from the goal.
   */
  brief?: string;
  /** How hard the run works — see `RESEARCH_TIERS`. Absent on runs older than tiers. */
  effort?: ResearchEffort;
  /** The tier's ceilings, frozen on the run so a later edit to the table cannot move a live run's limits. */
  budget?: ResearchBudget;
  /** One entry per round of workers, in order. The engine resumes from its length. */
  rounds?: ResearchRound[];
}

// ---------------------------------------------------------------------------
// Effort tiers
// ---------------------------------------------------------------------------

/**
 * How hard a run works.
 *
 * The four names are the ones the product surfaces use, so they are the
 * vocabulary here rather than a number: a caller asks for "deep", not for
 * eight workers, and the table below is what "deep" means this release.
 */
export const RESEARCH_EFFORTS = ["quick", "standard", "deep", "max"] as const;
export type ResearchEffort = (typeof RESEARCH_EFFORTS)[number];

export function isResearchEffort(value: unknown): value is ResearchEffort {
  return typeof value === "string" && (RESEARCH_EFFORTS as readonly string[]).includes(value);
}

/**
 * What a tier is allowed to spend, in every unit the run can run out of.
 *
 * Pages, tool calls, tokens and wall clock are each a real ceiling, because
 * each is a different way for an agent loop to go wrong: a worker that keeps
 * searching without opening anything burns tool calls and no pages; a page
 * that summarises to nothing burns tokens and no findings; a site that answers
 * in thirty seconds a fetch burns the clock and nothing else. Money is the
 * ceiling the account already had (`ResearchRun.budgetMicroUsd`); the tier
 * does not add a second one, it sizes itself to fit inside the first.
 */
export interface ResearchTier {
  effort: ResearchEffort;
  /** Workers dispatched in parallel per round. */
  workers: number;
  /** Rounds of workers before the run must write. */
  rounds: number;
  /** Tool calls one worker may make before it is told to wrap up. */
  toolCallsPerWorker: number;
  /** Pages the whole run may read in full. */
  pages: number;
  /** Model tokens (input + output) the workers may consume across the run. */
  tokens: number;
  /** Wall clock from the first worker to the writer, in milliseconds. */
  wallClockMs: number;
  /** Wall clock one worker gets before it is stopped. */
  workerWallClockMs: number;
  /** Judge calls the citation audit may make on this tier's report. */
  judgeCalls: number;
}

const MINUTE_MS = 60_000;

/**
 * The tier table.
 *
 * Sized from the published shape of the deep-research products this engine is
 * measured against — a quick pass reads a couple of dozen pages in a few
 * minutes; a deep one runs a team for half an hour and reads a few hundred.
 * The page figures are the ones a user actually feels, and are what the
 * `deep` tier's $8 default budget is checked against in
 * tests/research-agents.test.ts: a tier that cannot afford its own page count
 * under the cost model below is a tier that stops early and says "budget".
 */
export const RESEARCH_TIERS: Record<ResearchEffort, ResearchTier> = {
  quick: {
    effort: "quick",
    workers: 1,
    rounds: 1,
    toolCallsPerWorker: 25,
    pages: 20,
    tokens: 400_000,
    wallClockMs: 5 * MINUTE_MS,
    workerWallClockMs: 4 * MINUTE_MS,
    judgeCalls: 24,
  },
  standard: {
    effort: "standard",
    workers: 4,
    rounds: 2,
    toolCallsPerWorker: 40,
    pages: 80,
    tokens: 1_500_000,
    wallClockMs: 12 * MINUTE_MS,
    workerWallClockMs: 5 * MINUTE_MS,
    judgeCalls: 48,
  },
  deep: {
    effort: "deep",
    workers: 8,
    rounds: 3,
    toolCallsPerWorker: 60,
    pages: 320,
    tokens: 6_000_000,
    wallClockMs: 30 * MINUTE_MS,
    workerWallClockMs: 8 * MINUTE_MS,
    judgeCalls: 96,
  },
  max: {
    effort: "max",
    workers: 12,
    rounds: 3,
    toolCallsPerWorker: 80,
    pages: 480,
    tokens: 12_000_000,
    wallClockMs: 60 * MINUTE_MS,
    workerWallClockMs: 12 * MINUTE_MS,
    judgeCalls: 160,
  },
};

/** The tier a run that named none is given. Chat and REST override it separately. */
export const DEFAULT_RESEARCH_EFFORT: ResearchEffort = "standard";

/**
 * The ceilings as frozen on the run, plus when investigation began.
 *
 * Frozen rather than looked up, so a deploy that retunes `RESEARCH_TIERS`
 * cannot change what a run already in flight is allowed to do — the user was
 * shown one plan and one budget, and those are the ones the engine enforces.
 */
export interface ResearchBudget {
  effort: ResearchEffort;
  workers: number;
  rounds: number;
  toolCallsPerWorker: number;
  pages: number;
  tokens: number;
  wallClockMs: number;
  workerWallClockMs: number;
  judgeCalls: number;
  /** ISO instant the first round started; the wall clock is measured from it. */
  startedAt?: string;
}

export function budgetForEffort(effort: ResearchEffort): ResearchBudget {
  const tier = RESEARCH_TIERS[effort];
  return {
    effort,
    workers: tier.workers,
    rounds: tier.rounds,
    toolCallsPerWorker: tier.toolCallsPerWorker,
    pages: tier.pages,
    tokens: tier.tokens,
    wallClockMs: tier.wallClockMs,
    workerWallClockMs: tier.workerWallClockMs,
    judgeCalls: tier.judgeCalls,
  };
}

/** A delegation brief: what one worker is sent to find. */
export interface ResearchDelegation {
  /** Stable within the run: `w<round>-<n>`. */
  workerId: string;
  /** The sub-question this worker serves; joins to `ResearchObjective.id`. */
  objectiveId: string;
  objective: string;
  /** What to find, in the lead's words — a paragraph, not a query. */
  whatToFind: string;
  /** What NOT to spend time on, so two workers do not read the same thing. */
  boundaries: string;
}

/** One round of workers, as the plan records it. */
export interface ResearchRound {
  round: number;
  /** The briefs that were dispatched. */
  delegations: ResearchDelegation[];
  /** Pages read in full by the whole run when the round ended. */
  pagesRead: number;
  toolCalls: number;
  tokens: number;
  /** Findings noted by this round's workers. */
  claims: number;
  /** Of those, findings on pages no earlier round had cited. */
  newClaims: number;
  startedAt: string;
  finishedAt?: string;
  /** Written by the lead review; absent while the round awaits one. */
  review?: ResearchRoundReview;
}

/** What the lead concluded from one round. */
export interface ResearchRoundReview {
  /** 0..1 per sub-question, keyed by objective id. */
  coverage: Record<string, number>;
  /** Sub-questions still open, each with the brief to send after it. */
  gaps: Array<{ objectiveId: string; reason: string }>;
  contradictions: number;
  decision: "continue" | "synthesize";
  reason: string;
}

/** A sub-question counts as answered at or above this coverage. */
export const COVERAGE_TARGET = 0.8;
/**
 * A round that added fewer new claims than this share of the total has
 * saturated: the corpus is telling the workers what they already know, and
 * another round would pay to hear it again.
 */
export const SATURATION_NEW_CLAIM_SHARE = 0.1;
/** Rounds one plan may record. A ceiling on the ledger, not a target. */
export const MAX_RESEARCH_ROUNDS = 6;
/** Delegations one round may hold. */
export const MAX_DELEGATIONS_PER_ROUND = 16;
export const MAX_BRIEF_CHARS = 2_000;
export const MAX_DELEGATION_CHARS = 1_200;

export const EMPTY_PLAN: ResearchPlan = {
  queries: [],
  objectives: [],
  constraints: [],
  pinnedSources: [],
  confirmation: "required",
};

/**
 * Bounds, applied on every write so a stored plan can never be unbounded.
 *
 * `MAX_PLAN_QUERIES` was 20 against a planner that drafts 14, which left six
 * slots for every follow-up round put together — and follow-ups are now one per
 * uncovered objective rather than one per round, so with up to
 * MAX_RESEARCH_OBJECTIVES gaps a single round could fill the remainder and
 * starve the three rounds after it. 40 leaves room for the planner's 14 plus
 * four genuinely wide rounds. It is a ceiling on the QUERY LIST, not a target:
 * a run only issues follow-ups the coverage matrix actually asks for.
 */
export const MAX_PLAN_QUERIES = 40;
/**
 * Steps are read, not executed, so they are bounded by what a person will
 * actually read at a decision point rather than by what the engine can afford.
 * Six is the count every published plan gate converges on — past that the gate
 * stops being a summary of the investigation and becomes the investigation.
 */
export const MAX_PLAN_STEPS = 6;
export const MAX_STEP_CHARS = 200;
export const MAX_PLAN_CONSTRAINTS = 16;
export const MAX_PINNED_SOURCES = 24;
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
  const queries = cleanList(raw.queries, MAX_PLAN_QUERIES, MAX_QUERY_CHARS);
  const steps = cleanList(raw.steps, MAX_PLAN_STEPS, MAX_STEP_CHARS);
  const parsedObjectives = parseObjectives(raw.objectives);
  const budget = parseBudget(raw.budget);
  return {
    // Omitted rather than stored empty, so "this plan predates steps" and "this
    // planner returned none" stay the same shape to every consumer.
    ...(steps.length ? { steps } : {}),
    queries,
    objectives: parsedObjectives.length ? parsedObjectives : buildResearchObjectives("", queries),
    constraints: cleanList(raw.constraints, MAX_PLAN_CONSTRAINTS, MAX_CONSTRAINT_CHARS),
    pinnedSources: cleanList(raw.pinnedSources, MAX_PINNED_SOURCES, MAX_QUERY_CHARS),
    confirmation,
    confirmedAt: typeof raw.confirmedAt === "string" ? raw.confirmedAt : undefined,
    ...(Array.isArray(raw.issuedQueries)
      ? { issuedQueries: cleanList(raw.issuedQueries, MAX_PLAN_QUERIES + MAX_FOLLOW_UP_ROUNDS * 4, MAX_QUERY_CHARS) }
      : {}),
    ...(typeof raw.followUpRound === "number"
      ? { followUpRound: Math.max(0, Math.min(MAX_FOLLOW_UP_ROUNDS, Math.floor(raw.followUpRound))) }
      : {}),
    ...(typeof raw.revisionRound === "number"
      ? { revisionRound: Math.max(0, Math.min(MAX_REVISION_ROUNDS, Math.floor(raw.revisionRound))) }
      : {}),
    ...(Array.isArray(raw.coverage) ? { coverage: parseCoverage(raw.coverage) } : {}),
    ...(Array.isArray(raw.conflicts) ? { conflicts: parseConflicts(raw.conflicts) } : {}),
    ...(typeof raw.brief === "string" && raw.brief.trim() ? { brief: raw.brief.trim().slice(0, MAX_BRIEF_CHARS) } : {}),
    ...(isResearchEffort(raw.effort) ? { effort: raw.effort } : {}),
    ...(budget ? { budget } : {}),
    ...(Array.isArray(raw.rounds) ? { rounds: parseRounds(raw.rounds) } : {}),
  };
}

/**
 * The tier's ceilings for a plan, whether or not the plan has frozen them.
 *
 * A plan written before tiers existed has neither `effort` nor `budget`; it
 * gets the default tier so a resumed legacy run is bounded like a new one.
 */
export function planBudget(plan: ResearchPlan): ResearchBudget {
  return plan.budget ?? budgetForEffort(plan.effort ?? DEFAULT_RESEARCH_EFFORT);
}

/** Wall clock spent since the first round began, or zero before it did. */
export function investigationElapsedMs(plan: ResearchPlan, now: Date): number {
  const started = plan.budget?.startedAt ? Date.parse(plan.budget.startedAt) : NaN;
  return Number.isFinite(started) ? Math.max(0, now.getTime() - started) : 0;
}

function parseDelegations(value: unknown): ResearchDelegation[] {
  if (!Array.isArray(value)) return [];
  const out: ResearchDelegation[] = [];
  for (const raw of value.slice(0, MAX_DELEGATIONS_PER_ROUND)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const workerId = typeof item.workerId === "string" ? item.workerId.slice(0, 40) : "";
    const objective = typeof item.objective === "string" ? item.objective.trim().slice(0, MAX_QUERY_CHARS) : "";
    if (!workerId || !objective) continue;
    out.push({
      workerId,
      objectiveId: typeof item.objectiveId === "string" ? item.objectiveId.slice(0, 80) : "",
      objective,
      whatToFind: typeof item.whatToFind === "string" ? item.whatToFind.slice(0, MAX_DELEGATION_CHARS) : "",
      boundaries: typeof item.boundaries === "string" ? item.boundaries.slice(0, MAX_DELEGATION_CHARS) : "",
    });
  }
  return out;
}

function parseRoundReview(value: unknown): ResearchRoundReview | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const coverage: Record<string, number> = {};
  if (raw.coverage && typeof raw.coverage === "object" && !Array.isArray(raw.coverage)) {
    for (const [key, score] of Object.entries(raw.coverage as Record<string, unknown>)) {
      if (typeof score === "number" && Number.isFinite(score)) coverage[key.slice(0, 80)] = Math.max(0, Math.min(1, score));
    }
  }
  const gaps = Array.isArray(raw.gaps)
    ? raw.gaps
        .filter((gap): gap is Record<string, unknown> => !!gap && typeof gap === "object" && !Array.isArray(gap))
        .map((gap) => ({
          objectiveId: typeof gap.objectiveId === "string" ? gap.objectiveId.slice(0, 80) : "",
          reason: typeof gap.reason === "string" ? gap.reason.slice(0, 400) : "",
        }))
        .filter((gap) => gap.objectiveId)
        .slice(0, MAX_RESEARCH_OBJECTIVES)
    : [];
  return {
    coverage,
    gaps,
    contradictions:
      typeof raw.contradictions === "number" ? Math.max(0, Math.floor(raw.contradictions)) : 0,
    decision: raw.decision === "continue" ? "continue" : "synthesize",
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 400) : "",
  };
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

function parseRounds(value: unknown): ResearchRound[] {
  if (!Array.isArray(value)) return [];
  const out: ResearchRound[] = [];
  for (const raw of value.slice(0, MAX_RESEARCH_ROUNDS)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const review = parseRoundReview(item.review);
    out.push({
      round: count(item.round) || out.length + 1,
      delegations: parseDelegations(item.delegations),
      pagesRead: count(item.pagesRead),
      toolCalls: count(item.toolCalls),
      tokens: count(item.tokens),
      claims: count(item.claims),
      newClaims: count(item.newClaims),
      startedAt: typeof item.startedAt === "string" ? item.startedAt : "",
      ...(typeof item.finishedAt === "string" ? { finishedAt: item.finishedAt } : {}),
      ...(review ? { review } : {}),
    });
  }
  return out;
}

function parseBudget(value: unknown): ResearchBudget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!isResearchEffort(raw.effort)) return undefined;
  // Any ceiling the stored blob lacks falls back to the tier's current value —
  // a budget written by a build with fewer ceilings must still bound the run.
  const base = budgetForEffort(raw.effort);
  const pick = (key: keyof Omit<ResearchBudget, "effort" | "startedAt">) => {
    const stored = raw[key];
    return typeof stored === "number" && Number.isFinite(stored) && stored > 0 ? Math.floor(stored) : base[key];
  };
  return {
    effort: raw.effort,
    workers: pick("workers"),
    rounds: pick("rounds"),
    toolCallsPerWorker: pick("toolCallsPerWorker"),
    pages: pick("pages"),
    tokens: pick("tokens"),
    wallClockMs: pick("wallClockMs"),
    workerWallClockMs: pick("workerWallClockMs"),
    judgeCalls: pick("judgeCalls"),
    ...(typeof raw.startedAt === "string" ? { startedAt: raw.startedAt } : {}),
  };
}

export function planIsConfirmed(plan: ResearchPlan): boolean {
  return typeof plan.confirmedAt === "string" && plan.confirmedAt.length > 0;
}

// ---------------------------------------------------------------------------
// What a stage costs
// ---------------------------------------------------------------------------

/*
 * The cost facts, in the one module both sides of the ceiling can import.
 *
 * `tools.ts` is what actually bills; `engine.ts` is what has to guess the bill
 * BEFORE the call, and it cannot import `tools.ts` (server-only, and it would
 * be a cycle — tools imports the engine's types). So the numbers lived in two
 * places and drifted, badly: the engine estimated a search at 10,000 µUSD
 * against a tools.ts that records 1,000, and a page fetch at 2,000 against a
 * recorded 500. Because `affordableCount` sizes each wave by multiplying the
 * estimate, a deep run stopped after roughly a tenth of the searches its
 * budget could pay for, and the transcript said only "budget exhausted".
 *
 * Nothing below is a second opinion about a price. The vendor fees ARE the
 * numbers tools.ts returns, and the caps ARE the slices and `maxTokens` it
 * calls the model with — imported by both, so the estimate cannot drift from
 * the bill again without the test in tests/research-run.test.ts failing.
 */

/** The flat fee `searchTheWeb` records for one multi-engine fan-out. */
export const SEARCH_FEE_MICRO_USD = 1_000;
/** The flat fee `fetchResearchPage` records for one extracted page. */
export const PAGE_FETCH_FEE_MICRO_USD = 500;

/**
 * How much dearer than the recorded fee a vendor step is allowed to be before
 * the ceiling stops projecting correctly.
 *
 * Two, not ten. These fees are flat and known — the estimate only has to
 * absorb a vendor repricing between deploys, not the spread between a cheap
 * model and an expensive one, which is what the model stages below carry.
 */
export const VENDOR_ESTIMATE_MARGIN = 2;

/*
 * The model stages, and why their estimate is arithmetic rather than a number.
 *
 * A search is a fixed fee; a planner or a writer is tokens times a rate, and
 * neither factor is a constant. The engine cannot know which model
 * `researchPlannerModel()` picked — it is chosen inside tools.ts, which the
 * engine cannot import — so it prices at the DEAREST rate any model
 * `utilityModelCandidates()` can return (sonnet-class, $3/$15 per MTok; see
 * `baseRate` in src/lib/pricing.ts). Micro-USD per token is numerically equal
 * to dollars per MTok, which is why these read as 3 and 15.
 *
 * That makes the model estimates deliberately conservative — a deployment
 * whose fastest free model is Haiku-class pays about a third of this. That
 * trade is taken on purpose and is the opposite of the search bug: PLAN and
 * SYNTHESIS happen once per run, so over-estimating them costs a slice of one
 * run's headroom, whereas over-estimating SEARCH multiplied across every query
 * in the sweep and was throttling the breadth the whole feature is for.
 */
export const REFERENCE_INPUT_MICRO_USD_PER_TOKEN = 3;
export const REFERENCE_OUTPUT_MICRO_USD_PER_TOKEN = 15;
/**
 * Extra allowed on top of the char-derived token count.
 *
 * `estimateTokensFromChars` in pricing.ts divides characters by four, which is
 * a good average for English prose and an under-count for what a research
 * corpus is mostly made of — URLs, markdown tables and code fragments tokenize
 * denser than that. Without this the estimate would be a floor on the input
 * side rather than a bound, which is the one thing a pre-spend check may not be.
 */
export const MODEL_ESTIMATE_MARGIN = 1.25;
/** pricing.ts's own chars-per-token rule; kept in step with it deliberately. */
const CHARS_PER_TOKEN = 4;

/** Goal characters `planResearchQueries` sends the brief expansion. */
export const BRIEF_PROMPT_CHARS = 4_000;
export const BRIEF_OUTPUT_TOKENS = 600;
/** Brief-augmented characters it then sends the planner. */
export const PLANNER_PROMPT_CHARS = 6_000;
export const PLANNER_OUTPUT_TOKENS = 1_024;
/** Gap description characters `expandResearchQueries` sends. */
export const EXPANSION_PROMPT_CHARS = 6_000;
export const EXPANSION_OUTPUT_TOKENS = 512;
/** `writeResearchReport`'s reply cap. Real reports are far shorter; this is the
 *  most the model is permitted to emit, and an upper bound has to use it. */
export const SYNTHESIS_OUTPUT_TOKENS = 16_384;
/** Previous-draft characters a citation-driven rewrite carries back in. */
export const REVISION_REPORT_CHARS = 48_000;
/**
 * Allowance for the system prompt riding each model call.
 *
 * One number rather than four because the three research system prompts are
 * 788, 1,690 and 857 characters and none of them is going to double; a
 * per-prompt constant would be four things to keep in step for no extra
 * accuracy.
 */
export const SYSTEM_PROMPT_CHARS = 2_500;
/**
 * Fixed characters of `buildResearchCorpus` before any source: the report
 * contract, the untrusted-content rule and the restated goal.
 */
export const CORPUS_PREAMBLE_CHARS = 4_000;
/**
 * Per-source characters the corpus adds around the snapshot itself — the
 * ordinal, a title capped at 200, the URL twice (once as the citation line,
 * once as the untrusted envelope's `source=`) and the envelope markers.
 */
export const CORPUS_PER_SOURCE_CHARS = 700;

/*
 * The citation audit, which is a MODEL stage and was being priced as free.
 *
 * `recordCitationAudit` runs one judge call per undecided claim/passage pair,
 * and it was the last un-gated cost path in a run: `runUtilityPrompt` never
 * told anyone what it spent, so the judge's tokens reached neither the run's
 * odometer nor `affordable()`. On a report with forty claims that is not a
 * rounding error — it is an entire stage the ceiling cannot see, spent after
 * the most expensive call in the run has already been paid for.
 *
 * The caps live here, beside the planner's and the writer's, for the reason the
 * section header gives: claims.ts is `server-only` and the engine cannot import
 * it, so a number raised there and not here would be a ceiling that silently
 * stopped holding. claims.ts imports these rather than keeping its own copies.
 */
/** How much of a passage `createCitationJudge` shows the judge. */
export const JUDGE_PASSAGE_CHARS = 1_600;
/** The judge's reply cap — it answers with one small JSON object. */
export const JUDGE_OUTPUT_TOKENS = 200;
/**
 * Judge calls one audit will make, over all claims together.
 *
 * Past this the remaining claims are recorded `unverified` and reported as
 * unchecked. It is a per-AUDIT cap, not a per-claim one, and that is what makes
 * the whole stage priceable in advance: see `CITATION_AUDIT_ESTIMATE_MICRO_USD`.
 */
export const MAX_JUDGE_CALLS = 24;
/**
 * The judge cap for a tier's report.
 *
 * A quick run's report has a dozen claims; a max run's has a hundred and
 * cites four hundred pages. Auditing both at 24 calls left most of the deep
 * report `unverified`, which the finish rule below then had to treat as fine
 * — so the cap scales with the tier, and `unverified` no longer gets a pass.
 */
export function judgeCallsForEffort(effort: ResearchEffort | undefined): number {
  return effort ? RESEARCH_TIERS[effort].judgeCalls : MAX_JUDGE_CALLS;
}
/**
 * The share of claims the audit may leave unchecked before the run stops
 * calling itself `completed`.
 *
 * `unverified` used to be free: a report whose audit ran out of judge calls
 * after two claims finished `completed`, identical to one whose every claim
 * was checked. Past this share the run is `partially_completed`, which is the
 * state that already means "usable, not fully verified".
 */
export const MAX_UNVERIFIED_SHARE = 0.2;
/**
 * Everything the judge prompt carries besides the passage itself: the claim
 * (bounded at 600 characters by `MAX_CLAIM_CHARS` in claim-analysis.ts), the
 * source title TWICE — once on the `SOURCE:` line, once as the untrusted
 * envelope's `source=` label, 500 each as stored — the published-on date, the
 * envelope markers and the fixed labels. That worst case is ~1,710; 2,000 is it
 * rounded up, because a pre-spend bound may only be wrong in one direction.
 */
export const JUDGE_PROMPT_OVERHEAD_CHARS = 2_000;

/**
 * What one model call may cost, priced at the reference ceiling.
 *
 * Exported so the estimate and the test that guards it compute it the same
 * way. `maxOutputTokens` is a real contractual bound (the `maxTokens` the call
 * is made with); `promptChars` is whatever the caller can actually put in front
 * of the model, which for synthesis is a function of the corpus and therefore
 * has to be passed in rather than baked into a constant.
 */
export function modelCallEstimateMicroUsd(
  promptChars: number,
  maxOutputTokens: number,
  rates: ResearchModelRates = REFERENCE_MODEL_RATES
): number {
  const promptTokens = Math.ceil(Math.max(0, promptChars) / CHARS_PER_TOKEN);
  const raw =
    promptTokens * rates.inputMicroUsdPerToken + Math.max(0, maxOutputTokens) * rates.outputMicroUsdPerToken;
  return Math.ceil(raw * MODEL_ESTIMATE_MARGIN);
}

/**
 * What a model charges, in the unit the estimates are computed in.
 *
 * Micro-USD per token equals dollars per million tokens, so a model's
 * `inputUsdPerMTok` from `getModelMetrics` IS this figure. The engine never
 * looks a model up itself — `tools.ts` chooses the models and reports their
 * rates through `ResearchDeps.modelRates`, so a cheap worker model is priced
 * as the cheap model it is rather than at the reference ceiling.
 */
export interface ResearchModelRates {
  inputMicroUsdPerToken: number;
  outputMicroUsdPerToken: number;
}

export const REFERENCE_MODEL_RATES: ResearchModelRates = {
  inputMicroUsdPerToken: REFERENCE_INPUT_MICRO_USD_PER_TOKEN,
  outputMicroUsdPerToken: REFERENCE_OUTPUT_MICRO_USD_PER_TOKEN,
};

/*
 * The agent stages, and how their ceilings are derived.
 *
 * A worker is a tool loop: every call re-sends the whole conversation, so the
 * bound on one call's prompt is the bound on the conversation, and the worker
 * runner enforces it by compacting old tool results once the transcript
 * passes `WORKER_CONTEXT_CHARS`. That cap is what makes the per-worker
 * estimate arithmetic rather than a guess: at most `toolCallsPerWorker + 1`
 * model calls, each at most the context cap in, each at most
 * `WORKER_OUTPUT_TOKENS` out, plus one vendor fee per tool call at the dearer
 * of the two fees.
 */
/** Characters of transcript a worker may carry into one model call. */
export const WORKER_CONTEXT_CHARS = 80_000;
/** A worker's reply cap per call: a tool call and a line of reasoning, or its final summary. */
export const WORKER_OUTPUT_TOKENS = 700;
/** Characters of a search digest returned to a worker. */
export const SEARCH_DIGEST_CHARS = 3_000;
/** Characters of a page digest (summary + chunk index) returned to a worker. */
export const PAGE_DIGEST_CHARS = 6_000;
/** Characters of a `find_in_page` reply. */
export const FIND_DIGEST_CHARS = 3_000;
/** Page characters the summariser is shown. Past this a page is summarised from its head. */
export const SUMMARY_PROMPT_CHARS = 24_000;
export const SUMMARY_OUTPUT_TOKENS = 320;
/** Findings characters the lead review is shown. */
export const REVIEW_PROMPT_CHARS = 48_000;
export const REVIEW_OUTPUT_TOKENS = 2_048;
/** Compressed findings characters the writer is shown, on top of the cited chunks. */
export const SYNTHESIS_FINDINGS_CHARS = 120_000;

/** One worker's worst case: its whole tool loop, priced at the worker model's rates. */
export function workerEstimateMicroUsd(
  budget: Pick<ResearchBudget, "toolCallsPerWorker">,
  rates: ResearchModelRates
): number {
  const calls = budget.toolCallsPerWorker + 1;
  const model = calls * modelCallEstimateMicroUsd(WORKER_CONTEXT_CHARS + SYSTEM_PROMPT_CHARS, WORKER_OUTPUT_TOKENS, rates);
  const vendor = budget.toolCallsPerWorker * Math.max(SEARCH_FEE_MICRO_USD, PAGE_FETCH_FEE_MICRO_USD) * VENDOR_ESTIMATE_MARGIN;
  return model + vendor;
}

/** One page open: the fetch fee and the summary the worker model writes for it. */
export function pageOpenEstimateMicroUsd(rates: ResearchModelRates): number {
  return (
    PAGE_FETCH_FEE_MICRO_USD * VENDOR_ESTIMATE_MARGIN +
    modelCallEstimateMicroUsd(SUMMARY_PROMPT_CHARS + SYSTEM_PROMPT_CHARS, SUMMARY_OUTPUT_TOKENS, rates)
  );
}

/** The lead's round review: one call over the compressed findings. */
export function reviewEstimateMicroUsd(rates: ResearchModelRates): number {
  return modelCallEstimateMicroUsd(REVIEW_PROMPT_CHARS + SYSTEM_PROMPT_CHARS, REVIEW_OUTPUT_TOKENS, rates);
}

/**
 * Inline citation markers, `[n]`, as the report's own numbering.
 *
 * Three digits, not two: a deep run numbers several hundred sources, and the
 * old `\d{1,2}` silently missed every `[100]` and above — a dangling citation
 * to source 250 of a 200-source corpus passed the check. Fenced code blocks
 * are skipped because `[1]` inside a code sample is an array index, and a
 * report about software would otherwise fail its own audit.
 */
export function citedMarkers(report: string): Set<number> {
  const cited = new Set<number>();
  const prose = report.replace(/```[\s\S]*?```/g, " ");
  for (const match of prose.matchAll(/\[(\d{1,3})\]/g)) cited.add(Number(match[1]));
  return cited;
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
