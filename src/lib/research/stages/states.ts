/*
 * Research engine — the state sets the engine's controls act on (pause,
 * cancel, refetch) and the refusal copy a sized-out run records. Split out of
 * engine.ts.
 */
import { RESEARCH_LIVE_STATES, type ResearchState, isPausable } from "@/lib/research/domain";
import { RESEARCH_REFUSAL_COPY } from "@/lib/research/entitlement";
import type { ResearchBudgetRefusal } from "@/lib/research/envelope";

/**
 * Derived from the live set rather than listed, so a state added to `domain.ts`
 * is pausable and cancellable the day it ships. That is the safe direction:
 * the cost of being able to stop something unexpected is a run that stops, and
 * the cost of the other mistake is a user watching a run they cannot interrupt.
 */
export const LIVE_PAUSABLE: ResearchState[] = RESEARCH_LIVE_STATES.filter((state) => isPausable(state));

export const REFUSAL_ERROR: Record<ResearchBudgetRefusal["reason"], string> = RESEARCH_REFUSAL_COPY.reasons;

/** Every live state — exactly the set a cancel must win from. */
export const RESEARCH_CANCELLABLE: ResearchState[] = [...RESEARCH_LIVE_STATES];

/**
 * States from which a newly pinned source sends the run back to gathering.
 *
 * Everything after the reading stage and before the report: at that point the
 * source can still change what the report says, and adding it without a round
 * trip would give the user a citation-shaped promise the corpus cannot keep.
 * Once synthesis has produced a report the constraint is still recorded but
 * the run is left alone — see `steer`.
 */
export const REFETCH_FROM: ResearchState[] = [
  "reviewing",
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
