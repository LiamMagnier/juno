/**
 * Research's client-safe shapes (SPEC §9.2, §9.4, §9.11.1).
 *
 * The run DTO was declared twice — once in the server's `run.ts`, once in the
 * client hook `use-research-run.ts` — and the two had drifted. The rework's
 * additions are declared once, here, where the envelope, the estimate, the
 * server view and the client hooks can all import them.
 *
 * Types only.
 */

import type { ResearchState } from "@/lib/research/domain";

/** The planner's decomposition of a question: what sizes a run. */
export interface ResearchScope {
  questions: number;                         // 1–8, = plan objectives
  breadth: "focused" | "broad" | "exhaustive";   // sources per question 4 / 8 / 12
  freshness: "any" | "recent" | "live";
  primarySources: boolean;
  quick: boolean;                            // planner's "a few searches answer this"
}

/** What the client needs to recompute the estimate line as the plan is edited. */
export interface ResearchEstimateCaps {
  maxWorkers: number;
  maxRounds: number;
  maxPages: number;
  maxMinutes: number;
  secondsPerPage: number;
  fixedMinutes: number;
}

/** "About 12 min · reads up to ~150 pages". Time and pages only; never money. */
export interface ResearchEstimate {
  minutesUpTo: number;
  pagesUpTo: number;
}

/**
 * A run's sizing, frozen on `plan.envelope` at confirmation (SPEC §9.2). The
 * engine reads every limit from it; money shows only in the panel's details.
 *
 * Declared here rather than in `envelope.ts` because `parsePlan` (domain.ts)
 * reads it back and `envelope.ts` imports the domain's cost facts: the type
 * living in a third, dependency-free module keeps those two from importing
 * each other.
 */
export interface ResearchEnvelope {
  v: 1;
  ceilingMicroUsd: number;
  reserve: { writerMicroUsd: number; auditMicroUsd: number };
  workers: number;
  rounds: number;
  toolCallsPerWorker: number;
  pages: number;
  resultsPerQuery: number;
  engines: string[];
  workerTokens: number;
  wallClockMs: number;
  workerWallClockMs: number;
  judgeCalls: number;
  /** Model id of the lead: the planner and the writer (§9.5.1). */
  leadModel: string;
  /**
   * Model id the researchers (search and read) run on. Absent on runs sized
   * before it was recorded, whose worker is unknown and is shown as nothing.
   */
  workerModel?: string;
  /**
   * Why the researchers run on a different model than the lead the person
   * chose: it has no tool calling, or its API cannot drive the search loop.
   * Absent when they share the lead's model, or the person chose none.
   */
  workerNote?: ResearchWorkerNote;
  /** True when the lead is the model the person picked in the composer. */
  chosen?: boolean;
  /** Per-token rates of the run's own models, for the engine's reservations. */
  rates?: { lead: ResearchModelRatesLite; worker: ResearchModelRatesLite };
  limitedBy: "scope" | "plan" | "month" | "window";
  estimate: ResearchEstimate;
  /** What the client needs to recompute the estimate. */
  caps: ResearchEstimateCaps;
}

/** Why the researchers run on a model other than the chosen lead. */
export type ResearchWorkerNote = "no_tools" | "responses_api";

/** Micro-USD per token, as `ResearchModelRates` in the engine. */
export interface ResearchModelRatesLite {
  inputMicroUsdPerToken: number;
  outputMicroUsdPerToken: number;
}

/** One model as the views show it: its id and its catalogue name. */
export interface ResearchModelLabel {
  id: string;
  label: string;
}

/**
 * Which models did the work, as recorded on the run (never guessed). Absent
 * on runs from before it was recorded: those show no model at all rather
 * than a name that may not be the truth.
 */
export interface ResearchRunModels {
  /** Planned, reviewed and (unless `writer` says otherwise) wrote. */
  lead: ResearchModelLabel;
  /** Searched and read. */
  worker: ResearchModelLabel | null;
  /** Set when `worker` differs from a chosen `lead`, with the reason. */
  workerNote: ResearchWorkerNote | null;
  /** The model that wrote the report; null until written, or for an evidence digest. */
  writer: ResearchModelLabel | null;
  /** The lead is the model the person picked. */
  chosen: boolean;
}

/**
 * Where a run is, as the reader sees it. Derived server-side from the run's
 * state and latest events; the client maps it to a glyph and a phrase with one
 * table (`RESEARCH_PHASE_UI`).
 */
export type ResearchPhase =
  | "planning"            // accepted, clarifying, planning           → glyph "thinking"
  | "awaiting_start"      // awaiting_plan_confirmation (card shown)  → glyph "waiting"
  | "searching"           // investigating, latest event a search     → glyph "searching"
  | "reading"             // investigating, latest event a page read  → glyph "reading"
  | "reviewing"           // reviewing                                → glyph "thinking"
  | "writing"             // synthesizing                             → glyph "writing"
  | "checking"            // validating_citations                     → glyph "writing"
  | "paused"              // paused                                   → glyph data-phase="paused"
  | "done" | "stopped" | "failed";

export type ResearchQuestionStatus = "pending" | "searching" | "covered" | "partial" | "thin";

export interface ResearchQuestionView {
  id: string;
  question: string;
  rationale?: string;
  status: ResearchQuestionStatus;
}

export interface ResearchClarificationView {
  id: string;
  question: string;
  options?: string[];
  answer?: string;
}

/** One count vocabulary everywhere: found → read → cited. */
export interface ResearchRunCounts {
  found: number;
  read: number;
  cited: number;
  searches: number;
  pages: number;
}

export interface ResearchFinding {
  id: string;
  claim: string;
  /** Verbatim from the source. */
  quote: string;
  url: string;
  title: string;
}

/**
 * What the evidence says so far about one question (RESEARCH_V2 §3): the
 * strongest note a researcher has made for it, in the note's own words, with
 * the page it quotes. Read from findings the workers already extracted, so it
 * costs nothing and says nothing the evidence does not.
 */
export interface ResearchEmergingAnswer {
  questionId: string;
  claim: string;
  url: string;
  title: string;
  /** Distinct pages behind this question's notes so far (of the notes the view read). */
  sources: number;
}

export interface ResearchSteeringEntry {
  text: string;
  /** Null until the round boundary that applies it. */
  appliedAtRound: number | null;
  createdAt: string;
}

/**
 * The fields the rework adds to the run DTO (`ResearchRunView`, SPEC §9.4).
 * All optional: a run written before the rework has none of them, and the
 * server and client views extend this interface rather than redeclare it.
 */
export interface ResearchRunViewAdditions {
  /** Report title, else the planner's short title. */
  title?: string | null;
  scope?: ResearchScope | null;
  estimate?: ResearchEstimate | null;
  /** Present while awaiting_plan_confirmation. */
  estimateCaps?: ResearchEstimateCaps | null;
  /** Frozen content language, BCP-47. */
  language?: string | null;
  questions?: ResearchQuestionView[];
  clarifications?: ResearchClarificationView[];
  counts?: ResearchRunCounts;
  phase?: ResearchPhase;
  phaseDetail?: { query?: string; domain?: string } | null;
  /** Excludes gates and paused time. */
  workingMs?: number;
  assistantMessageId?: string | null;
  /**
   * The model that wrote the report, for "Written by". Null when it is not
   * recorded (runs from before models were recorded, an evidence digest).
   */
  leadModel?: { id: string; label: string } | null;
  /** Every model the run used, recorded per stage. Null on older runs. */
  models?: ResearchRunModels | null;
  /** ≤ 5, newest first. */
  latestFindings?: ResearchFinding[];
  /** One per question with evidence, in the plan's order; live runs only. */
  emergingAnswers?: ResearchEmergingAnswer[];
  /** Who drafted the plan when the planner model did not (RESEARCH_V2 F4). */
  plannedBy?: "lines" | "goal" | null;
  /** The report is the evidence digest, written without a model (F6). */
  digest?: boolean;
  /** Details only: the one place money shows. Serialised as strings (BigInt). */
  spend?: { microUsd: string; ceilingMicroUsd: string | null } | null;
  steering?: ResearchSteeringEntry[];
  /** The planner is rerunning with the reader's edits; the scope card stays mounted, busy. */
  revising?: boolean;
  /** "Finish now" was pressed; the engine acts at the next round boundary. */
  finishRequested?: boolean;
}

/** One row of `GET /api/research?conversationId=` and `?live=1`, newest first (≤ 20). */
export interface ResearchRunSummary {
  id: string;
  conversationId: string | null;
  state: ResearchState;
  phase: ResearchPhase;
  title: string | null;
  createdAt: string;
  finishedAt: string | null;
  live: boolean;
  assistantMessageId: string | null;
}
