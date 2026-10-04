import "server-only";
import { executeMultiEngineSearch, isSearchEngineAvailable, searchWithEngineReport } from "@/lib/search/search-engine";
import { researchSearchFeeMicroUsd } from "@/lib/research/search-metering";
import { recordSpend } from "@/lib/spend";
import type { SpendKind } from "@/lib/spend-ceiling";

/*
 * Work's and code search's web search: every engine, fused. Chat's `web_search`
 * does NOT come through here — it uses one keyed engine at a time with query
 * hygiene and per-turn limits (`src/lib/web/search.ts`, SPEC §6.3).
 */

export interface WebSource {
  title: string;
  url: string;
  snippet: string;
}

/** Web search is always available with multi-engine capability. */
export function isWebSearchConfigured(): boolean {
  return isSearchEngineAvailable();
}

/**
 * `signal` ends the search with the caller (a cancelled Work step, a closed
 * request) instead of letting every engine run out its own deadline.
 */
export async function webSearch(query: string, maxResults = 6, signal?: AbortSignal): Promise<WebSource[]> {
  if (!query.trim()) return [];
  try {
    const hits = await executeMultiEngineSearch({ query, count: maxResults, signal });
    return hits.map((h) => ({
      title: h.title,
      url: h.url,
      snippet: h.snippet,
    }));
  } catch (e) {
    if (signal?.aborted) return [];
    console.error("[web-search] multi-engine search error:", e);
    return [];
  }
}

/**
 * The most one fused query can cost: every keyed engine answering at the
 * requested depth (Tavily + Serper + Brave + Exa list prices). The pre-call
 * estimate a gate admits a search against.
 */
export function maxFusedSearchFeeMicroUsd(maxResults: number): number {
  return researchSearchFeeMicroUsd(
    ["tavily", "serper", "brave", "exa"].map((name) => ({ name, results: maxResults, status: "ok" })),
    maxResults
  );
}

/**
 * `webSearch`, billed. The fused search fans out to every keyed engine that is
 * configured, each at its own per-query price, and three callers — Code's web
 * search seam, a Work run's `web_search` tool and the topic-monitor trigger —
 * ran it on the operator's keys without one ledger row. Each keyed engine that
 * answered is charged at its list price (researchSearchFeeMicroUsd, the rule
 * research already bills by), to the account that asked, as one
 * `juno-tool:web_search` row of `kind`.
 */
export async function meteredWebSearch(input: {
  userId: string;
  kind: SpendKind;
  query: string;
  maxResults?: number;
  signal?: AbortSignal;
}): Promise<WebSource[]> {
  const maxResults = input.maxResults ?? 6;
  if (!input.query.trim()) return [];
  try {
    const { results, engines } = await searchWithEngineReport({
      query: input.query,
      count: maxResults,
      signal: input.signal,
    });
    const fee = researchSearchFeeMicroUsd(engines, maxResults);
    if (fee > 0) {
      await recordSpend({
        userId: input.userId,
        model: "juno-tool:web_search",
        kind: input.kind,
        costUsd: fee / 1_000_000,
      }).catch(() => {});
    }
    return results.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet }));
  } catch (e) {
    if (input.signal?.aborted) return [];
    console.error("[web-search] multi-engine search error:", e);
    return [];
  }
}
