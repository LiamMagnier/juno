import assert from "node:assert/strict";
import test from "node:test";

import { alevrBackends, alevrSearchAvailable, planDiscovery, planFanout, type EngineRunner } from "@/lib/search/alevr/backends";
import { findInPage, passagesOf } from "@/lib/search/alevr/find";
import { bm25Scores, candidatesFromHits, freshnessScore, rankResults, tokenize } from "@/lib/search/alevr/rank";
import { alevrSearch, normalizeQuery, queryCacheKey } from "@/lib/search/alevr/service";
import { MemorySearchStore, snippetAround, summarizeCalls } from "@/lib/search/alevr/store";
import type { CachedPage, DiscoveryBackend, DiscoveryHit, DiscoveryQuery } from "@/lib/search/alevr/types";
import type { SearchResult } from "@/lib/search/fusion";

/*
 * Alevr Search's core (BRIEF §15–16), offline: backend selection by
 * availability, quality floor and cost; the cheapest-path service (query
 * cache → page index → one discovery backend, or a fused fan-out); the
 * ranker's signals, de-duplication and diversity; the in-page finder. Every
 * backend is a fake; nothing here touches the network or a database.
 */

const NOW = new Date("2026-10-04T12:00:00Z");
const KEYS = { SERPER_API_KEY: "s", BRAVE_API_KEY: "b", TAVILY_API_KEY: "t", EXA_API_KEY: "e" };

function result(url: string, over: Partial<SearchResult> = {}): SearchResult {
  return { title: `About ${new URL(url).hostname}`, url, snippet: "heat pump subsidies explained", engine: "x", ...over };
}

/** An engine runner that answers per engine from a script and records the calls. */
function runner(script: Record<string, { status?: string; results?: SearchResult[] }> = {}) {
  const calls: Array<{ engine: string; query: DiscoveryQuery }> = [];
  const run: EngineRunner = async (engine, query) => {
    calls.push({ engine, query });
    const entry = script[engine] ?? {};
    const status = entry.status ?? "ok";
    const results = status === "ok" ? (entry.results ?? [result(`https://${engine}.example/a`), result(`https://${engine}.example/b`)]) : [];
    return { results, status: status === "ok" && results.length === 0 ? "empty" : status };
  };
  return { run, calls };
}

let clockMs = 0;
const clock = () => (clockMs += 5);

function page(over: Partial<CachedPage> & { url: string }): CachedPage {
  const host = new URL(over.url).hostname.replace(/^www\./, "");
  return {
    canonicalKey: over.url.replace(/^https?:\/\/(www\.)?/, "https://").replace(/\/$/, ""),
    host,
    title: `Page on ${host}`,
    text: "Heat pump subsidies in Norway cover up to 40 percent of installation cost for households.",
    contentHash: `hash-${over.url}`,
    fetchedAt: NOW,
    validatedAt: NOW,
    freshUntil: new Date(NOW.getTime() + 3_600_000),
    contentType: "html",
    admission: "discovered",
    ...over,
  };
}

// ── Backends ────────────────────────────────────────────────────────────────

test("selection: available, serves the vertical, clears the floor, cheapest first", () => {
  const backends = alevrBackends({ env: KEYS, runner: runner().run });
  assert.deepEqual(planDiscovery(backends, { vertical: "web", env: KEYS, count: 5 }).map((b) => b.id), ["serper", "brave", "tavily", "exa"]);
  // Exa bills per result, so for five results it costs more than Tavily's flat call.
  assert.deepEqual(planDiscovery(backends, { vertical: "news", env: KEYS, count: 5 }).map((b) => b.id), ["serper", "brave", "tavily", "exa"]);
  const withSearx = { ...KEYS, SEARXNG_URL: "http://searxng:8080" };
  const all = alevrBackends({ env: withSearx, runner: runner().run });
  assert.equal(planDiscovery(all, { vertical: "web", env: withSearx, count: 5 })[0].id, "searxng", "self-hosted and free goes first");
  assert.ok(
    !planDiscovery(all, { vertical: "web", env: withSearx, count: 5 }).some((b) => b.id === "wikipedia"),
    "Wikipedia never answers a chat search",
  );
  const lowRated = { ...withSearx, ALEVR_SEARXNG_QUALITY: "0.4" };
  assert.equal(planDiscovery(alevrBackends({ env: lowRated }), { vertical: "web", env: lowRated, count: 5 })[0].id, "serper");
  assert.deepEqual(planFanout(all, { vertical: "web", env: withSearx }).map((b) => b.id).sort(), ["brave", "exa", "searxng", "serper", "tavily", "wikipedia"]);
  assert.ok(!planFanout(all, { vertical: "news", env: withSearx }).some((b) => b.id === "wikipedia"), "no encyclopedia for news");
  assert.equal(alevrSearchAvailable({}), false);
  assert.equal(alevrSearchAvailable({ SEARXNG_URL: "javascript:alert(1)" }), false);
});

test("public SearXNG instances and scraped DuckDuckGo are gone from the engine module", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/lib/search/search-engine.ts", "utf8");
  for (const host of ["searx.be", "search.sapti.me", "priv.au", "html.duckduckgo.com"]) {
    assert.ok(!source.includes(host), `${host} is still referenced`);
  }
  assert.match(source, /export function isSearchEngineAvailable\(\): boolean \{\n\s+return searchProviderStatus\(\)\.hasGoodIndex;/);
});

// ── The service ─────────────────────────────────────────────────────────────

test("discovery: one backend, recorded with its cost; the second identical query is served from the query cache for free", async () => {
  const store = new MemorySearchStore();
  const { run, calls } = runner();
  const backends = alevrBackends({ env: KEYS, runner: run });
  const deps = { backends, store, env: KEYS, now: () => NOW, clock };
  const input = { query: "Heat pump subsidies", count: 5, vertical: "web" as const, surface: "bench" as const, private: false };

  const first = await alevrSearch(input, deps);
  assert.equal(first.servedBy, "discovery");
  assert.equal(first.backend, "serper");
  assert.equal(first.costMicroUsd, 1_000);
  assert.deepEqual(calls.map((c) => c.engine), ["serper"]);
  assert.equal(first.results.length, 2);

  const second = await alevrSearch({ ...input, query: "  heat PUMP   subsidies " }, deps);
  assert.equal(second.servedBy, "query_cache");
  assert.equal(second.costMicroUsd, 0);
  assert.equal(calls.length, 1, "no backend was asked again");
  assert.deepEqual(second.results.map((r) => r.url), first.results.map((r) => r.url));

  // The call log has both calls, and never the query.
  assert.equal(store.calls.length, 2);
  assert.ok(!JSON.stringify(store.calls).toLowerCase().includes("heat pump"));
  assert.ok(![...store.queries.keys()].some((key) => key.includes("heat")), "the cache key is a hash");
  const summary = summarizeCalls(store.calls);
  assert.equal(summary.cacheHitRate, 0.5);
  assert.equal(summary.totalCostMicroUsd, 1_000);
  assert.deepEqual(summary.backendHits, { serper: 1, query_cache: 1 });
});

test("the page index answers when it holds enough fresh, distinct, matching pages — and joins the candidates otherwise", async () => {
  const store = new MemorySearchStore();
  for (const host of ["a.example", "b.example", "c.example", "d.example", "e.example"]) {
    await store.putPage(page({ url: `https://${host}/subsidies` }));
  }
  const { run, calls } = runner();
  const backends = alevrBackends({ env: KEYS, runner: run });
  const deps = { backends, store, env: KEYS, now: () => NOW, clock };
  const input = { query: "heat pump subsidies", count: 5, vertical: "web" as const, surface: "bench" as const, private: false };

  const answered = await alevrSearch(input, deps);
  assert.equal(answered.servedBy, "index");
  assert.equal(answered.costMicroUsd, 0);
  assert.equal(calls.length, 0);
  assert.equal(answered.results.length, 5);

  // A time-bound query never comes from the index alone.
  const recent = await alevrSearch({ ...input, recency: "week" }, deps);
  assert.equal(recent.servedBy, "discovery");
  assert.equal(calls.length, 1);

  // With the index answers switched off, matching pages still compete in the ranking.
  const merged = await alevrSearch({ ...input, query: "heat pump subsidies norway" }, { ...deps, env: { ...KEYS, ALEVR_SEARCH_INDEX_ANSWERS: "off" } });
  assert.equal(merged.servedBy, "discovery");
  assert.ok(merged.results.some((r) => r.ranks.some((rank) => rank.backend === "index")), "index pages joined the candidates");
  assert.equal(merged.backend, "serper+index");
});

test("stale index pages never answer on their own", async () => {
  const store = new MemorySearchStore();
  const old = new Date(NOW.getTime() - 10 * 86_400_000);
  for (const host of ["a.example", "b.example", "c.example", "d.example", "e.example"]) {
    await store.putPage(page({ url: `https://${host}/x`, validatedAt: old }));
  }
  const { run } = runner();
  const outcome = await alevrSearch(
    { query: "heat pump subsidies", count: 5, vertical: "web", surface: "bench", private: false },
    { backends: alevrBackends({ env: KEYS, runner: run }), store, env: KEYS, now: () => NOW, clock },
  );
  assert.equal(outcome.servedBy, "discovery");
});

test("a private search reads the caches and writes nothing", async () => {
  const store = new MemorySearchStore();
  const { run } = runner();
  const deps = { backends: alevrBackends({ env: KEYS, runner: run }), store, env: KEYS, now: () => NOW, clock };
  const outcome = await alevrSearch({ query: "private query", count: 5, vertical: "web", surface: "chat", private: true }, deps);
  assert.equal(outcome.servedBy, "discovery");
  assert.equal(store.calls.length, 0, "no call record");
  assert.equal(store.queries.size, 0, "no query cache entry");
});

test("escalation: a failed primary is not billed; a free backend's empty answer escalates; a paid empty answer does not", async () => {
  const env = { ...KEYS, SEARXNG_URL: "http://searxng:8080" };
  const failed = runner({ searxng: { status: "timeout" } });
  const a = await alevrSearch(
    { query: "q1", count: 5, vertical: "web", surface: "bench", private: false },
    { backends: alevrBackends({ env, runner: failed.run }), store: null, env, now: () => NOW, clock },
  );
  assert.deepEqual(failed.calls.map((c) => c.engine), ["searxng", "serper"]);
  assert.equal(a.degraded, true);
  assert.equal(a.costMicroUsd, 1_000);
  assert.deepEqual(a.reports.map((r) => [r.backend, r.status, r.costMicroUsd]), [["searxng", "timeout", 0], ["serper", "ok", 1_000]]);

  const paidEmpty = runner({ serper: { results: [] } });
  const b = await alevrSearch(
    { query: "q2", count: 5, vertical: "web", surface: "bench", private: false },
    { backends: alevrBackends({ env: KEYS, runner: paidEmpty.run }), store: null, env: KEYS, now: () => NOW, clock },
  );
  assert.deepEqual(paidEmpty.calls.map((c) => c.engine), ["serper"]);
  assert.equal(b.results.length, 0);
  assert.equal(b.costMicroUsd, 1_000, "an empty paid answer was still paid");
});

test("news: the vertical reaches the backend and only news-capable backends are asked", async () => {
  const { run, calls } = runner();
  await alevrSearch(
    { query: "election results", count: 5, vertical: "news", recency: "day", surface: "bench", private: false },
    { backends: alevrBackends({ env: KEYS, runner: run }), store: null, env: KEYS, now: () => NOW, clock },
  );
  assert.equal(calls[0].query.vertical, "news");
  assert.equal(calls[0].query.recency, "day");
});

test("fan-out (Research): every available backend, fused, each answered backend billed", async () => {
  const shared = result("https://shared.example/report");
  const { run, calls } = runner({
    serper: { results: [shared, result("https://serper-only.example/x")] },
    brave: { results: [shared] },
    tavily: { status: "rate_limited" },
  });
  const outcome = await alevrSearch(
    { query: "fan out", count: 10, vertical: "web", surface: "research", private: false, mode: "fanout" },
    { backends: alevrBackends({ env: KEYS, runner: run }), store: null, env: KEYS, now: () => NOW, clock },
  );
  assert.deepEqual(calls.map((c) => c.engine).sort(), ["brave", "exa", "serper", "tavily", "wikipedia"]);
  assert.equal(outcome.results[0].url, "https://shared.example/report", "agreement ranks first");
  assert.equal(outcome.results[0].backend, "brave+serper");
  const exaCost = alevrBackends({ env: KEYS }).find((b) => b.id === "exa")!.costMicroUsd(2);
  assert.equal(outcome.costMicroUsd, 1_000 + 5_000 + exaCost + 0, "Tavily failed and was not billed; Wikipedia is free");
  assert.equal(outcome.degraded, true);
});

test("the query key is case-, space- and Unicode-insensitive and separates vertical, recency and mode", () => {
  assert.equal(normalizeQuery("  Ｈeat   PUMP "), "heat pump");
  const base = { query: "heat pump", vertical: "web" as const };
  assert.equal(queryCacheKey(base), queryCacheKey({ ...base, query: "HEAT  pump" }));
  assert.notEqual(queryCacheKey(base), queryCacheKey({ ...base, vertical: "news" }));
  assert.notEqual(queryCacheKey(base), queryCacheKey({ ...base, recency: "week" }));
  assert.notEqual(queryCacheKey(base), queryCacheKey({ ...base, mode: "fanout" }));
  assert.match(queryCacheKey(base), /^[0-9a-f]{64}$/);
});

// ── Ranking ─────────────────────────────────────────────────────────────────

test("BM25 rewards the documents that carry the query's rare terms", () => {
  assert.deepEqual(tokenize("The Heat-Pump, in 2026!"), ["heat", "pump", "2026"]);
  const scores = bm25Scores("heat pump grant", ["heat pump grant rules", "pump catalogue", "unrelated page"]);
  assert.equal(scores[0], 1);
  assert.ok(scores[1] > 0 && scores[1] < scores[0]);
  assert.equal(scores[2], 0);
});

test("freshness halves per half-life; undated is neutral", () => {
  assert.equal(freshnessScore(null, NOW, "web"), 0.5);
  assert.ok(Math.abs(freshnessScore(new Date(NOW.getTime() - 3 * 86_400_000), NOW, "news") - 0.5) < 1e-9);
  assert.ok(freshnessScore(new Date(NOW.getTime() - 3 * 86_400_000), NOW, "web") > 0.99);
});

test("ranking: dedup by canonical URL, content hash and syndicated title; one host cannot fill the list", () => {
  const hits: DiscoveryHit[] = [
    { title: "Grants for heat pumps announced today", url: "https://wire.example/story?utm_source=x", snippet: "heat pump grants", backend: "serper", rank: 0 },
    { title: "Grants for heat pumps announced today | Daily", url: "https://daily.example/copy", snippet: "heat pump grants", backend: "serper", rank: 1 },
    { title: "Grants page", url: "https://wire.example/story", snippet: "heat pump grants", backend: "brave", rank: 0 },
    ...[2, 3, 4, 5, 6].map((i) => ({ title: `Big site ${i}`, url: `https://big.example/${i}`, snippet: "heat pump grants", backend: "serper", rank: i })),
    { title: "Government scheme", url: "https://energy.gov.example.gov/scheme", snippet: "heat pump grants scheme", backend: "brave", rank: 1 },
  ];
  const candidates = candidatesFromHits(hits);
  assert.equal(candidates.filter((c) => c.url.startsWith("https://wire.example")).length, 1, "tracking parameters merged");
  const ranked = rankResults(candidates, { query: "heat pump grants", vertical: "web", count: 5, now: NOW });
  const urls = ranked.map((r) => r.url);
  assert.ok(!urls.includes("https://daily.example/copy"), "the syndicated copy is dropped");
  assert.ok(urls.filter((u) => u.startsWith("https://big.example")).length <= 3, "diversity discount");
  assert.ok(urls.includes("https://energy.gov.example.gov/scheme"));
  const top = ranked[0];
  for (const key of ["engine", "lexical", "authority", "freshness", "sourceType", "language", "region"] as const) {
    assert.notEqual(top.signals[key], undefined, key);
  }
  assert.equal(top.signals.semantic, null, "no embedder, no fake semantic score");
});

test("ranking: an injected embedder contributes; language and region matches help", () => {
  const candidates = candidatesFromHits([
    { title: "Varmepumpe støtte", url: "https://enova.no/a", snippet: "støtte", backend: "serper", rank: 1, language: "no" },
    { title: "Heat pump support", url: "https://example.com/a", snippet: "support", backend: "serper", rank: 0, language: "en" },
  ]);
  const ranked = rankResults(candidates, {
    query: "varmepumpe støtte",
    vertical: "web",
    count: 2,
    now: NOW,
    language: "no",
    region: "no",
    semantic: (_q, docs) => docs.map((d) => (d.includes("Varmepumpe") ? 0.9 : 0.1)),
  });
  assert.equal(ranked[0].url, "https://enova.no/a");
  assert.equal(ranked[0].signals.semantic, 0.9);
  assert.equal(ranked[0].signals.language, 1);
  assert.equal(ranked[0].signals.region, 1);
});

// ── Store and finder ────────────────────────────────────────────────────────

test("the memory index needs every term, keeps one copy per content hash, and filters stale pages", async () => {
  const store = new MemorySearchStore();
  await store.putPage(page({ url: "https://a.example/1", contentHash: "same" }));
  await store.putPage(page({ url: "https://a.example/1?ref=copy", canonicalKey: "copy", contentHash: "same" }));
  await store.putPage(page({ url: "https://b.example/2", text: "Nothing about pumps here, only heat." }));
  const hits = await store.searchIndex({ query: "heat pump subsidies", limit: 10 });
  assert.equal(hits.length, 1);
  assert.match(hits[0].snippet, /Heat pump subsidies/);
  assert.equal((await store.searchIndex({ query: "heat pump", limit: 10, freshAfter: new Date(NOW.getTime() + 1) })).length, 0);
});

test("snippets centre on the first matched term", () => {
  const text = `${"lorem ipsum ".repeat(100)}the subsidy is 40 percent ${"dolor ".repeat(100)}`;
  const s = snippetAround(text, "subsidy");
  assert.match(s, /subsidy is 40 percent/);
  assert.ok(s.startsWith("…"));
});

test("find_in_page's finder: exact phrases first with their offsets, then term passages, never two from one window", () => {
  const text = [
    "Introduction to the warranty programme.",
    "x".repeat(900),
    "The battery warranty lasts eight years or 160,000 km, whichever comes first.",
    "y".repeat(900),
    "Battery replacement outside the warranty costs extra.",
  ].join("\n");
  const matches = findInPage(text, "battery warranty", 5);
  assert.equal(matches[0].kind, "exact");
  assert.match(matches[0].text, /eight years/);
  assert.equal(text.slice(matches[0].offset).includes("battery warranty"), true);
  assert.ok(matches.some((m) => m.kind === "terms" && /replacement/.test(m.text)));
  assert.equal(new Set(matches.map((m) => Math.floor(m.offset / 700))).size, matches.length);
  assert.deepEqual(findInPage(text, "   ", 5), []);
  assert.deepEqual(findInPage(text, "zebra quokka", 5), []);
  const passages = passagesOf(text);
  assert.equal(passages.map((p) => p.text).join(""), text, "passages tile the page exactly");
});

test("the backend interface is the only thing a backend has to implement", async () => {
  const custom: DiscoveryBackend = {
    id: "custom",
    kind: "self_hosted",
    verticals: new Set(["web"]),
    quality: { web: 0.9 },
    available: () => true,
    costMicroUsd: () => 0,
    run: async (q) => [{ title: "Custom", url: "https://custom.example/", snippet: q.query, backend: "custom", rank: 0 }],
  };
  const outcome = await alevrSearch(
    { query: "anything", count: 3, vertical: "web", surface: "bench", private: false },
    { backends: [custom], store: null, env: {}, now: () => NOW, clock },
  );
  assert.equal(outcome.backend, "custom");
  assert.equal(outcome.results[0].url, "https://custom.example/");
});
