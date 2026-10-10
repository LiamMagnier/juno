/**
 * Sizing a research run (SPEC §9.2): the planner's scope, the plan's caps and
 * the month's remaining budget become one frozen envelope — workers, rounds,
 * pages, clocks, judge calls and the spend ceiling — or a refusal with a
 * reason. There are no depth levels; the scope is the only dial (DECISIONS R1).
 *
 * Pure: the EUR→USD rate is an input, so this file never imports the
 * server-only spend module, and every price is computed from the same cost
 * facts the engine reserves against (the cost section of domain.ts). The
 * caller (`run.ts`) gathers the facts — the plan, what is left of the month,
 * the model and engine prices, how many runs are going — and freezes what
 * comes back on the run at confirmation.
 */

import type { Plan } from "@prisma/client";

import {
  MAX_RESEARCH_OBJECTIVES,
  PAGE_FETCH_FEE_MICRO_USD,
  SYSTEM_PROMPT_CHARS,
  VENDOR_ESTIMATE_MARGIN,
  WORKER_CONTEXT_CHARS,
  WORKER_OUTPUT_TOKENS,
  auditEstimateMicroUsd,
  modelCallEstimateMicroUsd,
  pageOpenEstimateMicroUsd,
  plannerEstimateMicroUsd,
  reviewEstimateMicroUsd,
  writerEstimateMicroUsd,
  type ResearchModelRates,
} from "@/lib/research/domain";
import { estimateFor } from "@/lib/research/estimate";
import { UNATTENDED_RUN_DEFAULT_MICRO_USD } from "@/lib/spend-ceiling";
import type { ResearchEnvelope, ResearchEstimateCaps, ResearchScope } from "@/types/research";

export type { ResearchEnvelope, ResearchEstimateCaps, ResearchScope } from "@/types/research";

export type ResearchBudgetRefusal = {
  refused: true;
  /** `not_configured`: no model the plan's lead class allows is configured (§9.5.1). Additive. */
  reason: "plan" | "live_runs" | "daily_starts" | "budget" | "not_configured";
  /** Copy params for the refusal line, e.g. share left and reset time. */
  params: Record<string, string | number>;
};

/** Worker, lead and judge prices, in micro-USD per token. */
export interface ResearchRates {
  worker: ResearchModelRates;
  lead: ResearchModelRates;
  judge: ResearchModelRates;
}

/** The keyed engines a run may fan out to, and what one query costs on each. */
export interface SearchRoster {
  engines: Array<{ name: "tavily" | "serper" | "brave" | "exa"; microUsdPerQuery: number }>;
}

// ---------------------------------------------------------------------------
// The plan caps (gap-entitlements §6.5; the owner confirms, SPEC §14 O-5)
// ---------------------------------------------------------------------------

export interface ResearchPlanCaps {
  entitled: boolean;
  /** Runs going at once, not counting plans parked at the gate. */
  liveRuns: number;
  /** Starts per local calendar day. Null: no daily limit. */
  startsPerDay: number | null;
  /** The investigation clock. */
  clockMinutes: number;
  /** The lead's class, as the most its input may cost per MTok. Null: any model. */
  leadInputUsdPerMTokMax: number | null;
}

export const RESEARCH_PLAN_CAPS: Record<Plan, ResearchPlanCaps> = {
  FREE: {
    entitled: false,
    liveRuns: 0,
    startsPerDay: 0,
    clockMinutes: 0,
    leadInputUsdPerMTokMax: null,
  },
  // Lite is chat-first: research is a Pro feature (PLANS.LITE.research).
  LITE: {
    entitled: false,
    liveRuns: 0,
    startsPerDay: 0,
    clockMinutes: 0,
    leadInputUsdPerMTokMax: null,
  },
  PRO: {
    entitled: true,
    liveRuns: 1,
    startsPerDay: 5,
    clockMinutes: 15,
    // Sonnet class.
    leadInputUsdPerMTokMax: 3,
  },
  PLUS: {
    entitled: true,
    liveRuns: 1,
    startsPerDay: 10,
    clockMinutes: 20,
    // Opus class.
    leadInputUsdPerMTokMax: 5,
  },
  MAX: {
    entitled: true,
    liveRuns: 2,
    startsPerDay: 15,
    clockMinutes: 30,
    // Opus class.
    leadInputUsdPerMTokMax: 5,
  },
  MAX20: {
    entitled: true,
    liveRuns: 3,
    startsPerDay: 30,
    clockMinutes: 60,
    leadInputUsdPerMTokMax: null,
  },
  ULTRA: {
    entitled: true,
    liveRuns: 5,
    startsPerDay: null,
    clockMinutes: 60,
    leadInputUsdPerMTokMax: null,
  },
  OWNER: {
    entitled: true,
    liveRuns: 3,
    startsPerDay: null,
    clockMinutes: 60,
    leadInputUsdPerMTokMax: null,
  },
};

/**
 * The runaway guard for an account nothing meters (RESEARCH_V2 §6): not a
 * price list — the clock, rounds and page caps end a run long before it —
 * only the bound on a loop that never ends. $40, the old owner clamp's cap.
 */
export const UNMETERED_RESEARCH_BACKSTOP_MICRO_USD = 40_000_000;

/** What a run always leaves in the month so the person can still chat after it. */
export const CHAT_FLOOR_EUR = 0.25;
/** Estimate calibration (SPEC §14 O-6): logged per run as `research.estimate.actual`. */
export const SECONDS_PER_PAGE = 9;
export const FIXED_MINUTES = 2;
/** Pages one run may read, seed sweep and hops included — the engine's own source ceiling. */
export const MAX_RUN_PAGES = 250;

/** The smallest scope there is: what a start is checked against before the planner has run. */
export const MINIMAL_RESEARCH_SCOPE: ResearchScope = {
  questions: 1,
  breadth: "focused",
  freshness: "any",
  primarySources: false,
  quick: true,
};

// ---------------------------------------------------------------------------
// The lead's class (§9.5.1)
// ---------------------------------------------------------------------------

/**
 * Lead classes by input price per MTok, cheapest first: Haiku, Sonnet and
 * Opus class, then anything dearer. A step down moves one band.
 */
const LEAD_CLASS_BANDS = [1, 3, 5, Infinity] as const;

function leadBand(inputUsdPerMTok: number): number {
  const band = LEAD_CLASS_BANDS.findIndex((limit) => inputUsdPerMTok <= limit);
  return band === -1 ? LEAD_CLASS_BANDS.length - 1 : band;
}

/** A model the lead may be, as the catalogue describes it. */
export interface ResearchLeadCandidate {
  id: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** The catalogue's intelligence rank; higher is stronger. */
  intelligence: number;
  /** The catalogue's cost tier; ties on intelligence go to the cheaper. */
  cost: number;
}

/**
 * The lead for a plan, and the one a step down would use (§9.2, §9.5.1).
 *
 * The candidates are filtered to the plan's class; the chat's own model wins
 * when it qualifies, because the person chose it and it writes the report
 * they read; otherwise the strongest qualifying model, cheaper first among
 * equals — the ordering `researchLeadModel` has always used. The step-down is
 * the strongest candidate one class below the lead, for a month too thin for
 * the lead's own minimum run.
 */
export function researchLeadCandidates(
  candidates: readonly ResearchLeadCandidate[],
  opts: { plan: Plan; preferred?: string | null }
): { lead: ResearchLeadCandidate | null; stepDown: ResearchLeadCandidate | null } {
  const limit = RESEARCH_PLAN_CAPS[opts.plan].leadInputUsdPerMTokMax ?? Infinity;
  const strongestFirst = (a: ResearchLeadCandidate, b: ResearchLeadCandidate) =>
    b.intelligence - a.intelligence || a.cost - b.cost || a.inputUsdPerMTok - b.inputUsdPerMTok;
  const allowed = candidates.filter((model) => model.inputUsdPerMTok <= limit).sort(strongestFirst);
  const lead = allowed.find((model) => model.id === opts.preferred) ?? allowed[0] ?? null;
  if (!lead) return { lead: null, stepDown: null };
  const band = leadBand(lead.inputUsdPerMTok);
  const stepDown = band > 0 ? allowed.find((model) => leadBand(model.inputUsdPerMTok) === band - 1) ?? null : null;
  return { lead, stepDown };
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/** Sources read per question, by breadth — the same table the estimate uses. */
const SOURCES_PER_QUESTION: Record<ResearchScope["breadth"], number> = { focused: 4, broad: 8, exhaustive: 12 };
/** Results one query brings back after the merge, by breadth. The first thing a thin ceiling trims. */
const RESULTS_PER_QUERY: Record<ResearchScope["breadth"], number> = { focused: 12, broad: 20, exhaustive: 30 };
const MIN_RESULTS_PER_QUERY = 8;
const MIN_TOOL_CALLS = 12;
const MAX_TOOL_CALLS = 48;
/** One worker per three calls searches and one opens a page; the rest are find and note. */
const CALLS_PER_SEARCH = 3;
const CALLS_PER_PAGE = 3;
/**
 * A worker call's prompt on AVERAGE: half the compaction cap. The engine's
 * live guard keeps reserving at the cap itself; this is a forecast of what a
 * round costs, and a forecast at the worst case sizes every PRO run to one
 * worker.
 */
const WORKER_AVERAGE_PROMPT_CHARS = WORKER_CONTEXT_CHARS / 2 + SYSTEM_PROMPT_CHARS;
/** Tokens one worker call is allowed on average, for the envelope's token ceiling. */
const WORKER_CALL_TOKENS = Math.ceil(WORKER_AVERAGE_PROMPT_CHARS / 4) + WORKER_OUTPUT_TOKENS;
const MINUTE_MS = 60_000;
const MIN_WORKER_CLOCK_MS = 3 * MINUTE_MS;
const MAX_WORKER_CLOCK_MS = 12 * MINUTE_MS;

interface Shape {
  workers: number;
  rounds: number;
  toolCalls: number;
  resultsPerQuery: number;
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/**
 * Rounds a scope asks for. Two at least unless the planner called the request
 * quick (research protocol RULE 0.3: discoveries in round N decide the
 * searches of round N+1, so a one-round run cannot follow a single lead).
 * `fit` still takes the second round away first when the ceiling cannot pay
 * for it, and the engine only USES it when there is a lead or a gap to chase.
 */
function wantedRounds(scope: ResearchScope): number {
  if (scope.quick) return 1;
  return 2 + (scope.breadth === "exhaustive" ? 1 : 0);
}

function demandedPages(scope: ResearchScope, questions: number): number {
  return Math.min(
    MAX_RUN_PAGES,
    Math.ceil(questions * SOURCES_PER_QUESTION[scope.breadth] * (scope.primarySources ? 1.25 : 1))
  );
}

/** Pages a shape can open: the demand, or what its workers' calls reach, whichever is less. */
function pagesFor(shape: Shape, demand: number): number {
  return Math.min(demand, shape.workers * shape.rounds * Math.ceil(shape.toolCalls / CALLS_PER_PAGE));
}

/** One worker's loop, on average, at the worker's rates and the roster's price per query. */
function workerEstimate(toolCalls: number, rates: ResearchModelRates, queryMicroUsd: number): number {
  const calls = (toolCalls + 1) * modelCallEstimateMicroUsd(WORKER_AVERAGE_PROMPT_CHARS, WORKER_OUTPUT_TOKENS, rates);
  const searches = Math.ceil(toolCalls / CALLS_PER_SEARCH) * queryMicroUsd * VENDOR_ESTIMATE_MARGIN;
  const opens = Math.ceil(toolCalls / CALLS_PER_PAGE) * Math.max(pageOpenEstimateMicroUsd(rates), PAGE_FETCH_FEE_MICRO_USD);
  return calls + searches + opens;
}

interface Priced {
  total: number;
  writer: number;
  audit: number;
  pages: number;
}

function price(
  shape: Shape,
  input: { rates: ResearchRates; lead: ResearchModelRates; queryMicroUsd: number; judgeCalls: number; demand: number }
): Priced {
  const pages = pagesFor(shape, input.demand);
  const writer = writerEstimateMicroUsd(pages, input.lead);
  const audit = auditEstimateMicroUsd(input.judgeCalls, input.rates.judge);
  const fixed = plannerEstimateMicroUsd(input.lead) + shape.rounds * reviewEstimateMicroUsd(input.lead) + writer + audit;
  const team = shape.rounds * shape.workers * workerEstimate(shape.toolCalls, input.rates.worker, input.queryMicroUsd);
  return { total: Math.ceil(fixed + team), writer, audit, pages };
}

/**
 * Fits the scope's demand under the ceiling, reducing in the order the spec
 * gives: results per query first, then rounds, then tool calls per worker,
 * then workers — never below half the questions. Returns null when even the
 * floor (one round of that team) does not fit: the minimum viable run.
 */
function fit(
  demand: Shape,
  floorWorkers: number,
  ceiling: number,
  pricing: Parameters<typeof price>[1]
): { shape: Shape; priced: Priced; reduced: boolean } | null {
  const shape = { ...demand };
  let priced = price(shape, pricing);
  if (priced.total <= ceiling) return { shape, priced, reduced: false };
  shape.resultsPerQuery = MIN_RESULTS_PER_QUERY;
  for (;;) {
    priced = price(shape, pricing);
    if (priced.total <= ceiling) return { shape, priced, reduced: true };
    if (shape.rounds > 1) shape.rounds -= 1;
    else if (shape.toolCalls > MIN_TOOL_CALLS) shape.toolCalls = Math.max(MIN_TOOL_CALLS, shape.toolCalls - 4);
    else if (shape.workers > floorWorkers) shape.workers -= 1;
    else return null;
  }
}

function microUsdOfEur(eur: number, eurPerUsd: number): number {
  const rate = Number.isFinite(eurPerUsd) && eurPerUsd > 0 ? eurPerUsd : 1;
  return Math.round((eur / rate) * 1_000_000);
}

export function researchBudgetFor(input: {
  scope: ResearchScope;
  plan: Plan;
  remaining: {
    monthMicroUsd: number | null;
    monthBudgetMicroUsd: number | null;
    /** When the month resets, for the refusal line. Additive. */
    resetsAtMs?: number | null;
    /** Room left in the binding usage window (five-hour or weekly); null when unmetered (§6). */
    windowMicroUsd?: number | null;
    /** When that window frees up, for the refusal line. */
    windowResetsAtMs?: number | null;
  };
  rates: ResearchRates;
  roster: SearchRoster;
  liveRuns: number;
  startsToday: number;
  /** EUR→USD rate, passed in by the caller (`eurPerUsd()` lives in the server-only spend.ts). */
  eurPerUsd: number;
  /** The lead's model id, recorded on the envelope. Additive. */
  leadModel?: string;
  /** One class down, for a month too thin for the lead (§9.2). Additive. */
  stepDown?: { leadModel: string; rates: ResearchModelRates } | null;
  /**
   * The researchers' model, why it differs from a chosen lead, and whether
   * the lead is the person's own pick. Recorded on the envelope so every
   * view shows the models that really ran. `chosenRefused` is the model the
   * person picked when it could not lead, and why. Additive.
   */
  models?: {
    workerModel?: string | null;
    workerNote?: ResearchEnvelope["workerNote"] | null;
    chosen?: boolean;
    chosenRefused?: ResearchEnvelope["chosenRefused"] | null;
  };
}): ResearchEnvelope | ResearchBudgetRefusal {
  const caps = RESEARCH_PLAN_CAPS[input.plan];
  if (!caps.entitled) return { refused: true, reason: "plan", params: {} };
  if (input.liveRuns >= caps.liveRuns) return { refused: true, reason: "live_runs", params: { limit: caps.liveRuns } };
  if (caps.startsPerDay !== null && input.startsToday >= caps.startsPerDay) {
    return { refused: true, reason: "daily_starts", params: { limit: caps.startsPerDay } };
  }

  /*
   * ceiling = min(window left, month left − chat floor) (RESEARCH_V2 §6).
   *
   * No per-run ceiling and no share of the month any more: the owner's rule
   * is that the account's five-hour and weekly windows are the limit. The
   * window figure is the binding window's room after settled spend and open
   * holds (`checkUsageWindows`); the month keeps its chat floor so a run
   * never leaves the person unable to chat for the rest of the month.
   */
  const { monthMicroUsd } = input.remaining;
  const windowMicroUsd = input.remaining.windowMicroUsd ?? null;
  const windowCap = windowMicroUsd !== null ? windowMicroUsd : Infinity;
  const monthCap = monthMicroUsd !== null ? monthMicroUsd - microUsdOfEur(CHAT_FLOOR_EUR, input.eurPerUsd) : Infinity;
  let ceiling = Math.min(windowCap, monthCap);
  // Nothing metered (enforcement off): a runaway backstop, set high enough
  // that the run's own clock, rounds and page cap bind first. Never below
  // the app-wide unattended default.
  if (!Number.isFinite(ceiling)) ceiling = Math.max(UNMETERED_RESEARCH_BACKSTOP_MICRO_USD, UNATTENDED_RUN_DEFAULT_MICRO_USD);
  ceiling = Math.max(0, Math.floor(ceiling));
  const bound: ResearchEnvelope["limitedBy"] =
    Number.isFinite(windowCap) && windowCap <= monthCap ? "window" : Number.isFinite(monthCap) ? "month" : "scope";

  const questions = clamp(Math.floor(input.scope.questions) || 1, 1, MAX_RESEARCH_OBJECTIVES);
  const scope = { ...input.scope, questions };
  const demand = demandedPages(scope, questions);
  const rounds = wantedRounds(scope);
  const pagesPerWorkerRound = Math.ceil(demand / (questions * rounds));
  const wanted: Shape = {
    workers: questions,
    rounds,
    toolCalls: clamp(CALLS_PER_PAGE * pagesPerWorkerRound + 6, MIN_TOOL_CALLS, MAX_TOOL_CALLS),
    resultsPerQuery: RESULTS_PER_QUERY[scope.breadth],
  };
  // targetClaims = 10 × questions; the audit checks 60% of them, 8 to 40 calls.
  const judgeCalls = clamp(Math.ceil(10 * questions * 0.6), 8, 40);
  const engines = input.roster.engines.map((engine) => engine.name);
  // The fan-out calls every keyed engine for every query, so a query costs the roster's sum.
  const queryMicroUsd = input.roster.engines.reduce((sum, engine) => sum + Math.max(0, engine.microUsdPerQuery), 0);
  const floorWorkers = Math.ceil(questions / 2);

  let leadModel = input.leadModel ?? "";
  let pricing = { rates: input.rates, lead: input.rates.lead, queryMicroUsd, judgeCalls, demand };
  let fitted = fit(wanted, floorWorkers, ceiling, pricing);
  if (!fitted && input.stepDown) {
    pricing = { ...pricing, lead: input.stepDown.rates };
    fitted = fit(wanted, floorWorkers, ceiling, pricing);
    if (fitted) leadModel = input.stepDown.leadModel;
  }
  if (!fitted) {
    const params: Record<string, string | number> = {};
    const { monthBudgetMicroUsd } = input.remaining;
    if (monthMicroUsd !== null && monthBudgetMicroUsd) {
      params.shareLeft = Math.max(0, Math.round((monthMicroUsd / monthBudgetMicroUsd) * 100));
    }
    // The reset that frees the binding limit: the window's when the window binds.
    const resetsAt = bound === "window" ? input.remaining.windowResetsAtMs : input.remaining.resetsAtMs;
    if (typeof resetsAt === "number" && Number.isFinite(resetsAt)) {
      params.resetsOn = new Date(resetsAt).toISOString();
    }
    if (bound === "window") params.limit = "window";
    else if (bound === "month") params.limit = "month";
    return { refused: true, reason: "budget", params };
  }

  const { shape, priced } = fitted;
  const limitedBy: ResearchEnvelope["limitedBy"] = fitted.reduced ? bound : "scope";
  const wallClockMs = caps.clockMinutes * MINUTE_MS;
  const estimateCaps: ResearchEstimateCaps = {
    // Unreduced, the card's edits may grow the team up to the spec's own
    // bounds; reduced, the money already decided the team and the card's
    // estimate must not promise more than the envelope can buy.
    maxWorkers: fitted.reduced ? shape.workers : MAX_RESEARCH_OBJECTIVES,
    maxRounds: fitted.reduced ? shape.rounds : 3,
    maxPages: fitted.reduced ? priced.pages : MAX_RUN_PAGES,
    maxMinutes: caps.clockMinutes,
    secondsPerPage: SECONDS_PER_PAGE,
    fixedMinutes: FIXED_MINUTES,
  };
  return {
    v: 1,
    ceilingMicroUsd: ceiling,
    reserve: { writerMicroUsd: priced.writer, auditMicroUsd: priced.audit },
    workers: shape.workers,
    rounds: shape.rounds,
    toolCallsPerWorker: shape.toolCalls,
    pages: priced.pages,
    resultsPerQuery: shape.resultsPerQuery,
    engines,
    workerTokens: shape.workers * shape.rounds * (shape.toolCalls + 1) * WORKER_CALL_TOKENS,
    wallClockMs,
    workerWallClockMs: clamp(Math.floor(wallClockMs / shape.rounds), MIN_WORKER_CLOCK_MS, MAX_WORKER_CLOCK_MS),
    judgeCalls,
    leadModel,
    ...(input.models?.workerModel ? { workerModel: input.models.workerModel } : {}),
    ...(input.models?.workerNote ? { workerNote: input.models.workerNote } : {}),
    ...(input.models?.chosen ? { chosen: true } : {}),
    ...(input.models?.chosenRefused && !input.models.chosen ? { chosenRefused: input.models.chosenRefused } : {}),
    rates: { lead: pricing.lead, worker: input.rates.worker },
    limitedBy,
    estimate: estimateFor(scope, estimateCaps),
    caps: estimateCaps,
  };
}

export function isBudgetRefusal(value: ResearchEnvelope | ResearchBudgetRefusal): value is ResearchBudgetRefusal {
  return "refused" in value;
}

/** Claims the audit extracts from a report of this scope: ten per question (B22). */
export function targetClaimsFor(questions: number): number {
  return 10 * clamp(Math.floor(questions) || 1, 1, MAX_RESEARCH_OBJECTIVES);
}
