import assert from "node:assert/strict";
import test from "node:test";

import { PrismaClient } from "@prisma/client";

import { contentHash, openPage } from "@/lib/search/alevr/retrieve";
import { alevrBackends, type EngineRunner } from "@/lib/search/alevr/backends";
import { alevrSearch } from "@/lib/search/alevr/service";
import { PostgresSearchStore, summarizeCalls } from "@/lib/search/alevr/store";
import type { CachedPage } from "@/lib/search/alevr/types";

/*
 * The Postgres page cache, query cache and call log (migration
 * 20261004190400_alevr_search_cache) against a throwaway, migrated database:
 *
 *   ALEVR_SEARCH_TEST_DATABASE_URL=postgresql://…/juno_search_test npx tsx --test tests/alevr-search-store-db.test.ts
 *
 * Skipped without that variable. Exercises the generated tsvector + GIN
 * index ranking, DISTINCT ON content hash, the freshness and language
 * filters, upsert, 304 touch, query-cache expiry and the call log.
 */

const url = process.env.ALEVR_SEARCH_TEST_DATABASE_URL;
const NOW = new Date("2026-10-04T12:00:00Z");

function page(key: string, over: Partial<CachedPage> = {}): CachedPage {
  const text = over.text ?? "Heat pump subsidies in Norway cover a quarter of the installation cost for homeowners.";
  return {
    canonicalKey: key,
    url: key,
    host: new URL(key).hostname,
    title: over.title ?? "Heat pump subsidies",
    text,
    contentHash: contentHash(text),
    etag: '"e1"',
    lastModified: null,
    publishedAt: null,
    fetchedAt: NOW,
    validatedAt: NOW,
    freshUntil: new Date(NOW.getTime() + 3_600_000),
    language: "en",
    contentType: "html",
    admission: "discovered",
    links: [{ href: "https://x.example/next", text: "next" }],
    ...over,
  };
}

test("the Postgres search store", { skip: !url && "set ALEVR_SEARCH_TEST_DATABASE_URL to a migrated throwaway database" }, async (t) => {
  const prisma = new PrismaClient({ datasourceUrl: url });
  const store = new PostgresSearchStore(prisma);
  await prisma.$executeRawUnsafe(`TRUNCATE "WebPageCache", "WebQueryCache", "WebSearchCall"`);
  t.after(() => prisma.$disconnect());

  await t.test("pages round-trip with links, upsert in place, and a 304 touch moves only freshness", async () => {
    await store.putPage(page("https://a.example/1"));
    await store.putPage(page("https://a.example/1", { title: "Heat pump subsidies, updated" }));
    const got = await store.getPage("https://a.example/1");
    assert.equal(got?.title, "Heat pump subsidies, updated");
    assert.deepEqual(got?.links, [{ href: "https://x.example/next", text: "next" }]);
    assert.equal(got?.etag, '"e1"');
    const later = new Date(NOW.getTime() + 7_200_000);
    await store.touchPage("https://a.example/1", later, new Date(later.getTime() + 60_000));
    assert.equal((await store.getPage("https://a.example/1"))?.validatedAt.getTime(), later.getTime());
    assert.equal((await store.getPages(["https://a.example/1", "https://missing.example/"])).length, 1);
  });

  await t.test("full-text search: every term, title-weighted, one row per content hash, fresh and language filters", async () => {
    await store.putPage(page("https://b.example/2", { title: "Unrelated", text: "Pump maintenance for boats and bilge water." }));
    await store.putPage(page("https://c.example/3", { title: "Heat pumps", text: "Subsidies for heat pump buyers are generous this year in Norway." }));
    await store.putPage(page("https://a.example/1-copy", { title: "Heat pump subsidies, updated" }));
    await store.putPage(page("https://d.example/4", { language: "nb", text: "Heat pump subsidies, in Norwegian." }));
    await store.putPage(page("https://e.example/5", { validatedAt: new Date(NOW.getTime() - 40 * 86_400_000), text: "Old heat pump subsidies page." }));

    const hits = await store.searchIndex({ query: "heat pump subsidies", limit: 10 });
    const urls = hits.map((h) => h.page.url);
    assert.ok(!urls.includes("https://b.example/2"), "every term must match");
    assert.equal(urls.filter((u) => u.startsWith("https://a.example/1")).length, 1, "one copy per content hash");
    assert.ok(hits.every((h, i) => i === 0 || hits[i - 1].lexical >= h.lexical), "ranked");
    assert.ok(hits[0].lexical > 0 && hits[0].lexical <= 1);
    assert.match(hits[0].snippet, /heat pump/i);

    const fresh = await store.searchIndex({ query: "heat pump subsidies", limit: 10, freshAfter: new Date(NOW.getTime() - 86_400_000) });
    assert.ok(!fresh.some((h) => h.page.url === "https://e.example/5"));
    const english = await store.searchIndex({ query: "heat pump subsidies", limit: 10, language: "en" });
    assert.ok(!english.some((h) => h.page.url === "https://d.example/4"));
  });

  await t.test("the query cache expires, never stores page text, and the call log aggregates", async () => {
    await store.putQuery({
      key: "k1",
      hits: [{ title: "T", url: "https://a.example/1", snippet: "s", rawContent: "SECRET PAGE TEXT", backend: "serper", rank: 0, publishedAt: NOW }],
      backend: "serper",
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    const got = await store.getQuery("k1", NOW);
    assert.equal(got?.hits[0].url, "https://a.example/1");
    assert.equal(got?.hits[0].rawContent, undefined);
    assert.equal(got?.hits[0].publishedAt?.getTime(), NOW.getTime());
    assert.equal(await store.getQuery("k1", new Date(NOW.getTime() + 120_000)), null);

    const run: EngineRunner = async () => ({ status: "ok", results: [{ title: "Heat pump", url: "https://z.example/", snippet: "heat pump", engine: "serper" }] });
    const env = { SERPER_API_KEY: "s", ALEVR_SEARCH_INDEX_ANSWERS: "off" };
    const deps = { backends: alevrBackends({ env, runner: run }), store, env, now: () => NOW };
    await alevrSearch({ query: "brand new query", count: 5, vertical: "web", surface: "bench", private: false }, deps);
    await alevrSearch({ query: "Brand  new query", count: 5, vertical: "web", surface: "bench", private: false }, deps);
    const rows = await prisma.$queryRawUnsafe<Array<{ servedBy: string; costMicroUsd: number; backends: unknown }>>(
      `SELECT "servedBy", "costMicroUsd", "backends" FROM "WebSearchCall" ORDER BY "at", "id"`,
    );
    assert.deepEqual(rows.map((r) => [r.servedBy, r.costMicroUsd]).sort(), [["discovery", 1000], ["query_cache", 0]]);
    const queryRows = await prisma.$queryRawUnsafe<Array<{ key: string }>>(`SELECT "key" FROM "WebQueryCache"`);
    assert.ok(queryRows.every((r) => !/brand/i.test(r.key)), "no query text in the table");
    const summary = summarizeCalls(
      rows.map((r) => ({ at: NOW, surface: "bench", vertical: "web", servedBy: r.servedBy as "discovery", backend: null, results: 1, latencyMs: 1, costMicroUsd: r.costMicroUsd, cachedPages: 0, backends: [] })),
    );
    assert.equal(summary.cacheHitRate, 0.5);
  });

  await t.test("openPage stores through Postgres and serves the next read from it", async () => {
    let fetches = 0;
    const extract = async (u: string) => {
      fetches += 1;
      return {
        ok: true as const,
        page: { title: "Doc", text: "A public document about heat pump subsidies. ".repeat(5), links: [], finalUrl: u, hops: [u], contentType: "html" as const, totalChars: 225 },
      };
    };
    const first = await openPage({ url: "https://f.example/doc", admit: "discovered", private: false, extractOptions: {} }, { store, extract, now: () => NOW, env: {} });
    const second = await openPage({ url: "https://f.example/doc", admit: "discovered", private: false, extractOptions: {} }, { store, extract, now: () => NOW, env: {} });
    assert.ok(first.ok && first.stored);
    assert.ok(second.ok && second.served === "cache");
    assert.equal(fetches, 1);
  });

  await t.test("prune drops expired queries and long-unvalidated pages", async () => {
    const result = await store.prune(new Date(NOW.getTime() + 365 * 86_400_000), 30);
    assert.ok(result.queries >= 1);
    assert.ok(result.pages >= 1);
  });
});
