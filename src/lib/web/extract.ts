/**
 * One URL to one document: the search stack's fast path, shared by Research,
 * Work and chat's `web_fetch` (SPEC §6.1 steps 7–9).
 *
 * Moved out of `search-engine.ts`, which re-exports it unchanged for its
 * existing callers, because that module is `server-only` (it holds the engine
 * keys) and this is exactly the part a test has to drive end to end: the safe
 * redirect walk, the pinned transport, the byte caps, the PDF reader and the
 * linear HTML extractor, against a real socket. Nothing here reads a secret.
 *
 * Every exit is a typed outcome, never a throw: this runs inside Research's
 * READ stage, where one exception ends the round rather than one source, and
 * inside chat, where a refusal has to reach the model as a sentence.
 *
 * What chat adds, all optional so Research and Work are unchanged:
 * - `guard`, applied to every redirect hop beside the SSRF host check, so a
 *   link the ledger approved cannot redirect to Juno's own origin or a
 *   non-web port;
 * - `timeoutMs`, one deadline over the whole chain (every hop, the body, the
 *   extraction), tied to the caller's signal (§6.4 item 7);
 * - `maxHtmlBytes` / `maxPdfBytes`, read by streaming straight into the bounded
 *   readers (the transport no longer buffers a whole response first);
 * - `userAgent`: chat identifies itself honestly (DECISIONS §4c);
 * - the hop list, the final URL, the content type and the full text length on
 *   the result, for the tool's metadata lines and the provenance ledger.
 */

import { fetchSafePublicUrl } from "@/lib/search/fetch-safe";
import { parseRetryAfterMs } from "@/lib/search/page-signals";
import {
  extractPdfText,
  looksLikePdf,
  MAX_PDF_BYTES,
  readBodyBounded,
  responseIsPdf,
  type PdfFailureReason,
} from "@/lib/search/pdf-text";
import { BlockedAddressError, fetchPinnedPublicUrl, ResponseTooLargeError } from "@/lib/search/pinned-fetch";
import { isDisallowedHost } from "@/lib/search/url-safety";
import { htmlToCleanTextAsync, looksLikeShell, type PageLink } from "@/lib/web/html-text";

export type { PageLink } from "@/lib/web/html-text";

export type DocumentContentType = "html" | "pdf" | "text" | "json" | "xml";

export interface ExtractResult {
  title: string;
  text: string;
  author?: string;
  publishedAt?: Date;
  /** Resolved, SSRF-filtered, de-duplicated — in the order the page listed them. */
  links: PageLink[];
  /**
   * True when the HTML looks like a client-rendered shell — an empty framework
   * root, a "please enable JavaScript" notice — so the text above is the
   * loading screen rather than the page. Only the extractor sees the raw HTML,
   * so only it can say; the research crawler uses this to decide whether a
   * headless render is worth attempting.
   */
  shell?: boolean;
  /** The URL the document came from, after redirects. */
  finalUrl?: string;
  /** Every URL requested, the first one first and `finalUrl` last. */
  hops?: string[];
  contentType?: DocumentContentType;
  /** PDF only: the document's page count. */
  pages?: number;
  /** Characters extracted before `text` was cut to `maxChars`. */
  totalChars?: number;
  /**
   * What the response said about caching, for Alevr's page cache (BRIEF §16):
   * the validators a later conditional request revalidates with, the
   * `Cache-Control` and `X-Robots-Tag` headers, and the page's own robots
   * meta and declared language. Absent when the server sent none.
   */
  cache?: PageCacheHeaders;
}

export interface PageCacheHeaders {
  etag?: string;
  lastModified?: string;
  cacheControl?: string;
  xRobotsTag?: string;
  /** `<meta name="robots" content="…">`, lowercased. */
  robotsMeta?: string;
  /** `<html lang="…">`, lowercased ISO tag. */
  language?: string;
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
  /** `retryAfterMs` carries the server's own `Retry-After`, when it sent one, for a caller that may retry. */
  | { reason: "http_error"; httpStatus: number; retryAfterMs?: number }
  | { reason: "unsupported_content_type"; contentType: string }
  | { reason: "response_too_large"; limitBytes: number }
  /** `shell`: the HTML was a client-rendered shell, so a browser might have found text. */
  | { reason: "empty_document"; shell?: boolean }
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
  /** Only with `timeoutMs`: the caller's own deadline passed. */
  | { reason: "timeout" }
  | { reason: "fetch_failed"; detail: string };

export type ExtractOutcome = { ok: true; page: ExtractResult } | { ok: false; failure: ExtractFailure };

export type ExtractTransport = (url: string, init: RequestInit, signal?: AbortSignal) => Promise<Response>;

export interface ExtractOptions {
  maxChars?: number;
  /** Replaces Research's browser-like User-Agent; chat sends an honest one. */
  userAgent?: string;
  /** Applied to every hop beside the SSRF host guard; false refuses the hop as `blocked_host`. */
  guard?: (url: string) => boolean;
  /** One deadline over the whole chain; its expiry is `{ reason: "timeout" }`. */
  timeoutMs?: number;
  /** HTML/text byte ceiling; default 4 MB. */
  maxHtmlBytes?: number;
  /** PDF byte ceiling; default `MAX_PDF_BYTES` (12 MB). */
  maxPdfBytes?: number;
  /** The per-hop transport; the pinned public fetch unless a test says otherwise. */
  transport?: ExtractTransport;
  /**
   * Validators of a cached copy. Sent as `If-None-Match` / `If-Modified-Since`;
   * a 304 comes back as `{ reason: "http_error", httpStatus: 304 }`, which the
   * page cache reads as "still current" (`src/lib/search/alevr/retrieve.ts`).
   */
  conditional?: { etag?: string | null; lastModified?: string | null };
}

/** Bounded scans of the document head, so a hostile page cannot make them backtrack. */
const HEAD_SCAN_CHARS = 64 * 1024;
const ROBOTS_META = /<meta\b[^>]{0,400}?\bname\s*=\s*["']?robots["']?[^>]{0,400}?>/i;
const META_CONTENT = /\bcontent\s*=\s*["']([^"'>]{0,200})["']/i;
const HTML_LANG = /<html\b[^>]{0,400}?\blang\s*=\s*["']?([a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?)/i;

/** The robots meta and the declared language from the first 64 KB of a page. */
export function headSignals(html: string): { robotsMeta?: string; language?: string } {
  const head = html.slice(0, HEAD_SCAN_CHARS);
  const meta = head.match(ROBOTS_META)?.[0];
  const robots = meta ? meta.match(META_CONTENT)?.[1]?.trim().toLowerCase() : undefined;
  const language = head.match(HTML_LANG)?.[1]?.toLowerCase();
  return { ...(robots ? { robotsMeta: robots } : {}), ...(language ? { language } : {}) };
}

function cacheHeadersOf(res: Response, html?: string): PageCacheHeaders | undefined {
  const pick = (name: string) => res.headers.get(name)?.trim() || undefined;
  const out: PageCacheHeaders = {
    ...(pick("etag") ? { etag: pick("etag") } : {}),
    ...(pick("last-modified") ? { lastModified: pick("last-modified") } : {}),
    ...(pick("cache-control") ? { cacheControl: pick("cache-control")!.toLowerCase() } : {}),
    ...(pick("x-robots-tag") ? { xRobotsTag: pick("x-robots-tag")!.toLowerCase() } : {}),
    ...(html ? headSignals(html) : {}),
  };
  return Object.keys(out).length ? out : undefined;
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
export const MAX_EXTRACT_CHARS = 200_000;
/** HTML is untrusted network input; bound bytes before decoding/parsing it. */
export const MAX_HTML_BYTES = 4 * 1024 * 1024;

const RESEARCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 JunoResearch/2.0";

function contentTypeOf(baseType: string): DocumentContentType {
  if (baseType.includes("html")) return "html";
  if (baseType.includes("json")) return "json";
  if (baseType.includes("xml")) return "xml";
  return baseType ? "text" : "html";
}

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
  maxChars: number,
  maxBytes: number,
): Promise<ExtractOutcome> {
  const bytes = await readBodyBounded(res, maxBytes);
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
      contentType: "pdf",
      pages: parsed.pages,
      totalChars: parsed.text.length,
    },
  };
}

function hostForLog(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable)";
  }
}

/** The caller's signal and the deadline as one, or whichever exists. */
function combine(signal: AbortSignal | undefined, deadline: AbortSignal | null): AbortSignal | undefined {
  if (signal && deadline) return AbortSignal.any([signal, deadline]);
  return signal ?? deadline ?? undefined;
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
  opts: ExtractOptions = {},
): Promise<ExtractOutcome> {
  if (!url || isDisallowedHost(url) || (opts.guard && !opts.guard(url))) {
    return { ok: false, failure: { reason: "blocked_host" } };
  }
  const maxChars = Math.max(1, Math.min(MAX_EXTRACT_CHARS, opts.maxChars ?? EXTRACT_CHARS));
  const maxHtmlBytes = opts.maxHtmlBytes ?? MAX_HTML_BYTES;
  const maxPdfBytes = opts.maxPdfBytes ?? MAX_PDF_BYTES;
  const deadline = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : null;
  const active = combine(signal, deadline);
  // The transport's own ceiling sits just above both readers', so the readers
  // are the ones that say "too large" with a typed outcome.
  const transport: ExtractTransport =
    opts.transport ??
    ((target, init, hopSignal) =>
      fetchPinnedPublicUrl(target, init, hopSignal, { maxBytes: Math.max(maxHtmlBytes, maxPdfBytes) + 1 }));

  try {
    const fetched = await fetchSafePublicUrl(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": opts.userAgent ?? RESEARCH_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
          "Accept-Language": "en-US,en;q=0.9",
          ...(opts.conditional?.etag ? { "If-None-Match": opts.conditional.etag } : {}),
          ...(opts.conditional?.lastModified ? { "If-Modified-Since": opts.conditional.lastModified } : {}),
        },
      },
      active,
      transport,
      opts.guard ? { guard: opts.guard } : {},
    );
    if (fetched.kind === "blocked") return { ok: false, failure: { reason: "blocked_host" } };
    if (fetched.kind === "redirect_limit") return { ok: false, failure: { reason: "redirect_limit" } };
    const { response: res, url: finalUrl, hops } = fetched;
    const located = { finalUrl, hops };

    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      return {
        ok: false,
        failure: { reason: "http_error", httpStatus: res.status, ...(retryAfterMs !== null ? { retryAfterMs } : {}) },
      };
    }
    const contentType = res.headers.get("content-type") ?? "";
    const baseType = contentType.split(";")[0].trim().toLowerCase();

    // The transport asks for `identity` and never inflates a body, so a server
    // that compresses anyway would hand the parsers raw gzip. Refused by name
    // rather than parsed as garbage, and no decompressor ever sees a byte a
    // stranger chose: a decompression bomb has nothing to expand in.
    const encoding = res.headers.get("content-encoding")?.trim().toLowerCase();
    if (encoding && encoding !== "identity") {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, failure: { reason: "unsupported_content_type", contentType: `encoded:${encoding.slice(0, 20)}` } };
    }

    // The response URL, not the requested one — redirects are followed, and it is
    // the landing address whose extension means anything.
    if (responseIsPdf(baseType, finalUrl)) {
      const outcome = await extractPdfDocumentFrom(res, finalUrl, active, maxChars, maxPdfBytes);
      const cache = cacheHeadersOf(res);
      return outcome.ok ? { ok: true, page: { ...outcome.page, ...located, ...(cache ? { cache } : {}) } } : outcome;
    }

    if (contentType && !contentType.includes("text/") && !contentType.includes("json") && !contentType.includes("xml")) {
      // Everything this build genuinely has no parser for — images, archives,
      // office documents. Naming the type is what lets the timeline say which.
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, failure: { reason: "unsupported_content_type", contentType: baseType } };
    }

    const htmlBytes = await readBodyBounded(res, maxHtmlBytes);
    if (!htmlBytes) return { ok: false, failure: { reason: "response_too_large", limitBytes: maxHtmlBytes } };
    const html = new TextDecoder().decode(htmlBytes);
    // The response URL, not the requested one: redirects are followed, and
    // resolving a page's relative links against the pre-redirect address points
    // the hop stage at URLs that do not exist.
    const parsed = await htmlToCleanTextAsync(html, finalUrl, active);
    const shell = looksLikeShell(parsed.text.length, parsed.shellMarkup);
    if (!parsed.text || parsed.text.length < 50) return { ok: false, failure: { reason: "empty_document", shell } };
    const cache = cacheHeadersOf(res, html);

    return {
      ok: true,
      page: {
        ...(cache ? { cache } : {}),
        title: parsed.title ?? url,
        text: parsed.text.slice(0, maxChars),
        author: parsed.author,
        publishedAt: parsed.publishedAt,
        links: parsed.links,
        shell,
        contentType: contentTypeOf(baseType),
        totalChars: parsed.text.length,
        ...located,
      },
    };
  } catch (e) {
    if (deadline?.aborted && !signal?.aborted) return { ok: false, failure: { reason: "timeout" } };
    if (e instanceof BlockedAddressError) return { ok: false, failure: { reason: "blocked_host" } };
    if (e instanceof ResponseTooLargeError) {
      return { ok: false, failure: { reason: "response_too_large", limitBytes: e.limitBytes } };
    }
    const detail = e instanceof Error ? e.message : String(e);
    if (!signal?.aborted) {
      // The host, never the URL: a chat's links are the user's, and a log line
      // is a copy of them outside the database.
      console.warn("[web/extract] fetch extraction failed for host:", hostForLog(url), detail);
    }
    return { ok: false, failure: { reason: "fetch_failed", detail } };
  }
}

/** The null-returning shape, for callers that only care whether a page arrived. */
export async function extractUrlContent(url: string, signal?: AbortSignal): Promise<ExtractResult | null> {
  const outcome = await extractUrlDocument(url, signal);
  return outcome.ok ? outcome.page : null;
}
