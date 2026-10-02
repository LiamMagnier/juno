/*
 * What `web_fetch` tells the model (SPEC §3.8.2, §6.2.5). English, constant,
 * and in a `*.prompt.ts` file so the i18n extractor never harvests it (INV-29).
 *
 * The metadata lines are Juno's and sit OUTSIDE the untrusted envelope; the
 * page's title, text and links sit inside it (INV-30). Refusals say what
 * happened, that nothing was fetched where that is true, and what to do next.
 */

export const NOT_IN_PRIOR_CONTEXT_TEXT =
  "Juno only opens links that appeared in this conversation: typed by the user, or returned by an earlier search or page. This link did not, so nothing was fetched. Use web_search to find the page, or ask the user to paste the link.";

export const URL_NOT_ALLOWED_TEXT = "This address cannot be opened. Do not retry it.";

export const URL_TOO_LONG_TEXT = "The link is too long to open. Ask the user for a shorter link.";

export function notAccessibleText(reason: string): string {
  return `The page could not be opened (${reason}). Try another source.`;
}

export function unsupportedTypeText(type: string): string {
  return `This link is a ${type || "file of an unknown type"}, which cannot be read as text.`;
}

export const TOO_LARGE_TEXT = "The page is too large. Try another source.";

export const TIMEOUT_TEXT = "The page took too long. Try another source.";

export const NEEDS_BROWSER_TEXT =
  "The page needs a browser to render, which is not available in chat. Say so, or suggest a task.";

export const RATE_LIMITED_TEXT = "The reading limit for this turn is reached. Answer from what you have.";

/** Appended once the enumeration guard trips (three provenance refusals in one turn). */
export const FETCH_DISABLED_LINE = "web_fetch is disabled for the rest of this turn.";

export const READING_BUDGET_SPENT_LINE = "The turn's reading budget is spent.";

export function urlLine(url: string): string {
  return `URL: ${url}`;
}

export function requestedLine(url: string): string {
  return `Requested: ${url}`;
}

export function retrievedLine(iso: string): string {
  return `Retrieved: ${iso}`;
}

export function typeLine(type: string, pages?: number): string {
  return pages ? `Type: ${type} (${pages} page${pages === 1 ? "" : "s"})` : `Type: ${type}`;
}

export function showingLine(from: number, to: number, total: number): string {
  return to < total
    ? `Showing ${from}–${to} of ${total} characters. Continue with offset=${to}.`
    : `Showing ${from}–${to} of ${total} characters.`;
}

export function pastEndLine(offset: number, total: number): string {
  return `Offset ${offset} is past the end of the page (${total} characters). There is nothing more to read.`;
}

/** The envelope label: what produced the text inside it. */
export function pageSourceLabel(url: string): string {
  return `web page ${url}`;
}

export const LINKS_HEADING = "Links on the page:";

export function linkLine(n: number, text: string, url: string): string {
  return text ? `[${n}] ${text} — ${url}` : `[${n}] ${url}`;
}
