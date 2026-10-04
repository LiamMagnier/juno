import "server-only";
import { isDisallowedHost } from "./url-safety";
import { fuseRankedLists, type EngineSpec, type SearchResult } from "./fusion";

/*
 * `SearchResult`, `EngineSpec`, the RRF constant and the merge itself used to be
 * declared here AND, byte for byte, in fusion.ts/url-safety.ts — which existed
 * only so the parts with judgement in them could be reached from `tsx --test`,
 * this module being `server-only`. Two copies of an SSRF guard is the kind of
 * duplication that drifts, and it had already drifted: the copy in url-safety.ts
 * rejects non-http(s) schemes and the copy here did not, so a `data:` URI
 * reached `extractUrlContent` — which a user-supplied pinned source can steer.
 * The sibling modules are now the only definition and this file imports them.
 */
export type { SearchResult } from "./fusion";

/*
 * The page extractor lives in `src/lib/web/extract.ts` (and its HTML half in
 * `src/lib/web/html-text.ts`) since the chat rework: it reads no secret, and it
 * is the part a test has to drive end to end against a real socket, which a
 * `server-only` module cannot be. Re-exported here unchanged, so Research's
 * crawler and every other caller keep importing it from where they always did.
 */
export {
  extractUrlContent,
  extractUrlDocument,
  type ExtractFailure,
  type ExtractOptions,
  type ExtractOutcome,
  type ExtractResult,
  type PageLink,
} from "@/lib/web/extract";
export { htmlToCleanText } from "@/lib/web/html-text";

/**
 * A provider answered, but not with results.
 *
 * Every keyed provider used to `return []` on a non-2xx. Mechanically that
 * degrades fine — the rank fusion just gets one fewer voter — but a user whose
 * Brave free tier ran out, or whose key was revoked, got a thin report with
 * nothing anywhere saying why. Carrying the status out means the run can say
 * "brave: quota exceeded" instead of silently becoming a worse run.
 */
class EngineHttpError extends Error {
  constructor(
    readonly engine: string,
    readonly status: number
  ) {
    super(`${engine} responded ${status}`);
    this.name = "EngineHttpError";
  }
}

export type EngineStatus =
  | "ok"
  | "empty"
  | "bad_key"
  | "rate_limited"
  | "provider_error"
  | "timeout"
  | "failed";

/** What one engine did for one query, for the run's timeline. */
export interface EngineReport {
  name: string;
  results: number;
  status: EngineStatus;
  httpStatus?: number;
}

function statusForHttp(status: number): EngineStatus {
  if (status === 401 || status === 403) return "bad_key";
  if (status === 429) return "rate_limited";
  return "provider_error";
}

/**
 * What one engine call may be asked beyond the query, for chat's single-engine
 * profile (SPEC §6.3). Research passes none, so nothing it sends changes.
 */
export interface EngineCallOptions {
  /** Only pages published within this period. Each engine spells it its own way. */
  recency?: "day" | "week" | "month" | "year";
  /**
   * What Exa returns with each result: `text` (Research's corpus, up to 12k
   * characters) or `highlights` (chat: one passage, so the snippet is not empty
   * and the bill is the highlight, not the page).
   */
  exaContents?: "text" | "highlights";
  /**
   * Alevr Search's news vertical (`search_news`). Each engine has its own news
   * surface: Serper's /news, Brave's news endpoint, Tavily's `topic: "news"`,
   * Exa's `category: "news"`, SearXNG's `news` category. Absent means web.
   */
  vertical?: "web" | "news";
}

/** One engine as the fan-out runs it: the fusion spec, plus the chat options. */
interface Engine extends EngineSpec {
  run(query: string, maxResults: number, signal?: AbortSignal, opts?: EngineCallOptions): Promise<SearchResult[]>;
}

const RECENCY_DAYS: Readonly<Record<NonNullable<EngineCallOptions["recency"]>, number>> = {
  day: 1,
  week: 7,
  month: 31,
  year: 366,
};

/**
 * Brave Search API
 */
async function searchBrave(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
  opts: EngineCallOptions = {},
): Promise<SearchResult[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY?.trim() || process.env.BRAVE_API_KEY?.trim();
  if (!key) return [];

  const news = opts.vertical === "news";
  const url = new URL(
    news ? "https://api.search.brave.com/res/v1/news/search" : "https://api.search.brave.com/res/v1/web/search",
  );
  url.searchParams.set("q", query);
  // Brave's own documented ceiling, unlike the 20 the other providers were
  // being held to for no reason. Asking for more is a 422, not more results.
  url.searchParams.set("count", String(Math.min(20, maxResults)));
  if (!news) url.searchParams.set("result_filter", "web");
  if (opts.recency) url.searchParams.set("freshness", `p${opts.recency[0]}`);

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": key,
    },
    signal,
  });

  if (!res.ok) throw new EngineHttpError("brave", res.status);
  const data = await res.json();
  // The news endpoint answers a top-level `results`; web nests it under `web`.
  const results = (news ? data.results : data.web?.results) ?? [];

  return results.slice(0, maxResults).map((r: Record<string, unknown>) => ({
    title: (r.title as string) ?? "",
    url: (r.url as string) ?? "",
    snippet: (r.description as string) ?? "",
    publishedAt: r.page_age && Number.isFinite(Date.parse(r.page_age as string)) ? new Date(r.page_age as string) : undefined,
    engine: "brave",
  }));
}

/**
 * Serper Google Search API
 */
async function searchSerper(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
  opts: EngineCallOptions = {},
): Promise<SearchResult[]> {
  const key = process.env.SERPER_API_KEY?.trim();
  if (!key) return [];

  const news = opts.vertical === "news";
  const res = await fetch(news ? "https://google.serper.dev/news" : "https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, num: maxResults, ...(opts.recency ? { tbs: `qdr:${opts.recency[0]}` } : {}) }),
    signal,
  });

  if (!res.ok) throw new EngineHttpError("serper", res.status);
  const data = await res.json();
  const organic = (news ? data.news : data.organic) ?? [];

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
async function searchExa(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
  opts: EngineCallOptions = {},
): Promise<SearchResult[]> {
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
      ...(opts.vertical === "news" ? { category: "news" } : {}),
      // Chat asks for one highlight per result (priced per result, SPEC §3.9)
      // instead of the page text, so its snippets are not empty.
      contents:
        opts.exaContents === "highlights"
          ? { highlights: { highlightsPerUrl: 1, numSentences: 3 } }
          : { text: { maxCharacters: 12000 } },
      ...(opts.recency
        ? { startPublishedDate: new Date(Date.now() - RECENCY_DAYS[opts.recency] * 86_400_000).toISOString() }
        : {}),
    }),
    signal,
  });

  if (!res.ok) throw new EngineHttpError("exa", res.status);
  const data = await res.json();
  const results = data.results ?? [];

  return results.slice(0, maxResults).map((r: Record<string, unknown>) => ({
    title: (r.title as string) ?? (r.url as string),
    url: (r.url as string) ?? "",
    snippet: (
      (Array.isArray(r.highlights) && typeof r.highlights[0] === "string" ? r.highlights[0] : (r.text as string)) ?? ""
    ).slice(0, 500),
    rawContent: r.text as string | undefined,
    publishedAt: r.publishedDate ? new Date(r.publishedDate as string) : undefined,
    author: r.author as string | undefined,
    engine: "exa",
  }));
}

/**
 * Tavily Search API (High reliability AI search)
 */
async function searchTavily(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
  opts: EngineCallOptions = {},
): Promise<SearchResult[]> {
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
      ...(opts.vertical === "news" ? { topic: "news" } : {}),
      ...(opts.recency ? { time_range: opts.recency } : {}),
    }),
    signal,
  });

  if (!res.ok) throw new EngineHttpError("tavily", res.status);
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
 * SearXNG — the operator's own instance, never a public one (BRIEF §16).
 *
 * This used to fall back to three hardcoded public instances. Public SearXNG
 * rate-limits anonymous JSON traffic (most instances disable the JSON API
 * outright), its operators never agreed to carry a product's traffic, and a
 * production that depends on them fails the day they say no. Alevr Search now
 * asks only the instance named by `SEARXNG_URL`, which the operator runs and
 * configures (`deploy/searxng/`): which upstream engines it queries, and on
 * what terms, is decided in that instance's settings.yml, not here. The
 * shipped settings enable only engines that are official APIs (SEARCH.md).
 *
 * No `engines=` parameter is sent for the same reason: the instance's own
 * configuration is the policy.
 */
export function selfHostedSearxngUrl(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const configured = env.SEARXNG_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${configured.replace(/\/+$/, "")}/search`;
  } catch {
    return null;
  }
}

async function searchSearxng(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
  opts: EngineCallOptions = {},
): Promise<SearchResult[]> {
  const instance = selfHostedSearxngUrl();
  if (!instance) return [];
  const url = new URL(instance);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", opts.vertical === "news" ? "news" : "general");
  if (opts.recency) url.searchParams.set("time_range", opts.recency);

  // The operator's own service, on an address they chose (often a private
  // one, beside the app): a plain fetch, not the public-only pinned fetch.
  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "AlevrSearch/1.0 (self-hosted SearXNG client)", Accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new EngineHttpError("searxng", res.status);
  const data = await res.json();
  const results = (data.results ?? []) as Array<Record<string, unknown>>;
  return results
    .filter((r) => typeof r.url === "string" && !isDisallowedHost(r.url))
    .slice(0, maxResults)
    .map((r) => ({
      title: (r.title as string) ?? "",
      url: (r.url as string) ?? "",
      snippet: (r.content as string) ?? "",
      publishedAt:
        typeof r.publishedDate === "string" && Number.isFinite(Date.parse(r.publishedDate))
          ? new Date(r.publishedDate)
          : undefined,
      engine: "searxng",
    }));
}

/**
 * Wikipedia's search API — an open-data source whose operator permits
 * programmatic access under the Wikimedia User-Agent policy (a descriptive
 * agent with contact details), which is what this sends. Encyclopedic only,
 * so it is a supplement in the research fan-out and never a chat backend.
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
      headers: { "User-Agent": "AlevrSearch/1.0 (https://alevr.com; search@alevr.com)" },
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

/*
 * Scraped DuckDuckGo HTML was removed (BRIEF §16: no fragile or abusive
 * scraping, no violating a provider's terms). Its endpoint answers 202/403 to
 * anything it judges a bot, which is exactly what a server is.
 */

const ENGINES: Engine[] = [
  { name: "tavily", weight: 1, available: () => !!process.env.TAVILY_API_KEY?.trim(), run: searchTavily },
  { name: "serper", weight: 1, available: () => !!process.env.SERPER_API_KEY?.trim(), run: searchSerper },
  {
    name: "brave",
    weight: 0.95,
    available: () => !!(process.env.BRAVE_SEARCH_API_KEY?.trim() || process.env.BRAVE_API_KEY?.trim()),
    run: searchBrave,
  },
  { name: "exa", weight: 0.95, available: () => !!process.env.EXA_API_KEY?.trim(), run: searchExa },
  { name: "searxng", weight: 0.7, available: () => selfHostedSearxngUrl() !== null, run: searchSearxng },
  // Encyclopedic and web-only: never asked for news.
  {
    name: "wikipedia",
    weight: 0.35,
    available: () => true,
    run: (query, maxResults, signal, opts) => (opts?.vertical === "news" ? Promise.resolve([]) : searchWikipedia(query, maxResults, signal)),
  },
];

export interface SearchProviderStatus {
  keyed: string[];
  keyless: string[];
  selfHostedSearxng: boolean;
  hasKeyedProvider: boolean;
  hasGoodIndex: boolean;
}

/**
 * What this deployment can actually reach.
 *
 * `hasGoodIndex` is the question worth asking, and it is deliberately NOT "is a
 * paid key set". A self-hosted SearXNG is a first-class answer here: it queries
 * the same engines a commercial API resells, needs no key, and is not subject to
 * the anonymous rate limits that make the PUBLIC instances close to useless
 * (which Alevr no longer asks at all). A deployment with neither has only
 * Wikipedia's encyclopedic API and should say so rather than quietly
 * returning five results.
 */
export function searchProviderStatus(): SearchProviderStatus {
  const keyedNames = ["tavily", "serper", "brave", "exa"];
  const keyed = ENGINES.filter((e) => keyedNames.includes(e.name) && e.available()).map((e) => e.name);
  const keyless = ENGINES.filter((e) => !keyedNames.includes(e.name) && e.available()).map((e) => e.name);
  const selfHostedSearxng = selfHostedSearxngUrl() !== null;
  return {
    keyed,
    keyless,
    selfHostedSearxng,
    hasKeyedProvider: keyed.length > 0,
    hasGoodIndex: keyed.length > 0 || selfHostedSearxng,
  };
}

/**
 * Whether this deployment can search the web: a keyed engine or the
 * operator's own SearXNG.
 *
 * This used to be `true` unconditionally, because scraped DuckDuckGo and the
 * public SearXNG instances "needed no key". Both are gone (BRIEF §16), and an
 * encyclopedia's title search is not web search, so a deployment without a
 * real index now says so instead of offering Research that cannot find pages.
 */
export function isSearchEngineAvailable(): boolean {
  return searchProviderStatus().hasGoodIndex;
}

/** One engine is allowed this long before the merge proceeds without it. */
const ENGINE_TIMEOUT_MS = 12_000;
/** A 429 is a "come back in a moment", not a failure. One retry, inside the deadline. */
const RATE_LIMIT_BACKOFF_MS = 1_200;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

/**
 * Runs one engine under its own deadline and reports how it went.
 *
 * The deadline is per ENGINE, not per attempt, so the 429 retry cannot push a
 * slow provider past the point where the merge would have proceeded without it.
 */
async function runEngine(
  engine: Engine,
  query: string,
  perEngine: number,
  parent?: AbortSignal,
  opts: EngineCallOptions = {},
): Promise<{ hits: SearchResult[]; report: EngineReport }> {
  const startedAt = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    const remaining = ENGINE_TIMEOUT_MS - (Date.now() - startedAt);
    if (remaining <= 0) return { hits: [], report: { name: engine.name, results: 0, status: "timeout" } };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), remaining);
    const onAbort = () => ctrl.abort();
    if (parent?.aborted) ctrl.abort();
    else parent?.addEventListener("abort", onAbort, { once: true });

    try {
      const hits = await engine.run(query, perEngine, ctrl.signal, opts);
      return {
        hits,
        report: { name: engine.name, results: hits.length, status: hits.length > 0 ? "ok" : "empty" },
      };
    } catch (error) {
      if (error instanceof EngineHttpError) {
        if (error.status === 429 && attempt === 0) {
          console.warn(`[search-engine] ${engine.name} rate-limited (429); retrying once`);
          await sleep(RATE_LIMIT_BACKOFF_MS, ctrl.signal);
          continue;
        }
        const status = statusForHttp(error.status);
        console.warn(
          `[search-engine] ${engine.name} returned ${error.status}` +
            (status === "bad_key"
              ? " — the API key is missing, wrong or revoked"
              : status === "rate_limited"
                ? " — quota or rate limit exhausted"
                : "")
        );
        return { hits: [], report: { name: engine.name, results: 0, status, httpStatus: error.status } };
      }
      const timedOut = ctrl.signal.aborted && !parent?.aborted;
      if (!timedOut && !parent?.aborted) {
        console.warn(`[search-engine] ${engine.name} failed:`, error instanceof Error ? error.message : error);
      }
      return { hits: [], report: { name: engine.name, results: 0, status: timedOut ? "timeout" : "failed" } };
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * How many results to ask ONE engine for, given what the caller wants merged.
 *
 * This was `Math.min(20, …)`, which capped every provider at a page of results
 * even when the caller asked for 50 — and only Brave actually has that limit.
 * The multiplier is there because the merge DEDUPES: asking each engine for
 * exactly `count` leaves the union short of `count` the moment two engines
 * agree on anything, which is the case the fusion is for.
 */
function perEngineCount(count: number): number {
  return Math.max(10, Math.min(50, Math.ceil(count * 1.5)));
}

/**
 * Multi-engine web search: every available backend, in parallel, merged, with a
 * per-engine account of what happened.
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
 * Engines that fail or time out simply do not vote — but they DO report, which
 * is how a run can tell a user its Brave quota ran out rather than just handing
 * back a thinner report.
 */
export async function searchWithEngineReport({
  query,
  count = 6,
  signal,
  engines,
  perEngineCount: perEngineOverride,
  options,
}: {
  query: string;
  count?: number;
  signal?: AbortSignal;
  /**
   * Which of the configured engines may run, by name. A filter over the one
   * list, never a second list: chat asks for exactly one engine per attempt
   * (SPEC §6.3), Research leaves it unset and fans out as before.
   */
  engines?: (name: string) => boolean;
  /** Results asked of each engine; `perEngineCount(count)` when unset. Chat asks for exactly `count`. */
  perEngineCount?: number;
  /** Chat's per-call engine options (recency, Exa highlights). */
  options?: EngineCallOptions;
}): Promise<{ results: SearchResult[]; engines: EngineReport[]; providers: SearchProviderStatus }> {
  const providers = searchProviderStatus();
  if (!query.trim()) return { results: [], engines: [], providers };

  const active = ENGINES.filter((engine) => engine.available() && (!engines || engines(engine.name)));
  if (active.length === 0) return { results: [], engines: [], providers };

  const perEngine = perEngineOverride ?? perEngineCount(count);
  const settled = await Promise.all(active.map((engine) => runEngine(engine, query, perEngine, signal, options)));

  const results = fuseRankedLists(
    settled.map(({ hits }, i) => ({ engine: active[i], hits })),
    count
  );
  return { results, engines: settled.map(({ report }) => report), providers };
}

/** The result-only shape, for callers with nowhere to put the engine roster. */
export async function executeMultiEngineSearch(input: {
  query: string;
  count?: number;
  signal?: AbortSignal;
}): Promise<SearchResult[]> {
  return (await searchWithEngineReport(input)).results;
}
