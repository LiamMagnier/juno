/**
 * Alevr Search discovery backends, behind one interface (BRIEF §16).
 *
 * Every backend that turns a query into URLs is a `DiscoveryBackend`: the four
 * paid APIs, the operator's self-hosted SearXNG and Wikipedia's open API. The
 * HTTP calls themselves stay in `src/lib/search/search-engine.ts` (one copy of
 * each engine, already used by Research and Work); a backend here is that
 * engine plus what the selector needs to know about it — which verticals it
 * serves, how good it is per vertical, and what one call costs.
 *
 * Provider-native search (Anthropic's server tool, OpenAI hosted search,
 * Gemini grounding…) is deliberately NOT a backend here. It runs inside the
 * model's own request and returns no result list Alevr could rank or cache, so
 * it cannot sit behind this interface honestly; `policy.ts` keeps it as the
 * turn-level fallback for when no Alevr backend is configured.
 *
 * Free of `server-only`: the engine module is imported only when a backend
 * actually runs, and tests inject a runner.
 */

import { enginePriceMicroUsd } from "@/lib/tools/metering";
import type { SearchResult } from "@/lib/search/fusion";
import type { DiscoveryBackend, DiscoveryHit, DiscoveryQuery, SearchVertical } from "@/lib/search/alevr/types";

type Env = Readonly<Record<string, string | undefined>>;

/** One engine call: the engine module's results, or a typed failure. */
export type EngineRunner = (
  engine: string,
  query: DiscoveryQuery,
  signal: AbortSignal,
) => Promise<{ results: SearchResult[]; status: string; httpStatus?: number }>;

/** The real engines, through the existing fan-out filtered to one engine. */
const defaultEngineRunner: EngineRunner = async (engine, query, signal) => {
  const { searchWithEngineReport } = await import("@/lib/search/search-engine");
  const { results, engines } = await searchWithEngineReport({
    query: query.query,
    count: query.count,
    signal,
    engines: (name) => name === engine,
    perEngineCount: query.count,
    options: {
      exaContents: "highlights",
      vertical: query.vertical,
      ...(query.recency ? { recency: query.recency } : {}),
    },
  });
  const report = engines[0];
  return { results, status: report?.status ?? "failed", ...(report?.httpStatus ? { httpStatus: report.httpStatus } : {}) };
};

/** Thrown by a backend run so the service can record the engine's own status. */
export class BackendFailure extends Error {
  constructor(
    readonly backend: string,
    readonly status: string,
    readonly httpStatus?: number,
  ) {
    super(`${backend}: ${status}`);
    this.name = "BackendFailure";
  }
}

function toHits(results: readonly SearchResult[], backend: string): DiscoveryHit[] {
  return results.map((r, rank) => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet,
    ...(r.rawContent ? { rawContent: r.rawContent } : {}),
    ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
    backend,
    rank,
  }));
}

function engineBackend(input: {
  id: string;
  kind: DiscoveryBackend["kind"];
  verticals: SearchVertical[];
  quality: Partial<Record<SearchVertical, number>>;
  available: (env: Env) => boolean;
  cost: (results: number) => number;
  runner: EngineRunner;
}): DiscoveryBackend {
  return {
    id: input.id,
    kind: input.kind,
    verticals: new Set(input.verticals),
    quality: input.quality,
    available: input.available,
    costMicroUsd: input.cost,
    async run(query, signal) {
      const outcome = await input.runner(input.id, query, signal);
      if (outcome.status !== "ok" && outcome.status !== "empty") {
        throw new BackendFailure(input.id, outcome.status, outcome.httpStatus);
      }
      return toHits(outcome.results, input.id);
    },
  };
}

function key(env: Env, ...names: string[]): boolean {
  return names.some((name) => !!env[name]?.trim());
}

/** A number from the environment, inside [min, max], or the default. */
export function envNumber(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = Number(env[name]);
  return Number.isFinite(raw) && raw >= min && raw <= max ? raw : fallback;
}

/**
 * The quality priors. Operator judgements, not measurements: SEARCH.md records
 * where each came from and the bench (`scripts/alevr-search-bench.ts`) is how
 * an operator checks them against their own query set. A self-hosted SearXNG's
 * quality depends entirely on which upstream engines it was configured with,
 * so it is the one an operator is expected to set (`ALEVR_SEARXNG_QUALITY`).
 */
export const DEFAULT_QUALITY = {
  serper: { web: 0.9, news: 0.85 },
  brave: { web: 0.86, news: 0.8 },
  tavily: { web: 0.86, news: 0.8 },
  exa: { web: 0.8, news: 0.7 },
  searxng: { web: 0.6, news: 0.5 },
  wikipedia: { web: 0.3 },
} as const;

export function alevrBackends(opts: { env?: Env; runner?: EngineRunner } = {}): DiscoveryBackend[] {
  const env = opts.env ?? process.env;
  const runner = opts.runner ?? defaultEngineRunner;
  const searxQuality = envNumber(env, "ALEVR_SEARXNG_QUALITY", DEFAULT_QUALITY.searxng.web, 0, 1);
  const searxCost = envNumber(env, "ALEVR_SEARXNG_COST_MICRO_USD", 0, 0, 1_000_000);
  return [
    engineBackend({
      id: "serper",
      kind: "paid",
      verticals: ["web", "news"],
      quality: DEFAULT_QUALITY.serper,
      available: (e) => key(e, "SERPER_API_KEY"),
      cost: (n) => enginePriceMicroUsd("serper", n),
      runner,
    }),
    engineBackend({
      id: "brave",
      kind: "paid",
      verticals: ["web", "news"],
      quality: DEFAULT_QUALITY.brave,
      available: (e) => key(e, "BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY"),
      cost: (n) => enginePriceMicroUsd("brave", n),
      runner,
    }),
    engineBackend({
      id: "tavily",
      kind: "paid",
      verticals: ["web", "news"],
      quality: DEFAULT_QUALITY.tavily,
      available: (e) => key(e, "TAVILY_API_KEY"),
      cost: (n) => enginePriceMicroUsd("tavily", n),
      runner,
    }),
    engineBackend({
      id: "exa",
      kind: "paid",
      verticals: ["web", "news"],
      quality: DEFAULT_QUALITY.exa,
      available: (e) => key(e, "EXA_API_KEY"),
      cost: (n) => enginePriceMicroUsd("exa", n),
      runner,
    }),
    engineBackend({
      id: "searxng",
      kind: "self_hosted",
      verticals: ["web", "news"],
      quality: { web: searxQuality, news: Math.max(0, searxQuality - 0.1) },
      available: (e) => {
        const raw = e.SEARXNG_URL?.trim();
        if (!raw) return false;
        try {
          const url = new URL(raw);
          return url.protocol === "http:" || url.protocol === "https:";
        } catch {
          return false;
        }
      },
      cost: () => searxCost,
      runner,
    }),
    engineBackend({
      id: "wikipedia",
      kind: "open_data",
      verticals: ["web"],
      quality: DEFAULT_QUALITY.wikipedia,
      available: () => true,
      cost: () => 0,
      runner,
    }),
  ];
}

/** The floor a backend must clear to answer a chat search by itself. */
export function qualityFloor(env: Env, vertical: SearchVertical): number {
  return vertical === "news"
    ? envNumber(env, "ALEVR_SEARCH_NEWS_FLOOR", 0.45, 0, 1)
    : envNumber(env, "ALEVR_SEARCH_WEB_FLOOR", 0.55, 0, 1);
}

/**
 * The backends to try, in order, for one single-backend search (chat).
 *
 * Only available backends that serve the vertical and clear the floor; then
 * the cheapest first, the better first at equal cost. So a configured
 * SearXNG the operator rates above the floor answers before any paid API, and
 * the paid APIs are tried cheapest-first only when it fails or comes back
 * empty. `ALEVR_SEARCH_ORDER` (comma-separated ids) overrides the order for an
 * operator who measured differently.
 */
export function planDiscovery(
  backends: readonly DiscoveryBackend[],
  input: { vertical: SearchVertical; env: Env; count: number },
): DiscoveryBackend[] {
  const floor = qualityFloor(input.env, input.vertical);
  const eligible = backends.filter(
    (b) => b.verticals.has(input.vertical) && (b.quality[input.vertical] ?? 0) >= floor && b.available(input.env),
  );
  const order = input.env.ALEVR_SEARCH_ORDER?.split(",").map((id) => id.trim()).filter(Boolean) ?? [];
  if (order.length > 0) {
    const pos = (id: string) => {
      const i = order.indexOf(id);
      return i < 0 ? order.length : i;
    };
    return eligible.slice().sort((a, b) => pos(a.id) - pos(b.id));
  }
  return eligible.slice().sort((a, b) => {
    const cost = a.costMicroUsd(input.count) - b.costMicroUsd(input.count);
    if (cost !== 0) return cost;
    return (b.quality[input.vertical] ?? 0) - (a.quality[input.vertical] ?? 0);
  });
}

/** Every available backend that serves the vertical, for Research's fan-out (breadth is its product). */
export function planFanout(backends: readonly DiscoveryBackend[], input: { vertical: SearchVertical; env: Env }): DiscoveryBackend[] {
  return backends.filter((b) => b.verticals.has(input.vertical) && b.available(input.env));
}

/** Whether Alevr Search can answer a chat search on this deployment: some backend clears the web floor. */
export function alevrSearchAvailable(env: Env = process.env, backends?: readonly DiscoveryBackend[]): boolean {
  return planDiscovery(backends ?? alevrBackends({ env }), { vertical: "web", env, count: 5 }).length > 0;
}
