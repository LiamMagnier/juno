import "server-only";
import { executeMultiEngineSearch, isSearchEngineAvailable } from "@/lib/search/search-engine";

export interface WebSource {
  title: string;
  url: string;
  snippet: string;
}

/** Web search is always available with multi-engine capability. */
export function isWebSearchConfigured(): boolean {
  return isSearchEngineAvailable();
}

export async function webSearch(query: string, maxResults = 6): Promise<WebSource[]> {
  if (!query.trim()) return [];
  try {
    const hits = await executeMultiEngineSearch({ query, count: maxResults });
    return hits.map((h) => ({
      title: h.title,
      url: h.url,
      snippet: h.snippet,
    }));
  } catch (e) {
    console.error("[web-search] multi-engine search error:", e);
    return [];
  }
}

/** A system-prompt section instructing the model to cite the numbered sources. */
export function buildSearchContext(query: string, sources: WebSource[]): string {
  const list = sources
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.url}\n${s.snippet}`)
    .join("\n\n");
  return `# Web search results
The user enabled web search. Below are current verified results for: "${query}". Use them to answer with up-to-date facts, and cite the sources you rely on inline using bracketed numbers like [1] or [2] that map directly to the list. Don't invent sources or numbers beyond this list. If the results don't cover the question, state so plainly.

${list}`;
}
