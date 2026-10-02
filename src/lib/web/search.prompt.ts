/*
 * What chat's search backend tells the model when it refuses a query before
 * any engine sees it (SPEC §6.3). English, constant, and in a `*.prompt.ts`
 * file so the i18n extractor never harvests it (INV-29). The result list and
 * its framing are the tool spec's (`src/lib/tools/specs/web-search.prompt.ts`).
 */

export const SENSITIVE_QUERY_TEXT = "The query contains sensitive data and was not sent.";

export const SEARCH_RATE_LIMITED_TEXT = "The search limit for this turn is reached. Answer from what you have.";
