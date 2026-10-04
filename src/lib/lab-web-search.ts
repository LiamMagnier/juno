/**
 * The labs whose OWN web search rides a Chat Completions request, so the
 * OpenAI-compatible adapter carries it instead of Juno's generic search.
 *
 * Each shape is the lab's documented one (all read 2026-10-04):
 *
 *  - Z.ai GLM — docs.z.ai/guides/tools/web-search, api-reference/llm/chat-completion.
 *    A `web_search` entry in `tools`: `{ type: "web_search", web_search: {
 *    enable, search_engine, search_result } }`. `search_engine` is
 *    "search_pro_jina", the only value the chat-completion schema lists (the
 *    guide's example says "search-prime"). With `search_result: true` the
 *    response carries a top-level `web_search` array of `{ title, link,
 *    content, media, refer, publish_date }`. Billed $0.01 per use; the usage
 *    block has no search counter, so a response that returned results counts
 *    as one use.
 *  - Xiaomi MiMo — mimo.mi.com quick-start/usage-guide/text-generation/
 *    tool-calling/web-search and api/chat/openai-api. A `web_search` entry in
 *    `tools` (`max_keyword`, `force_search`, `limit`, `user_location`). The
 *    sources come back as `url_citation` annotations (`url`, `title`,
 *    `summary`, `site_name`) on the message — in the FIRST streamed packet —
 *    and `usage.web_search_usage.tool_usage` counts the billed calls ($5 per
 *    1,000 overseas). The Web Search plugin must be switched on in Xiaomi's
 *    console or the model never searches.
 *  - Alibaba Qwen — alibabacloud.com/help/en/model-studio/web-search.
 *    `enable_search: true` on the request. "The OpenAI-compatible protocol
 *    does not support returning search sources in the response", so no
 *    sources and no search count come back on this transport.
 *
 * Kimi is deliberately absent: its `$web_search` builtin is deprecated and
 * retires on 2026-10-20, and it returns no source URLs either.
 *
 * Pure and client-safe, so the request shapes and the citation mapping are
 * tested without a provider.
 */

import type { ClientSource } from "@/types/chat";

export type CompatSearchLab = "zhipu" | "mimo" | "qwen";

const LABS: ReadonlySet<string> = new Set<CompatSearchLab>(["zhipu", "mimo", "qwen"]);

/** Whether the compat adapter carries this lab's own search. */
export function compatCarriesLabSearch(provider: string): provider is CompatSearchLab {
  return LABS.has(provider);
}

/** Z.ai's `web_search` tool, with the results returned so they can be cited. */
export const ZHIPU_WEB_SEARCH_TOOL = {
  type: "web_search",
  web_search: { enable: true, search_engine: "search_pro_jina", search_result: true },
} as const;

/**
 * MiMo's `web_search` tool. The model decides whether to search
 * (`force_search: false`); `max_keyword` caps the concurrent keyword searches
 * one round may bill, at the value Xiaomi's own example uses.
 */
export const MIMO_WEB_SEARCH_TOOL = { type: "web_search", max_keyword: 3, force_search: false } as const;

export interface LabSearchRequest {
  /** Extra entries for the request's `tools` array. */
  tools: Array<Record<string, unknown>>;
  /** Extra top-level request fields. */
  fields: Record<string, unknown>;
}

/** What a searching request adds for this lab (empty for a lab the compat path does not search for). */
export function labSearchRequest(provider: string): LabSearchRequest {
  switch (provider) {
    case "zhipu":
      return { tools: [{ ...ZHIPU_WEB_SEARCH_TOOL, web_search: { ...ZHIPU_WEB_SEARCH_TOOL.web_search } }], fields: {} };
    case "mimo":
      return { tools: [{ ...MIMO_WEB_SEARCH_TOOL }], fields: {} };
    case "qwen":
      return { tools: [], fields: { enable_search: true } };
    default:
      return { tools: [], fields: {} };
  }
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

const SNIPPET_MAX = 300;

function snippet(value: unknown): string {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX - 1)}…` : s;
}

/** Z.ai: the top-level `web_search` results on a response or stream chunk. */
export function zhipuSearchSources(chunk: unknown): ClientSource[] {
  const list = rec(chunk)?.web_search;
  if (!Array.isArray(list)) return [];
  const out: ClientSource[] = [];
  for (const raw of list) {
    const r = rec(raw);
    const url = text(r?.link);
    if (!r || !url) continue;
    out.push({ title: text(r.title) ?? url, url, snippet: snippet(r.content) });
  }
  return out;
}

/** MiMo: the `url_citation` annotations on a streamed delta or a whole message. */
export function mimoSearchSources(chunk: unknown): ClientSource[] {
  const choice = rec(Array.isArray(rec(chunk)?.choices) ? (rec(chunk)!.choices as unknown[])[0] : null);
  const holder = rec(choice?.delta) ?? rec(choice?.message);
  const list = holder?.annotations;
  if (!Array.isArray(list)) return [];
  const out: ClientSource[] = [];
  for (const raw of list) {
    const a = rec(raw);
    const url = text(a?.url);
    if (!a || !url || (a.type !== undefined && a.type !== "url_citation")) continue;
    out.push({ title: text(a.title) ?? url, url, snippet: snippet(a.summary) });
  }
  return out;
}

/** The sources one chunk carries for this lab. */
export function labSearchSources(provider: string, chunk: unknown): ClientSource[] {
  if (provider === "zhipu") return zhipuSearchSources(chunk);
  if (provider === "mimo") return mimoSearchSources(chunk);
  return [];
}

/** MiMo's billed search calls: `usage.web_search_usage.tool_usage`. */
export function mimoSearchCalls(usage: unknown): number {
  const n = rec(rec(usage)?.web_search_usage)?.tool_usage;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
