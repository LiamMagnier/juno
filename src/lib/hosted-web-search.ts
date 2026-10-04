/**
 * The hosted `web_search` tool on OpenAI's and xAI's Responses APIs.
 *
 * OpenAI (developers.openai.com/api/docs/guides/tools-web-search, read
 * 2026-10-04):
 *  - Request: `tools: [{ type: "web_search", search_context_size }]`.
 *    `user_location` is left out: the request carries no location.
 *  - `include: ["web_search_call.action.sources"]` lists every URL a search
 *    consulted on the call's `action.sources`; the answer's `output_text`
 *    parts carry `url_citation` annotations for what it actually cited.
 *  - A `web_search_call`'s `action.type` is `search`, `open_page` or
 *    `find_in_page`. "Search actions incur a tool call cost", so a call is
 *    billed when it searched, not when it opened or read a page.
 *  - Not with gpt-5 at "minimal" (`hostedSearchMinEffort` in model-tools.ts).
 *  - Pricing (developers.openai.com/api/docs/pricing): $10 / 1k calls on
 *    reasoning models, $25 / 1k on gpt-4o / gpt-4.1 (`toolFeesUsd`).
 *
 * xAI (docs.x.ai/developers/tools/web-search, /tools/citations and the
 * Responses reference, read 2026-10-04):
 *  - Request: `tools: [{ type: "web_search" }]` on `POST https://api.x.ai/v1/responses`.
 *    Live Search (`search_parameters`) is retired on Chat Completions (410).
 *  - Inline `url_citation` annotations are on by default, and the response
 *    carries a top-level `citations` URL list.
 *  - Usage reports `server_side_tool_usage_details.web_search_calls` (and
 *    `x_search_calls`). $5 / 1k web search calls (docs.x.ai/developers/pricing).
 *  - `x_search` is not attached: it bills per post and profile fetched, not per
 *    call, and the composer has no X toggle to ask for it.
 *
 * Pure and client-safe, so request shape, citation mapping and counting are
 * tested without the SDK.
 */

import type { ClientSource } from "@/types/chat";

export type HostedSearchDialect = "openai" | "xai";

/** The tool entry a searching request carries. */
export function hostedWebSearchTool(dialect: HostedSearchDialect): Record<string, unknown> {
  // "medium" is OpenAI's default, stated so the request says what it pays for.
  return dialect === "openai" ? { type: "web_search", search_context_size: "medium" } : { type: "web_search" };
}

/** OpenAI: what makes each `web_search_call` list the URLs it consulted. */
export const OPENAI_WEB_SEARCH_INCLUDE = "web_search_call.action.sources";

type Item = Record<string, unknown>;

function record(value: unknown): Item | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Item) : null;
}

/** Whether one `web_search_call` is a billed call: a search ran (or the action is unstated). */
export function hostedSearchCallBillable(item: Item): boolean {
  const action = record(item.action);
  if (!action) return true;
  return action.type !== "open_page" && action.type !== "find_in_page";
}

/** OpenAI: the URLs a call consulted (`action.sources`, with the include above). */
export function actionSourceList(item: Item): ClientSource[] {
  const action = record(item.action);
  const sources = Array.isArray(action?.sources) ? action.sources : [];
  const out: ClientSource[] = [];
  for (const raw of sources) {
    const source = record(raw);
    const url = typeof source?.url === "string" && source.url ? source.url : undefined;
    if (!source || !url) continue;
    const title = typeof source.title === "string" && source.title.trim() ? source.title : url;
    out.push({ title, url, snippet: "" });
  }
  return out;
}

/** xAI: the response's top-level `citations` URL list, as sources. */
export function xaiResponseCitations(response: Item): ClientSource[] {
  const list = Array.isArray(response.citations) ? response.citations : [];
  const out: ClientSource[] = [];
  for (const raw of list) {
    const url = typeof raw === "string" ? raw : typeof record(raw)?.url === "string" ? (record(raw)!.url as string) : "";
    if (url) out.push({ title: url, url, snippet: "" });
  }
  return out;
}

/** xAI: the server-side search counts its usage block reports, when it reports them. */
export function xaiServerToolCounts(response: Item): { web: number | null; x: number | null } {
  const usage = record(response.usage) ?? {};
  const details = record(usage.server_side_tool_usage_details) ?? record(response.server_side_tool_usage_details);
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
  return { web: n(details?.web_search_calls), x: n(details?.x_search_calls) };
}
