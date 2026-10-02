/**
 * Chat's `web_search` backend: one primary keyed engine (the first configured
 * of Tavily, Serper, Brave, Exa) and one fallback only when it fails. No
 * keyless engines in chat (DECISIONS §4c, SPEC §6.3).
 *
 * Why not Research's fan-out. Research asks every engine and fuses the lists,
 * because breadth is its product and a run pays for it once. A chat turn
 * searches several times, on every model, by default; asking four paid
 * engines each time multiplies the bill for a list the model reads five items
 * of. So chat asks one engine and asks a second only when the first failed —
 * never when it merely answered "nothing". Scraped DuckDuckGo, public SearXNG
 * and Wikipedia are not used at all: with no keyed engine, `web_search` is not
 * offered (`keyedSearchEngineConfigured`, §3.6).
 *
 * Before any engine sees a query, it passes the query hygiene: at most 400
 * characters, no credential-shaped string (a DLP critical rule), no verbatim
 * span of the user's private text and not the account email
 * (`private-spans.ts`). A refused query throws a `WebToolError` whose message
 * is written for the model; the tool spec turns it into the call's result.
 *
 * The engine calls are injected, so this file stays free of `server-only`;
 * the default runner imports the search stack only when it is first used.
 */

import { DLP_RULES } from "@/lib/security/dlp";
import type { SearchResult } from "@/lib/search/fusion";
import { enginePriceMicroUsd } from "@/lib/tools/metering";
import { scanUntrusted } from "@/lib/web/injection";
import { SEARCH_RATE_LIMITED_TEXT, SENSITIVE_QUERY_TEXT } from "@/lib/web/search.prompt";
import { auditWeb, webTurnState } from "@/lib/web/turn-state";
import type { ChatSearchResult, EngineReport, PrivateSpanSet, TurnWebLimits } from "@/lib/web/types";
import { canonicalize, canonKey } from "@/lib/web/url-canon";
import type { ToolErrorCode } from "@/types/run";

/** The chat profile's engines, in the order the first configured one is picked. */
export const CHAT_SEARCH_ENGINES = ["tavily", "serper", "brave", "exa"] as const;
export type ChatSearchEngine = (typeof CHAT_SEARCH_ENGINES)[number];

/** §6.3. */
export const SEARCH_DEADLINE_MS = 15_000;
export const MAX_QUERY_CHARS = 400;
export const SEARCH_DEFAULT_COUNT = 5;
export const SEARCH_MAX_COUNT = 8;
const SNIPPET_CHARS = 300;
/** Prefetched page text kept per result, and results kept per turn. */
const PREFETCH_MAX_CHARS = 200_000;
const PREFETCH_MAX_PAGES = 24;

const RECENCIES = new Set(["day", "week", "month", "year"]);
type Recency = "day" | "week" | "month" | "year";

/** A refusal the tool spec returns as the call's result: `code` for the record, `message` for the model. */
export class WebToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WebToolError";
  }
}

/** Which environment variable holds each chat engine's key (Brave accepts either spelling). */
const ENGINE_KEYS: Readonly<Record<ChatSearchEngine, readonly string[]>> = {
  tavily: ["TAVILY_API_KEY"],
  serper: ["SERPER_API_KEY"],
  brave: ["BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY"],
  exa: ["EXA_API_KEY"],
};

/** The chat engines with a key, in profile order. */
export function configuredChatEngines(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ChatSearchEngine[] {
  return CHAT_SEARCH_ENGINES.filter((engine) => ENGINE_KEYS[engine].some((name) => !!env[name]?.trim()));
}

/** True when any of Tavily, Serper, Brave or Exa has a key. `/api/app` and the entitlements read it. */
export function keyedSearchEngineConfigured(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return configuredChatEngines(env).length > 0;
}

/** One engine attempt: its results and its report. Never throws for an engine failure. */
export type ChatEngineRunner = (
  engine: ChatSearchEngine,
  input: { query: string; count: number; recency?: Recency; signal: AbortSignal },
) => Promise<{ results: SearchResult[]; report: EngineReport }>;

/** The real engines, through the search stack's fan-out filtered to one engine. */
const defaultRunner: ChatEngineRunner = async (engine, { query, count, recency, signal }) => {
  const { searchWithEngineReport } = await import("@/lib/search/search-engine");
  const { results, engines } = await searchWithEngineReport({
    query,
    count,
    signal,
    engines: (name) => name === engine,
    perEngineCount: count,
    options: { exaContents: "highlights", ...(recency ? { recency } : {}) },
  });
  return { results, report: engines[0] ?? { name: engine, results: 0, status: "failed" } };
};

export interface ChatSearchDeps {
  runEngine?: ChatEngineRunner;
  env?: Readonly<Record<string, string | undefined>>;
  /** Juno's fee for one engine call (§3.9); WS1's price table when absent. */
  price?: (engine: ChatSearchEngine, results: number) => number;
}

export interface ChatSearchOutcome {
  results: ChatSearchResult[];
  engine: string | null;
  engines: EngineReport[];
  feeMicroUsd: number;
  degraded: boolean;
  /** The injection scan's verdict on the result block, when not clean (§6.4 item 5). */
  injection?: "suspicious" | "hostile";
}

function answered(report: EngineReport): boolean {
  return report.status === "ok" || report.status === "empty";
}

/** A credential-shaped string in the query: a DLP critical rule. */
function queryLeaksSecret(query: string): boolean {
  return DLP_RULES.some(
    (rule) => rule.severity === "critical" && new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", "")).test(query),
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function flatten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

/**
 * The engine's hits as chat results: an absolute http(s) URL each, a title
 * that is never empty (INV-3 falls back to the host), a snippet cut at 300
 * characters, and the page date as ISO. Tavily's raw page text goes to the
 * turn's prefetch, never to the result.
 */
function toChatResults(hits: readonly SearchResult[], limits: TurnWebLimits): ChatSearchResult[] {
  const out: ChatSearchResult[] = [];
  const prefetch = webTurnState(limits).prefetch;
  for (const hit of hits) {
    const canon = canonicalize(hit.url, { bareDomain: false });
    if (!canon) continue;
    const title = flatten(hit.title ?? "", 300) || hostOf(hit.url);
    const published = hit.publishedAt instanceof Date && Number.isFinite(hit.publishedAt.getTime())
      ? hit.publishedAt.toISOString()
      : undefined;
    out.push({
      title,
      url: hit.url,
      snippet: flatten(hit.snippet ?? "", SNIPPET_CHARS),
      ...(published ? { publishedAt: published } : {}),
      engine: hit.engine,
    });
    if (hit.rawContent && hit.rawContent.trim() && prefetch.size < PREFETCH_MAX_PAGES) {
      prefetch.set(canonKey(canon), { url: hit.url, title, text: hit.rawContent.slice(0, PREFETCH_MAX_CHARS) });
    }
  }
  return out;
}

export async function chatWebSearch(
  input: { query: string; count?: number; recency?: string },
  ctx: { signal: AbortSignal; private: boolean; privateSpans: PrivateSpanSet; limits: TurnWebLimits },
  deps: ChatSearchDeps = {},
): Promise<ChatSearchOutcome> {
  const query = input.query.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
  const count = Math.min(SEARCH_MAX_COUNT, Math.max(1, Math.floor(input.count ?? SEARCH_DEFAULT_COUNT)));
  const recency = input.recency && RECENCIES.has(input.recency) ? (input.recency as Recency) : undefined;

  // The turn's (and the account's) search budget, spent even when the query is
  // then refused: a model retrying a refused query is still searching.
  if (!ctx.limits.take("web_search")) throw new WebToolError("rate_limited", SEARCH_RATE_LIMITED_TEXT);

  // Query hygiene, before any engine sees a byte of it.
  if (queryLeaksSecret(query) || ctx.privateSpans.matches(query)) {
    throw new WebToolError("not_permitted", SENSITIVE_QUERY_TEXT);
  }

  const engines = configuredChatEngines(deps.env);
  if (engines.length === 0 || !query) {
    return { results: [], engine: null, engines: [], feeMicroUsd: 0, degraded: false };
  }

  const runEngine = deps.runEngine ?? defaultRunner;
  const price = deps.price ?? enginePriceMicroUsd;
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(SEARCH_DEADLINE_MS)]);
  const reports: EngineReport[] = [];
  let fee = 0;
  let hits: SearchResult[] = [];
  let engine: ChatSearchEngine | null = null;

  // The primary, then one fallback only if the primary did not answer.
  for (const candidate of engines.slice(0, 2)) {
    const attempt = await runEngine(candidate, { query, count, ...(recency ? { recency } : {}), signal });
    if (ctx.signal.aborted) throw abortError();
    reports.push(attempt.report);
    if (!answered(attempt.report)) continue;
    // Only an engine that answered is billed (§3.9).
    fee += price(candidate, attempt.report.results);
    hits = attempt.results.slice(0, count);
    engine = candidate;
    break;
  }

  const results = toChatResults(hits, ctx.limits);
  const outcome: ChatSearchOutcome = {
    results,
    engine,
    engines: reports,
    feeMicroUsd: fee,
    // The primary failed: whether or not the fallback answered, this search degraded.
    degraded: !answered(reports[0]),
  };

  if (results.length > 0) {
    const block = results.map((result) => `${result.title}\n${result.url}\n${result.snippet}`).join("\n\n");
    const verdict = scanUntrusted(block);
    if (verdict.severity !== "none") {
      outcome.injection = verdict.severity;
      auditWeb(ctx.limits, {
        kind: "injection_detected",
        severity: verdict.severity === "hostile" ? "violation" : "warning",
        detail: { tool: "web_search", engine: engine ?? "", signals: verdict.signals.join(","), matchCount: verdict.matchCount },
      });
    }
  }
  return outcome;
}
