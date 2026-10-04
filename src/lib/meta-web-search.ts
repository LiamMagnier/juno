/**
 * Meta's `web_search` tool for Muse Spark, on Meta's Responses API.
 *
 * Source: dev.meta.ai/docs/search-grounding, the Responses schemas page and
 * dev.meta.ai/docs/pricing-rate-limits (all read 2026-10-04).
 *
 *  - Request: `tools: [{ type: "web_search" }]` on `POST /v1/responses`. Not
 *    available on Chat Completions at all. `search_context_size` defaults to
 *    "medium" and is left to that default; no `user_location` is sent because
 *    the request carries no location.
 *  - The model decides whether to search. When it does, `output` carries a
 *    `web_search_call` item, and the answer's `output_text` parts carry
 *    `url_citation` annotations (`url`, `title`, `start_index`, `end_index`).
 *  - `include: ["web_search_call.results"]` adds `results` to each call:
 *    `{ type: "text_result", title, url, snippet }`, every source the model
 *    considered. The citations are the subset it actually cited.
 *  - Billing: $2.50 per 1,000 search queries on top of tokens. The usage block
 *    has no search counter, so queries are counted from the call items.
 *
 * Pure and client-safe, so the request shape and the citation mapping are
 * tested without the SDK.
 */

import type { ClientSource } from "@/types/chat";

/** The tool entry a searching Muse Spark request carries. */
export const META_WEB_SEARCH_TOOL = { type: "web_search" } as const;

/** What makes each `web_search_call` report the sources it retrieved. */
export const META_WEB_SEARCH_INCLUDE = "web_search_call.results";

type Item = Record<string, unknown>;

function record(value: unknown): Item | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Item) : null;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** The queries a `web_search_call` ran: `action.queries`, else the deprecated `action.query`. */
export function metaSearchQueries(item: Item): string[] {
  const action = record(item.action);
  if (!action) return [];
  if (Array.isArray(action.queries)) {
    const queries = action.queries.map(nonEmpty).filter((q): q is string => !!q);
    if (queries.length) return queries;
  }
  const query = nonEmpty(action.query);
  return query ? [query] : [];
}

/**
 * How many billable search queries one `web_search_call` stands for.
 *
 * A `search` action bills each query it ran (at least one). `open_page` and
 * `find_in_page` read a page the search already returned and run no query.
 * A call with no action at all, which is how the docs' own example response
 * prints one, is counted as one query: a search ran and its size is unknown.
 * A failed call is counted too; Meta does not say failed searches are free.
 */
export function metaBillableQueries(item: Item): number {
  const action = record(item.action);
  if (!action) return 1;
  if (action.type === "open_page" || action.type === "find_in_page") return 0;
  return Math.max(1, metaSearchQueries(item).length);
}

/** One `web_search_call`'s retrieved results, as sources (titles and snippets kept). */
export function metaSearchResultSources(item: Item): ClientSource[] {
  const results = Array.isArray(item.results) ? item.results : [];
  const out: ClientSource[] = [];
  for (const raw of results) {
    const result = record(raw);
    const url = nonEmpty(result?.url);
    if (!result || !url) continue;
    out.push({ title: nonEmpty(result.title) ?? url, url, snippet: typeof result.snippet === "string" ? result.snippet : "" });
  }
  return out;
}

/**
 * The `url_citation` annotations on an assistant `message` item, as sources,
 * in the order the answer cites them. The cited span is kept as the snippet
 * when the part's text has it, so a citation names what it backs.
 */
export function urlCitationSources(item: Item): ClientSource[] {
  const content = Array.isArray(item.content) ? item.content : [];
  const out: ClientSource[] = [];
  for (const rawPart of content) {
    const part = record(rawPart);
    if (!part || !Array.isArray(part.annotations)) continue;
    const text = typeof part.text === "string" ? part.text : "";
    for (const rawAnnotation of part.annotations) {
      const annotation = record(rawAnnotation);
      const url = nonEmpty(annotation?.url);
      if (!annotation || annotation.type !== "url_citation" || !url) continue;
      const start = typeof annotation.start_index === "number" ? annotation.start_index : -1;
      const end = typeof annotation.end_index === "number" ? annotation.end_index : -1;
      const span = start >= 0 && end > start && end <= text.length ? text.slice(start, end).trim() : "";
      out.push({ title: nonEmpty(annotation.title) ?? url, url, snippet: span });
    }
  }
  return out;
}

/**
 * A reasoning output item made ready to send back. Meta requires `summary` on
 * every reasoning INPUT item ("send summary: [] when you have no summary").
 */
export function metaReplayReasoning(item: Item): Item {
  return Array.isArray(item.summary) ? item : { ...item, summary: [] };
}
