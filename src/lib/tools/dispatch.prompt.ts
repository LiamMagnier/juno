/*
 * What the dispatcher tells the model when a call cannot run or does not end
 * well (chat-rework SPEC §4.2 steps 1, 2, 3, 8 and 9). English, in a
 * `*.prompt.ts` file so the i18n extractor never harvests it. Each says what
 * happened and what to do next: an error the model can act on is a result, not
 * a dead end.
 */

export function invalidJsonText(parserMessage: string): string {
  return `The arguments were not valid JSON (${parserMessage}). Nothing was run. Send the call again with a JSON object that matches the tool's schema.`;
}

export const NOT_AN_OBJECT_TEXT =
  "The arguments were not a JSON object. Nothing was run. Send the call again with a JSON object that matches the tool's schema.";

export function unknownToolText(name: string): string {
  return `There is no tool named "${name}". Nothing was run. Use only the tools you were given.`;
}

export function missingFieldText(field: string): string {
  return `"${field}" is required. Nothing was run. Send the call again with it.`;
}

export function wrongTypeText(field: string, type: string): string {
  const article = type === "integer" || type === "array" || type === "object" ? "an" : "a";
  return `"${field}" must be ${article} ${type}. Nothing was run.`;
}

export function notInEnumText(field: string, values: readonly string[]): string {
  return `"${field}" must be one of ${values.map((v) => `"${v}"`).join(", ")}. Nothing was run.`;
}

export function unknownKeyText(field: string, known: readonly string[]): string {
  const list = known.length ? ` The parameters are: ${known.map((k) => `"${k}"`).join(", ")}.` : " This tool takes no parameters.";
  return `"${field}" is not a parameter of this tool. Nothing was run.${list}`;
}

export function toolErrorText(message: string): string {
  return `Tool error: ${message}`;
}

/**
 * A timed-out READ is simply over. A call that may change something is not
 * known to have done nothing: the remote side can finish after we stop
 * waiting, so the model is told to check before it repeats it — "did not
 * finish" there is a claim that invites a second, real execution.
 */
export function timeoutText(timeoutMs: number, mayHaveTakenEffect = false): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1_000));
  return mayHaveTakenEffect
    ? `Timed out after ${seconds} s. It may still have taken effect: check before running it again.`
    : `Timed out after ${seconds} s. Try a narrower request or another approach.`;
}

export const CANCELLED_BEFORE_RUN_TEXT = "The call was cancelled before it ran: the user stopped the reply.";

export const CANCELLED_WHILE_RUNNING_TEXT =
  "The call was cancelled while it ran: the user stopped the reply. Whatever it was doing did not finish.";

/** Stopped mid-run, for a call that may change something: its effect is not known. */
export const CANCELLED_WHILE_RUNNING_EFFECT_TEXT =
  "The call was cancelled while it ran: the user stopped the reply. It may have partly or fully taken effect: check before running it again.";

/**
 * A native or Alevr tool THREW. That is a bug or an infrastructure failure,
 * not an answer, and its message (a database error, an internal path) is not
 * the model's or the person's to read; it is logged server-side instead.
 */
export function internalToolErrorText(mayHaveTakenEffect: boolean): string {
  return mayHaveTakenEffect
    ? "The tool failed with an internal error. It may have partly taken effect: check before running it again."
    : "The tool failed with an internal error. Try again later or another approach.";
}

export function tooManyCallsText(limit: number): string {
  return `Too many calls in one response: only the first ${limit} were considered, and this one was not run. Send it again in your next step if you still need it.`;
}

export function oversizedResultText(chars: number, limit: number): string {
  return `The tool's output was ${chars} characters long, over the ${limit}-character limit, so it was withheld. Ask for a smaller part of it.`;
}

/**
 * Appended (outside any envelope) to a result served from the turn's duplicate
 * cache. Without it a model polling a status ("is the deploy done yet?") reads
 * the first answer again and again as if it were fresh, and loops until its
 * rounds run out.
 */
export const CACHED_RESULT_NOTE =
  "[This is the result of an identical call made earlier in this reply; it was not run again. To see a newer state, change the request or do something else first.]";

export const NO_RESULT_TEXT = "The call returned no result, so nothing is known about its outcome.";

export const DENIED_TEXT =
  "The user declined this call. Nothing was run. Do not call it again with the same arguments; answer without it, or ask the user what they want instead.";

export const EXPIRED_TEXT =
  "The approval request for this call expired before the user answered. Nothing was run. Answer without it, or ask the user whether to try again.";

export function blockedText(reason: string): string {
  return `This call is blocked by the user's settings (${reason}). Nothing was run. Answer without it.`;
}

export function notPermittedText(reason: string): string {
  return `This call was not permitted (${reason}). Nothing was run. Answer without it.`;
}

export const BROKER_UNAVAILABLE_TEXT =
  "Juno could not verify permission for this call, so it was not run. Answer without it.";
