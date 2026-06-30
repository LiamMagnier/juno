import "server-only";

export interface WebSource {
  title: string;
  url: string;
  snippet: string;
}

/** Web search is available when a Tavily key is set (free tier works fine). */
export function isWebSearchConfigured(): boolean {
  return Boolean(process.env.TAVILY_API_KEY?.trim());
}

export async function webSearch(query: string, maxResults = 5): Promise<WebSource[]> {
  const key = process.env.TAVILY_API_KEY?.trim();
  if (!key || !query.trim()) return [];
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query: query.slice(0, 400),
        max_results: maxResults,
        search_depth: "basic",
      }),
    });
    if (!res.ok) {
      console.error("[web-search] tavily", res.status);
      return [];
    }
    const data = await res.json();
    return (data.results ?? [])
      .filter((r: { url?: string; title?: string }) => r.url && r.title)
      .slice(0, maxResults)
      .map((r: { title: string; url: string; content?: string }) => ({
        title: r.title,
        url: r.url,
        snippet: (r.content ?? "").slice(0, 600),
      }));
  } catch (e) {
    console.error("[web-search]", e);
    return [];
  }
}

/** A system-prompt section instructing the model to cite the numbered sources. */
export function buildSearchContext(query: string, sources: WebSource[]): string {
  const list = sources
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.url}\n${s.snippet}`)
    .join("\n\n");
  return `# Web search results
The user enabled web search. Below are current results for: "${query}". Use them to answer with up-to-date information, and cite the sources you rely on inline using bracketed numbers like [1] or [2] that map to the list. Don't invent sources or numbers beyond this list. If the results don't cover the question, say so.

${list}`;
}
