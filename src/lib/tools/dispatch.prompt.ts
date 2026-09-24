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

// ── Validation (SPEC §4.2 step 3) ───────────────────────────────────────────

export function missingFieldText(field: string): string {
  return `"${field}" is required. Nothing was run. Send the call again with it.`;
}

export function wrongTypeText(field: string, type: string): string {
  return `"${field}" must be ${type === "integer" || type === "array" || type === "object" ? "an" : "a"} ${type}. Nothing was run.`;
}

export function notInEnumText(field: string, values: readonly string[]): string {
  return `"${field}" must be one of ${values.map((v) => `"${v}"`).join(", ")}. Nothing was run.`;
}

// ── Timeouts and refusals (SPEC §4.2 steps 7–8, §2.5) ───────────────────────

export function timeoutText(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1_000));
  return `Timed out after ${seconds} s. Try a narrower request or another source.`;
}

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
