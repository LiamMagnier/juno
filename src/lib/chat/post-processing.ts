/**
 * Stage: post-processing — what still has to happen after the response settles.
 *
 * The route runs this inside `after()`, which fires once the response is done
 * *including when the client disconnected*, so the rules about what runs when
 * are easy to get subtly wrong and impossible to see from the call site.
 *
 * Two of them are load-bearing:
 *
 *  - Moderation runs whether or not generation succeeded. A policy violation in
 *    the user's message has to be caught even when the model errored — tying it
 *    to a successful answer would make erroring out a way to avoid the screen.
 *  - Memory work runs only when there IS an answer. Extracting memories from a
 *    turn that produced nothing writes facts from a conversation that, as far
 *    as the user is concerned, never happened.
 *
 * Private mode never reaches either: it has no conversation to extract from,
 * and its moderation is dispatched separately with content redacted.
 */

export interface PostGenerationPlan {
  moderates: boolean;
  extractsMemory: boolean;
  /** Periodic re-summarisation, so the memory stays deduped and tidy. */
  consolidates: boolean;
}

export function postGenerationPlan(input: {
  /** The account is subject to moderation and had text worth screening. */
  moderate: boolean;
  memoryEnabled: boolean;
  /** The assistant actually produced and persisted an answer. */
  producedAnswer: boolean;
}): PostGenerationPlan {
  const memoryWork = input.memoryEnabled && input.producedAnswer;
  return {
    moderates: input.moderate,
    extractsMemory: memoryWork,
    consolidates: memoryWork,
  };
}
