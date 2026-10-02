/*
 * What `web_search` tells the model (SPEC §3.8.1). English, in a `*.prompt.ts`
 * file so the i18n extractor never harvests it (INV-29).
 *
 * The header and the closing instruction are Juno's and sit OUTSIDE the
 * untrusted envelope; the results, which are strangers' titles and snippets,
 * sit inside it (INV-30).
 */

export const SEARCH_RESULTS_LABEL = "web search results";

export function searchedLine(query: string, engine: string, count: number, iso: string): string {
  return `Searched for "${query}" (${engine}, ${count} result${count === 1 ? "" : "s"}, ${iso}).`;
}

export function numberedResult(n: number, title: string, url: string, age: string | null, snippet: string): string {
  return `[${n}] ${title} — ${url}${age ? ` (${age})` : ""}${snippet ? `\n${snippet}` : ""}`;
}

export function bulletedResult(title: string, url: string, age: string | null, snippet: string): string {
  return `- ${title} — ${url}${age ? ` (${age})` : ""}${snippet ? `\n  ${snippet}` : ""}`;
}

export function citeNumberedLine(example: number): string {
  return `Cite a result as [${example}] only if you used it. Open a result with web_fetch before quoting it.`;
}

export const CITE_LINKS_LINE =
  "Cite a result as a markdown link [title](url) only if you used it. Open a result with web_fetch before quoting it.";

export const NO_RESULTS_TEXT = "No results. Try a broader query.";

export const EMPTY_QUERY_TEXT =
  "The query is empty. Nothing was searched. Send a query of 2 to 8 words.";

export function searchUnavailableText(detail: string | null): string {
  return `Web search is unavailable right now${detail ? ` (${detail})` : ""}. Nothing was found. Answer from what you already have and say that you could not search.`;
}
