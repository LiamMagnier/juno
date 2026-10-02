/**
 * The scope card's estimate line: "About 12 min · reads up to ~150 pages"
 * (SPEC §9.2, DECISIONS §4b). Time and pages only; never money.
 *
 * The server computes the same figure when it sizes a run and sends `caps`
 * with the plan, so the card can recompute it on every edit without asking the
 * server. Pure and client-safe; the scope card imports this file, never
 * `envelope.ts`.
 */

import type { ResearchEstimate, ResearchEstimateCaps, ResearchScope } from "@/types/research";

/** Sources read per question, by breadth. */
const SOURCES_PER_QUESTION: Record<ResearchScope["breadth"], number> = {
  focused: 4,
  broad: 8,
  exhaustive: 12,
};

/** Primary sources take longer to find and read; the demand grows by a quarter. */
const PRIMARY_SOURCES_FACTOR = 1.25;

const MAX_QUESTIONS = 8;

function atLeastOne(n: number): number {
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
}

/**
 * Demand from the scope (one worker per question; a round more for broad and
 * another for exhaustive; pages by breadth), clamped to the caps, then:
 *
 *   minutesUpTo = ceil(fixedMinutes + rounds × (pagesPerRound × secondsPerPage / 60) / workers)
 *
 * clamped to the plan clock, and `pagesUpTo` = the pages. `quick` does not
 * change the estimate: a quick scope is already small in every term above.
 */
export function estimateFor(scope: ResearchScope, caps: ResearchEstimateCaps): ResearchEstimate {
  const questions = Math.min(MAX_QUESTIONS, atLeastOne(scope.questions));
  const workers = Math.min(questions, atLeastOne(caps.maxWorkers));
  const wantedRounds = 1 + (scope.breadth !== "focused" ? 1 : 0) + (scope.breadth === "exhaustive" ? 1 : 0);
  const rounds = Math.min(wantedRounds, atLeastOne(caps.maxRounds));
  const wantedPages = Math.ceil(
    questions * SOURCES_PER_QUESTION[scope.breadth] * (scope.primarySources ? PRIMARY_SOURCES_FACTOR : 1),
  );
  const pages = Math.max(0, Math.min(wantedPages, Math.floor(caps.maxPages)));
  const pagesPerRound = pages / rounds;
  const minutes = Math.ceil(caps.fixedMinutes + (rounds * ((pagesPerRound * caps.secondsPerPage) / 60)) / workers);
  return {
    minutesUpTo: Math.max(1, Math.min(minutes, atLeastOne(caps.maxMinutes))),
    pagesUpTo: pages,
  };
}
