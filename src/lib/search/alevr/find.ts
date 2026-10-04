/**
 * `find_in_page`'s finder: the passages of one page that answer a query
 * (BRIEF §15).
 *
 * A long page is read in windows (`web_fetch` offsets); a model looking for
 * one figure in a 150,000-character report should not have to page through
 * it. This returns the few passages that match, each with the character
 * offset `web_fetch` takes, so the model can open exactly there.
 *
 * Exact phrase matches first (the query as written, case-insensitive), then
 * passages ranked by BM25 over the query's terms. Linear in the page: one
 * paragraph split, one tokenisation per passage.
 *
 * Pure and client-safe.
 */

import { bm25Scores, tokenize } from "@/lib/search/alevr/rank";

export interface PageMatch {
  /** Character offset of the passage in the page text, for `web_fetch`'s `offset`. */
  offset: number;
  text: string;
  kind: "exact" | "terms";
  score: number;
}

const PASSAGE_CHARS = 700;
export const FIND_MAX_MATCHES = 8;

interface Passage {
  offset: number;
  text: string;
}

/** Paragraph-aligned passages of at most ~700 characters, with their offsets. */
export function passagesOf(text: string, size = PASSAGE_CHARS): Passage[] {
  const out: Passage[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const para = text.lastIndexOf("\n", end);
      const sentence = text.lastIndexOf(". ", end);
      const cut = para > start + size / 2 ? para : sentence > start + size / 2 ? sentence + 1 : end;
      end = cut;
    }
    const slice = text.slice(start, end);
    if (slice.trim()) out.push({ offset: start, text: slice });
    start = end;
  }
  return out;
}

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function findInPage(text: string, query: string, maxMatches = 5): PageMatch[] {
  const limit = Math.max(1, Math.min(FIND_MAX_MATCHES, Math.floor(maxMatches)));
  const phrase = query.replace(/\s+/g, " ").trim();
  if (!phrase || !text) return [];
  const out: PageMatch[] = [];
  const used = new Set<number>();

  // Exact phrase, case-insensitive, each with a window around it.
  const lower = text.toLowerCase();
  const needle = phrase.toLowerCase();
  let at = lower.indexOf(needle);
  while (at >= 0 && out.length < limit) {
    const start = Math.max(0, at - 200);
    const end = Math.min(text.length, at + needle.length + 300);
    const bucket = Math.floor(start / PASSAGE_CHARS);
    if (!used.has(bucket)) {
      used.add(bucket);
      out.push({ offset: start, text: flat(text.slice(start, end)), kind: "exact", score: 1 });
    }
    at = lower.indexOf(needle, at + needle.length);
  }
  if (out.length >= limit || tokenize(phrase).length === 0) return out;

  // Then the passages that carry the most of the query's terms.
  const passages = passagesOf(text);
  const scores = bm25Scores(phrase, passages.map((p) => p.text));
  const ranked = passages
    .map((p, i) => ({ p, score: scores[i] }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.offset - b.p.offset);
  for (const { p, score } of ranked) {
    if (out.length >= limit) break;
    const bucket = Math.floor(p.offset / PASSAGE_CHARS);
    if (used.has(bucket)) continue;
    used.add(bucket);
    out.push({ offset: p.offset, text: flat(p.text), kind: "terms", score });
  }
  return out;
}
