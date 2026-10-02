import "server-only";
import { executeMultiEngineSearch, isSearchEngineAvailable } from "@/lib/search/search-engine";

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
