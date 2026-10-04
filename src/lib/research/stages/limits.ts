/*
 * Research engine — cost estimates and corpus limits every stage sizes against.
 * Split out of engine.ts; the budget tests assert boundaries relative to these.
 */
import {
  BRIEF_OUTPUT_TOKENS,
  BRIEF_PROMPT_CHARS,
  CLARIFY_OUTPUT_TOKENS,
  CLARIFY_PROMPT_CHARS,
  CORPUS_PER_SOURCE_CHARS,
  CORPUS_PREAMBLE_CHARS,
  EXPANSION_OUTPUT_TOKENS,
  EXPANSION_PROMPT_CHARS,
  JUDGE_OUTPUT_TOKENS,
  JUDGE_PASSAGE_CHARS,
  JUDGE_PROMPT_OVERHEAD_CHARS,
  MAX_JUDGE_CALLS,
  PAGE_FETCH_FEE_MICRO_USD,
  PLANNER_OUTPUT_TOKENS,
  PLANNER_PROMPT_CHARS,
  RESEARCH_SNAPSHOT_CHARS,
  REVISION_REPORT_CHARS,
  type ResearchPlan,
  SEARCH_FEE_MICRO_USD,
  SYNTHESIS_OUTPUT_TOKENS,
  SYSTEM_PROMPT_CHARS,
  VENDOR_ESTIMATE_MARGIN,
  modelCallEstimateMicroUsd,
} from "@/lib/research/domain";
import type { ResearchSourceRow } from "./types";

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
export const MAX_READ_SOURCES = 250;

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
export const FETCH_PER_HOST = 2;
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
export const DEEPEN_BELOW_CHARS = 2_000;
/** How many previews one run will pay to turn into real pages. */
export const MAX_DEEPENED_SOURCES = 40;
export const PASSAGE_CHARS = 1_200;
export const MAX_PASSAGES_PER_SOURCE = 6;
/** Guard against a driver looping forever on a state that never advances. */
export const MAX_STEPS = 40;
/** The goal is a prompt, not an essay; the column is Text but the bill is not. */
export const MAX_GOAL_CHARS = 8_000;

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
export const READ_CONCURRENCY = 8;
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
export const MAX_HOP_SOURCES = 24;
/**
 * How much of a link's anchor text has to be about an unmet objective.
 *
 * Anchor text is short, so this is measured as the fraction of the ANCHOR's
 * tokens that appear in the objective rather than the other way round — "read
 * the full 2024 methodology" scores well against a methodology question, while
 * "privacy policy" scores zero against everything.
 */
export const HOP_MIN_OVERLAP = 0.34;

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
