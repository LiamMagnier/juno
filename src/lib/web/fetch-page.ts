/**
 * `web_fetch`'s backend: one page or PDF as clean text, behind the provenance
 * check, the SSRF guard on every redirect hop and the turn's limits (SPEC §6.1).
 *
 * The pipeline is normative and runs in the spec's order. Steps 1–6 decide
 * with no network and no DNS: the turn's call budget, the length, provenance
 * (`provenance.ts`), the secret check on untrusted links, the chat URL policy
 * (`url-guard.ts`), and the per-host budget. Only then does anything leave the
 * process, through `extractUrlDocument` with the chat guard on every hop, one
 * 15-second deadline over the whole chain, and chat's byte caps. What comes
 * back is scanned for injection, its URLs join the ledger, and the model gets
 * Juno's metadata lines outside the untrusted envelope and the page inside it.
 *
 * A refusal is a result, never a throw: the model reads why and what to do
 * next, the row shows the host only, and nothing was fetched. The one throw is
 * the turn's own abort, which the dispatcher turns into `cancelled`.
 *
 * Free of `server-only` (the extractor is `src/lib/web/extract.ts`), so the
 * whole pipeline is tested offline against fakes and a loopback socket.
 */

import { env } from "@/lib/env";
import type { ToolOutcome } from "@/lib/tools/types";
import { wrapUntrusted } from "@/lib/untrusted-content";
import {
  extractUrlDocument,
  MAX_EXTRACT_CHARS,
  type ExtractFailure,
  type ExtractOptions,
  type ExtractOutcome,
  type ExtractResult,
} from "@/lib/web/extract";
import {
  FETCH_DISABLED_LINE,
  LINKS_HEADING,
  NEEDS_BROWSER_TEXT,
  NOT_IN_PRIOR_CONTEXT_TEXT,
  RATE_LIMITED_TEXT,
  READING_BUDGET_SPENT_LINE,
  TIMEOUT_TEXT,
  TOO_LARGE_TEXT,
  URL_NOT_ALLOWED_TEXT,
  URL_TOO_LONG_TEXT,
  linkLine,
  notAccessibleText,
  pageSourceLabel,
  pastEndLine,
  requestedLine,
  retrievedLine,
  showingLine,
  typeLine,
  unsupportedTypeText,
  urlLine,
} from "@/lib/web/fetch-page.prompt";
import { openPage } from "@/lib/search/alevr/retrieve";
import { defaultSearchStore } from "@/lib/search/alevr/service";
import type { SearchStore } from "@/lib/search/alevr/types";
import { scanUntrusted } from "@/lib/web/injection";
import type { TurnTaint } from "@/lib/web/taint";
import { auditWeb, webTurnState, type PrefetchedPage } from "@/lib/web/turn-state";
import type { LazyUrlLedger, TurnWebLimits } from "@/lib/web/types";
import { canonicalize, canonKey, MAX_URL_CHARS } from "@/lib/web/url-canon";
import { urlGuard, urlGuardReason, urlSecretRule } from "@/lib/web/url-guard";
import type { ClientSource } from "@/types/chat";
import type { ToolErrorCode, ToolWebDetail } from "@/types/run";

export interface FetchPageInput {
  url: string;
  offset?: number;
  maxChars?: number;
}

export interface FetchPageContext {
  ledger: LazyUrlLedger;
  taint: TurnTaint;
  limits: TurnWebLimits;
  signal: AbortSignal;
  private: boolean;
}

/** Seams for tests; production passes none. */
export interface FetchPageDeps {
  extract?: (url: string, signal: AbortSignal | undefined, opts: ExtractOptions) => Promise<ExtractOutcome>;
  now?: () => Date;
  /** Juno's own hostnames; from the deployment's environment when absent. */
  ownHosts?: ReadonlySet<string>;
  /**
   * Alevr Search's page cache (BRIEF §16). `null` turns it off; absent means
   * the deployment's store, except when a test injected `extract`.
   */
  pageStore?: SearchStore | null;
}

/** §6.1 step 7: the whole redirect chain, the body and the extraction. */
export const FETCH_DEADLINE_MS = 15_000;
/** §6.1 step 8. */
export const CHAT_MAX_HTML_BYTES = 2 * 1024 * 1024;
export const CHAT_MAX_PDF_BYTES = 10 * 1024 * 1024;
/** §6.1 step 12. */
export const FETCH_DEFAULT_CHARS = 16_000;
export const FETCH_MIN_CHARS = 1_000;
export const FETCH_MAX_CHARS = 40_000;
/** Links shown to the model, and links kept on the record for T7 provenance. */
const LINKS_SHOWN = 40;
const LINKS_RECORDED = 20;
/** Links of one page that join the ledger (the extractor keeps at most this many). */
const LINKS_TO_LEDGER = 120;
const SNIPPET_CHARS = 300;

/** Chat's honest identity (DECISIONS §4c): it names Juno and says a person asked. */
export function chatUserAgent(appUrl: string = env.appUrl): string {
  return `Mozilla/5.0 (compatible; Juno/1.0; +${appUrl}) user-initiated fetch`;
}

function refusal(code: ToolErrorCode, text: string): ToolOutcome {
  return { status: "failed", text, body: text, error: { code } };
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function flatten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The refusal an extractor failure becomes (§6.1 step 9). */
export function failureOutcome(failure: ExtractFailure): ToolOutcome {
  switch (failure.reason) {
    case "blocked_host":
      return refusal("url_not_allowed", URL_NOT_ALLOWED_TEXT);
    case "http_error":
      return refusal("url_not_accessible", notAccessibleText(`HTTP ${failure.httpStatus}`));
    case "unsupported_content_type":
      return refusal("unsupported_content_type", unsupportedTypeText(failure.contentType));
    case "response_too_large":
      return refusal("too_large", TOO_LARGE_TEXT);
    case "empty_document":
      return failure.shell
        ? refusal("needs_browser", NEEDS_BROWSER_TEXT)
        : refusal("url_not_accessible", notAccessibleText("no readable text"));
    case "pdf_unreadable":
      if (failure.detail === "too_large") return refusal("too_large", TOO_LARGE_TEXT);
      return refusal(
        "url_not_accessible",
        notAccessibleText(failure.detail === "encrypted" ? "the PDF is password-protected" : "the PDF could not be read"),
      );
    case "redirect_limit":
      return refusal("url_not_accessible", notAccessibleText("too many redirects"));
    case "timeout":
      return refusal("timeout", TIMEOUT_TEXT);
    case "fetch_failed":
      return refusal("url_not_accessible", notAccessibleText(fetchFailureReason(failure.detail)));
  }
}

/** A network error in words a model can pass on, never the raw error text. */
function fetchFailureReason(detail: string): string {
  if (/ENOTFOUND|EAI_AGAIN|did not resolve/i.test(detail)) return "the address did not resolve";
  if (/certificate|TLS|SSL|self[- ]signed/i.test(detail)) return "a TLS error";
  if (/ECONNREFUSED/i.test(detail)) return "the connection was refused";
  if (/ECONNRESET|socket hang up|closed before/i.test(detail)) return "the connection was reset";
  return "a network error";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return "";
  }
}

/** The injection verdict on what reaches the model, marked on the turn's taint (§6.1 step 10). */
function scanAndMark(
  text: string,
  host: string,
  ctx: FetchPageContext,
): "suspicious" | "hostile" | undefined {
  const verdict = scanUntrusted(text);
  if (verdict.severity === "none") {
    ctx.taint.mark("web_fetch");
    return undefined;
  }
  ctx.taint.mark("web_fetch", verdict.severity);
  auditWeb(ctx.limits, {
    kind: "injection_detected",
    severity: verdict.severity === "hostile" ? "violation" : "warning",
    detail: { tool: "web_fetch", host, signals: verdict.signals.join(","), matchCount: verdict.matchCount },
  });
  return verdict.severity;
}

interface Readable {
  requestedUrl: string;
  finalUrl: string;
  hops: string[];
  title: string;
  text: string;
  totalChars: number;
  contentType: NonNullable<ExtractResult["contentType"]>;
  pages?: number;
  links: Array<{ href: string; text: string }>;
}

function fromPrefetch(requestedUrl: string, page: PrefetchedPage): Readable {
  return {
    requestedUrl,
    finalUrl: page.url,
    hops: [page.url],
    title: page.title,
    text: page.text,
    totalChars: page.text.length,
    contentType: "text",
    links: [],
  };
}

function fromExtract(requestedUrl: string, page: ExtractResult): Readable {
  const finalUrl = page.finalUrl ?? requestedUrl;
  return {
    requestedUrl,
    finalUrl,
    hops: page.hops ?? [requestedUrl],
    title: page.title,
    text: page.text,
    totalChars: page.totalChars ?? page.text.length,
    contentType: page.contentType ?? "html",
    ...(page.pages ? { pages: page.pages } : {}),
    links: page.links,
  };
}

/** Pages kept per turn for `find_in_page`. */
const OPENED_MAX_PAGES = 24;

/** The whole text of an opened page, under both its requested and its final URL. */
function rememberOpened(page: Readable, limits: TurnWebLimits): void {
  const opened = webTurnState(limits).opened;
  if (opened.size >= OPENED_MAX_PAGES) return;
  const entry = { url: page.finalUrl, title: page.title, text: page.text };
  for (const raw of [page.requestedUrl, page.finalUrl]) {
    const canon = canonicalize(raw, { bareDomain: false });
    if (canon) opened.set(canonKey(canon), entry);
  }
}

/** Steps 10–12: scan, ledger, and the result the model and the panel read. */
function present(page: Readable, input: FetchPageInput, ctx: FetchPageContext, now: Date): ToolOutcome {
  rememberOpened(page, ctx.limits);
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const maxChars = Math.min(FETCH_MAX_CHARS, Math.max(FETCH_MIN_CHARS, Math.floor(input.maxChars ?? FETCH_DEFAULT_CHARS)));
  const available = page.text.length;
  const wanted = Math.max(0, Math.min(maxChars, available - offset));
  const granted = ctx.limits.takeChars(wanted);
  const window = page.text.slice(offset, offset + granted);
  const title = flatten(page.title || page.finalUrl, 300);
  const links = page.links.slice(0, LINKS_SHOWN);

  const host = hostOf(page.finalUrl);
  const linkLines = links.map((link, i) => linkLine(i + 1, flatten(link.text, 200), link.href));
  const inside = [title, "", window, ...(linkLines.length ? ["", LINKS_HEADING, ...linkLines] : [])].join("\n");
  const injection = scanAndMark(inside, host, ctx);

  // Step 11: everything this fetch saw joins the ledger as a fetched page.
  ctx.ledger.add(page.requestedUrl, "fetched_page");
  for (const hop of page.hops) ctx.ledger.add(hop, "fetched_page");
  ctx.ledger.add(page.finalUrl, "fetched_page");
  for (const link of page.links.slice(0, LINKS_TO_LEDGER)) ctx.ledger.add(link.href, "fetched_page");

  const meta = [
    urlLine(page.finalUrl),
    ...(page.finalUrl !== page.requestedUrl ? [requestedLine(page.requestedUrl)] : []),
    retrievedLine(now.toISOString()),
    typeLine(page.contentType, page.pages),
  ];
  // Offsets index the text Juno holds (at most MAX_EXTRACT_CHARS of a page),
  // so that is the total the model is told; the record keeps the page's own.
  if (offset >= available && available > 0) meta.push(pastEndLine(offset, available));
  else if (offset > 0 || offset + granted < available) meta.push(showingLine(offset, offset + granted, available));
  const cut = granted < wanted;
  const tail = cut ? [READING_BUDGET_SPENT_LINE] : [];

  const text = [...meta, wrapUntrusted(pageSourceLabel(page.finalUrl), inside), ...tail].join("\n");
  const body = [...meta, inside, ...tail].join("\n");
  const source: ClientSource = {
    title,
    url: page.finalUrl,
    snippet: flatten(window, SNIPPET_CHARS),
    cited: false,
    origin: "juno_fetch",
  };
  const web: ToolWebDetail = {
    requestedUrl: page.requestedUrl,
    finalUrl: page.finalUrl,
    contentType: page.contentType,
    ...(page.pages ? { pages: page.pages } : {}),
    chars: window.length,
    totalChars: page.totalChars,
    links: page.links.slice(0, LINKS_RECORDED).map((link) => link.href),
    ...(injection ? { injection } : {}),
  };
  return {
    status: "succeeded",
    text,
    body,
    sources: [source],
    figure: page.contentType === "pdf" && page.pages ? { kind: "pages", n: page.pages } : { kind: "chars", n: window.length },
    web,
  };
}

export async function fetchPageForChat(
  input: FetchPageInput,
  ctx: FetchPageContext,
  deps: FetchPageDeps = {},
): Promise<ToolOutcome> {
  const state = webTurnState(ctx.limits);
  const now = deps.now ?? (() => new Date());
  const requested = input.url.trim();

  // The enumeration guard has tripped: nothing more this turn (§6.2.5).
  if (state.fetchDisabled) return refusal("rate_limited", `${RATE_LIMITED_TEXT}\n${FETCH_DISABLED_LINE}`);

  // 1. The turn's (and the account's) fetch budget. Refusals below count too.
  if (!ctx.limits.take("web_fetch")) return refusal("rate_limited", RATE_LIMITED_TEXT);

  // 2. Length.
  if (requested.length > MAX_URL_CHARS) return refusal("url_too_long", URL_TOO_LONG_TEXT);

  // Not an absolute http(s) URL at all (another scheme, credentials, garbage):
  // nothing to look up, and nothing that could ever be opened.
  const canon = canonicalize(requested, { bareDomain: true });
  if (!canon) return refusal("url_not_allowed", URL_NOT_ALLOWED_TEXT);
  const url = canon.raw;

  // 3. Provenance. After a hostile scan this turn, only what the user typed counts.
  const match = await ctx.ledger.match(url);
  if (!match || (ctx.taint.severity === "hostile" && !match.userClass)) {
    const tripped = ctx.limits.noteProvenanceRefusal();
    if (!tripped) return refusal("url_not_in_prior_context", NOT_IN_PRIOR_CONTEXT_TEXT);
    state.fetchDisabled = true;
    auditWeb(ctx.limits, {
      kind: "fetch_provenance_refused",
      severity: "warning",
      detail: { tool: "web_fetch", host: canon.host },
    });
    return refusal("url_not_in_prior_context", `${NOT_IN_PRIOR_CONTEXT_TEXT}\n${FETCH_DISABLED_LINE}`);
  }

  // 4. A link from outside content that carries a credential goes nowhere.
  if (!match.userClass && urlSecretRule(url)) return refusal("url_not_allowed", URL_NOT_ALLOWED_TEXT);

  // 5. The chat URL policy on the literal URL: scheme, credentials, ports, a
  //    literal address, Juno's own origins. No DNS here; the transport judges
  //    every resolved address on every hop.
  if (urlGuardReason(url, deps.ownHosts)) return refusal("url_not_allowed", URL_NOT_ALLOWED_TEXT);

  // 6. The per-host budget.
  if (!ctx.limits.takeHost(canon.host)) return refusal("rate_limited", RATE_LIMITED_TEXT);

  // 14. The same page came back from this turn's search with its text: serve
  //     that, still through steps 10–12, with no network.
  const prefetched = state.prefetch.get(canonKey(canon));
  if (prefetched) return present(fromPrefetch(url, prefetched), input, ctx, now());

  // 7–9. Fetch and extract — through Alevr's page cache: a fresh copy is
  //      served without a request, a stale one is revalidated with its
  //      validators, and a discovered page is stored for the next reader.
  //      Every network hop still goes through the extractor's guards.
  const extract = deps.extract ?? extractUrlDocument;
  const store = deps.pageStore !== undefined ? deps.pageStore : deps.extract ? null : await defaultSearchStore();
  // Only pages a search (or a page a search found) surfaced may join the shared
  // cache; a URL the person typed, a remembered one or an attachment's never does.
  const admit = match.kind === "search_result" || match.kind === "fetched_page" || match.kind === "research_source";
  const opened = await openPage(
    {
      url,
      signal: ctx.signal,
      admit: admit ? "discovered" : false,
      private: ctx.private,
      extractOptions: {
        maxChars: MAX_EXTRACT_CHARS,
        userAgent: chatUserAgent(),
        guard: (hop) => urlGuard(hop, deps.ownHosts),
        timeoutMs: FETCH_DEADLINE_MS,
        maxHtmlBytes: CHAT_MAX_HTML_BYTES,
        maxPdfBytes: CHAT_MAX_PDF_BYTES,
      },
    },
    { store, extract, ...(deps.now ? { now: deps.now } : {}) },
  );
  if (ctx.signal.aborted) throw abortError();
  if (!opened.ok) return failureOutcome(opened.outcome.failure);
  return present(fromExtract(url, opened.page), input, ctx, now());
}
