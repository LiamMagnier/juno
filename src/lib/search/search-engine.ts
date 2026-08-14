import "server-only";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  rawContent?: string;
  publishedAt?: Date;
  author?: string;
  engine: string;
}

export interface ExtractResult {
  title: string;
  text: string;
  author?: string;
  publishedAt?: Date;
}

/**
 * SSRF & Private IP Protection: blocks internal network probes.
 */
function isDisallowedHost(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.endsWith(".internal") ||
      host.endsWith(".local")
    ) {
      return true;
    }
    // Block AWS/GCP/Azure instance metadata
    if (host === "169.254.169.254" || host.startsWith("169.254.")) {
      return true;
    }
    // Block RFC 1918 private subnets
    if (
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
    ) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Clean and convert raw HTML into readable structured markdown text.
 */
export function htmlToCleanText(html: string): { title?: string; text: string; author?: string; publishedAt?: Date } {
  try {
    // Strip scripts, styles, iframes, and svg tags
    let clean = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
      .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "")
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "");

    // Extract title
    const titleMatch = clean.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, " ") : undefined;

    // Extract meta published date
    const dateMatch = clean.match(/<meta[^>]+(?:article:published_time|date|pubdate)[^>]+content=["']([^"']+)["']/i);
    let publishedAt: Date | undefined;
    if (dateMatch && dateMatch[1] && Number.isFinite(Date.parse(dateMatch[1]))) {
      publishedAt = new Date(dateMatch[1]);
    }

    // Extract author
    const authorMatch = clean.match(/<meta[^>]+(?:author|article:author)[^>]+content=["']([^"']+)["']/i);
    const author = authorMatch ? authorMatch[1].trim() : undefined;

    // Convert standard tags to text equivalents
    clean = clean
      .replace(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/gi, "\n\n## $1\n\n")
      .replace(/<h[4-6][^>]*>(.*?)<\/h[4-6]>/gi, "\n\n### $1\n\n")
      .replace(/<p[^>]*>/gi, "\n\n")
      .replace(/<\/p>/gi, "")
      .replace(/<li[^>]*>(.*?)<\/li>/gi, "\n- $1")
      .replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gi, "\n> $1\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<hr\s*\/?>/gi, "\n---\n")
      .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, "[$2]($1)")
      .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
      .replace(/<b[^>]*>(.*?)<\/b>/gi, "**$1**")
      .replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*")
      .replace(/<i[^>]*>(.*?)<\/i>/gi, "*$1*")
      .replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`")
      .replace(/<[^>]+>/g, " ");

    // Decode HTML entities
    clean = clean
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&mdash;/g, "—")
      .replace(/&ndash;/g, "–")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

    // Normalize spacing
    clean = clean
      .split("\n")
      .map((line) => line.trim())
      .filter((line, i, arr) => line || (i > 0 && arr[i - 1]))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return { title, text: clean, author, publishedAt };
  } catch {
    return { text: html.replace(/<[^>]+>/g, " ").trim() };
  }
}

/**
 * Universal Page Extractor with SSIR security protection and clean markdown synthesis.
 */
export async function extractUrlContent(url: string, signal?: AbortSignal): Promise<ExtractResult | null> {
  if (!url || isDisallowedHost(url)) return null;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 JunoResearch/2.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal,
      redirect: "follow",
    });

    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType && !contentType.includes("text/") && !contentType.includes("json") && !contentType.includes("xml")) {
      return null;
    }

    const html = await res.text();
    const parsed = htmlToCleanText(html);
    if (!parsed.text || parsed.text.length < 50) return null;

    return {
      title: parsed.title ?? url,
      text: parsed.text.slice(0, 16_000),
      author: parsed.author,
      publishedAt: parsed.publishedAt,
    };
  } catch (e) {
    if (!signal?.aborted) {
      console.warn("[search-engine] fetch extraction failed for:", url, e instanceof Error ? e.message : e);
    }
    return null;
  }
}

/**
 * Brave Search API
 */
async function searchBrave(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY?.trim() || process.env.BRAVE_API_KEY?.trim();
  if (!key) return [];

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(20, maxResults)));
  url.searchParams.set("result_filter", "web");

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": key,
    },
    signal,
  });

  if (!res.ok) return [];
  const data = await res.json();
  const results = data.web?.results ?? [];

  return results.slice(0, maxResults).map((r: Record<string, unknown>) => ({
    title: (r.title as string) ?? "",
    url: (r.url as string) ?? "",
    snippet: (r.description as string) ?? "",
    publishedAt: r.page_age ? new Date(r.page_age as string) : undefined,
    engine: "brave",
  }));
}

/**
 * Serper Google Search API
 */
async function searchSerper(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const key = process.env.SERPER_API_KEY?.trim();
  if (!key) return [];

  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, num: maxResults }),
    signal,
  });

  if (!res.ok) return [];
  const data = await res.json();
  const organic = data.organic ?? [];

  return organic.slice(0, maxResults).map((r: Record<string, unknown>) => ({
    title: (r.title as string) ?? "",
    url: (r.link as string) ?? "",
    snippet: (r.snippet as string) ?? "",
    publishedAt: r.date && typeof r.date === "string" && Number.isFinite(Date.parse(r.date)) ? new Date(r.date) : undefined,
    engine: "serper",
  }));
}

/**
 * Exa Neural Search API
 */
async function searchExa(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const key = process.env.EXA_API_KEY?.trim();
  if (!key) return [];

  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      numResults: maxResults,
      contents: { text: { maxCharacters: 12000 } },
    }),
    signal,
  });

  if (!res.ok) return [];
  const data = await res.json();
  const results = data.results ?? [];

  return results.slice(0, maxResults).map((r: Record<string, unknown>) => ({
    title: (r.title as string) ?? (r.url as string),
    url: (r.url as string) ?? "",
    snippet: ((r.text as string) ?? "").slice(0, 500),
    rawContent: r.text as string | undefined,
    publishedAt: r.publishedDate ? new Date(r.publishedDate as string) : undefined,
    author: r.author as string | undefined,
    engine: "exa",
  }));
}

/**
 * Tavily Search API (High reliability AI search)
 */
async function searchTavily(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const key = process.env.TAVILY_API_KEY?.trim();
  if (!key) return [];

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      query: query.slice(0, 400),
      max_results: maxResults,
      search_depth: "basic",
      include_raw_content: true,
    }),
    signal,
  });

  if (!res.ok) return [];
  const data = await res.json();
  const results = data.results ?? [];

  return results.slice(0, maxResults).map((r: Record<string, unknown>) => ({
    title: (r.title as string) ?? "",
    url: (r.url as string) ?? "",
    snippet: (r.content as string) ?? "",
    rawContent: typeof r.raw_content === "string" ? r.raw_content : undefined,
    publishedAt: r.published_date && typeof r.published_date === "string" && Number.isFinite(Date.parse(r.published_date)) ? new Date(r.published_date) : undefined,
    engine: "tavily",
  }));
}

/**
 * SearXNG Public Meta-Search API
 */
async function searchSearxng(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const instances = [
    "https://searx.be/search",
    "https://search.sapti.me/search",
    "https://priv.au/search",
  ];

  for (const instance of instances) {
    try {
      const url = new URL(instance);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("engines", "google,bing,duckduckgo");

      const res = await fetch(url.toString(), {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          Accept: "application/json",
        },
        signal,
      });

      if (!res.ok) continue;
      const data = await res.json();
      const results = (data.results ?? []) as Array<Record<string, unknown>>;
      if (results.length === 0) continue;

      return results
        .filter((r) => typeof r.url === "string" && !isDisallowedHost(r.url))
        .slice(0, maxResults)
        .map((r) => ({
          title: (r.title as string) ?? "",
          url: (r.url as string) ?? "",
          snippet: (r.content as string) ?? "",
          engine: "searxng",
        }));
    } catch {
      continue;
    }
  }

  return [];
}

/**
 * Wikipedia Encyclopedia API Fallback
 */
async function searchWikipedia(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
  try {
    const url = new URL("https://en.wikipedia.org/w/api.php");
    url.searchParams.set("action", "opensearch");
    url.searchParams.set("search", query);
    url.searchParams.set("limit", String(Math.min(5, maxResults)));
    url.searchParams.set("namespace", "0");
    url.searchParams.set("format", "json");

    const res = await fetch(url.toString(), {
      headers: { "User-Agent": "JunoSearch/1.0 (https://juno.app)" },
      signal,
    });

    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data) || data.length < 4) return [];

    const titles = (data[1] ?? []) as string[];
    const descriptions = (data[2] ?? []) as string[];
    const urls = (data[3] ?? []) as string[];

    const results: SearchResult[] = [];
    for (let i = 0; i < titles.length; i++) {
      if (urls[i] && titles[i]) {
        results.push({
          title: titles[i],
          url: urls[i],
          snippet: descriptions[i] || `Wikipedia article about ${titles[i]}`,
          engine: "wikipedia",
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * DuckDuckGo Search API & HTML Fallback (Zero Config Required)
 */
async function searchDuckDuckGo(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
  try {
    const url = new URL("https://html.duckduckgo.com/html/");
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      body: new URLSearchParams({ q: query }).toString(),
      signal,
    });

    if (!res.ok) return [];
    const html = await res.text();
    const results: SearchResult[] = [];

    // Parse DuckDuckGo result blocks
    const resultBlocks = html.split(/class="result\s+results_links/i).slice(1);
    for (const block of resultBlocks) {
      const linkMatch = block.match(/href="([^"]+)"[^>]*class="result__url"[^>]*>([\s\S]*?)<\/a>/i) ||
        block.match(/<a[^>]+class="result__snippet[^>]+href="([^"]+)"/i) ||
        block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);

      const titleMatch = block.match(/<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
      const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i) ||
        block.match(/class="result__snippet">([\s\S]*?)<\/td>/i);

      if (linkMatch && titleMatch) {
        let rawUrl = linkMatch[1];
        // Decode DDG proxy url if present
        if (rawUrl.includes("uddg=")) {
          try {
            const parsed = new URL("https://duckduckgo.com" + rawUrl);
            const uddg = parsed.searchParams.get("uddg");
            if (uddg) rawUrl = decodeURIComponent(uddg);
          } catch {
            /* use raw */
          }
        }

        const title = titleMatch[1].replace(/<[^>]+>/g, "").trim();
        const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";

        if (rawUrl.startsWith("http") && !isDisallowedHost(rawUrl) && title) {
          results.push({
            title,
            url: rawUrl,
            snippet,
            engine: "duckduckgo",
          });
        }
      }

      if (results.length >= maxResults) break;
    }

    return results;
  } catch (e) {
    if (!signal?.aborted) {
      console.warn("[search-engine] duckduckgo search failed:", e instanceof Error ? e.message : e);
    }
    return [];
  }
}

/**
 * Check if search capability is available in any form.
 */
export function isSearchEngineAvailable(): boolean {
  return true; // DuckDuckGo direct fallback and meta-search engines are always available.
}

/**
 * Multi-Engine Web Search: Cascading fallback through best-available search backends (Tavily, Serper, Brave, Exa, SearXNG, DuckDuckGo, Wikipedia).
 */
export async function executeMultiEngineSearch({
  query,
  count = 6,
  signal,
}: {
  query: string;
  count?: number;
  signal?: AbortSignal;
}): Promise<SearchResult[]> {
  if (!query.trim()) return [];

  // 1. Try Tavily Search API (Fast, deep research native)
  if (process.env.TAVILY_API_KEY?.trim()) {
    const hits = await searchTavily(query, count, signal).catch(() => []);
    if (hits.length > 0) return hits;
  }

  // 2. Try Serper Google Search
  if (process.env.SERPER_API_KEY?.trim()) {
    const hits = await searchSerper(query, count, signal).catch(() => []);
    if (hits.length > 0) return hits;
  }

  // 3. Try Brave Search API
  if (process.env.BRAVE_SEARCH_API_KEY?.trim() || process.env.BRAVE_API_KEY?.trim()) {
    const hits = await searchBrave(query, count, signal).catch(() => []);
    if (hits.length > 0) return hits;
  }

  // 4. Try Exa Neural Search
  if (process.env.EXA_API_KEY?.trim()) {
    const hits = await searchExa(query, count, signal).catch(() => []);
    if (hits.length > 0) return hits;
  }

  // 5. Try SearXNG Meta-Search
  const searxHits = await searchSearxng(query, count, signal).catch(() => []);
  if (searxHits.length > 0) return searxHits;

  // 6. Try DuckDuckGo
  const ddgHits = await searchDuckDuckGo(query, count, signal).catch(() => []);
  if (ddgHits.length > 0) return ddgHits;

  // 7. Fallback to Wikipedia encyclopedia index
  return searchWikipedia(query, count, signal).catch(() => []);
}
