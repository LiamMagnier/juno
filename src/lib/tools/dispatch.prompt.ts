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

export function timeoutText(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1_000));
  return `Timed out after ${seconds} s. Try a narrower request or another approach.`;
}

export const CANCELLED_BEFORE_RUN_TEXT = "The call was cancelled before it ran: the user stopped the reply.";

export const CANCELLED_WHILE_RUNNING_TEXT =
  "The call was cancelled while it ran: the user stopped the reply. Whatever it was doing did not finish.";

export const NO_RESULT_TEXT = "The call returned no result, so nothing is known about its outcome.";
