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
/**
 * Where SearXNG lives — yours first, if you run one.
 *
 * This used to be three hardcoded public instances and nothing else. Public
 * SearXNG aggressively rate-limits anonymous JSON traffic (most instances
 * disable the JSON API outright), so on a deployment with no commercial key the
 * fan-out was effectively falling through to scraped DuckDuckGo and Wikipedia's
 * five-result index — the real reason "deep" research bottomed out at a handful
 * of sites.
 *
 * A SearXNG you host yourself is the answer for anyone who does not want to pay
 * for a search API: it queries Google, Bing, Brave and DuckDuckGo on your
 * behalf, you own the rate limit, and it needs no key. One container:
 *
 *   docker run -d -p 8080:8080 -e SEARXNG_BASE_URL=http://localhost:8080/ \
 *     -v ./searxng:/etc/searxng searxng/searxng
 *
 * then set SEARXNG_URL=http://localhost:8080 and enable the JSON format in
 * settings.yml (`search.formats: [html, json]`). The public instances stay as a
 * last resort rather than the primary path.
 */
function searxngInstances(): string[] {
  const configured = process.env.SEARXNG_URL?.trim();
  const own = configured
    ? [`${configured.replace(/\/+$/, "")}/search`]
    : [];
  return [
    ...own,
    "https://searx.be/search",
    "https://search.sapti.me/search",
    "https://priv.au/search",
  ];
}

async function searchSearxng(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const instances = searxngInstances();

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
 * One search backend, as the fan-out sees it.
 *
 * `weight` is how much this engine's ranking is trusted when engines disagree —
 * it multiplies the reciprocal-rank score below, so a keyed commercial index
 * outvotes a scraped one without ever silencing it. Nothing is a "fallback"
 * any more: every available engine runs, and the merge decides.
 */
interface EngineSpec {
  name: string;
  weight: number;
  available(): boolean;
  run(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]>;
}

const ENGINES: EngineSpec[] = [
  { name: "tavily", weight: 1, available: () => !!process.env.TAVILY_API_KEY?.trim(), run: searchTavily },
  { name: "serper", weight: 1, available: () => !!process.env.SERPER_API_KEY?.trim(), run: searchSerper },
  {
    name: "brave",
    weight: 0.95,
    available: () => !!(process.env.BRAVE_SEARCH_API_KEY?.trim() || process.env.BRAVE_API_KEY?.trim()),
    run: searchBrave,
  },
  { name: "exa", weight: 0.95, available: () => !!process.env.EXA_API_KEY?.trim(), run: searchExa },
  { name: "searxng", weight: 0.7, available: () => true, run: searchSearxng },
  { name: "duckduckgo", weight: 0.7, available: () => true, run: searchDuckDuckGo },
  { name: "wikipedia", weight: 0.35, available: () => true, run: searchWikipedia },
];

/**
 * What this deployment can actually reach.
 *
 * `hasGoodIndex` is the question worth asking, and it is deliberately NOT "is a
 * paid key set". A self-hosted SearXNG is a first-class answer here: it queries
 * the same engines a commercial API resells, needs no key, and is not subject to
 * the anonymous rate limits that make the PUBLIC instances close to useless. A
 * deployment with neither is running on scraped endpoints and should say so
 * rather than quietly returning eight results.
 */
export function searchProviderStatus(): {
  keyed: string[];
  keyless: string[];
  selfHostedSearxng: boolean;
  hasKeyedProvider: boolean;
  hasGoodIndex: boolean;
} {
  const keyedNames = ["tavily", "serper", "brave", "exa"];
  const keyed = ENGINES.filter((e) => keyedNames.includes(e.name) && e.available()).map((e) => e.name);
  const keyless = ENGINES.filter((e) => !keyedNames.includes(e.name)).map((e) => e.name);
  const selfHostedSearxng = !!process.env.SEARXNG_URL?.trim();
  return {
    keyed,
    keyless,
    selfHostedSearxng,
    hasKeyedProvider: keyed.length > 0,
    hasGoodIndex: keyed.length > 0 || selfHostedSearxng,
  };
}

/**
 * Check if search capability is available in any form.
 *
 * Always true: SearXNG, DuckDuckGo and Wikipedia need no key. Whether the
 * deployment has a *good* index is `searchProviderStatus().hasKeyedProvider`,
 * which is a different question and the one worth surfacing to a user.
 */
export function isSearchEngineAvailable(): boolean {
  return true;
}

/**
 * The dedupe key for a result.
 *
 * Two engines almost never return the same URL byte-for-byte — one keeps the
 * tracking parameters, one resolves the redirect, one adds the trailing slash —
 * so deduping on the raw string leaves the corpus full of the same page three
 * times, which then reads to the synthesis model as three independent sources
 * corroborating each other. That is the specific failure this prevents.
 */
function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_[ce]id|ref|source|_hs)/i.test(key)) u.searchParams.delete(key);
    }
    const path = u.pathname.replace(/\/+$/, "") || "/";
    const qs = u.searchParams.toString();
    return `${u.protocol}//${u.hostname}${path}${qs ? `?${qs}` : ""}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

/** Aborts with the parent OR after `ms`, so one hung engine cannot stall the fan-out. */
function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  if (parent?.aborted) ctrl.abort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  return work(ctrl.signal).finally(() => {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort);
  });
}

/** One engine is allowed this long before the merge proceeds without it. */
const ENGINE_TIMEOUT_MS = 12_000;

/**
 * The constant in reciprocal-rank fusion. 60 is the value from the original
 * Cormack et al. paper and the one every IR implementation uses; it flattens
 * the head of each list enough that a result ranked #1 by one engine does not
 * automatically beat a result ranked #2 by three engines.
 */
const RRF_K = 60;

/**
 * Multi-engine web search: every available backend, in parallel, merged.
 *
 * This was a cascade — it returned the first engine that answered and never
 * asked the others. That made the result set as narrow as whichever backend
 * happened to be configured, and on a deployment with no API keys at all it
 * meant scraped DuckDuckGo or, worse, Wikipedia's five-item index: the real
 * reason a "deep" research run bottomed out at a handful of sites regardless
 * of how many queries it planned.
 *
 * Now every engine runs concurrently and the lists are merged by reciprocal-rank
 * fusion, so breadth is the union rather than the best single source, and a page
 * several engines agree on outranks one that only the cheapest engine found.
 * Engines that fail or time out simply do not vote.
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

  const active = ENGINES.filter((engine) => engine.available());
  if (active.length === 0) return [];

  // Ask each engine for more than the caller wants: the merge discards
  // duplicates, and asking for exactly `count` per engine would leave the union
  // short of `count` as soon as two engines agree on anything.
  const perEngine = Math.min(20, Math.max(10, count));

  const settled = await Promise.all(
    active.map(async (engine) => {
      try {
        const hits = await withDeadline((s) => engine.run(query, perEngine, s), ENGINE_TIMEOUT_MS, signal);
        return { engine, hits };
      } catch {
        return { engine, hits: [] as SearchResult[] };
      }
    })
  );

  const scored = new Map<string, { result: SearchResult; score: number; engines: Set<string> }>();
  for (const { engine, hits } of settled) {
    hits.forEach((hit, rank) => {
      if (!hit.url || !hit.url.startsWith("http") || isDisallowedHost(hit.url)) return;
      const key = canonicalUrl(hit.url);
      const contribution = engine.weight / (RRF_K + rank + 1);
      const existing = scored.get(key);
      if (!existing) {
        scored.set(key, { result: { ...hit, engine: engine.name }, score: contribution, engines: new Set([engine.name]) });
        return;
      }
      existing.score += contribution;
      existing.engines.add(engine.name);
      // Keep the richest copy: a snippet beats nothing, a fetched body beats a
      // snippet, and a date from any engine beats no date at all.
      if (!existing.result.rawContent && hit.rawContent) existing.result.rawContent = hit.rawContent;
      if (!existing.result.publishedAt && hit.publishedAt) existing.result.publishedAt = hit.publishedAt;
      if (!existing.result.author && hit.author) existing.result.author = hit.author;
      if (hit.snippet.length > existing.result.snippet.length) existing.result.snippet = hit.snippet;
      if (!existing.result.title && hit.title) existing.result.title = hit.title;
    });
  }

  return [...scored.values()]
    .sort((a, b) => b.score - a.score || a.result.title.localeCompare(b.result.title))
    .slice(0, count)
    .map(({ result, engines }) => ({ ...result, engine: [...engines].sort().join("+") }));
}
