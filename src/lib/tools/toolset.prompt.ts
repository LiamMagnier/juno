/*
 * What the chat toolset tells the model when a call reaches it by a path it
 * does not serve (SPEC §3.7). English, in a `*.prompt.ts` file so the i18n
 * extractor never harvests it (INV-29).
 */

export function unknownToolText(name: string): string {
  return `There is no tool named "${name}". Use only the tools you were given.`;
}

export const NOT_DISPATCHED_TEXT =
  "This tool could not be run on this path, so nothing was run. Answer without it.";
