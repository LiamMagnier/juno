/**
 * Alevr Search ranking (BRIEF §16, "do more than return ten links").
 *
 * Candidates arrive from discovery backends (each with its own rank) and from
 * Alevr's page index (with a full-text score). One score per candidate, from
 * signals that are each recorded on the result so a reader — or a test — can
 * see why something ranked where it did:
 *
 *   - `engine`: reciprocal-rank agreement across the backends that returned it.
 *     A search engine's own ranking is the strongest relevance signal we have
 *     and is never thrown away;
 *   - `lexical`: BM25 of the query over title + snippet (+ cached page text),
 *     with the candidate set as the corpus;
 *   - `semantic`: cosine similarity from an injected embedder — optional; with
 *     none, its weight moves to `lexical` (no fake embedding);
 *   - `authority`, `sourceType`: the research host heuristics
 *     (`claim-analysis.ts`), so chat and Research weigh a source the same way;
 *   - `freshness`: exponential decay by publication date, with a half-life by
 *     intent (days for news, a year for the web); undated is neutral;
 *   - `language` / `region`: a match helps, a known mismatch hurts.
 *
 * Then de-duplication (same canonical URL, same content hash, or the same
 * title on two hosts — a syndicated copy) and diversity (each further result
 * from one host is discounted), greedily, so the list is not five pages of one
 * site.
 *
 * Pure and client-safe.
 */

import { authorityOf, sourceTypeOf, type ResearchSourceType } from "@/lib/research/claim-analysis";
import { canonicalUrl, isDisallowedHost } from "@/lib/search/url-safety";
import { RRF_K } from "@/lib/search/fusion";
import type { DiscoveryHit, Recency, SearchVertical } from "@/lib/search/alevr/types";

export interface RankCandidate {
  url: string;
  title: string;
  snippet: string;
  /** Page text when Alevr holds it (cached page or backend raw content). */
  text?: string;
  publishedAt?: Date | null;
  language?: string | null;
  contentHash?: string | null;
  /** Each backend that returned it, with its 0-based rank there. */
  ranks: Array<{ backend: string; rank: number }>;
  /** Full-text score from the page index, 0..1, when the index returned it. */
  indexScore?: number;
  rawContent?: string;
}

export interface RankSignals {
  engine: number;
  lexical: number;
  semantic: number | null;
  authority: number;
  freshness: number;
  sourceType: ResearchSourceType;
  language: number;
  region: number;
}

export interface RankedResult extends RankCandidate {
  score: number;
  signals: RankSignals;
  /** The backends that returned it, joined: "serper+index". */
  backend: string;
}

export interface RankOptions {
  query: string;
  vertical: SearchVertical;
  count: number;
  now: Date;
  recency?: Recency;
  language?: string;
  region?: string;
  /** Cosine similarity of the query to each text, 0..1; absent = no semantic signal. */
  semantic?: (query: string, texts: readonly string[]) => readonly number[];
  /** Discount per extra result from one host, 0..1. */
  hostDiscount?: number;
}

const STOPWORDS = new Set(
  "a an and are as at be by for from has have how i in is it its of on or that the this to was what when where which who why will with".split(" "),
);

/** Lowercased word tokens, letters and digits in any script, stopwords dropped. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0];
    if (token.length < 2 && !/\p{N}/u.test(token)) continue;
    if (STOPWORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * BM25 of `query` against each document, the documents themselves as the
 * corpus (k1 = 1.2, b = 0.75), scaled to 0..1 by the best score.
 */
export function bm25Scores(query: string, docs: readonly string[]): number[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || docs.length === 0) return docs.map(() => 0);
  const tokenized = docs.map((doc) => tokenize(doc));
  const avg = tokenized.reduce((sum, d) => sum + d.length, 0) / tokenized.length || 1;
  const df = new Map<string, number>();
  for (const doc of tokenized) {
    const seen = new Set(doc);
    for (const term of terms) if (seen.has(term)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = tokenized.length;
  const k1 = 1.2;
  const b = 0.75;
  const raw = tokenized.map((doc) => {
    const tf = new Map<string, number>();
    for (const token of doc) tf.set(token, (tf.get(token) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const f = tf.get(term) ?? 0;
      if (f === 0) continue;
      const idf = Math.log(1 + (n - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / avg)));
    }
    return score;
  });
  const max = Math.max(...raw);
  return raw.map((s) => (max > 0 ? s / max : 0));
}

const HALF_LIFE_DAYS: Readonly<Record<SearchVertical, number>> = { news: 3, web: 365 };
const RECENCY_HALF_LIFE_DAYS: Readonly<Record<Recency, number>> = { day: 1, week: 4, month: 15, year: 120 };

/** 1 for today, halving every half-life; 0.5 for an undated page (neither rewarded nor punished). */
export function freshnessScore(publishedAt: Date | null | undefined, now: Date, vertical: SearchVertical, recency?: Recency): number {
  if (!publishedAt || !Number.isFinite(publishedAt.getTime())) return 0.5;
  const ageDays = Math.max(0, (now.getTime() - publishedAt.getTime()) / 86_400_000);
  const halfLife = recency ? RECENCY_HALF_LIFE_DAYS[recency] : HALF_LIFE_DAYS[vertical];
  return Math.pow(0.5, ageDays / halfLife);
}

const SOURCE_TYPE_SCORE: Readonly<Record<ResearchSourceType, number>> = {
  official: 1,
  primary: 0.9,
  reputable_secondary: 0.8,
  general: 0.55,
  user_generated: 0.35,
  unknown: 0.5,
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function regionScore(url: string, region?: string): number {
  if (!region) return 0.5;
  const tld = hostOf(url).split(".").pop() ?? "";
  const want = region.toLowerCase() === "gb" ? "uk" : region.toLowerCase();
  if (tld === want) return 1;
  // A generic TLD says nothing about region.
  return tld.length === 2 ? 0.3 : 0.5;
}

function languageScore(language: string | null | undefined, want?: string): number {
  if (!want || !language) return 0.7;
  return language.slice(0, 2).toLowerCase() === want.slice(0, 2).toLowerCase() ? 1 : 0.3;
}

/** Title as a syndication key: lowercase words only, so "Title | Site A" and "Title - Site B" agree. */
function titleKey(title: string): string {
  const words = tokenize(title.replace(/\s[|–—-]\s[^|–—-]+$/u, ""));
  return words.length >= 4 ? words.join(" ") : "";
}

/**
 * Merge discovery hits of several backends into candidates by canonical URL.
 * A hit that is not public http(s) — another scheme, a literal private or
 * metadata address, localhost — never becomes a result, so the model is never
 * shown a link Alevr would refuse to open (BRIEF §17).
 */
export function candidatesFromHits(hits: readonly DiscoveryHit[]): RankCandidate[] {
  const byKey = new Map<string, RankCandidate>();
  for (const hit of hits) {
    if (!/^https?:\/\//i.test(hit.url) || isDisallowedHost(hit.url)) continue;
    const key = canonicalUrl(hit.url);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        url: hit.url,
        title: hit.title,
        snippet: hit.snippet,
        ...(hit.rawContent ? { rawContent: hit.rawContent } : {}),
        ...(hit.publishedAt ? { publishedAt: hit.publishedAt } : {}),
        ...(hit.language ? { language: hit.language } : {}),
        ranks: [{ backend: hit.backend, rank: hit.rank }],
      });
      continue;
    }
    existing.ranks.push({ backend: hit.backend, rank: hit.rank });
    if (hit.snippet.length > existing.snippet.length) existing.snippet = hit.snippet;
    if (!existing.publishedAt && hit.publishedAt) existing.publishedAt = hit.publishedAt;
    if (!existing.rawContent && hit.rawContent) existing.rawContent = hit.rawContent;
    if (!existing.title && hit.title) existing.title = hit.title;
  }
  return [...byKey.values()];
}

export function rankResults(candidates: readonly RankCandidate[], opts: RankOptions): RankedResult[] {
  if (candidates.length === 0) return [];
  const docs = candidates.map((c) => [c.title, c.title, c.snippet, (c.text ?? c.rawContent ?? "").slice(0, 4_000)].join(" "));
  const lexical = bm25Scores(opts.query, docs);
  const semantic = opts.semantic ? opts.semantic(opts.query, docs) : null;
  const news = opts.vertical === "news";

  // Weights sum to 1. Without an embedder, the semantic share goes to lexical.
  const w = {
    engine: 0.34,
    lexical: semantic ? 0.2 : 0.3,
    semantic: semantic ? 0.1 : 0,
    authority: news ? 0.08 : 0.12,
    freshness: news ? 0.18 : opts.recency ? 0.14 : 0.08,
    sourceType: news ? 0.04 : 0.06,
    language: 0.06,
    region: 0.04,
  };
  const spare = 1 - (w.engine + w.lexical + w.semantic + w.authority + w.freshness + w.sourceType + w.language + w.region);
  w.engine += spare;

  // Engine agreement, normalised by the best: one #1 from one backend is 1.
  const best = 1 / (RRF_K + 1);
  const scored = candidates.map((c, i): RankedResult => {
    const rrf = c.ranks.reduce((sum, r) => sum + 1 / (RRF_K + r.rank + 1), 0);
    const engine = Math.min(1.5, rrf / best) / 1.5;
    const indexBoost = c.indexScore !== undefined ? Math.max(0, Math.min(1, c.indexScore)) : 0;
    const authority = authorityOf(c.url);
    const sourceType = sourceTypeOf({ url: c.url, text: `${c.title} ${c.snippet}`, authority });
    const signals: RankSignals = {
      engine: Math.max(engine, indexBoost * 0.8),
      lexical: lexical[i],
      semantic: semantic ? Math.max(0, Math.min(1, semantic[i] ?? 0)) : null,
      authority,
      freshness: freshnessScore(c.publishedAt, opts.now, opts.vertical, opts.recency),
      sourceType,
      language: languageScore(c.language, opts.language),
      region: regionScore(c.url, opts.region),
    };
    const score =
      w.engine * signals.engine +
      w.lexical * signals.lexical +
      w.semantic * (signals.semantic ?? 0) +
      w.authority * signals.authority +
      w.freshness * signals.freshness +
      w.sourceType * SOURCE_TYPE_SCORE[sourceType] +
      w.language * signals.language +
      w.region * signals.region;
    return { ...c, score, signals, backend: [...new Set(c.ranks.map((r) => r.backend))].sort().join("+") };
  });

  scored.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));

  // Greedy pick: drop duplicates, discount repeated hosts.
  const discount = opts.hostDiscount ?? 0.6;
  const seenKeys = new Set<string>();
  const seenHashes = new Set<string>();
  const seenTitles = new Set<string>();
  const pool = scored.filter((r) => {
    const key = canonicalUrl(r.url);
    const title = titleKey(r.title);
    if (seenKeys.has(key)) return false;
    if (r.contentHash && seenHashes.has(r.contentHash)) return false;
    if (title && seenTitles.has(title)) return false;
    seenKeys.add(key);
    if (r.contentHash) seenHashes.add(r.contentHash);
    if (title) seenTitles.add(title);
    return true;
  });

  const out: RankedResult[] = [];
  const perHost = new Map<string, number>();
  const remaining = pool.slice();
  while (out.length < opts.count && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const host = hostOf(remaining[i].url);
      const adjusted = remaining[i].score * Math.pow(discount, perHost.get(host) ?? 0);
      if (adjusted > bestScore) {
        bestScore = adjusted;
        bestIndex = i;
      }
    }
    const [picked] = remaining.splice(bestIndex, 1);
    const host = hostOf(picked.url);
    perHost.set(host, (perHost.get(host) ?? 0) + 1);
    out.push(picked);
  }
  return out;
}
