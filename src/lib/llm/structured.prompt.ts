/*
 * Model-facing text for structured output through a tool (SPEC §5.0
 * `responseSchema`). English, and in a `*.prompt.ts` file so the i18n extractor
 * never harvests it (INV-29, SPEC §10.5).
 *
 * Anthropic has no forced choice on its newest models (a forced `any`/`tool`
 * choice is a 400 on Fable 5.1 and Opus 5.5), so the schema is offered as one
 * tool under `tool_choice: auto` and these lines are how the model is steered
 * to it — once, when it answers in prose instead or sends arguments that do not
 * match.
 */

export function structuredToolDescription(name: string): string {
  return `Return your complete answer by calling ${name} once, with arguments that match its schema exactly. Do not write the answer as text.`;
}

export function structuredNudgeText(name: string): string {
  return `Call the ${name} tool now, with your complete answer as its arguments. Do not reply with text.`;
}

export function structuredInvalidText(issue: string): string {
  return `The arguments did not match the schema: ${issue}. Call the tool again with corrected arguments.`;
}
