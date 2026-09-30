/**
 * Ranking the mention palette.
 *
 * A palette is a name lookup, not a search engine: the person is typing the
 * start of something they can see in their head. So a match that begins the
 * name beats one that begins a word inside it, which beats one buried in the
 * middle, and an exact name beats all three. Everything else — which kind,
 * how recent — only breaks ties.
 *
 * Case and accents are ignored ("cafe" finds "Café"). A query of several
 * words matches when every word is found somewhere in the name, and ranks
 * below any single-run match. An empty query ranks nothing: rows keep the
 * recency order the database returned them in, per kind.
 *
 * Pure, so the rules are tested without a database.
 */
import type { ContextTokenKind } from "@/lib/chat/context-tokens";
import { MENTION_KIND_ORDER, type MentionItem } from "@/lib/mentions/types";

export const MENTION_SCORE = {
  exact: 100,
  prefix: 80,
  wordPrefix: 60,
  substring: 40,
  allWords: 30,
} as const;

/** Lower-case, accents removed, whitespace collapsed. */
export function normalizeMentionText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function wordStarts(text: string, query: string): boolean {
  // A word starts after a space or any punctuation: "q3-forecast.xlsx" has
  // words "q3", "forecast", "xlsx".
  const pattern = /[^a-z0-9]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const start = match.index + match[0].length;
    if (text.startsWith(query, start)) return true;
  }
  return false;
}

/** How well `query` matches one name, or -1 when it does not. */
export function scoreText(name: string, query: string): number {
  const text = normalizeMentionText(name);
  const q = normalizeMentionText(query);
  if (!q) return 0;
  if (!text) return -1;
  if (text === q) return MENTION_SCORE.exact;
  if (text.startsWith(q)) return MENTION_SCORE.prefix;
  if (wordStarts(text, q)) return MENTION_SCORE.wordPrefix;
  if (text.includes(q)) return MENTION_SCORE.substring;
  const words = q.split(" ").filter(Boolean);
  if (words.length > 1 && words.every((word) => text.includes(word))) return MENTION_SCORE.allWords;
  return -1;
}

/**
 * The best score across a row's names. The label counts in full; a secondary
 * name (a skill's slug, an app's id) a little less, so "gh" finds GitHub by
 * its id but a label that says "gh" still ranks first.
 */
export function scoreMention(label: string, query: string, alternates: readonly string[] = []): number {
  const primary = scoreText(label, query);
  const secondary = alternates.reduce((best, alternate) => {
    const score = scoreText(alternate, query);
    return score > 0 ? Math.max(best, score - 5) : best;
  }, -1);
  return Math.max(primary, secondary);
}

export interface MentionCandidate {
  item: Omit<MentionItem, "score">;
  /** Extra names the row answers to. */
  alternates?: readonly string[];
  /** Small nudges between rows that match equally: a connected app over one to connect. */
  boost?: number;
}

const KIND_RANK = new Map<ContextTokenKind, number>(MENTION_KIND_ORDER.map((kind, index) => [kind, index]));

/**
 * Scores, filters, caps each kind at `limitPerKind`, and orders the whole list.
 *
 * With a query: by score, then kind, then recency, then name. Without one: by
 * kind, then the order each kind's rows arrived in (their recency), so an
 * empty "@" shows the most recent few of each.
 */
export function rankMentions(candidates: readonly MentionCandidate[], query: string, limitPerKind: number): MentionItem[] {
  const hasQuery = normalizeMentionText(query).length > 0;
  const scored = candidates
    .map((candidate, arrival) => {
      const base = hasQuery ? scoreMention(candidate.item.label, query, candidate.alternates) : 0;
      return { candidate, arrival, base, score: base < 0 ? -1 : base + (candidate.boost ?? 0) };
    })
    .filter((entry) => entry.base >= 0);

  const time = (item: Omit<MentionItem, "score">) => (item.updatedAt ? Date.parse(item.updatedAt) || 0 : 0);
  scored.sort((a, b) => {
    const kindOrder = (KIND_RANK.get(a.candidate.item.kind) ?? 99) - (KIND_RANK.get(b.candidate.item.kind) ?? 99);
    if (!hasQuery) {
      if (kindOrder !== 0) return kindOrder;
      if (b.score !== a.score) return b.score - a.score;
      return a.arrival - b.arrival;
    }
    if (b.score !== a.score) return b.score - a.score;
    if (kindOrder !== 0) return kindOrder;
    const recency = time(b.candidate.item) - time(a.candidate.item);
    if (recency !== 0) return recency;
    return a.candidate.item.label.localeCompare(b.candidate.item.label);
  });

  const perKind = new Map<ContextTokenKind, number>();
  const seen = new Set<string>();
  const out: MentionItem[] = [];
  for (const entry of scored) {
    const item = entry.candidate.item;
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) continue;
    const count = perKind.get(item.kind) ?? 0;
    if (count >= limitPerKind) continue;
    seen.add(key);
    perKind.set(item.kind, count + 1);
    out.push({ ...item, score: entry.score });
  }
  return out;
}
