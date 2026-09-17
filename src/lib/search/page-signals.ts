/**
 * What a fetched response says about itself beyond its text.
 *
 * Two signals the research crawler needs and the extractor is the only code
 * that can see: whether an HTML document is a client-rendered shell whose
 * real content only exists once JavaScript has run, and how long a server
 * that answered 429 or 503 asked to be left alone. Pure, and separate from
 * search-engine.ts because that module is `server-only` and these are exactly
 * the decisions a test has to be able to reach. The shell heuristic used to
 * live in the crawler, exported and tested, and was called from nothing in
 * production — the only code that had the raw HTML could not import it.
 */

/**
 * Whether a page's initial HTML is a client-side rendered shell.
 *
 * Two kinds of evidence. Too little text is the direct one: below 150
 * characters a document is a loading screen, whatever its markup says. Above
 * that, the markup itself — an empty framework root, a "please enable
 * JavaScript" plea, a `<noscript>` that only ever shows when scripts are off —
 * is what tells a 300-character page of navigation and a cookie banner apart
 * from a 300-character article.
 */
export function isPotentialSpa(html: string, textLength: number): boolean {
  if (textLength < 150) return true;

  const spaPatterns = [
    /<div[^>]+id=["'](?:root|app|__next)["'][^>]*>\s*<\/div>/i,
    /<div[^>]+id=["'](?:root|app|__next)["'][^>]*\/>/i,
    /<div[^>]+id=["'](?:root|app)["'][^>]*><\/div>/i,
    /enable javascript/i,
    /javascript is required/i,
    /requires javascript/i,
    /<noscript>[\s\S]*?javascript[\s\S]*?<\/noscript>/i,
  ];

  for (const pattern of spaPatterns) {
    if (pattern.test(html)) return true;
  }

  return false;
}

/**
 * Milliseconds a `Retry-After` header asks for, or null when it is absent or
 * unreadable. Both forms the header allows are read: a delay in seconds, and
 * an HTTP date measured against `now`.
 */
export function parseRetryAfterMs(header: string | null | undefined, now: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - now);
}

/** The most one retry will wait, and the least it needs left on the clock to be worth starting. */
export const FETCH_RETRY_BACKOFF_MS = 3_000;
const FETCH_RETRY_HEADROOM_MS = 5_000;

export interface FetchFailureSignal {
  reason: string;
  httpStatus?: number;
  retryAfterMs?: number;
}

/**
 * How long to wait before retrying a failed page fetch once, or null when a
 * retry is not worth the wait.
 *
 * Only a 429 or a 503 is retried: those are the two answers that mean "not
 * right now" rather than "not at all", and the page fetcher used to treat
 * them like a 404 while the search layer beside it already retried its own
 * 429s. The wait honours `Retry-After` up to a short cap — a server asking for
 * a minute is not going to get it from a fetch on a 25-second clock — and the
 * retry is skipped outright when the second attempt would start with too
 * little of that clock left to finish.
 */
export function fetchRetryDelayMs(failure: FetchFailureSignal, elapsedMs: number, timeoutMs: number): number | null {
  if (failure.reason !== "http_error") return null;
  if (failure.httpStatus !== 429 && failure.httpStatus !== 503) return null;
  const wait = Math.min(failure.retryAfterMs ?? FETCH_RETRY_BACKOFF_MS, FETCH_RETRY_BACKOFF_MS);
  if (elapsedMs + wait + FETCH_RETRY_HEADROOM_MS > timeoutMs) return null;
  return wait;
}
