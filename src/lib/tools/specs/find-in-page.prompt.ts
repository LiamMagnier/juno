/*
 * What `find_in_page` tells the model (BRIEF §15). English, in a `*.prompt.ts`
 * file so the i18n extractor never harvests it (INV-29). Juno's lines sit
 * OUTSIDE the untrusted envelope; the page's passages sit inside it.
 */

export const EMPTY_FIND_QUERY_TEXT =
  "The query is empty. Nothing was searched. Pass the words or phrase to look for in the page.";

export const FIND_UNAVAILABLE_TEXT =
  "Searching inside web pages is not available in this conversation. Nothing was searched. Answer from what you have.";

export function foundLine(url: string, query: string, n: number, total: number): string {
  return `Searched ${url} for "${query}": ${n === 0 ? "no matching passage" : `${n} passage${n === 1 ? "" : "s"}`} in ${total.toLocaleString("en-US")} characters.`;
}

export function passageLine(offset: number, kind: "exact" | "terms", text: string): string {
  return `[offset ${offset}${kind === "exact" ? ", exact match" : ""}] ${text}`;
}

export const OPEN_AT_OFFSET_LINE =
  "To read around a passage, call web_fetch with this URL and its offset. Quote only what the passages say.";

export const NO_MATCH_LINE =
  "Nothing in the page matches. Try other words, or open the page with web_fetch and read it.";

export const FIND_BUDGET_SPENT_LINE =
  "This turn's reading budget is spent, so the passages are cut. Answer from what you have.";

export function findSourceLabel(url: string): string {
  return `passages of web page ${url}`;
}
