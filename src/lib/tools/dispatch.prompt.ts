/*
 * What the dispatcher tells the model when a call cannot run or fails
 * (SPEC §4.2 steps 1, 2, 8 and 9). English, and in a `*.prompt.ts` file so the
 * i18n extractor never harvests it (INV-29). Each one says what happened and
 * what to do next: an error the model can act on is a result, not a dead end.
 */

export function invalidJsonText(parserMessage: string): string {
  return `The arguments were not valid JSON (${parserMessage}). Nothing was run. Send the call again with a JSON object that matches the tool's schema.`;
}

export const NOT_AN_OBJECT_TEXT =
  "The arguments were not a JSON object. Nothing was run. Send the call again with a JSON object that matches the tool's schema.";

export function unknownToolText(name: string): string {
  return `There is no tool named "${name}". Use only the tools you were given.`;
}

export function toolErrorText(message: string): string {
  return `Tool error: ${message}`;
}

export const CANCELLED_BEFORE_RUN_TEXT = "The call was cancelled before it ran.";

export const CANCELLED_WHILE_RUNNING_TEXT = "The call was cancelled while it ran.";
