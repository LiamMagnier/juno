/**
 * Alevr Search: the shapes every part of the provider-neutral search stack
 * shares (BRIEF §15–17).
 *
 * One discovery interface for every backend that can turn a query into URLs
 * (paid APIs, a self-hosted SearXNG, a permitted open-data API, Alevr's own
 * page index), one page store for what Alevr has already read, and one call
 * record so every search says which backend answered and what it cost.
 *
 * Types only, pure and client-safe.
 */

/** What kind of results a call wants. `images` and `documents` have no backend yet (SEARCH.md). */
export type SearchVertical = "web" | "news";

export type Recency = "day" | "week" | "month" | "year";

/**
 * Where a backend's results come from, which is also how it is paid for.
 *
 *  - `paid`: a commercial search API billed per call (Tavily, Serper, Brave, Exa).
 *  - `self_hosted`: an index the operator runs (SearXNG). No per-call fee; the
 *    infrastructure is not free and SEARCH.md says so.
 *  - `open_data`: a public API whose operator permits programmatic access
 *    (Wikipedia's API under its User-Agent policy).
 *  - `index`: Alevr's own page cache, searched with Postgres full-text search.
 */
export type BackendKind = "paid" | "self_hosted" | "open_data" | "index";

/** One discovered result before ranking. */
export interface DiscoveryHit {
  title: string;
  url: string;
  snippet: string;
  /** Page text the backend returned with the hit (Tavily raw content, Exa text). */
  rawContent?: string;
  publishedAt?: Date;
  /** The backend id that returned it; a fused result joins several with "+". */
  backend: string;
  /** 0-based rank in the backend's own list. */
  rank: number;
  /** Detected language of the page, ISO 639-1, when the backend or the page says. */
  language?: string;
}

export type BackendStatus = "ok" | "empty" | "bad_key" | "rate_limited" | "provider_error" | "timeout" | "failed" | "skipped";

/** What one backend did for one query. */
export interface BackendReport {
  backend: string;
  status: BackendStatus;
  results: number;
  latencyMs: number;
  costMicroUsd: number;
  httpStatus?: number;
}

export interface DiscoveryQuery {
  query: string;
  count: number;
  vertical: SearchVertical;
  recency?: Recency;
  /** ISO 639-1 the reader wants results in, when known. */
  language?: string;
  /** ISO 3166-1 alpha-2 region, when relevant. */
  region?: string;
}

/**
 * One discovery backend behind the Alevr Search interface.
 *
 * `quality` is the operator's prior for how good the backend is per vertical
 * (0..1). Selection never picks a backend below the request's floor, then
 * picks the cheapest that clears it, so a cheap backend wins only where it is
 * good enough. `costMicroUsd` is the marginal cost of ONE call returning
 * `results` results, and is what the call record bills.
 */
export interface DiscoveryBackend {
  id: string;
  kind: BackendKind;
  /** Verticals the backend can serve at all. */
  verticals: ReadonlySet<SearchVertical>;
  quality: Readonly<Partial<Record<SearchVertical, number>>>;
  available(env: Readonly<Record<string, string | undefined>>): boolean;
  costMicroUsd(results: number): number;
  run(query: DiscoveryQuery, signal: AbortSignal): Promise<DiscoveryHit[]>;
}

/** A page Alevr has read, as the page store holds it. */
export interface CachedPage {
  /** `canonicalUrl(url)`: tracking parameters dropped, host lowercased, no fragment. */
  canonicalKey: string;
  url: string;
  host: string;
  title: string;
  text: string;
  /** sha256 of the extracted text: two URLs with one hash are one document. */
  contentHash: string;
  etag?: string | null;
  lastModified?: string | null;
  publishedAt?: Date | null;
  fetchedAt: Date;
  /** Last time the origin confirmed the copy (a 200 or a 304). */
  validatedAt: Date;
  /** After this the copy is revalidated before it is served. */
  freshUntil: Date;
  language?: string | null;
  contentType: string;
  /** How the page reached the cache: a chat search result or a research source. */
  admission: "discovered" | "research";
  /** The page's outbound links (at most 120), so a cached page still feeds Research's hop stage. */
  links?: Array<{ href: string; text: string }>;
}

/** An index search hit: a cached page and its full-text score. */
export interface IndexHit {
  page: CachedPage;
  /** `ts_rank_cd` normalised by document length (Postgres) or BM25 (memory store). */
  lexical: number;
  /** A window of the text around the first matched term. */
  snippet: string;
}

/** The exact-query result cache: results of one (query, vertical, recency, language, region). */
export interface CachedQuery {
  key: string;
  hits: DiscoveryHit[];
  backend: string;
  createdAt: Date;
  expiresAt: Date;
}

/** One search call, as the call log keeps it. Never the query text and never a user. */
export interface SearchCallRecord {
  at: Date;
  surface: "chat" | "research" | "work" | "bench";
  vertical: SearchVertical;
  /** Which path answered: an exact cached query, the page index, or a discovery backend. */
  servedBy: "query_cache" | "index" | "discovery" | "none";
  backend: string | null;
  results: number;
  latencyMs: number;
  costMicroUsd: number;
  /** Results of this call that were already in the page cache. */
  cachedPages: number;
  backends: BackendReport[];
}

/** Persistence behind the page cache, the query cache and the call log. */
export interface SearchStore {
  getPage(canonicalKey: string): Promise<CachedPage | null>;
  getPages(canonicalKeys: readonly string[]): Promise<CachedPage[]>;
  /** Insert or replace; a page whose content hash already exists under another key is linked, not duplicated. */
  putPage(page: CachedPage): Promise<void>;
  /** A 304: the copy is still the origin's. */
  touchPage(canonicalKey: string, validatedAt: Date, freshUntil: Date): Promise<void>;
  searchIndex(input: { query: string; limit: number; language?: string; freshAfter?: Date }): Promise<IndexHit[]>;
  getQuery(key: string, now: Date): Promise<CachedQuery | null>;
  putQuery(entry: CachedQuery): Promise<void>;
  recordCall(record: SearchCallRecord): Promise<void>;
}
