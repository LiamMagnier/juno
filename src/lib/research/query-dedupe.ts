/**
 * Query similarity, for the research protocol's anti-paraphrase rule.
 *
 * The protocol the owner set for Deep Research (docs/research/PROTOCOL_UPGRADE.md)
 * opens with the failure it exists to prevent: a run that "generates 3–4
 * semantic paraphrases of the user's prompt and stops". Before this module the
 * engine deduplicated queries by exact lower-case string only, so "pricing of
 * GitHub Copilot business" and "GitHub Copilot business pricing" were two
 * searches, two vendor fees and the same page of results twice. Workers were
 * TOLD which searches the team had run; nothing stopped them repeating one.
 *
 * This is deliberately cheap and deterministic — content tokens, crude
 * singularisation, Jaccard and containment — because it runs on every worker
 * search and every follow-up list, and it must never cost a model call. It
 * catches reorderings, plurals, stop-word padding and one-word additions; it
 * does not try to catch true synonyms, which is the planner's job.
 *
 * Pure and client-safe.
 */

import { contentTokens } from "@/lib/research/claim-analysis";

/**
 * Words that change nothing about what a search engine returns for a research
 * query: filler a model adds to make a paraphrase look new. Removed before
 * comparison only — the query sent is never rewritten.
 */
const FILLER = new Set([
  "best", "guide", "overview", "detailed", "details", "information", "info", "explained", "explain", "analysis",
  "comprehensive", "complete", "full", "latest", "current", "today", "review", "reviews", "summary", "how", "why",
  "does", "work", "works", "key", "main", "important", "really", "actually", "exactly", "specific", "official",
]);

/** The comparison key for a query: content tokens without filler. */
export function queryTokens(query: string): Set<string> {
  const out = new Set<string>();
  for (const token of contentTokens(query)) if (!FILLER.has(token)) out.add(token);
  // A query of nothing but filler still needs SOMETHING to compare on.
  return out.size > 0 ? out : contentTokens(query);
}

/** Jaccard similarity of two queries' tokens, 0..1. */
export function querySimilarity(a: string, b: string): number {
  const ta = queryTokens(a);
  const tb = queryTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

/** At or above this Jaccard, two queries are the same search. */
export const NEAR_DUPLICATE_SIMILARITY = 0.8;

/**
 * Whether `query` is a near-duplicate of `other`: the same tokens reordered or
 * pluralised (Jaccard of their content tokens at least 0.8), or one that adds
 * only a year or a number to the other, which a search engine ranks the same.
 */
export function isNearDuplicateQuery(query: string, other: string): boolean {
  const a = queryTokens(query);
  const b = queryTokens(other);
  if (a.size === 0 || b.size === 0) return query.trim().toLowerCase() === other.trim().toLowerCase();
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const jaccard = shared / (a.size + b.size - shared);
  if (jaccard >= NEAR_DUPLICATE_SIMILARITY) return true;
  // Containment: every token of the shorter one is in the longer, and all
  // the longer adds is a year or a number. "copilot business pricing" vs
  // "copilot business pricing 2025" is the same results page; "adoption rate
  // standard" vs "adoption rate standard registry" names a record and is a
  // different search. (Filler words were already dropped by `queryTokens`.)
  const smaller = Math.min(a.size, b.size);
  if (shared !== smaller || Math.abs(a.size - b.size) !== 1 || smaller < 2) return false;
  const [longer, shorter] = a.size > b.size ? [a, b] : [b, a];
  const extra = [...longer].find((token) => !shorter.has(token)) ?? "";
  return /^\d+$/.test(extra);
}

/** The first already-issued query `query` duplicates, or null. */
export function duplicateOf(query: string, issued: readonly string[]): string | null {
  for (const other of issued) if (isNearDuplicateQuery(query, other)) return other;
  return null;
}

/**
 * `queries` with every near-duplicate removed — of an issued query, or of an
 * earlier member of the list. Order kept; the first of a cluster wins.
 */
export function dedupeQueries(queries: readonly string[], issued: readonly string[] = []): string[] {
  const kept: string[] = [];
  for (const query of queries) {
    const text = query.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (duplicateOf(text, issued) || duplicateOf(text, kept)) continue;
    kept.push(text);
  }
  return kept;
}

/**
 * Whether a query (or a planned sub-question) merely restates the request.
 *
 * Measured as the share of the candidate's tokens that are the goal's own: a
 * paraphrase is built almost entirely from the request's words, while an
 * investigative vector or a primary-source query brings its own vocabulary
 * ("pricing page", "changelog", "rate limit", "SEC 10-K"). A short goal makes
 * every candidate look derived, so goals of fewer than three content tokens
 * are never judged.
 */
export function restatesGoal(candidate: string, goal: string): boolean {
  const g = queryTokens(goal);
  const c = queryTokens(candidate);
  if (g.size < 3 || c.size === 0) return false;
  let fromGoal = 0;
  for (const token of c) if (g.has(token)) fromGoal += 1;
  const ownShare = fromGoal / c.size;
  const goalShare = fromGoal / g.size;
  // Nearly all of the candidate is the goal's words, and it carries a good
  // part of the goal: a rewording, not a decomposition.
  return ownShare >= 0.8 && goalShare >= 0.5;
}

/** Sentence furniture that is capitalised without being a name. */
const NOT_A_NAME = new Set(
  "should which what how why is are does do can could would will the a an our we i you my for in on of to compare comparing vs versus between and or with best top".split(" ")
);

/**
 * What a text is about, as a search subject: its proper names when it has
 * any ("GitHub Copilot Cursor" from "Should our team use GitHub Copilot or
 * Cursor?"), else its first content words. At most four words, in order.
 */
export function subjectOf(text: string, exclude: ReadonlySet<string> = new Set()): string {
  const words = text.split(/[^\p{L}\p{N}.+#-]+/u).map((raw) => raw.replace(/^[.-]+|[.-]+$/g, "")).filter(Boolean);
  const names: string[] = [];
  for (const word of words) {
    const lower = word.toLowerCase();
    if (exclude.has(lower) || NOT_A_NAME.has(lower)) continue;
    if (!/^\p{Lu}/u.test(word) && !/\p{Lu}/u.test(word.slice(1))) continue;
    if (names.some((w) => w.toLowerCase() === lower)) continue;
    names.push(word);
    if (names.length >= 4) break;
  }
  if (names.length > 0) return names.join(" ");
  const keep = contentTokens(text);
  const out: string[] = [];
  for (const word of words) {
    const lower = word.toLowerCase();
    if (exclude.has(lower) || NOT_A_NAME.has(lower)) continue;
    const singular = lower.length > 4 && lower.endsWith("s") && !lower.endsWith("ss") ? lower.slice(0, -1) : lower;
    if (!keep.has(singular) && !keep.has(lower)) continue;
    if (out.some((w) => w.toLowerCase() === lower)) continue;
    out.push(word);
    if (out.length >= 4) break;
  }
  return out.join(" ");
}
