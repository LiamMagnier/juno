/**
 * A task on a chat, decided as pure functions.
 *
 * The model starts a task from a chat turn (the `start_task` tool); nothing in
 * the composer arms one any more. What is left for the client to decide is
 * what the chat does once a task is attached to it:
 *
 *   1. While the task is live, what does pressing send do?
 *   2. When the discovery poll finds a task, should the transcript draw it?
 *
 * Kept out of the composer for the reason `domain.ts` gives about itself: a
 * decision worth being sure about belongs somewhere a test can reach without a
 * browser, a database, or React. `use-conversation-work.ts` and the chat view
 * import these; `tests/work-in-chat.test.ts` imports them too.
 */

import { isTerminalStatus, type WorkStatus } from "@/lib/work/domain";
import { PRODUCT_NAME } from "@/lib/brand/names";

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
export function delegatedComposerPlaceholder(mode: DelegatedComposerMode, taskTitle?: string | null): string {
  // With several tasks live the field says which one it goes to; with one, the
  // sentence it always said.
  const title = taskTitle?.replace(/\s+/g, " ").trim();
  if (title) {
    return mode.kind === "answer" ? `Answer the question from “${title}”…` : `Add an instruction to “${title}”…`;
  }
  return mode.kind === "answer"
    ? `Answer ${PRODUCT_NAME}’s question…`
    : "Add an instruction to the running task…";
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
 * get rid of it. A task the model has just started does not come through here:
 * the stream hands it over already dispatched and it is adopted directly, so
 * this costs that path nothing.
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
