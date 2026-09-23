/**
 * Sizing a research run (SPEC §9.2): the planner's scope, the plan's caps and
 * the month's remaining budget become one frozen envelope — workers, rounds,
 * pages, clocks, judge calls and the spend ceiling — or a refusal with a
 * reason. There are no depth levels; the scope is the only dial (DECISIONS R1).
 *
 * Pure: the EUR→USD rate is an input, so this file never imports the
 * server-only spend module. WS0 lands the types and the signature; WS7
 * implements the sizing, the plan caps and the legacy `plan.budget` it writes
 * for the previous build (INV-22).
 */

import type { Plan } from "@prisma/client";

import type { ResearchModelRates } from "@/lib/research/domain";
import type { ResearchEstimate, ResearchEstimateCaps, ResearchScope } from "@/types/research";

export type { ResearchEstimateCaps, ResearchScope } from "@/types/research";

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
  leadModel: string;                         // model id
  limitedBy: "scope" | "plan" | "month" | "window";
  estimate: ResearchEstimate;
  caps: ResearchEstimateCaps;                // what the client needs to recompute the estimate
}

export type ResearchBudgetRefusal = {
  refused: true;
  reason: "plan" | "live_runs" | "daily_starts" | "budget";
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

export function researchBudgetFor(_input: {
  scope: ResearchScope;
  plan: Plan;
  remaining: { monthMicroUsd: number | null; monthBudgetMicroUsd: number | null };
  rates: ResearchRates;
  roster: SearchRoster;
  liveRuns: number;
  startsToday: number;
  /** EUR→USD rate, passed in by the caller (`eurPerUsd()` lives in the server-only spend.ts). */
  eurPerUsd: number;
  overrideCeilingMicroUsd?: number | null;   // RESEARCH_CHAT_BUDGET_USD, owner clamp only
}): ResearchEnvelope | ResearchBudgetRefusal {
  throw new Error("not implemented: WS7");
}
