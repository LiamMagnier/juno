/**
 * Where Alevr Search keeps what it has read: the page cache/index, the exact
 * query cache and the call log (BRIEF §16, "Alevr-owned retrieval").
 *
 * Two implementations of one `SearchStore`:
 *
 *  - `MemorySearchStore`: for tests and the offline bench. Its index is BM25
 *    over title + text, the same ranking the Postgres one approximates.
 *  - `PostgresSearchStore`: three tables (`WebPageCache`, `WebQueryCache`,
 *    `WebSearchCall`, migration `20261004190400_alevr_search_cache`). The page
 *    index is a stored, generated `tsvector` (title weighted A, text B) under a
 *    GIN index, ranked with `ts_rank_cd(..., 32)` — cover density normalised
 *    by document length into 0..1, the closest Postgres gets to BM25 without
 *    an extension.
 *
 * What the tables hold, and what they never hold. Public pages a search
 * discovered (never a URL a person typed, a connector returned or a document
 * contained — `admission`), the result lists of normalised queries keyed by a
 * hash (never the query text), and per-call counts. No user id, no
 * conversation, no query text anywhere, so a cached page is the public web's,
 * not a person's. Private chats never write (the service enforces it).
 *
 * The SQL runs through an injected `$queryRaw`/`$executeRaw` pair so it is
 * testable against a throwaway database without importing the app's client
 * (`tests/alevr-search-store-db.test.ts`). These tables carry no ownership
 * column, so the Prisma ownership guard does not apply to them by design.
 */

import { Prisma } from "@prisma/client";

import { bm25Scores } from "@/lib/search/alevr/rank";
import type { CachedPage, CachedQuery, IndexHit, SearchCallRecord, SearchStore } from "@/lib/search/alevr/types";

const SNIPPET_CHARS = 300;

/** A window of `text` around the first query term, or its head. */
export function snippetAround(text: string, query: string, chars = SNIPPET_CHARS): string {
  const lower = text.toLowerCase();
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = at < 0 ? 0 : Math.max(0, at - Math.floor(chars / 3));
  const window = text.slice(start, start + chars).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${window}${start + chars < text.length ? "…" : ""}`;
}

export class MemorySearchStore implements SearchStore {
  readonly pages = new Map<string, CachedPage>();
  readonly queries = new Map<string, CachedQuery>();
  readonly calls: SearchCallRecord[] = [];
  /** Counters a test or the bench reads. */
  readonly counters = { pageReads: 0, pageWrites: 0, touches: 0, indexSearches: 0 };

  async getPage(key: string): Promise<CachedPage | null> {
    this.counters.pageReads += 1;
    return this.pages.get(key) ?? null;
  }

  async getPages(keys: readonly string[]): Promise<CachedPage[]> {
    return keys.map((key) => this.pages.get(key)).filter((p): p is CachedPage => !!p);
  }

  async putPage(page: CachedPage): Promise<void> {
    this.counters.pageWrites += 1;
    this.pages.set(page.canonicalKey, page);
  }

  async touchPage(key: string, validatedAt: Date, freshUntil: Date): Promise<void> {
    this.counters.touches += 1;
    const page = this.pages.get(key);
    if (page) this.pages.set(key, { ...page, validatedAt, freshUntil });
  }

  async searchIndex(input: { query: string; limit: number; language?: string; freshAfter?: Date }): Promise<IndexHit[]> {
    this.counters.indexSearches += 1;
    const pages = [...this.pages.values()].filter(
      (p) =>
        (!input.freshAfter || p.validatedAt >= input.freshAfter) &&
        (!input.language || !p.language || p.language.slice(0, 2) === input.language.slice(0, 2)),
    );
    // One copy per content hash, as the Postgres index keeps one row per hash.
    const unique = new Map<string, CachedPage>();
    for (const page of pages) if (!unique.has(page.contentHash)) unique.set(page.contentHash, page);
    const list = [...unique.values()];
    const scores = bm25Scores(input.query, list.map((p) => `${p.title} ${p.title} ${p.text}`));
    // Every query term must appear somewhere, as `plainto_tsquery` requires.
    const terms = input.query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
    return list
      .map((page, i) => ({ page, lexical: scores[i], snippet: snippetAround(page.text, input.query) }))
      .filter((hit) => {
        const hay = `${hit.page.title} ${hit.page.text}`.toLowerCase();
        return hit.lexical > 0 && terms.every((t) => hay.includes(t));
      })
      .sort((a, b) => b.lexical - a.lexical)
      .slice(0, input.limit);
  }

  async getQuery(key: string, now: Date): Promise<CachedQuery | null> {
    const entry = this.queries.get(key);
    return entry && entry.expiresAt > now ? entry : null;
  }

  async putQuery(entry: CachedQuery): Promise<void> {
    this.queries.set(entry.key, entry);
  }

  async recordCall(record: SearchCallRecord): Promise<void> {
    this.calls.push(record);
  }
}

/** The two raw-SQL entry points of a Prisma client, so a test can pass its own. */
export interface RawSql {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
}

interface PageRow {
  canonicalKey: string;
  url: string;
  host: string;
  title: string;
  text: string;
  contentHash: string;
  etag: string | null;
  lastModified: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  validatedAt: Date;
  freshUntil: Date;
  language: string | null;
  contentType: string;
  admission: string;
  links: unknown;
}

function pageFromRow(row: PageRow): CachedPage {
  return {
    canonicalKey: row.canonicalKey,
    url: row.url,
    host: row.host,
    title: row.title,
    text: row.text,
    contentHash: row.contentHash,
    etag: row.etag,
    lastModified: row.lastModified,
    publishedAt: row.publishedAt,
    fetchedAt: row.fetchedAt,
    validatedAt: row.validatedAt,
    freshUntil: row.freshUntil,
    language: row.language,
    contentType: row.contentType,
    admission: row.admission === "research" ? "research" : "discovered",
    links: Array.isArray(row.links)
      ? (row.links as Array<{ href?: unknown; text?: unknown }>)
          .filter((l) => typeof l?.href === "string")
          .map((l) => ({ href: l.href as string, text: typeof l.text === "string" ? l.text : "" }))
      : [],
  };
}

const PAGE_COLUMNS = Prisma.sql`"canonicalKey", "url", "host", "title", "text", "contentHash", "etag", "lastModified",
  "publishedAt", "fetchedAt", "validatedAt", "freshUntil", "language", "contentType", "admission", "links"`;

/**
 * A UTC instant for a `TIMESTAMP(3)` column. A bare `Date` parameter reaches
 * Postgres as a zoned value and is converted to the SESSION time zone before
 * the zone is dropped, so a server outside UTC would store every instant
 * shifted; the ISO string cast to `timestamp` stores UTC, as the ORM does.
 */
function ts(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamp`;
}

function tsOrNull(date: Date | null | undefined): Prisma.Sql {
  return date ? ts(date) : Prisma.sql`NULL`;
}

/** Text kept per cached page; the tsvector reads the first 100k characters. */
export const MAX_CACHED_TEXT_CHARS = 200_000;

export class PostgresSearchStore implements SearchStore {
  constructor(private readonly db: RawSql) {}

  async getPage(key: string): Promise<CachedPage | null> {
    const rows = await this.db.$queryRaw<PageRow[]>(
      Prisma.sql`SELECT ${PAGE_COLUMNS} FROM "WebPageCache" WHERE "canonicalKey" = ${key} LIMIT 1`,
    );
    return rows[0] ? pageFromRow(rows[0]) : null;
  }

  async getPages(keys: readonly string[]): Promise<CachedPage[]> {
    if (keys.length === 0) return [];
    const rows = await this.db.$queryRaw<PageRow[]>(
      Prisma.sql`SELECT ${PAGE_COLUMNS} FROM "WebPageCache" WHERE "canonicalKey" IN (${Prisma.join([...keys])})`,
    );
    return rows.map(pageFromRow);
  }

  async putPage(page: CachedPage): Promise<void> {
    const text = page.text.slice(0, MAX_CACHED_TEXT_CHARS);
    await this.db.$executeRaw(Prisma.sql`
      INSERT INTO "WebPageCache" (${PAGE_COLUMNS})
      VALUES (${page.canonicalKey}, ${page.url}, ${page.host}, ${page.title}, ${text}, ${page.contentHash},
        ${page.etag ?? null}, ${page.lastModified ?? null}, ${tsOrNull(page.publishedAt)}, ${ts(page.fetchedAt)},
        ${ts(page.validatedAt)}, ${ts(page.freshUntil)}, ${page.language ?? null}, ${page.contentType}, ${page.admission},
        ${JSON.stringify(page.links ?? [])}::jsonb)
      ON CONFLICT ("canonicalKey") DO UPDATE SET
        "url" = EXCLUDED."url", "host" = EXCLUDED."host", "title" = EXCLUDED."title", "text" = EXCLUDED."text",
        "contentHash" = EXCLUDED."contentHash", "etag" = EXCLUDED."etag", "lastModified" = EXCLUDED."lastModified",
        "publishedAt" = coalesce(EXCLUDED."publishedAt", "WebPageCache"."publishedAt"),
        "fetchedAt" = EXCLUDED."fetchedAt", "validatedAt" = EXCLUDED."validatedAt", "freshUntil" = EXCLUDED."freshUntil",
        "language" = EXCLUDED."language", "contentType" = EXCLUDED."contentType", "admission" = EXCLUDED."admission",
        "links" = EXCLUDED."links"`);
  }

  async touchPage(key: string, validatedAt: Date, freshUntil: Date): Promise<void> {
    await this.db.$executeRaw(Prisma.sql`
      UPDATE "WebPageCache" SET "validatedAt" = ${ts(validatedAt)}, "freshUntil" = ${ts(freshUntil)}, "hits" = "hits" + 1
      WHERE "canonicalKey" = ${key}`);
  }

  async searchIndex(input: { query: string; limit: number; language?: string; freshAfter?: Date }): Promise<IndexHit[]> {
    const freshFilter = input.freshAfter ? Prisma.sql`AND "validatedAt" >= ${ts(input.freshAfter)}` : Prisma.empty;
    const languageFilter = input.language
      ? Prisma.sql`AND ("language" IS NULL OR left("language", 2) = ${input.language.slice(0, 2).toLowerCase()})`
      : Prisma.empty;
    // One row per content hash (DISTINCT ON keeps the best-ranked copy), so
    // two URLs of one document never take two places in the result.
    const rows = await this.db.$queryRaw<Array<PageRow & { rank: number }>>(Prisma.sql`
      SELECT * FROM (
        SELECT DISTINCT ON ("contentHash") ${PAGE_COLUMNS},
          ts_rank_cd("searchVector", plainto_tsquery('simple', ${input.query}), 32) AS rank
        FROM "WebPageCache"
        WHERE "searchVector" @@ plainto_tsquery('simple', ${input.query}) ${freshFilter} ${languageFilter}
        ORDER BY "contentHash", rank DESC
      ) ranked
      ORDER BY rank DESC
      LIMIT ${Math.max(1, Math.min(50, input.limit))}::int`);
    return rows.map((row) => ({
      page: pageFromRow(row),
      lexical: Number(row.rank) || 0,
      snippet: snippetAround(row.text, input.query),
    }));
  }

  async getQuery(key: string, now: Date): Promise<CachedQuery | null> {
    const rows = await this.db.$queryRaw<Array<{ key: string; hits: unknown; backend: string; createdAt: Date; expiresAt: Date }>>(
      Prisma.sql`SELECT "key", "hits", "backend", "createdAt", "expiresAt" FROM "WebQueryCache"
        WHERE "key" = ${key} AND "expiresAt" > ${ts(now)} LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    await this.db.$executeRaw(Prisma.sql`UPDATE "WebQueryCache" SET "served" = "served" + 1 WHERE "key" = ${key}`);
    const hits = Array.isArray(row.hits) ? (row.hits as CachedQuery["hits"]) : [];
    return {
      key: row.key,
      backend: row.backend,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      hits: hits.map((h) => ({ ...h, ...(h.publishedAt ? { publishedAt: new Date(h.publishedAt) } : {}) })),
    };
  }

  async putQuery(entry: CachedQuery): Promise<void> {
    // Raw page text never rides in the query cache: it belongs in the page cache.
    const hits = entry.hits.map(({ rawContent: _raw, ...rest }) => rest);
    await this.db.$executeRaw(Prisma.sql`
      INSERT INTO "WebQueryCache" ("key", "hits", "backend", "createdAt", "expiresAt")
      VALUES (${entry.key}, ${JSON.stringify(hits)}::jsonb, ${entry.backend}, ${ts(entry.createdAt)}, ${ts(entry.expiresAt)})
      ON CONFLICT ("key") DO UPDATE SET "hits" = EXCLUDED."hits", "backend" = EXCLUDED."backend",
        "createdAt" = EXCLUDED."createdAt", "expiresAt" = EXCLUDED."expiresAt"`);
  }

  async recordCall(record: SearchCallRecord): Promise<void> {
    await this.db.$executeRaw(Prisma.sql`
      INSERT INTO "WebSearchCall" ("id", "at", "surface", "vertical", "servedBy", "backend", "results", "latencyMs",
        "costMicroUsd", "cachedPages", "backends")
      VALUES (${`wsc_${record.at.getTime().toString(36)}_${Math.random().toString(36).slice(2, 10)}`}, ${ts(record.at)},
        ${record.surface}, ${record.vertical}, ${record.servedBy}, ${record.backend}, ${record.results}::int,
        ${Math.round(record.latencyMs)}::int, ${Math.round(record.costMicroUsd)}::int, ${record.cachedPages}::int,
        ${JSON.stringify(record.backends)}::jsonb)`);
  }

  /** Drop expired query entries and pages nobody revalidated for `staleDays`. Run from a maintenance job. */
  async prune(now: Date, staleDays = 30): Promise<{ queries: number; pages: number }> {
    const queries = await this.db.$executeRaw(Prisma.sql`DELETE FROM "WebQueryCache" WHERE "expiresAt" < ${ts(now)}`);
    const cutoff = new Date(now.getTime() - staleDays * 86_400_000);
    const pages = await this.db.$executeRaw(Prisma.sql`DELETE FROM "WebPageCache" WHERE "validatedAt" < ${ts(cutoff)}`);
    return { queries, pages };
  }
}

/** Aggregates over the call log, for SEARCH.md's measurements and an operator's dashboard query. */
export function summarizeCalls(calls: readonly SearchCallRecord[]): {
  calls: number;
  servedBy: Record<SearchCallRecord["servedBy"], number>;
  backendHits: Record<string, number>;
  cacheHitRate: number;
  meanLatencyMs: number;
  p95LatencyMs: number;
  totalCostMicroUsd: number;
  costPerQueryMicroUsd: number;
} {
  const servedBy = { query_cache: 0, index: 0, discovery: 0, none: 0 };
  const backendHits: Record<string, number> = {};
  let cost = 0;
  const latencies: number[] = [];
  for (const call of calls) {
    servedBy[call.servedBy] += 1;
    if (call.backend) backendHits[call.backend] = (backendHits[call.backend] ?? 0) + 1;
    cost += call.costMicroUsd;
    latencies.push(call.latencyMs);
  }
  latencies.sort((a, b) => a - b);
  const n = calls.length || 1;
  return {
    calls: calls.length,
    servedBy,
    backendHits,
    cacheHitRate: (servedBy.query_cache + servedBy.index) / n,
    meanLatencyMs: latencies.reduce((s, l) => s + l, 0) / n,
    p95LatencyMs: latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0,
    totalCostMicroUsd: cost,
    costPerQueryMicroUsd: cost / n,
  };
}
