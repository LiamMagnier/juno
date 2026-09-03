import "server-only";
import { isDisallowedHost } from "./url-safety";
import { fetchSafePublicUrl } from "./fetch-safe";
import { fuseRankedLists, type EngineSpec, type SearchResult } from "./fusion";
import {
  extractPdfText,
  looksLikePdf,
  MAX_PDF_BYTES,
  readBodyBounded,
  responseIsPdf,
  type PdfFailureReason,
} from "./pdf-text";

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

/** One outbound link kept from a fetched page, for the bounded hop stage. */
export interface PageLink {
  href: string;
  text: string;
}

export interface ExtractResult {
  title: string;
  text: string;
  author?: string;
  publishedAt?: Date;
  /** Resolved, SSRF-filtered, de-duplicated — in the order the page listed them. */
  links: PageLink[];
}

/**
 * Why a fetch produced no document.
 *
 * `extractUrlContent` returned a bare null for all of these, which meant the
 * research engine's READ loop could only `continue` — and a PDF, exactly the
 * primary-source class the planner is prompted to go looking for, vanished from
 * a run with nothing anywhere saying it had been seen and skipped. PDFs are now
 * read rather than skipped, but the ones that still cannot be (protected,
 * damaged, enormous) travel out by the same route for the same reason.
 */
export type ExtractFailure =
  | { reason: "blocked_host" }
  | { reason: "redirect_limit" }
  | { reason: "http_error"; httpStatus: number }
  | { reason: "unsupported_content_type"; contentType: string }
  | { reason: "response_too_large"; limitBytes: number }
  | { reason: "empty_document" }
  /*
   * A PDF that was fetched and recognised but still yielded nothing. Separate
   * from `unsupported_content_type` because that reason now means what it says —
   * no parser exists for this type at all — and folding "this build cannot read
   * PDFs" together with "this particular PDF is password-protected" would make
   * the reason code useless the moment either answer changed.
   *
   * `no_text_layer` is deliberately absent: a scanned PDF parses perfectly and
   * simply has no text, which is `empty_document`, the same answer a JS-rendered
   * HTML page gets and the same sentence the timeline already prints for it.
   */
  | { reason: "pdf_unreadable"; detail: Exclude<PdfFailureReason, "no_text_layer"> }
  | { reason: "fetch_failed"; detail: string };

export type ExtractOutcome = { ok: true; page: ExtractResult } | { ok: false; failure: ExtractFailure };

/**
 * Page chrome, removed before anything else looks at the body.
 *
 * The extractor stripped only script/style/iframe/svg/noscript, so a cookie
 * banner, a mega-menu and a footer sitemap all survived into the text — and
 * since the text is then truncated to a fixed budget, the chrome ate the FRONT
 * of it. A source whose stored snapshot is a navigation menu is a source the
 * coverage matrix scores as irrelevant and the report cannot cite.
 *
 * Non-greedy, so a nested `<nav>` inside a `<nav>` leaves a stray close tag
 * behind; that is harmless here because every remaining tag is dropped later,
 * and the alternative is an HTML parser this repo deliberately does not carry.
 */
const CHROME_TAGS = ["nav", "header", "footer", "aside", "form", "dialog"];

function stripChrome(html: string): string {
  let out = html;
  for (const tag of CHROME_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), " ");
  }
  return out;
}

/** Roughly how much visible text a `<main>`/`<article>` must hold to be believed. */
const MAIN_REGION_MIN_CHARS = 600;

function visibleLength(html: string): number {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
}

/**
 * The part of the document that is the document.
 *
 * Deliberately conservative: a `<main>` or `<article>` is trusted only when it
 * holds enough visible text to plausibly BE the page. Plenty of sites emit an
 * empty `<main>` and render into it client-side, and preferring that region
 * would turn a readable page into an empty one — strictly worse than the chrome
 * this is trying to avoid.
 */
function mainRegion(html: string): string {
  for (const tag of ["article", "main"]) {
    const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
    if (match && visibleLength(match[1]) >= MAIN_REGION_MIN_CHARS) return match[1];
  }
  return html;
}

/** Links kept per page. Beyond this the tail is site navigation, not citations. */
const MAX_PAGE_LINKS = 120;

function collectLinks(html: string, baseUrl?: string): PageLink[] {
  if (!baseUrl) return [];
  const out: PageLink[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let resolved: string;
    try {
      resolved = new URL(match[1], baseUrl).toString();
    } catch {
      continue;
    }
    // The same guard the fan-out applies to search results. A page is an
    // untrusted party handing us URLs, and this is the one that reaches fetch().
    if (isDisallowedHost(resolved)) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const text = match[2]
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    out.push({ href: resolved, text });
    if (out.length >= MAX_PAGE_LINKS) break;
  }
  return out;
}

/**
 * Clean and convert raw HTML into readable structured markdown text.
 *
 * `baseUrl` is what turns the page's relative hrefs into followable links; omit
 * it and `links` comes back empty rather than full of unusable fragments.
 */
export function htmlToCleanText(
  html: string,
  baseUrl?: string
): { title?: string; text: string; author?: string; publishedAt?: Date; links: PageLink[] } {
  try {
    // Strip scripts, styles, iframes, and svg tags
    const stripped = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
      .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "")
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "");

    // Title and meta come from the WHOLE document: <title> and <meta> live in
    // <head>, which the main-content pick below is about to throw away.
    const titleMatch = stripped.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, " ") : undefined;

    const dateMatch = stripped.match(/<meta[^>]+(?:article:published_time|date|pubdate)[^>]+content=["']([^"']+)["']/i);
    let publishedAt: Date | undefined;
    if (dateMatch && dateMatch[1] && Number.isFinite(Date.parse(dateMatch[1]))) {
      publishedAt = new Date(dateMatch[1]);
    }

    const authorMatch = stripped.match(/<meta[^>]+(?:author|article:author)[^>]+content=["']([^"']+)["']/i);
    const author = authorMatch ? authorMatch[1].trim() : undefined;

    const body = mainRegion(stripChrome(stripped));
    // Links are read from the body region, not the raw document, for the same
    // reason the text is: a footer sitemap would otherwise be the top 100 links
    // on every page of the site and crowd out the ones the article cited.
    const links = collectLinks(body, baseUrl);

    // Convert standard tags to text equivalents
    let clean = body
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

    return { title, text: clean, author, publishedAt, links };
  } catch {
    return { text: html.replace(/<[^>]+>/g, " ").trim(), links: [] };
  }
}

/**
 * How much of one page is kept by default.
 *
 * Callers with a bigger appetite pass `maxChars`: the research corpus stores
 * pages in full (60k) because its workers grep them chunk by chunk, while a
 * chat-side fetch that lands the whole thing in one prompt keeps this cap.
 */
const EXTRACT_CHARS = 16_000;
/** The most any caller may ask for; bounds a hostile page's cost in memory. */
const MAX_EXTRACT_CHARS = 200_000;
/** HTML is untrusted network input; bound bytes before decoding/parsing it. */
const MAX_HTML_BYTES = 4 * 1024 * 1024;

/**
 * The PDF half of `extractUrlDocument`, kept separate only for length.
 *
 * Every exit is a typed outcome. This runs inside the research engine's READ
 * stage, where one thrown exception ends the round rather than one source, and a
 * PDF is an arbitrary binary chosen by a page we do not control — so the parser
 * is treated as something that will fail, not something that might.
 */
async function extractPdfDocumentFrom(
  res: Response,
  url: string,
  signal: AbortSignal | undefined,
  maxChars: number
): Promise<ExtractOutcome> {
  const bytes = await readBodyBounded(res, MAX_PDF_BYTES);
  if (!bytes) return { ok: false, failure: { reason: "pdf_unreadable", detail: "too_large" } };
  // Checked here as well as inside the parser so a mislabelled HTML error page —
  // a login wall served as application/pdf, which is common behind paywalls —
  // never pays for the pdf.js import at all.
  if (!looksLikePdf(bytes)) return { ok: false, failure: { reason: "pdf_unreadable", detail: "not_a_pdf" } };

  const parsed = await extractPdfText(bytes, { maxChars, signal });
  if (!parsed.ok) {
    // A scan is a valid document that simply holds no text, which is exactly
    // what `empty_document` already means for a JS-rendered HTML page — same
    // situation, same reason code, and a sentence the timeline already prints.
    if (parsed.reason === "no_text_layer") return { ok: false, failure: { reason: "empty_document" } };
    return { ok: false, failure: { reason: "pdf_unreadable", detail: parsed.reason } };
  }

  // The same floor the HTML path applies: a document that yielded a line or two
  // is a cover page, and storing it as a source makes a run look better read
  // than it is.
  if (parsed.text.length < 50) return { ok: false, failure: { reason: "empty_document" } };

  return {
    ok: true,
    page: {
      title: parsed.title ?? url,
      text: parsed.text,
      author: parsed.author,
      publishedAt: parsed.publishedAt,
      // A PDF link annotation has a target but no anchor text, so `text` is left
      // empty rather than filled with the URL again — the hop stage ranks on the
      // href, and a fabricated label would read as the document's own words.
      links: parsed.links.map((href) => ({ href, text: "" })),
    },
  };
}

/**
 * Universal page extractor with SSRF protection and clean markdown synthesis.
 *
 * Returns the REASON on failure rather than a bare null, so a caller can tell a
 * user "that file was password-protected" instead of quietly producing a report
 * that looks like it considered a document it never opened.
 *
 * The `Accept` header still asks for HTML first because that is what the vast
 * majority of results are; it ends in a wildcard at q=0.7, so a server with a
 * PDF still offers it and no header change was needed to start reading them.
 */
export async function extractUrlDocument(
  url: string,
  signal?: AbortSignal,
  opts: { maxChars?: number } = {}
): Promise<ExtractOutcome> {
  if (!url || isDisallowedHost(url)) return { ok: false, failure: { reason: "blocked_host" } };
  const maxChars = Math.max(1, Math.min(MAX_EXTRACT_CHARS, opts.maxChars ?? EXTRACT_CHARS));

  try {
    const fetched = await fetchSafePublicUrl(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 JunoResearch/2.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
      },
    }, signal);
    if (fetched.kind === "blocked") return { ok: false, failure: { reason: "blocked_host" } };
    if (fetched.kind === "redirect_limit") return { ok: false, failure: { reason: "redirect_limit" } };
    const { response: res, url: finalUrl } = fetched;

    if (!res.ok) return { ok: false, failure: { reason: "http_error", httpStatus: res.status } };
    const contentType = res.headers.get("content-type") ?? "";
    const baseType = contentType.split(";")[0].trim().toLowerCase();

    // The response URL, not the requested one — redirects are followed, and it is
    // the landing address whose extension means anything.
    if (responseIsPdf(baseType, finalUrl)) return await extractPdfDocumentFrom(res, finalUrl, signal, maxChars);

    if (contentType && !contentType.includes("text/") && !contentType.includes("json") && !contentType.includes("xml")) {
      // Everything this build genuinely has no parser for — images, archives,
      // office documents. Naming the type is what lets the timeline say which.
      return { ok: false, failure: { reason: "unsupported_content_type", contentType: baseType } };
    }

    const htmlBytes = await readBodyBounded(res, MAX_HTML_BYTES);
    if (!htmlBytes) return { ok: false, failure: { reason: "response_too_large", limitBytes: MAX_HTML_BYTES } };
    const html = new TextDecoder().decode(htmlBytes);
    // The response URL, not the requested one: redirects are followed, and
    // resolving a page's relative links against the pre-redirect address points
    // the hop stage at URLs that do not exist.
    const parsed = htmlToCleanText(html, finalUrl);
    if (!parsed.text || parsed.text.length < 50) return { ok: false, failure: { reason: "empty_document" } };

    return {
      ok: true,
      page: {
        title: parsed.title ?? url,
        text: parsed.text.slice(0, maxChars),
        author: parsed.author,
        publishedAt: parsed.publishedAt,
        links: parsed.links,
      },
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (!signal?.aborted) {
      console.warn("[search-engine] fetch extraction failed for:", url, detail);
    }
    return { ok: false, failure: { reason: "fetch_failed", detail } };
  }
}

/** The null-returning shape, for callers that only care whether a page arrived. */
export async function extractUrlContent(url: string, signal?: AbortSignal): Promise<ExtractResult | null> {
  const outcome = await extractUrlDocument(url, signal);
  return outcome.ok ? outcome.page : null;
}

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
 * Brave Search API
 */
async function searchBrave(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY?.trim() || process.env.BRAVE_API_KEY?.trim();
  if (!key) return [];

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  // Brave's own documented ceiling, unlike the 20 the other providers were
  // being held to for no reason. Asking for more is a 422, not more results.
  url.searchParams.set("count", String(Math.min(20, maxResults)));
  url.searchParams.set("result_filter", "web");

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": key,
    },
    signal,
  });

  if (!res.ok) throw new EngineHttpError("brave", res.status);
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

  if (!res.ok) throw new EngineHttpError("serper", res.status);
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

  if (!res.ok) throw new EngineHttpError("exa", res.status);
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

    // Not silent, unlike every other keyless path: DuckDuckGo's HTML endpoint
    // answers 202/403 when it decides a caller is a bot, and that is a real
    // degradation a keyless deployment should be able to see in the logs.
    if (!res.ok) throw new EngineHttpError("duckduckgo", res.status);
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
    if (e instanceof EngineHttpError) throw e;
    if (!signal?.aborted) {
      console.warn("[search-engine] duckduckgo search failed:", e instanceof Error ? e.message : e);
    }
    return [];
  }
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
 * the anonymous rate limits that make the PUBLIC instances close to useless. A
 * deployment with neither is running on scraped endpoints and should say so
 * rather than quietly returning eight results.
 */
export function searchProviderStatus(): SearchProviderStatus {
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
  engine: EngineSpec,
  query: string,
  perEngine: number,
  parent?: AbortSignal
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
      const hits = await engine.run(query, perEngine, ctrl.signal);
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
}: {
  query: string;
  count?: number;
  signal?: AbortSignal;
}): Promise<{ results: SearchResult[]; engines: EngineReport[]; providers: SearchProviderStatus }> {
  const providers = searchProviderStatus();
  if (!query.trim()) return { results: [], engines: [], providers };

  const active = ENGINES.filter((engine) => engine.available());
  if (active.length === 0) return { results: [], engines: [], providers };

  const perEngine = perEngineCount(count);
  const settled = await Promise.all(active.map((engine) => runEngine(engine, query, perEngine, signal)));

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
