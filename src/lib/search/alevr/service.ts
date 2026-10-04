/**
 * Alevr Search: one query to ranked results, cheapest path first (BRIEF §15–16).
 *
 *   1. the exact query cache — the same normalised query, vertical, recency,
 *      language and region answered recently: no backend is asked;
 *   2. the page index — enough fresh, distinct, fully matching pages Alevr has
 *      already read: no backend is asked (web only, never a time-bound query);
 *   3. discovery — chat asks ONE backend at a time, cheapest first among those
 *      that clear the quality floor, escalating on a failure or on an empty
 *      answer from a free backend; Research fans out to every backend and fuses.
 *
 * Index pages that match always join the candidates, so a page Alevr already
 * read competes with what a paid API returned. Everything is then ranked
 * (`rank.ts`). Every call is recorded — which path served it, which backend,
 * latency, cost, how many results were already cached — with no query text
 * and no user (`SearchCallRecord`). A private chat writes nothing at all.
 *
 * Free of `server-only`: backends and store are injected; the defaults load
 * lazily.
 */

import { createHash } from "node:crypto";

import { fuseRankedLists } from "@/lib/search/fusion";
import { canonicalUrl } from "@/lib/search/url-safety";
import { alevrBackends, BackendFailure, envNumber, planDiscovery, planFanout } from "@/lib/search/alevr/backends";
import { pageCacheKey } from "@/lib/search/alevr/retrieve";
import { candidatesFromHits, rankResults, type RankCandidate, type RankedResult, type RankOptions } from "@/lib/search/alevr/rank";
import type {
  BackendReport,
  BackendStatus,
  CachedPage,
  DiscoveryBackend,
  DiscoveryHit,
  IndexHit,
  Recency,
  SearchCallRecord,
  SearchStore,
  SearchVertical,
} from "@/lib/search/alevr/types";

type Env = Readonly<Record<string, string | undefined>>;

export interface AlevrSearchInput {
  query: string;
  count: number;
  vertical: SearchVertical;
  recency?: Recency;
  language?: string;
  region?: string;
  surface: SearchCallRecord["surface"];
  /** A private chat: read caches, write nothing, record nothing. */
  private: boolean;
  /** `single` (chat: one backend at a time) or `fanout` (Research: every backend, fused). */
  mode?: "single" | "fanout";
  signal?: AbortSignal;
}

export interface AlevrSearchDeps {
  backends?: readonly DiscoveryBackend[];
  store?: SearchStore | null;
  env?: Env;
  now?: () => Date;
  /** Monotonic milliseconds, for latency. */
  clock?: () => number;
  semantic?: RankOptions["semantic"];
}

export interface AlevrSearchOutcome {
  results: RankedResult[];
  servedBy: SearchCallRecord["servedBy"];
  /** The backend(s) that answered: "serper", "index", "query_cache", "serper+index"… */
  backend: string | null;
  reports: BackendReport[];
  costMicroUsd: number;
  /** A backend failed and another answered, or none did. */
  degraded: boolean;
  cachedPages: number;
  latencyMs: number;
}

const BACKEND_TIMEOUT_MS = 12_000;

/** Whitespace collapsed, case folded: the form two equivalent queries share. */
export function normalizeQuery(query: string): string {
  return query.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The query cache key: a hash, so the table never holds query text. */
export function queryCacheKey(input: Pick<AlevrSearchInput, "query" | "vertical" | "recency" | "language" | "region" | "mode">): string {
  const parts = [
    "v1",
    input.mode ?? "single",
    input.vertical,
    input.recency ?? "",
    (input.language ?? "").slice(0, 2).toLowerCase(),
    (input.region ?? "").toLowerCase(),
    normalizeQuery(input.query),
  ];
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

/** How long one query's results are reused. */
export function queryTtlSeconds(env: Env, vertical: SearchVertical, recency?: Recency): number {
  if (vertical === "news" || recency === "day") return envNumber(env, "ALEVR_SEARCH_NEWS_TTL_SECONDS", 30 * 60, 60, 24 * 3600);
  if (recency === "week") return 2 * 3600;
  return envNumber(env, "ALEVR_SEARCH_QUERY_TTL_SECONDS", 6 * 3600, 60, 7 * 24 * 3600);
}

function statusOf(error: unknown, signal: AbortSignal, parent?: AbortSignal): BackendStatus {
  if (error instanceof BackendFailure) {
    const s = error.status;
    return s === "bad_key" || s === "rate_limited" || s === "provider_error" || s === "timeout" ? s : "failed";
  }
  if (signal.aborted && !parent?.aborted) return "timeout";
  return "failed";
}

async function runBackend(
  backend: DiscoveryBackend,
  input: AlevrSearchInput,
  clock: () => number,
): Promise<{ hits: DiscoveryHit[]; report: BackendReport }> {
  const started = clock();
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(BACKEND_TIMEOUT_MS)])
    : AbortSignal.timeout(BACKEND_TIMEOUT_MS);
  try {
    const hits = (
      await backend.run(
        {
          query: input.query,
          count: input.count,
          vertical: input.vertical,
          ...(input.recency ? { recency: input.recency } : {}),
          ...(input.language ? { language: input.language } : {}),
          ...(input.region ? { region: input.region } : {}),
        },
        signal,
      )
    ).slice(0, Math.max(input.count, 10));
    return {
      hits,
      report: {
        backend: backend.id,
        status: hits.length > 0 ? "ok" : "empty",
        results: hits.length,
        latencyMs: clock() - started,
        // An engine that answered was paid, even when it found nothing.
        costMicroUsd: backend.costMicroUsd(hits.length),
      },
    };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return {
      hits: [],
      report: {
        backend: backend.id,
        status: statusOf(error, signal, input.signal),
        results: 0,
        latencyMs: clock() - started,
        costMicroUsd: 0,
        ...(error instanceof BackendFailure && error.httpStatus ? { httpStatus: error.httpStatus } : {}),
      },
    };
  }
}

function indexCandidates(hits: readonly IndexHit[]): RankCandidate[] {
  const best = Math.max(...hits.map((h) => h.lexical), 0);
  return hits.map((hit, rank) => ({
    url: hit.page.url,
    title: hit.page.title,
    snippet: hit.snippet,
    text: hit.page.text,
    publishedAt: hit.page.publishedAt ?? null,
    language: hit.page.language ?? null,
    contentHash: hit.page.contentHash,
    ranks: [{ backend: "index", rank }],
    indexScore: best > 0 ? hit.lexical / best : 0,
  }));
}

function distinctHosts(hits: readonly IndexHit[]): number {
  return new Set(hits.map((h) => h.page.host)).size;
}

/** Merge index candidates into discovery candidates by canonical URL. */
function mergeCandidates(discovered: RankCandidate[], fromIndex: RankCandidate[]): RankCandidate[] {
  const byKey = new Map(discovered.map((c) => [canonicalUrl(c.url), c]));
  for (const c of fromIndex) {
    const key = canonicalUrl(c.url);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, c);
      continue;
    }
    existing.ranks.push(...c.ranks);
    existing.indexScore = c.indexScore;
    existing.text ??= c.text;
    existing.contentHash ??= c.contentHash;
  }
  return [...byKey.values()];
}

/** Attach what the page cache holds about the results: text for ranking, hash for dedup. */
async function enrichFromCache(candidates: RankCandidate[], store: SearchStore | null): Promise<number> {
  if (!store || candidates.length === 0) return 0;
  const keys = candidates.map((c) => pageCacheKey(c.url));
  let pages: CachedPage[] = [];
  try {
    pages = await store.getPages(keys);
  } catch {
    return 0;
  }
  const byKey = new Map(pages.map((p) => [p.canonicalKey, p]));
  let cached = 0;
  candidates.forEach((c, i) => {
    const page = byKey.get(keys[i]);
    if (!page) return;
    cached += 1;
    c.text ??= page.text;
    c.contentHash ??= page.contentHash;
    c.publishedAt ??= page.publishedAt ?? null;
    c.language ??= page.language ?? null;
  });
  return cached;
}

let defaultStorePromise: Promise<SearchStore | null> | null = null;

/**
 * The deployment's store: Postgres unless `ALEVR_SEARCH_CACHE=off`. Loaded once
 * and lazily so nothing here imports the app's Prisma client at module load.
 */
export function defaultSearchStore(env: Env = process.env): Promise<SearchStore | null> {
  if (env.ALEVR_SEARCH_CACHE?.trim().toLowerCase() === "off") return Promise.resolve(null);
  defaultStorePromise ??= (async () => {
    try {
      const [{ prisma }, { PostgresSearchStore }] = await Promise.all([import("@/lib/prisma"), import("@/lib/search/alevr/store")]);
      return new PostgresSearchStore(prisma);
    } catch {
      return null;
    }
  })();
  return defaultStorePromise;
}

export async function alevrSearch(input: AlevrSearchInput, deps: AlevrSearchDeps = {}): Promise<AlevrSearchOutcome> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const clock = deps.clock ?? (() => performance.now());
  const started = clock();
  const store = deps.store === undefined ? await defaultSearchStore(env) : deps.store;
  const backends = deps.backends ?? alevrBackends({ env });
  const mode = input.mode ?? "single";
  const at = now();
  const rankOpts: RankOptions = {
    query: input.query,
    vertical: input.vertical,
    count: input.count,
    now: at,
    ...(input.recency ? { recency: input.recency } : {}),
    ...(input.language ? { language: input.language } : {}),
    ...(input.region ? { region: input.region } : {}),
    ...(deps.semantic ? { semantic: deps.semantic } : {}),
  };

  const finish = async (outcome: Omit<AlevrSearchOutcome, "latencyMs">): Promise<AlevrSearchOutcome> => {
    const latencyMs = clock() - started;
    if (store && !input.private) {
      await store
        .recordCall({
          at,
          surface: input.surface,
          vertical: input.vertical,
          servedBy: outcome.servedBy,
          backend: outcome.backend,
          results: outcome.results.length,
          latencyMs,
          costMicroUsd: outcome.costMicroUsd,
          cachedPages: outcome.cachedPages,
          backends: outcome.reports,
        })
        .catch(() => undefined);
    }
    return { ...outcome, latencyMs };
  };

  if (!input.query.trim()) {
    return finish({ results: [], servedBy: "none", backend: null, reports: [], costMicroUsd: 0, degraded: false, cachedPages: 0 });
  }

  // 1. The exact query cache.
  const key = queryCacheKey({ ...input, mode });
  const cachedQuery = store ? await store.getQuery(key, at).catch(() => null) : null;
  if (cachedQuery && cachedQuery.hits.length > 0) {
    const candidates = candidatesFromHits(cachedQuery.hits);
    const cachedPages = await enrichFromCache(candidates, store);
    return finish({
      results: rankResults(candidates, rankOpts),
      servedBy: "query_cache",
      backend: "query_cache",
      reports: [],
      costMicroUsd: 0,
      degraded: false,
      cachedPages,
    });
  }

  // 2. The page index.
  const indexAnswers = env.ALEVR_SEARCH_INDEX_ANSWERS?.trim().toLowerCase() !== "off";
  const maxIndexAgeS = envNumber(env, "ALEVR_SEARCH_INDEX_MAX_AGE_SECONDS", 3 * 24 * 3600, 60, 90 * 24 * 3600);
  let indexHits: IndexHit[] = [];
  if (store && input.vertical === "web" && (!input.recency || input.recency === "year")) {
    indexHits = await store
      .searchIndex({
        query: input.query,
        limit: input.count * 2,
        ...(input.language ? { language: input.language } : {}),
        freshAfter: new Date(at.getTime() - maxIndexAgeS * 1000),
      })
      .catch(() => []);
    const enough = indexHits.length >= input.count && distinctHosts(indexHits) >= Math.min(3, input.count);
    if (indexAnswers && mode === "single" && enough) {
      return finish({
        results: rankResults(indexCandidates(indexHits), rankOpts),
        servedBy: "index",
        backend: "index",
        reports: [],
        costMicroUsd: 0,
        degraded: false,
        cachedPages: Math.min(indexHits.length, input.count),
      });
    }
  }

  // 3. Discovery.
  const reports: BackendReport[] = [];
  let hits: DiscoveryHit[] = [];
  let answeredBy: string | null = null;
  if (mode === "single") {
    // At most two backends per chat search (the primary and one escalation),
    // so a dead deployment cannot fan a single query out across every bill.
    const maxAttempts = envNumber(env, "ALEVR_SEARCH_MAX_ATTEMPTS", 2, 1, 6);
    for (const backend of planDiscovery(backends, { vertical: input.vertical, env, count: input.count }).slice(0, maxAttempts)) {
      const attempt = await runBackend(backend, input, clock);
      reports.push(attempt.report);
      const answered = attempt.report.status === "ok" || attempt.report.status === "empty";
      if (!answered) continue;
      if (attempt.hits.length === 0 && backend.kind !== "paid") continue; // escalate past a free backend's empty answer
      hits = attempt.hits;
      answeredBy = backend.id;
      break;
    }
  } else {
    const plan = planFanout(backends, { vertical: input.vertical, env });
    const settled = await Promise.all(plan.map((backend) => runBackend(backend, input, clock)));
    reports.push(...settled.map((s) => s.report));
    const weight = (b: DiscoveryBackend) => Math.max(0.2, b.quality[input.vertical] ?? 0.5);
    const fused = fuseRankedLists(
      settled.map((s, i) => ({
        engine: { name: plan[i].id, weight: weight(plan[i]) },
        hits: s.hits.map((h) => ({
          title: h.title,
          url: h.url,
          snippet: h.snippet,
          ...(h.rawContent ? { rawContent: h.rawContent } : {}),
          ...(h.publishedAt ? { publishedAt: h.publishedAt } : {}),
          engine: h.backend,
        })),
      })),
      Math.max(input.count * 2, 20),
    );
    // Keep each backend's own rank so the ranker can count agreement.
    const rankIn = new Map<string, Array<{ backend: string; rank: number }>>();
    settled.forEach((s, i) =>
      s.hits.forEach((h) => {
        const k = canonicalUrl(h.url);
        rankIn.set(k, [...(rankIn.get(k) ?? []), { backend: plan[i].id, rank: h.rank }]);
      }),
    );
    hits = fused.flatMap((r) =>
      (rankIn.get(canonicalUrl(r.url)) ?? [{ backend: r.engine, rank: 0 }]).map((rk) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        ...(r.rawContent ? { rawContent: r.rawContent } : {}),
        ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
        backend: rk.backend,
        rank: rk.rank,
      })),
    );
    const answered = reports.filter((r) => r.status === "ok").map((r) => r.backend);
    answeredBy = answered.length ? answered.join("+") : null;
  }

  const costMicroUsd = reports.reduce((sum, r) => sum + r.costMicroUsd, 0);
  const candidates = mergeCandidates(candidatesFromHits(hits), indexCandidates(indexHits));
  const cachedPages = await enrichFromCache(candidates, store);
  const results = rankResults(candidates, rankOpts);
  const failed = (r: BackendReport) => r.status !== "ok" && r.status !== "empty";
  const degraded = mode === "single" ? reports.length > 0 && failed(reports[0]) : reports.some(failed);

  if (store && !input.private && hits.length > 0 && answeredBy) {
    await store
      .putQuery({
        key,
        hits,
        backend: answeredBy,
        createdAt: at,
        expiresAt: new Date(at.getTime() + queryTtlSeconds(env, input.vertical, input.recency) * 1000),
      })
      .catch(() => undefined);
  }

  const usedIndex = results.some((r) => r.ranks.some((rk) => rk.backend === "index"));
  const backend = answeredBy ? (usedIndex ? `${answeredBy}+index` : answeredBy) : results.length ? "index" : null;
  return finish({
    results,
    servedBy: answeredBy ? "discovery" : results.length ? "index" : "none",
    backend,
    reports,
    costMicroUsd,
    degraded,
    cachedPages,
  });
}
