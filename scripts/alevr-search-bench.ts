/**
 * Alevr Search bench (BRIEF §16): backend hit rates, cache hit rate, latency and
 * cost per query on a fixed, seeded query workload.
 *
 *   npx tsx scripts/alevr-search-bench.ts            # SIMULATED backends (default)
 *   npx tsx scripts/alevr-search-bench.ts --json out.json
 *
 * What is real and what is not. The Alevr Search code under test is the real
 * service, ranker, backend selection, query cache, page cache and in-memory
 * index (`MemorySearchStore`, the BM25 twin of the Postgres index). The
 * BACKENDS are simulated: a synthetic web of topic pages, each backend
 * returning an overlapping slice of it with a latency drawn from a fixed
 * distribution and an empty-answer rate. Prices are the list prices in
 * `src/lib/tools/metering.ts`. Latencies are a virtual clock, not wall time.
 * So the numbers say how the CACHING AND SELECTION POLICY behaves on a
 * repeated-query workload; they do not measure any provider's real latency or
 * result quality. A live run needs keys and is left to the operator
 * (SEARCH.md, "Measuring on your deployment").
 */

import { writeFileSync } from "node:fs";

import { alevrBackends, type EngineRunner } from "@/lib/search/alevr/backends";
import { openPage } from "@/lib/search/alevr/retrieve";
import { alevrSearch } from "@/lib/search/alevr/service";
import { MemorySearchStore, summarizeCalls } from "@/lib/search/alevr/store";
import type { SearchCallRecord, SearchVertical } from "@/lib/search/alevr/types";
import type { SearchResult } from "@/lib/search/fusion";
import type { ExtractOutcome } from "@/lib/web/extract";

// ── A deterministic workload ────────────────────────────────────────────────

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPICS: Array<{ id: string; vertical: SearchVertical; variants: string[]; words: string }> = [
  { id: "heatpump", vertical: "web", variants: ["heat pump subsidies norway", "Heat pump subsidies Norway", "norway heat pump grant"], words: "heat pump subsidies norway grant enova installation" },
  { id: "ev-tax", vertical: "web", variants: ["electric car tax 2026", "EV tax rules 2026"], words: "electric car ev tax rules 2026 vat registration" },
  { id: "python", vertical: "web", variants: ["python 3.14 release notes", "what is new in python 3.14"], words: "python 3.14 release notes new features free threading" },
  { id: "next", vertical: "web", variants: ["next.js 16 caching", "nextjs 16 cache components"], words: "next.js nextjs 16 caching cache components rendering" },
  { id: "oled", vertical: "web", variants: ["oled monitor burn in", "OLED burn-in warranty monitors"], words: "oled monitor burn in warranty panel" },
  { id: "rust", vertical: "web", variants: ["rust async traits", "async fn in traits rust"], words: "rust async traits fn stable" },
  { id: "postgres", vertical: "web", variants: ["postgres 18 features", "PostgreSQL 18 new features"], words: "postgres postgresql 18 features new async io" },
  { id: "passport", vertical: "web", variants: ["renew uk passport online", "UK passport renewal"], words: "renew uk passport online renewal gov" },
  { id: "flights", vertical: "web", variants: ["oslo to lisbon flights", "cheap flights oslo lisbon"], words: "oslo lisbon flights cheap airline" },
  { id: "recipe", vertical: "web", variants: ["sourdough starter recipe", "how to make sourdough starter"], words: "sourdough starter recipe make flour water" },
  { id: "kubernetes", vertical: "web", variants: ["kubernetes 1.34 deprecations", "k8s 1.34 removed apis"], words: "kubernetes k8s 1.34 deprecations removed apis" },
  { id: "vitamin", vertical: "web", variants: ["vitamin d dosage adults", "how much vitamin d per day"], words: "vitamin d dosage adults per day iu" },
  { id: "mortgage", vertical: "web", variants: ["norway mortgage rates", "mortgage interest norway"], words: "norway mortgage rates interest bank" },
  { id: "iphone", vertical: "web", variants: ["iphone 18 battery life", "iPhone 18 battery test"], words: "iphone 18 battery life test hours" },
  { id: "chess", vertical: "web", variants: ["sicilian defense najdorf", "najdorf sicilian main line"], words: "sicilian defense najdorf main line chess" },
  { id: "llm-pricing", vertical: "web", variants: ["claude api pricing", "anthropic api prices"], words: "claude anthropic api pricing prices tokens" },
  { id: "tax-deadline", vertical: "web", variants: ["norway tax return deadline", "skattemelding deadline"], words: "norway tax return deadline skattemelding" },
  { id: "garden", vertical: "web", variants: ["when to plant tulip bulbs", "tulip bulbs planting time"], words: "plant tulip bulbs planting time autumn" },
  { id: "news-election", vertical: "news", variants: ["election results", "latest election results"], words: "election results latest votes" },
  { id: "news-markets", vertical: "news", variants: ["stock market today", "markets today"], words: "stock market today markets index" },
  { id: "news-weather", vertical: "news", variants: ["storm warning norway", "norway storm warning"], words: "storm warning norway weather" },
  { id: "news-tech", vertical: "news", variants: ["apple announcement", "apple event announcement"], words: "apple announcement event" },
];

/** Zipf-ish popularity: topic k drawn with weight 1/(k+1). */
function workload(n: number, seed: number): Array<{ query: string; vertical: SearchVertical; topic: string }> {
  const rand = prng(seed);
  const weights = TOPICS.map((_, k) => 1 / (k + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const out: Array<{ query: string; vertical: SearchVertical; topic: string }> = [];
  for (let i = 0; i < n; i += 1) {
    let r = rand() * total;
    let k = 0;
    while (r > weights[k]) {
      r -= weights[k];
      k += 1;
    }
    const topic = TOPICS[Math.min(k, TOPICS.length - 1)];
    const variant = topic.variants[Math.floor(rand() * topic.variants.length)];
    out.push({ query: variant, vertical: topic.vertical, topic: topic.id });
  }
  return out;
}

// ── A synthetic web and simulated backends ──────────────────────────────────

const HOSTS = ["gov.example.gov", "news.example.com", "wiki.example.org", "blog.example.net", "docs.example.dev", "forum.example.com", "shop.example.com", "univ.example.edu", "media.example.co", "guide.example.io", "review.example.com", "data.example.org"];

function topicFor(query: string) {
  const q = query.toLowerCase();
  return TOPICS.find((t) => t.variants.some((v) => v.toLowerCase() === q)) ?? TOPICS[0];
}

function pagesOf(topicId: string): SearchResult[] {
  const topic = TOPICS.find((t) => t.id === topicId)!;
  return HOSTS.map((host, i) => ({
    title: `${topic.variants[i % topic.variants.length]}: ${["overview", "guide", "faq", "analysis", "explainer", "update"][i % 6]} ${i}`,
    url: `https://${host}/${topic.id}/${i}`,
    snippet: `${topic.words.split(" ").slice(0, 3 + (i % 4)).join(" ")} — notes from ${host} section ${i}`,
    engine: "sim",
    ...(topic.vertical === "news" ? { publishedAt: new Date("2026-10-04T08:00:00Z") } : {}),
  }));
}

interface SimBackend {
  offset: number;
  latencyMs: [number, number];
  emptyRate: number;
  failRate: number;
}

const SIM: Record<string, SimBackend> = {
  serper: { offset: 0, latencyMs: [450, 900], emptyRate: 0.01, failRate: 0.01 },
  brave: { offset: 1, latencyMs: [500, 1_000], emptyRate: 0.02, failRate: 0.01 },
  tavily: { offset: 2, latencyMs: [900, 1_800], emptyRate: 0.01, failRate: 0.01 },
  exa: { offset: 3, latencyMs: [700, 1_400], emptyRate: 0.02, failRate: 0.01 },
  searxng: { offset: 1, latencyMs: [700, 1_600], emptyRate: 0.15, failRate: 0.03 },
  wikipedia: { offset: 2, latencyMs: [150, 300], emptyRate: 0.5, failRate: 0 },
};

function simulatedRunner(rand: () => number, clock: { now: number }): EngineRunner {
  return async (engine, query) => {
    const sim = SIM[engine];
    const [lo, hi] = sim.latencyMs;
    clock.now += lo + rand() * (hi - lo);
    if (rand() < sim.failRate) return { results: [], status: "timeout" };
    if (rand() < sim.emptyRate) return { results: [], status: "empty" };
    const pages = pagesOf(topicFor(query.query).id);
    const slice = [...pages.slice(sim.offset), ...pages.slice(0, sim.offset)].slice(0, Math.min(query.count, 8));
    return { results: slice.map((p) => ({ ...p, engine })), status: "ok" };
  };
}

// ── Scenarios ───────────────────────────────────────────────────────────────

interface Scenario {
  name: string;
  env: Record<string, string>;
  cache: boolean;
}

const SCENARIOS: Scenario[] = [
  { name: "A. one paid API (Serper), no Alevr cache", env: { SERPER_API_KEY: "sim" }, cache: false },
  { name: "B. one paid API (Serper) + Alevr caches", env: { SERPER_API_KEY: "sim" }, cache: true },
  { name: "C. self-hosted SearXNG first, Serper escalation, + caches", env: { SERPER_API_KEY: "sim", SEARXNG_URL: "http://127.0.0.1:8888" }, cache: true },
  { name: "D. Tavily only (highest list price), no cache", env: { TAVILY_API_KEY: "sim" }, cache: false },
  { name: "E. Tavily + Alevr caches", env: { TAVILY_API_KEY: "sim" }, cache: true },
];

const CALLS = 240;
const SEED = 20261004;
const MINUTES_BETWEEN_CALLS = 3;
const OPENED_PER_SEARCH = 2;

async function runScenario(scenario: Scenario) {
  const rand = prng(SEED);
  const clock = { now: 0 };
  const store = new MemorySearchStore();
  const backends = alevrBackends({ env: scenario.env, runner: simulatedRunner(rand, clock) });
  const start = new Date("2026-10-04T06:00:00Z").getTime();
  const records: SearchCallRecord[] = [];
  let pageFetches = 0;
  let pageCacheServes = 0;
  let opens = 0;
  const calls = workload(CALLS, SEED);
  for (let i = 0; i < calls.length; i += 1) {
    const at = new Date(start + i * MINUTES_BETWEEN_CALLS * 60_000);
    const before = clock.now;
    const outcome = await alevrSearch(
      {
        query: calls[i].query,
        count: 5,
        vertical: calls[i].vertical,
        ...(calls[i].vertical === "news" ? { recency: "day" as const } : {}),
        surface: "bench",
        private: false,
      },
      { backends, store: scenario.cache ? store : null, env: scenario.env, now: () => at, clock: () => clock.now },
    );
    // The service clock is virtual; latency is what the backends consumed.
    records.push({
      at,
      surface: "bench",
      vertical: calls[i].vertical,
      servedBy: outcome.servedBy,
      backend: outcome.backend,
      results: outcome.results.length,
      latencyMs: clock.now - before,
      costMicroUsd: outcome.costMicroUsd,
      cachedPages: outcome.cachedPages,
      backends: outcome.reports,
    });
    // The model opens the top results, which is what fills the page cache.
    for (const result of outcome.results.slice(0, OPENED_PER_SEARCH)) {
      opens += 1;
      const opened = await openPage(
        { url: result.url, admit: "discovered", private: false, extractOptions: {} },
        {
          store: scenario.cache ? store : null,
          now: () => at,
          env: {},
          extract: async (url): Promise<ExtractOutcome> => {
            pageFetches += 1;
            const topic = TOPICS.find((t) => url.includes(`/${t.id}/`))!;
            return {
              ok: true,
              page: { title: result.title, text: `${topic.words} (${url}). `.repeat(30), links: [], finalUrl: url, hops: [url], contentType: "html", totalChars: 30 * (topic.words.length + url.length + 5), cache: { cacheControl: "max-age=86400" } },
            };
          },
        },
      );
      if (opened.ok && opened.served !== "network") pageCacheServes += 1;
    }
  }
  const summary = summarizeCalls(records);
  const discovery = records.filter((r) => r.servedBy === "discovery");
  const backendAnswered: Record<string, number> = {};
  for (const r of records) for (const report of r.backends) if (report.status === "ok") backendAnswered[report.backend] = (backendAnswered[report.backend] ?? 0) + 1;
  const discoveryLatencies = discovery.map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    scenario: scenario.name,
    calls: records.length,
    servedBy: summary.servedBy,
    cacheHitRate: Number(summary.cacheHitRate.toFixed(3)),
    backendAnswered,
    meanLatencyMs: Math.round(summary.meanLatencyMs),
    p95LatencyMs: Math.round(summary.p95LatencyMs),
    discoveryMedianMs: Math.round(discoveryLatencies[Math.floor(discoveryLatencies.length / 2)] ?? 0),
    totalCostUsd: Number((summary.totalCostMicroUsd / 1e6).toFixed(4)),
    costPerQueryUsd: Number((summary.costPerQueryMicroUsd / 1e6).toFixed(5)),
    costPer1kQueriesUsd: Number(((summary.costPerQueryMicroUsd / 1e6) * 1000).toFixed(2)),
    opens,
    pageFetches,
    pageCacheServes,
    emptyResults: records.filter((r) => r.results === 0).length,
  };
}

async function main() {
  const jsonAt = process.argv.indexOf("--json");
  const results = [];
  for (const scenario of SCENARIOS) results.push(await runScenario(scenario));
  const report = {
    generatedAt: new Date().toISOString(),
    label: "SIMULATED backends (synthetic web, list prices, virtual-clock latency). Real Alevr Search service, ranker, selection and caches.",
    workload: { calls: CALLS, seed: SEED, topics: TOPICS.length, minutesBetweenCalls: MINUTES_BETWEEN_CALLS, openedPerSearch: OPENED_PER_SEARCH },
    results,
  };
  console.log(report.label);
  console.log("| scenario | cache hit | served by (qc/index/discovery/none) | backends answered | mean / p95 ms | $ per 1k queries | page fetches (cache serves) |");
  console.log("|---|---|---|---|---|---|---|");
  for (const r of results) {
    const s = r.servedBy;
    console.log(
      `| ${r.scenario} | ${(r.cacheHitRate * 100).toFixed(1)}% | ${s.query_cache}/${s.index}/${s.discovery}/${s.none} | ${Object.entries(r.backendAnswered).map(([k, v]) => `${k} ${v}`).join(", ")} | ${r.meanLatencyMs} / ${r.p95LatencyMs} | ${r.costPer1kQueriesUsd.toFixed(2)} | ${r.pageFetches} (${r.pageCacheServes}) |`,
    );
  }
  if (jsonAt > 0 && process.argv[jsonAt + 1]) writeFileSync(process.argv[jsonAt + 1], `${JSON.stringify(report, null, 2)}\n`);
}

void main();
