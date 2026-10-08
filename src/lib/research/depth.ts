/**
 * Adaptive depth: more rounds and pages for hard questions, within explicit
 * ceilings and the account's usage windows; an early stop when a round
 * stopped finding anything new.
 *
 * The envelope (`envelope.ts`) sizes a run at confirmation from the
 * planner's scope, before anything is known about how hard the evidence is
 * to find. A question with five vectors, sources that disagree and figures
 * still missing after the planned rounds then wrote its report anyway, having
 * read a few dozen pages where the market's deep-research products read
 * hundreds. There is no per-run money limit to protect (commit 68a5282f: the
 * five-hour and weekly windows are the limit), so what keeps this honest is:
 *
 * - it is earned: an extension needs a hard question (`hardness`) AND a last
 *   round that was still finding new facts (not saturated);
 * - it is bounded: at most `MAX_EXTRA_ROUNDS` rounds beyond the envelope,
 *   never past `MAX_RESEARCH_ROUNDS`, pages at most +50% of the envelope and
 *   never past `MAX_RUN_PAGES`, worker tokens in proportion to the rounds;
 *   the wall clock is the plan's and is never extended;
 * - it is paid for up front: the engine only extends when the ceiling (the
 *   binding usage window's room, frozen on the envelope) can pay for another
 *   round with the writer's and the audit's reserve still held back, and a
 *   spent window or "Finish now" still ends the rounds at the next boundary.
 *
 * Pure: the engine (`stages/workers.ts`) gathers the signals and the money
 * check and records the decision on the plan (`ResearchPlan.depth`), where
 * `planBudget` adds it to the envelope's limits so a resumed run keeps it.
 */

import type { ResearchDepthExtension, ResearchPlan } from "@/lib/research/domain";
import { unitFigures } from "@/lib/research/metric-match";

/** Rounds one run may add beyond its envelope. */
export const MAX_EXTRA_ROUNDS = 2;
/** Pages one run may add, as a share of its envelope's pages. */
export const EXTRA_PAGE_SHARE = 0.5;
/** Pages one extension adds at least (a small envelope still gets a real round). */
export const MIN_EXTRA_PAGES = 12;
/** Score at which a question counts as hard. */
export const HARD_SCORE = 3;

export interface DepthSignals {
  /** Vectors (sub-questions) in the plan. */
  vectors: number;
  /** Conflicting figures the gap audit found. */
  conflicts: number;
  /** Figures still missing (per option included). */
  missingFigures: number;
  /** Claims still unverified. */
  unverified: number;
  /** Leads the last round opened. */
  leads: number;
  /** Findings recorded in the last round. */
  roundFindings: number;
  /** Findings on pages no earlier finding cited, in the last round. */
  newClaims: number;
  /** Figures in the last round's findings that no earlier finding stated. */
  newFigures: number;
  /** All findings so far. */
  findings: number;
  /** The round just finished (1-based). */
  round: number;
}

/** How hard the question is proving, with the reasons a person can read. */
export function hardness(signals: DepthSignals): { score: number; hard: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (signals.vectors >= 5) {
    score += 1;
    reasons.push(`${signals.vectors} vectors`);
  }
  if (signals.conflicts > 0) {
    score += Math.min(2, signals.conflicts);
    reasons.push(`${signals.conflicts} conflicting figure${signals.conflicts === 1 ? "" : "s"}`);
  }
  if (signals.missingFigures >= 3) {
    score += signals.missingFigures >= 6 ? 2 : 1;
    reasons.push(`${signals.missingFigures} figures still missing`);
  }
  if (signals.unverified >= 2) {
    score += 1;
    reasons.push(`${signals.unverified} claims unverified`);
  }
  if (signals.leads >= 3) {
    score += 1;
    reasons.push(`${signals.leads} open leads`);
  }
  return { score, hard: score >= HARD_SCORE, reasons };
}

/** Share of a round's findings that must be new for the round to count as productive. */
const SATURATED_BELOW = 0.1;

/**
 * Whether the last round stopped finding anything new: almost no new pages
 * cited, or no new figures and few new pages. The first round is never
 * saturated (there is nothing before it to repeat).
 */
export function saturated(signals: Pick<DepthSignals, "round" | "roundFindings" | "newClaims" | "newFigures" | "findings">): boolean {
  if (signals.round <= 1) return false;
  if (signals.roundFindings === 0) return true;
  if (signals.newClaims < Math.max(1, signals.findings * SATURATED_BELOW)) return true;
  return signals.newFigures === 0 && signals.newClaims < signals.roundFindings / 2;
}

/** Figures (value + unit basis) in the round's findings that earlier findings did not state. */
export function newFigureCount(
  roundClaims: readonly string[],
  earlierClaims: readonly string[]
): number {
  const key = (f: ReturnType<typeof unitFigures>[number]) =>
    `${f.kind}:${f.currency ?? ""}:${f.period ?? ""}:${Number(f.value.toPrecision(3))}`;
  const seen = new Set(earlierClaims.flatMap((claim) => unitFigures(claim).map(key)));
  const fresh = new Set<string>();
  for (const claim of roundClaims) for (const figure of unitFigures(claim)) if (!seen.has(key(figure))) fresh.add(key(figure));
  return fresh.size;
}

export type DepthExtension = ResearchDepthExtension;

/**
 * The next extension, or null. One round at a time: each extension is
 * decided at the end of the round that would otherwise have been the last,
 * on that round's evidence.
 */
export function nextExtension(input: {
  signals: DepthSignals;
  envelope: { rounds: number; pages: number; workerTokens: number };
  current: DepthExtension | null | undefined;
  /** The engine's own round and page caps (MAX_RESEARCH_ROUNDS, MAX_RUN_PAGES). */
  maxRounds: number;
  maxPages: number;
  now: Date;
}): DepthExtension | null {
  const { signals, envelope } = input;
  const current = input.current ?? { extraRounds: 0, extraPages: 0, extraTokens: 0, reasons: [], at: "" };
  if (current.extraRounds >= MAX_EXTRA_ROUNDS) return null;
  if (envelope.rounds + current.extraRounds + 1 > input.maxRounds) return null;
  if (saturated(signals)) return null;
  const verdict = hardness(signals);
  if (!verdict.hard) return null;
  const pageCap = Math.min(input.maxPages, Math.floor(envelope.pages * (1 + EXTRA_PAGE_SHARE)));
  const perRound = Math.max(MIN_EXTRA_PAGES, Math.ceil((envelope.pages * EXTRA_PAGE_SHARE) / MAX_EXTRA_ROUNDS));
  const extraPages = Math.max(0, Math.min(pageCap - envelope.pages, current.extraPages + perRound));
  const tokensPerRound = Math.ceil(envelope.workerTokens / Math.max(1, envelope.rounds));
  return {
    extraRounds: current.extraRounds + 1,
    extraPages,
    extraTokens: current.extraTokens + tokensPerRound,
    reasons: verdict.reasons,
    at: input.now.toISOString(),
  };
}

/** The run's footprint, for the methodology: what was found, what was read, how. */
export interface ResearchFootprint {
  /** Distinct sources the searches and links surfaced. */
  found: number;
  /** Pages the run fetched and read itself. */
  read: number;
  /** Sources with text the report may cite. */
  citable: number;
  searches: number;
  rounds: number;
  /** Rounds added for a hard question, and why. */
  extended?: { rounds: number; reasons: string[] };
}

export function footprintLines(footprint: ResearchFootprint): string[] {
  return [
    `Sources found: ${footprint.found}`,
    `Pages read in full: ${footprint.read}`,
    `Sources with text available to cite: ${footprint.citable}`,
    `Searches run: ${footprint.searches}`,
    `Research rounds: ${footprint.rounds}${footprint.extended ? ` (${footprint.extended.rounds} added for a hard question: ${footprint.extended.reasons.join(", ")})` : ""}`,
  ];
}

/** The footprint from a run's plan: `found` is every source row, `citable` the rows with text. */
export function footprintOf(plan: ResearchPlan, found: number, citable: number): ResearchFootprint {
  const read = (plan.seedPagesRead ?? 0) + (plan.rounds ?? []).reduce((n, round) => n + round.pagesRead, 0);
  const searches = new Set([...(plan.issuedQueries ?? []), ...(plan.workerQueries ?? [])].map((query) => query.toLowerCase())).size;
  return {
    found: Math.max(found, citable),
    read,
    citable,
    searches,
    rounds: plan.rounds?.length ?? 0,
    ...(plan.depth ? { extended: { rounds: plan.depth.extraRounds, reasons: plan.depth.reasons } } : {}),
  };
}
