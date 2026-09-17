/**
 * Delegating a sentence typed in a chat, decided as pure functions.
 *
 * Two questions live here, both of which the chat composer has to answer while
 * somebody is still typing, and neither of which may involve a round trip:
 *
 *   1. Does this sentence look like an errand rather than a question — enough
 *      to OFFER running it as a task?
 *   2. While a task on this conversation is live, what does pressing send do?
 *
 * Kept out of the composer, and out of `inference.ts`, for the reason
 * `domain.ts` gives about itself: a decision worth being sure about belongs
 * somewhere a test can reach without a browser, a database, or React. The
 * composer imports these; `tests/work-in-chat.test.ts` imports them too.
 */

import { inferCapabilities, type CapabilityInference } from "@/lib/work/inference";
import { describeCapability, isTerminalStatus, type WorkStatus } from "@/lib/work/domain";

// ---------------------------------------------------------------------------
// Offering
// ---------------------------------------------------------------------------

/**
 * The capabilities that mean a sentence has a FINISH LINE.
 *
 * `inferCapabilities` reads eight things out of a goal and most of them are not
 * evidence of delegation at all: "research the new EU battery rules" infers
 * `web_research` and is a question that wants an answer in the next thirty
 * seconds, not a run with a budget. Two of the eight are different. A
 * `deliverables` match means the sentence names a document to be produced — a
 * report, a spreadsheet, a deck — and a `background_continuation` match means it
 * names a stretch of time to work across. Both describe something that ENDS with
 * a thing that exists, which is what a delegated run is for.
 */
const FINISH_LINE_CAPABILITIES = ["deliverables", "background_continuation"] as const;

/**
 * Verbs that put something outside Juno, in someone else's hands.
 *
 * A connector match on its own is far too weak to offer on — "what did Linear
 * say about the migration" names a connector and wants a reply — so the second
 * arm of the rule needs a connector AND a verb that acts through it. These are
 * the verbs that make the difference between reading an app and using one.
 */
const SENDING_VERB =
  /\b(?:send|email|e-mail|post|publish|file|upload|schedule|invite|reply|respond|share|assign|create|open a (?:pr|pull request|ticket|issue))\b/i;

export interface DelegationOffer {
  /** The caption under the field. One sentence, phrased as a reading. */
  caption: string;
  /** What the chip says. It arms the pill; it never sends. */
  chip: string;
}

/**
 * Whether to offer this sentence as a task, and what to say if so.
 *
 * ONE caption with ONE chip, or nothing at all. The asymmetry argument at the
 * top of `inference.ts` is the reason this is deliberately hard to trigger: a
 * wrong guess about a local capability blocks somebody, and a wrong guess HERE
 * would spend a run ceiling — real money, on a clock — on a sentence that wanted
 * a reply. So the offer only appears where the sentence names something that
 * finishes, and even then it only ARMS the pill. Deciding for the reader is not
 * something this product does; suggesting is.
 *
 * Null for a goal that reads as a question, for an empty draft, and for anything
 * short enough that the reader is still typing the verb.
 */
export function delegationOffer(goal: string): DelegationOffer | null {
  const text = goal.trim();
  // Under this, every sentence is still being written and any reading of it is a
  // reading of a fragment. The number is a floor on evidence, not on effort:
  // "draft the Q3 board memo" is 25 characters and is exactly the case this
  // exists for.
  if (text.length < 20) return null;

  const inference = inferCapabilities(text);
  const found = new Set<string>(inference.capabilities);
  const hasFinishLine = FINISH_LINE_CAPABILITIES.some((capability) => found.has(capability));
  const actsThroughAnApp = found.has("connectors") && SENDING_VERB.test(text);
  if (!hasFinishLine && !actsThroughAnApp) return null;

  return {
    caption: `${offerReading(inference)} Run it as a task?`,
    chip: "Run as a task",
  };
}

/**
 * The reading half of the caption.
 *
 * `describeInference` in `inference.ts` writes the same sentence for the /work
 * composer and this deliberately does not reuse it: that one names EVERY
 * capability the regexes matched, which on a delegable sentence is routinely
 * four of them and reads as a system report. The offer names at most two, and
 * they are the two that argued for the offer.
 */
function offerReading(inference: CapabilityInference): string {
  const named = inference.capabilities
    .filter(
      (capability) =>
        (FINISH_LINE_CAPABILITIES as readonly string[]).includes(capability) ||
        capability === "connectors"
    )
    .slice(0, 2)
    .map(describeCapability);
  if (named.length === 0) return "This looks like a job rather than a question.";
  if (named.length === 1) return `Looks like this needs ${named[0]}.`;
  return `Looks like this needs ${named[0]} and ${named[1]}.`;
}

// ---------------------------------------------------------------------------
// Typing at a run that is already going
// ---------------------------------------------------------------------------

/**
 * What the chat composer's send does while a delegated run is on the
 * conversation.
 *
 *   answer — the run asked something and is parked until it is told. `POST
 *            /answer` refuses an unprompted instruction while a question is
 *            open, on purpose: the runner reads the newest `question_answered`
 *            on the run, so an instruction recorded on top of an answer would
 *            leave it waiting for a reply it had already been given.
 *   steer  — the run is working, and words go in front of it before its next
 *            step.
 *   null   — there is no live run, and the composer is an ordinary chat box.
 *
 * A paused run steers rather than answers and that is correct: the instruction
 * is recorded on the task and read when it resumes. A terminal run takes
 * nothing, because nothing is listening — restarting it is a decision, and the
 * decision belongs on a button rather than in a box somebody typed into.
 */
export type DelegatedComposerMode =
  | { kind: "answer"; questionId: string; question: string }
  | { kind: "steer" };

export function delegatedComposerMode(input: {
  status: WorkStatus | null;
  /** The oldest question still open, which is the one blocking. */
  openQuestion: { id: string; question: string } | null;
}): DelegatedComposerMode | null {
  if (input.status === null) return null;
  if (input.openQuestion !== null) {
    return {
      kind: "answer",
      questionId: input.openQuestion.id,
      question: input.openQuestion.question,
    };
  }
  if (isTerminalStatus(input.status)) return null;
  if (input.status === "draft") return null;
  return { kind: "steer" };
}

/**
 * What the field says it will do with what is typed into it.
 *
 * The placeholder is the only thing on the surface that distinguishes the two
 * sends, so it names the destination rather than describing the box. A composer
 * whose placeholder never changed while a run was waiting on an answer was the
 * whole of finding (c): the reader typed the answer, and it went nowhere.
 */
export function delegatedComposerPlaceholder(mode: DelegatedComposerMode): string {
  return mode.kind === "answer"
    ? "Answer Juno’s question…"
    : "Add an instruction to the running task…";
}

// ---------------------------------------------------------------------------
// Pressing the button twice
// ---------------------------------------------------------------------------

/** Everything a delegated draft is created with, as the chat composer hands it over. */
export interface DelegationInputs {
  goal: string;
  /** How often the run stops to ask, exactly as the armed pill states it. */
  permissionPolicy: string;
  /** The connected apps this task may reach. Empty is an answer: it reaches none. */
  connectorIds: readonly string[];
  attachmentIds: readonly string[];
  projectId: string | null;
  model: string;
  reasoningEffort: string | null;
}

/**
 * One press's inputs, as a string two presses can be compared on.
 *
 * A dispatch is two calls — create the draft, then start a run on it — and the
 * second press after a failed start deliberately REUSES the draft the first one
 * created, so a refused start does not leave an orphan in the reader's list.
 * That reuse is only honest while the inputs have not moved, and the goal alone
 * does not say whether they have: the "+" menu can change the approval mode, add
 * or remove a connector, take a file back off, or switch the project, all
 * without touching a character of the sentence. Keyed on the goal alone, a
 * reader who is refused, opens the menu, switches "How often it asks" from Ask
 * to Manual and presses again gets the first press's permission policy under the
 * second press's button — while the pill beside `+` and the disclosure line under
 * the field both state the new one. A permission control that reads one way and
 * acts another is the worst thing on this surface, so everything the create
 * carries is in the key and a change to any of it mints a fresh pair of
 * idempotency keys.
 *
 * The two id lists are sorted because what the create carries is a SET of
 * grants: the same three files and the same two apps in a different order are
 * the same permission surface, and this composer exposes no way to reorder
 * either deliberately.
 */
export function delegationAttemptKey(inputs: DelegationInputs): string {
  return JSON.stringify([
    inputs.goal.trim(),
    inputs.permissionPolicy,
    [...inputs.connectorIds].sort(),
    [...inputs.attachmentIds].sort(),
    inputs.projectId,
    inputs.model,
    inputs.reasoningEffort,
  ]);
}

// ---------------------------------------------------------------------------
// Finding the run again
// ---------------------------------------------------------------------------

/**
 * Whether a task the discovery poll just found should become the one the
 * transcript draws.
 *
 * A `draft` is refused. That status means the create landed and the dispatch did
 * not — the second half of a press that was blocked or lost its connection — and
 * a session that has never had a run has nothing for the panel to draw: no
 * current action, no plan, no run, no meter, and no composer mode either, since
 * a draft takes neither an answer nor an instruction. Adopted, it puts an empty
 * task panel in the reader's transcript with no way to start it and no way to
 * get rid of it. The session a press has just dispatched does not come through
 * here — it is adopted directly, keys and all — so this costs that path nothing.
 *
 * Everything else, including a task already on screen, is returned unchanged
 * when it is the same row: re-adopting an identical session would reset the
 * event cursor and replay the run from zero every four seconds.
 */
export function adoptDiscoveredSession<T extends { id: string; status: WorkStatus }>(
  current: T | null,
  discovered: T | null
): T | null {
  if (current !== null && discovered !== null && current.id === discovered.id) return current;
  if (discovered !== null && discovered.status === "draft") return current;
  return discovered;
}
