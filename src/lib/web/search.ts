/**
 * Chat's `web_search` / `search_news` backend: Alevr Search in its
 * single-backend profile (BRIEF §15–16, `src/lib/search/alevr/service.ts`).
 *
 * A chat search is answered by the cheapest path that is good enough: the
 * exact query cache, then Alevr's own page index, then ONE discovery backend —
 * the cheapest available one that clears the quality floor (a self-hosted
 * SearXNG the operator rates high enough, then the paid APIs cheapest first) —
 * with one escalation when it fails or a free backend comes back empty. A paid
 * engine's empty answer is an answer. Public SearXNG instances and scraped
 * DuckDuckGo are not used anywhere; Wikipedia's API sits below the chat floor.
 * With no backend that clears the floor, Alevr Search is not offered and the
 * turn falls back to the model's own search (`src/lib/search/alevr/policy.ts`).
 *
 * Why not Research's fan-out. Research asks every engine and fuses the lists,
 * because breadth is its product and a run pays for it once. A chat turn
 * searches several times, on every model, by default; asking four paid
 * engines each time multiplies the bill for a list the model reads five items
 * of.
 *
 * Before any engine sees a query — and before it becomes a cache key — it
 * passes the query hygiene: at most 400 characters, no credential-shaped
 * string (a DLP critical rule), no verbatim span of the user's private text
 * and not the account email (`private-spans.ts`). A refused query throws a
 * `WebToolError` whose message is written for the model; the tool spec turns
 * it into the call's result. A private chat reads the caches and writes
 * nothing (INV-32).
 *
 * The engine calls and the store are injected, so this file stays free of
 * `server-only`; the defaults load lazily on first use.
 */

import { DLP_RULES } from "@/lib/security/dlp";
import type { SearchResult } from "@/lib/search/fusion";
import { alevrBackends, alevrSearchAvailable, type EngineRunner } from "@/lib/search/alevr/backends";
import { alevrSearch, defaultSearchStore } from "@/lib/search/alevr/service";
import type { DiscoveryBackend, SearchStore } from "@/lib/search/alevr/types";
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
  input: { query: string; count: number; recency?: Recency; vertical?: "news"; signal: AbortSignal },
) => Promise<{ results: SearchResult[]; report: EngineReport }>;

export interface ChatSearchDeps {
  /** Test seam: the engine calls. With it and no `store`, nothing is cached. */
  runEngine?: ChatEngineRunner;
  env?: Readonly<Record<string, string | undefined>>;
  /** Juno's fee for one engine call (§3.9); WS1's price table when absent. */
  price?: (engine: ChatSearchEngine, results: number) => number;
  /** Alevr Search's page/query cache; the deployment's when absent (and no `runEngine`). */
  store?: SearchStore | null;
  /** The backends themselves, for a test that drives Alevr Search directly. */
  backends?: readonly DiscoveryBackend[];
  now?: () => Date;
}

export interface ChatSearchOutcome {
  results: ChatSearchResult[];
  engine: string | null;
  engines: EngineReport[];
  feeMicroUsd: number;
  degraded: boolean;
  /** The injection scan's verdict on the result block, when not clean (§6.4 item 5). */
  injection?: "suspicious" | "hostile";
  /** Which Alevr Search path served it, for the call row (query cache, index, discovery). */
  servedBy?: "query_cache" | "index" | "discovery" | "none";
}

/** The chat runner as an Alevr Search engine runner. */
function engineRunnerFrom(runEngine: ChatEngineRunner): EngineRunner {
  return async (engine, query, signal) => {
    const attempt = await runEngine(engine as ChatSearchEngine, {
      query: query.query,
      count: query.count,
      ...(query.recency ? { recency: query.recency } : {}),
      ...(query.vertical === "news" ? { vertical: "news" as const } : {}),
      signal,
    });
    return {
      results: attempt.results,
      status: attempt.report.status,
      ...(attempt.report.httpStatus ? { httpStatus: attempt.report.httpStatus } : {}),
    };
  };
}

function backendsFor(deps: ChatSearchDeps, env: Readonly<Record<string, string | undefined>>): readonly DiscoveryBackend[] {
  if (deps.backends) return deps.backends;
  const backends = alevrBackends({ env, ...(deps.runEngine ? { runner: engineRunnerFrom(deps.runEngine) } : {}) });
  const price = deps.price;
  if (!price) return backends;
  return backends.map((backend) =>
    (CHAT_SEARCH_ENGINES as readonly string[]).includes(backend.id)
      ? { ...backend, costMicroUsd: (n: number) => price(backend.id as ChatSearchEngine, n) }
      : backend,
  );
}

/** Whether chat can search on this deployment: some Alevr Search backend clears the web floor. */
export function chatSearchAvailable(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return alevrSearchAvailable(env);
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
  input: { query: string; count?: number; recency?: string; vertical?: "web" | "news" },
  ctx: { signal: AbortSignal; private: boolean; privateSpans: PrivateSpanSet; limits: TurnWebLimits },
  deps: ChatSearchDeps = {},
): Promise<ChatSearchOutcome> {
  const query = input.query.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
  const count = Math.min(SEARCH_MAX_COUNT, Math.max(1, Math.floor(input.count ?? SEARCH_DEFAULT_COUNT)));
  const recency = input.recency && RECENCIES.has(input.recency) ? (input.recency as Recency) : undefined;
  const vertical = input.vertical === "news" ? "news" : "web";

  // The turn's (and the account's) search budget, spent even when the query is
  // then refused: a model retrying a refused query is still searching.
  if (!ctx.limits.take("web_search")) throw new WebToolError("rate_limited", SEARCH_RATE_LIMITED_TEXT);

  // Query hygiene, before any backend — or any cache key — sees a byte of it.
  if (queryLeaksSecret(query) || ctx.privateSpans.matches(query)) {
    throw new WebToolError("not_permitted", SENSITIVE_QUERY_TEXT);
  }

  const env = deps.env ?? process.env;
  const backends = backendsFor(deps, env);
  if (!query || !alevrSearchAvailable(env, backends)) {
    return { results: [], engine: null, engines: [], feeMicroUsd: 0, degraded: false };
  }

  const store = deps.store !== undefined ? deps.store : deps.runEngine || deps.backends ? null : await defaultSearchStore(env);
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(SEARCH_DEADLINE_MS)]);
  const found = await alevrSearch(
    {
      query,
      count,
      vertical,
      ...(recency ? { recency } : {}),
      surface: "chat",
      private: ctx.private,
      mode: "single",
      signal,
    },
    { backends, store, env, ...(deps.now ? { now: deps.now } : {}) },
  );
  if (ctx.signal.aborted) throw abortError();

  const hits: SearchResult[] = found.results.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet,
    ...(r.rawContent ? { rawContent: r.rawContent } : {}),
    ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
    engine: r.backend,
  }));
  const results = toChatResults(hits, ctx.limits);
  const outcome: ChatSearchOutcome = {
    results,
    engine: found.backend,
    engines: found.reports.map((r) => ({
      name: r.backend,
      results: r.results,
      status: r.status === "skipped" ? "failed" : r.status,
      ...(r.httpStatus ? { httpStatus: r.httpStatus } : {}),
    })),
    feeMicroUsd: found.costMicroUsd,
    degraded: found.degraded,
    servedBy: found.servedBy,
  };

  if (results.length > 0) {
    const block = results.map((result) => `${result.title}\n${result.url}\n${result.snippet}`).join("\n\n");
    const verdict = scanUntrusted(block);
    if (verdict.severity !== "none") {
      outcome.injection = verdict.severity;
      auditWeb(ctx.limits, {
        kind: "injection_detected",
        severity: verdict.severity === "hostile" ? "violation" : "warning",
        detail: { tool: "web_search", engine: found.backend ?? "", signals: verdict.signals.join(","), matchCount: verdict.matchCount },
      });
    }
  }
  return outcome;
}
