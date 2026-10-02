/*
 * What `web_fetch` tells the model when the call never reaches the fetch
 * pipeline (SPEC §3.8.2). The pipeline's own results and refusals are written
 * by `src/lib/web/fetch-page.ts` (WS2). English, in a `*.prompt.ts` file so the
 * i18n extractor never harvests it (INV-29).
 */

export const EMPTY_URL_TEXT =
  "The url is empty. Nothing was fetched. Pass an absolute http(s) URL that appeared in this conversation.";

export const FETCH_UNAVAILABLE_TEXT =
  "Reading web pages is not available in this conversation. Nothing was fetched. Answer from what you have.";
