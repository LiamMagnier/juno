/**
 * Query parsing, snippet marking and ranking — the parts of unified search that
 * have behaviour rather than a database connection.
 *
 * Split out of index.ts so all three are testable without Postgres, which is
 * the same reason src/lib/work/recents.ts keeps its projection separate from
 * the route that reads the tables.
 *
 * The one design decision that runs through this whole file: Postgres matches
 * with the `simple` text-search configuration and a prefix flag per token, and
 * this module marks the snippet with exactly the same rule. Not `english`.
 * Stemming would have found "guarding" for "guard" — genuinely better recall —
 * but the highlight would then have to guess which characters the stemmer had
 * agreed with, and a highlight that lands on the wrong span (or on nothing, in a
 * result the engine swears matched) reads as a bug in a way that a missed
 * inflection never does. `simple` also keeps stopwords searchable, which
 * matters when the corpus is one person's own writing and "the plan" is a real
 * thing they typed. The two rules have to agree, so they are stated once here
 * and once in sql.ts, and the tests hold them together.
 */

import {
  SEARCH_TYPES,
  SEARCH_TYPE_LABELS,
  type SearchGroup,
  type SearchHit,
  type SearchMark,
  type SearchSnippet,
  type SearchType,
} from "@/lib/search/types";

/**
 * A parsed query. `terms` is what gets highlighted, `tsquery` is what Postgres
 * is handed; they are derived from the same token list so they cannot drift.
 */
export interface ParsedSearchQuery {
  raw: string;
  terms: string[];
  /** Ready for `to_tsquery('simple', …)`. Never contains tsquery syntax from the user. */
  tsquery: string;
}

/**
 * A palette query is a handful of words, not a paragraph. Every extra token is
 * another AND clause against eight tables; the cap stops a pasted sentence from
 * turning one keystroke into a nine-way scan that will match nothing anyway.
 */
const MAX_TERMS = 8;

/** Letters and digits in any script — Juno's users do not all type ASCII. */
const TOKEN_RE = /[\p{L}\p{N}]+/gu;

/**
 * Split a raw query into search tokens.
 *
 * Everything that is not a letter or a digit is a separator, which is what makes
 * the result safe to interpolate into a tsquery string: `&`, `|`, `!`, `(`, `)`
 * and `:` cannot survive tokenisation, so a user typing `a | b` searches for the
 * words "a" and "b" instead of injecting an OR into the parser. That is the
 * entire injection argument for `buildTsQuery` below, and it is why the
 * tokeniser is a whitelist rather than an escape function.
 */
export function searchTerms(raw: string): string[] {
  const seen = new Set<string>();
  for (const match of raw.toLowerCase().matchAll(TOKEN_RE)) {
    seen.add(match[0]);
    if (seen.size >= MAX_TERMS) break;
  }
  return [...seen];
}

/**
 * `to_tsquery` text for a token list: every token prefix-matched, all ANDed.
 *
 * Prefix on EVERY token, not just the last, because this is a type-ahead
 * surface — "conv gua" should find "conversation guard" while the user is still
 * typing, and a search that only comes alive on whole words feels broken at
 * exactly the moment the user is deciding whether to trust it.
 */
export function buildTsQuery(terms: readonly string[]): string {
  return terms.map((t) => `${t}:*`).join(" & ");
}

/**
 * Parse a raw query, or null when there is nothing to search for.
 *
 * Null rather than an empty result, because "no query" and "no matches" are
 * different states with different UI: one shows recents, the other shows an
 * empty state. Collapsing them is how search surfaces end up telling people
 * their account is empty.
 */
export function parseSearchQuery(raw: string): ParsedSearchQuery | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const terms = searchTerms(trimmed);
  if (terms.length === 0) return null;
  return { raw: trimmed, terms, tsquery: buildTsQuery(terms) };
}

/** How much of the text either side of the first match a snippet carries. */
const SNIPPET_RADIUS = 64;

/** Collapse whitespace so a match spanning a line break still reads as one line. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ");
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/**
 * Every place a term matches, as offsets into `text`.
 *
 * A match must start at a word boundary and may end mid-word: that is precisely
 * what `token:*` means in Postgres, so a highlight produced this way marks the
 * characters the engine actually matched. Searching "guard" highlights the
 * "guard" of "guardrail" and nothing inside "safeguard" — which is also the
 * behaviour that makes the marks legible rather than confetti.
 */
export function markTerms(text: string, terms: readonly string[]): SearchMark[] {
  const haystack = text.toLowerCase();
  const found: SearchMark[] = [];

  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(term, from);
      if (at === -1) break;
      if (!isWordChar(haystack[at - 1])) found.push({ start: at, end: at + term.length });
      // Advance past the match: overlapping needles ("aa" in "aaa") would
      // otherwise never terminate, and a zero-length term is impossible because
      // the tokeniser cannot produce one.
      from = at + term.length;
    }
  }

  // Merge, so two terms matching the same word ("guard" and "guardrail") become
  // one span rather than two overlapping ones the renderer would double-wrap.
  found.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SearchMark[] = [];
  for (const mark of found) {
    const last = merged[merged.length - 1];
    if (last && mark.start <= last.end) last.end = Math.max(last.end, mark.end);
    else merged.push({ ...mark });
  }
  return merged;
}

/**
 * True when every term matches, which is what `a:* & b:*` means in Postgres.
 *
 * The branches that match in SQL never need this. The message branch does: its
 * bodies are encrypted, so the AND is evaluated here in TypeScript instead, and
 * it has to reach the same verdict Postgres would — otherwise a two-word query
 * would return messages containing either word from one source and both from
 * every other, which reads as the search being broken for messages specifically.
 */
export function matchesAllTerms(text: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const haystack = text.toLowerCase();
  return terms.every((term) => {
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(term, from);
      if (at === -1) return false;
      if (!isWordChar(haystack[at - 1])) return true;
      from = at + term.length;
    }
  });
}

/**
 * One line of context around the first match, with the matches marked.
 *
 * Returns null when nothing matches — which happens legitimately: Postgres
 * matched the row on a different column (a document's file name, an artifact's
 * title) than the one whose body we are snippeting. A null snippet is the
 * honest answer there; inventing a leading fragment of the text would imply the
 * match was in it.
 *
 * Whitespace is flattened segment by segment rather than up front, so the marks
 * stay aligned: collapsing "a\n\nb" to "a b" after computing offsets would slide
 * every highlight left by the characters it removed.
 */
export function buildSnippet(
  text: string,
  terms: readonly string[],
  { radius = SNIPPET_RADIUS }: { radius?: number } = {}
): SearchSnippet | null {
  if (!text) return null;
  const marks = markTerms(text, terms);
  if (marks.length === 0) return null;

  const first = marks[0];
  const windowStart = Math.max(0, first.start - radius);
  const windowEnd = Math.min(text.length, first.end + radius);
  const inWindow = marks.filter((m) => m.start >= windowStart && m.end <= windowEnd);

  const prefix = windowStart > 0 ? "…" : "";
  let out = prefix;
  const outMarks: SearchMark[] = [];
  let cursor = windowStart;

  for (const mark of inWindow) {
    out += flatten(text.slice(cursor, mark.start));
    const start = out.length;
    out += flatten(text.slice(mark.start, mark.end));
    outMarks.push({ start, end: out.length });
    cursor = mark.end;
  }
  out += flatten(text.slice(cursor, windowEnd));
  if (windowEnd < text.length) out += "…";

  return { text: out, marks: outMarks };
}

/**
 * Per-type multiplier applied to the Postgres relevance score.
 *
 * Not a statement about which content matters — it is a correction for the fact
 * that `ts_rank` over a six-word chat title and over a 4,000-word artifact are
 * not the same number. Short, deliberately-chosen text (a title someone named, a
 * fact they asked Juno to remember) is a stronger signal of intent per matched
 * word than a body that happens to contain the word somewhere, so titles are
 * nudged up rather than left to lose every comparison on length normalisation.
 */
export const TYPE_WEIGHT: Record<SearchType, number> = {
  conversation: 1.6,
  project: 1.5,
  memory: 1.3,
  work: 1.2,
  artifact: 1.1,
  file: 1.0,
  knowledge: 1.0,
  message: 1.0,
};

/**
 * Total order over hits: relevance, then recency, then id.
 *
 * The id tie-break is not decoration. Eight sources are queried concurrently and
 * merged, so without a final deterministic key two equally-ranked, equally-aged
 * hits could swap places between two identical searches — and in a palette,
 * where the user is pressing Enter on "the second row", a list that reorders
 * under an unchanged query is a wrong-destination bug, not a cosmetic one.
 */
export function compareHits(a: SearchHit, b: SearchHit): number {
  if (b.score !== a.score) return b.score - a.score;
  const at = Date.parse(a.updatedAt);
  const bt = Date.parse(b.updatedAt);
  // An unparseable timestamp sorts last rather than poisoning the comparison
  // with NaN, which would make the sort's result depend on the input order.
  const av = Number.isNaN(at) ? -Infinity : at;
  const bv = Number.isNaN(bt) ? -Infinity : bt;
  if (bv !== av) return bv - av;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function rankHits(hits: readonly SearchHit[]): SearchHit[] {
  return [...hits].sort(compareHits);
}

/**
 * Group ranked hits by type, in SEARCH_TYPES order, dropping empty groups.
 *
 * The group order is fixed rather than "best group first": the palette is
 * operated by muscle memory, and a heading that moves depending on the query is
 * a heading nobody can aim at.
 */
export function groupHits(hits: readonly SearchHit[], { perGroup }: { perGroup?: number } = {}): SearchGroup[] {
  const ranked = rankHits(hits);
  const groups: SearchGroup[] = [];
  for (const type of SEARCH_TYPES) {
    const own = ranked.filter((h) => h.type === type);
    if (own.length === 0) continue;
    groups.push({
      type,
      label: SEARCH_TYPE_LABELS[type],
      hits: perGroup ? own.slice(0, perGroup) : own,
    });
  }
  return groups;
}
