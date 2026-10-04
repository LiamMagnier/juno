/**
 * Alevr-owned retrieval: one URL to one document through the page cache
 * (BRIEF §16, "fetch safely, normalize, deduplicate, extract, cache").
 *
 * The network half is the existing extractor (`src/lib/web/extract.ts`): the
 * pinned, SSRF-checked transport, the guarded redirect walk, the byte caps,
 * the MIME gate, the PDF and HTML readers. This module only decides whether
 * the network is needed:
 *
 *   1. canonical key (`canonicalUrl`: no fragment, no tracking parameters,
 *      lowercased host) → a fresh cached copy is served with no request;
 *   2. a stale copy with validators is revalidated with a conditional GET —
 *      a 304 refreshes it without a body;
 *   3. otherwise the page is fetched and, when it may be cached, stored with
 *      its content hash, validators and freshness.
 *
 * What may be cached is decided here, deterministically: only pages the
 * caller says were DISCOVERED (a search result, a research source or a link
 * on one) — never a URL a person typed, a connector result or anything from a
 * private chat; never a response marked `no-store`/`private`; never a page
 * whose robots header or meta says `noindex`/`noarchive`/`none`; never a URL
 * carrying a credential-shaped string.
 *
 * A cached copy is DATA like any other page: whoever serves it still scans it
 * for injection and wraps it in the untrusted envelope (`fetch-page.ts`
 * `present`). The cache never launders a page into trusted text.
 *
 * Free of `server-only`; the store and the extractor are injected.
 */

import { createHash } from "node:crypto";

import { canonicalUrl } from "@/lib/search/url-safety";
import { envNumber } from "@/lib/search/alevr/backends";
import type { CachedPage, SearchStore } from "@/lib/search/alevr/types";
import type { ExtractOptions, ExtractOutcome, ExtractResult, PageCacheHeaders } from "@/lib/web/extract";
import { urlSecretRule } from "@/lib/web/url-guard";

type Env = Readonly<Record<string, string | undefined>>;

export type Extractor = (url: string, signal: AbortSignal | undefined, opts: ExtractOptions) => Promise<ExtractOutcome>;

export function contentHash(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}

/**
 * The page cache key: `canonicalUrl` (no fragment, no tracking parameters,
 * lowercased host without `www.`) WITH the port. `canonicalUrl` drops the
 * port, which is harmless for de-duplicating a run's sources but would let a
 * page served on one port answer for another in a shared cache.
 */
export function pageCacheKey(url: string): string {
  const key = canonicalUrl(url);
  try {
    const port = new URL(url).port;
    if (!port) return key;
    const at = key.indexOf("//");
    const slash = key.indexOf("/", at + 2);
    const end = slash < 0 ? key.length : slash;
    return `${key.slice(0, end)}:${port}${key.slice(end)}`;
  } catch {
    return key;
  }
}

const MIN_TTL_S = 5 * 60;
const MAX_CACHED_LINKS = 120;
const MAX_TTL_S = 7 * 24 * 60 * 60;

/** Whether a response may be cached, and until when it is fresh. */
export function cachePolicy(
  headers: PageCacheHeaders | undefined,
  now: Date,
  env: Env = process.env,
): { store: boolean; reason?: string; freshUntil: Date } {
  const defaultTtl = envNumber(env, "ALEVR_PAGE_TTL_SECONDS", 24 * 60 * 60, MIN_TTL_S, MAX_TTL_S);
  const cc = headers?.cacheControl ?? "";
  const robots = `${headers?.xRobotsTag ?? ""},${headers?.robotsMeta ?? ""}`;
  if (/\b(no-store|private)\b/.test(cc)) return { store: false, reason: "cache_control", freshUntil: now };
  if (/\b(noindex|noarchive|none)\b/.test(robots)) return { store: false, reason: "robots", freshUntil: now };
  const maxAge = cc.match(/\bs-maxage=(\d+)/)?.[1] ?? cc.match(/\bmax-age=(\d+)/)?.[1];
  // `no-cache` means "revalidate before use": cache it, already stale.
  const ttl = /\bno-cache\b/.test(cc) ? 0 : maxAge ? Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, Number(maxAge))) : defaultTtl;
  return { store: true, freshUntil: new Date(now.getTime() + ttl * 1000) };
}

export interface OpenPageInput {
  url: string;
  signal?: AbortSignal;
  /** The page was discovered (search result, research source, link on one): it may join the shared cache. */
  admit: "discovered" | "research" | false;
  /** A private chat reads the cache but never writes it. */
  private: boolean;
  extractOptions: ExtractOptions;
}

export interface OpenPageDeps {
  store: SearchStore | null;
  extract: Extractor;
  now?: () => Date;
  env?: Env;
}

export type OpenPageOutcome =
  | { ok: true; page: ExtractResult; served: "cache" | "revalidated" | "network"; stored: boolean; key: string; contentHash: string }
  | { ok: false; outcome: Extract<ExtractOutcome, { ok: false }>; key: string };

function fromCache(cached: CachedPage, maxChars: number | undefined): ExtractResult {
  const text = maxChars ? cached.text.slice(0, maxChars) : cached.text;
  return {
    title: cached.title,
    text,
    links: cached.links ?? [],
    finalUrl: cached.url,
    hops: [cached.url],
    contentType: cached.contentType === "pdf" ? "pdf" : cached.contentType === "text" ? "text" : "html",
    totalChars: cached.text.length,
    ...(cached.publishedAt ? { publishedAt: cached.publishedAt } : {}),
  };
}

export async function openPage(input: OpenPageInput, deps: OpenPageDeps): Promise<OpenPageOutcome> {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const key = pageCacheKey(input.url);
  const cached = deps.store ? await deps.store.getPage(key).catch(() => null) : null;
  const at = now();

  if (cached && cached.freshUntil > at) {
    return { ok: true, page: fromCache(cached, input.extractOptions.maxChars), served: "cache", stored: false, key, contentHash: cached.contentHash };
  }

  const conditional =
    cached && (cached.etag || cached.lastModified) ? { etag: cached.etag ?? null, lastModified: cached.lastModified ?? null } : undefined;
  const outcome = await deps.extract(input.url, input.signal, { ...input.extractOptions, ...(conditional ? { conditional } : {}) });

  if (!outcome.ok) {
    if (cached && outcome.failure.reason === "http_error" && outcome.failure.httpStatus === 304) {
      const policy = cachePolicy(undefined, at, env);
      if (!input.private && deps.store) await deps.store.touchPage(key, at, policy.freshUntil).catch(() => undefined);
      return { ok: true, page: fromCache(cached, input.extractOptions.maxChars), served: "revalidated", stored: false, key, contentHash: cached.contentHash };
    }
    return { ok: false, outcome, key };
  }

  const page = outcome.page;
  const hash = contentHash(page.text);
  let stored = false;
  if (deps.store && !input.private && input.admit && !urlSecretRule(page.finalUrl ?? input.url) && !urlSecretRule(input.url)) {
    const policy = cachePolicy(page.cache, at, env);
    // A page cut to the caller's window is not the page: only a whole text is cached.
    const whole = (page.totalChars ?? page.text.length) <= page.text.length;
    if (policy.store && whole) {
      const finalUrl = page.finalUrl ?? input.url;
      let host = "";
      try {
        host = new URL(finalUrl).hostname.toLowerCase().replace(/^www\./, "");
      } catch {
        host = "";
      }
      await deps.store
        .putPage({
          canonicalKey: key,
          url: finalUrl,
          host,
          title: page.title,
          text: page.text,
          contentHash: hash,
          etag: page.cache?.etag ?? null,
          lastModified: page.cache?.lastModified ?? null,
          publishedAt: page.publishedAt ?? null,
          fetchedAt: at,
          validatedAt: at,
          freshUntil: policy.freshUntil,
          language: page.cache?.language ?? null,
          contentType: page.contentType ?? "html",
          admission: input.admit,
          links: page.links.slice(0, MAX_CACHED_LINKS).map((link) => ({ href: link.href, text: link.text.slice(0, 200) })),
        })
        .then(() => {
          stored = true;
        })
        .catch(() => undefined);
    }
  }
  return { ok: true, page, served: "network", stored, key, contentHash: hash };
}
