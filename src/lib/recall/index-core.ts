/*
 * SESSION RECALL — the pure core of full-history conversation search.
 *
 * WHAT IT REPLACES. Message bodies are AES-GCM ciphertext at rest
 * (message-crypto.ts), so Postgres full-text search cannot read them, and
 * unified search used to decrypt the 50 most recent conversations / 1,500
 * messages and grep them. Anything older was unsearchable: "what did we decide
 * about Orbit permissions in March?" could not be answered from the actual
 * conversation, only from whatever a memory summary happened to keep.
 *
 * THE INDEX. Each message becomes a set of BLIND TOKENS: every distinct
 * meaning-bearing word, HMAC'd under a key that is (a) derived from the
 * message-encryption key, so it rotates with it, and (b) different for every
 * account. The database stores those tokens, never a word. A query is
 * tokenised and HMAC'd the same way and matched with a GIN array overlap —
 * no decrypt of the corpus, no model call. Only the top candidates are
 * decrypted, to verify the words really occur (a truncated HMAC can collide)
 * and to cut the excerpt the user sees.
 *
 * WHAT IT LEAKS, honestly. Ciphertext alone reveals lengths and timestamps.
 * The token index additionally reveals, to someone holding the database but
 * not the key, which messages share a word with which, and how common each
 * (unknown) word is within that one account. Per-account keys stop correlation
 * across accounts; tokens are deduplicated per message (no term counts, no
 * positions); and the commonest English function words are never indexed.
 * It does not reveal any word. That trade is recorded in
 * docs/rework/program/MEMORY.md, with the stronger alternative (encrypted
 * per-account index shards) and why it was not chosen.
 *
 * Everything in this file is pure: the hasher is injected, so the ranking and
 * the evaluation run without keys, Postgres or node:crypto.
 */

import { significantTokens } from "@/lib/memory-lifecycle";

/** Index version: bump when tokenisation changes, so old rows are re-indexed. */
export const RECALL_INDEX_VERSION = 1;

/** Distinct tokens kept per message. A wall of pasted text is still one message. */
export const RECALL_MAX_TOKENS_PER_MESSAGE = 400;

/** Characters of a message body read for tokens. */
export const RECALL_MAX_CHARS = 24_000;

/**
 * Words too common to be evidence of anything, and too common to hide: the
 * frequency of "the" in an index is the easiest thing to recognise. Never
 * indexed and never queried. Small on purpose — over-eager stopwords cost
 * recall ("will", "can" are sometimes the point).
 */
const RECALL_STOPWORDS = new Set([
  "what", "did", "we", "about", "how", "when", "where", "who", "which", "why", "our", "my", "me",
  "i", "you", "your", "us", "can", "could", "would", "should", "will", "just", "so", "if", "or",
  "but", "not", "no", "yes", "there", "here", "then", "than", "too", "all", "any", "one", "get",
  "got", "let", "lets", "like", "know", "think", "say", "said", "tell", "told", "talk", "talked",
  "discuss", "discussed", "chat", "chats", "conversation", "remember", "again", "ago", "back",
  "please", "thanks", "thank", "ok", "okay", "im", "ive", "dont", "doesnt", "its", "thats",
]);

/**
 * The lifecycle's stems disagree on a trailing "e" ("decide" / "decided" →
 * "decide" / "decid"); recall folds it so a question's tense never decides
 * whether the answer is found.
 */
function fold(token: string): string {
  return token.length > 4 && token.endsWith("e") ? token.slice(0, -1) : token;
}

/** The distinct, meaning-bearing tokens of a text, in first-seen order. */
export function recallTokens(text: string, max: number = RECALL_MAX_TOKENS_PER_MESSAGE): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of significantTokens(text.slice(0, RECALL_MAX_CHARS))) {
    if (raw.length < 2 || RECALL_STOPWORDS.has(raw)) continue;
    const token = fold(raw);
    if (RECALL_STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Entities: words written with a capital inside a sentence ("Orbit", "Hooli",
 * "Lisbon"), or containing a digit or internal capital ("GPT5", "iOS"). Indexed
 * a second time under an "e:" namespace, so a query naming one can be ranked
 * by it without guessing at proper nouns from lowercase text.
 */
export function recallEntities(text: string, max = 60): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const body = text.slice(0, RECALL_MAX_CHARS);
  const re = /(?:^|[^\p{L}\p{N}])(\p{Lu}[\p{L}\p{N}]+|[\p{L}]*\p{N}[\p{L}\p{N}]*|\p{Ll}+\p{Lu}[\p{L}\p{N}]*)/gu;
  for (const match of body.matchAll(re)) {
    const word = match[1];
    const start = (match.index ?? 0) + match[0].length - word.length;
    // Capitalised only because a sentence starts there is not a name.
    const before = body.slice(Math.max(0, start - 2), start);
    if (/^\p{Lu}\p{Ll}+$/u.test(word) && (start === 0 || /[.!?]\s*$|\n\s*$/u.test(before))) continue;
    const [token] = recallTokens(word, 1);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= max) break;
  }
  return out;
}

/** Turns a plaintext token into the stored blind token. Injected: HMAC in production. */
export type BlindHasher = (token: string) => string;

/** The stored token set for one message: words, then entities under their namespace. */
export function blindTokensFor(text: string, hash: BlindHasher): string[] {
  const words = recallTokens(text);
  const entities = recallEntities(text);
  return [...new Set([...words.map((t) => hash(`w:${t}`)), ...entities.map((t) => hash(`e:${t}`))])];
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  couple: 2, few: 3, several: 4,
};
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };

/** "two weeks ago" → a point in time and how loosely to read it. */
export interface RecallTimeHint {
  at: Date;
  /** Half-width of the window around `at`, in days. */
  toleranceDays: number;
  /** The words that said it, removed from the lexical query. */
  phrase: string;
}

export function parseTimeHint(query: string, now: Date): RecallTimeHint | null {
  const lower = query.toLowerCase();
  const ago = /\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|couple of|few|several)\s+(day|week|month|year)s?\s+ago\b/.exec(lower);
  if (ago) {
    const n = /^\d+$/.test(ago[1]) ? Number(ago[1]) : NUMBER_WORDS[ago[1].replace(" of", "")] ?? 1;
    const days = n * UNIT_DAYS[ago[2]];
    return { at: new Date(now.getTime() - days * 86_400_000), toleranceDays: Math.max(2, days * 0.5), phrase: ago[0] };
  }
  const last = /\b(yesterday|last (week|month|year))\b/.exec(lower);
  if (last) {
    const days = last[1] === "yesterday" ? 1 : UNIT_DAYS[last[2]];
    return { at: new Date(now.getTime() - days * 86_400_000), toleranceDays: Math.max(1, days * 0.6), phrase: last[0] };
  }
  return null;
}

export interface RecallQuery {
  /** Plain tokens, for verification and excerpts. */
  words: string[];
  /** Entities the query names, for the entity boost. */
  entities: string[];
  time: RecallTimeHint | null;
}

export function parseRecallQuery(query: string, now: Date): RecallQuery {
  const time = parseTimeHint(query, now);
  const text = time ? query.replace(new RegExp(time.phrase, "i"), " ") : query;
  // Entities in a typed query are often lowercase ("orbit permissions"); every
  // word is tried as an entity too, and only scores if one was indexed.
  const words = recallTokens(text, 16);
  return { words, entities: words, time };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export interface RecallCandidate {
  messageId: string;
  conversationId: string;
  projectId: string | null;
  createdAt: Date;
  /** Which query words (plaintext, as parsed) this message's blind tokens matched. */
  matchedWords: readonly string[];
  matchedEntities: readonly string[];
  /** Distinct tokens in the message, for length normalisation. */
  tokenCount: number;
}

export interface RankOptions {
  query: RecallQuery;
  /** Messages in the account's index — the BM25 corpus size. */
  corpusSize: number;
  /** Per plaintext query word, how many indexed messages contain it. */
  documentFrequency: ReadonlyMap<string, number>;
  /** Mean distinct tokens per message. */
  meanTokenCount: number;
  /** The scope the question was asked in: its project's messages rank first. */
  projectId: string | null;
  now: Date;
}

/** Recency half-life for recall: a past chat should not lose to a newer one only for being older. */
const RECALL_RECENCY_HALF_LIFE_DAYS = 120;

/**
 * Hybrid score: BM25-style IDF over the words matched (binary term weight —
 * the index keeps no counts), length-normalised, plus entity, project, time
 * and recency evidence. Lexical evidence dominates; the rest orders near-ties
 * and lets "two weeks ago" pick the right one of three similar chats.
 */
export function scoreRecallCandidate(candidate: RecallCandidate, opts: RankOptions): number {
  const { query } = opts;
  if (query.words.length === 0) return 0;
  const k1 = 1.2;
  const b = 0.5;
  const lengthNorm = 1 - b + b * (candidate.tokenCount / Math.max(1, opts.meanTokenCount));
  let lexical = 0;
  let maxLexical = 0;
  for (const word of query.words) {
    const df = opts.documentFrequency.get(word) ?? 0;
    const idf = Math.log(1 + (opts.corpusSize - df + 0.5) / (df + 0.5));
    maxLexical += idf;
    if (candidate.matchedWords.includes(word)) lexical += (idf * (k1 + 1)) / (1 + k1 * lengthNorm);
  }
  const lexicalShare = maxLexical > 0 ? lexical / maxLexical : 0;
  const coverage = candidate.matchedWords.length / query.words.length;
  const entity = candidate.matchedEntities.length > 0 ? 0.08 * Math.min(1, candidate.matchedEntities.length / 2) : 0;
  const project = opts.projectId !== null && candidate.projectId === opts.projectId ? 0.06 : 0;
  const ageDays = Math.max(0, (opts.now.getTime() - candidate.createdAt.getTime()) / 86_400_000);
  const recency = 0.06 * Math.pow(0.5, ageDays / RECALL_RECENCY_HALF_LIFE_DAYS);
  let time = 0;
  if (query.time) {
    const offDays = Math.abs(candidate.createdAt.getTime() - query.time.at.getTime()) / 86_400_000;
    time = offDays <= query.time.toleranceDays ? 0.25 : 0.25 * Math.exp(-(offDays - query.time.toleranceDays) / query.time.toleranceDays);
  }
  return 0.6 * lexicalShare + 0.25 * coverage + entity + project + recency + time;
}

/** Least share of the query's words a candidate must contain to be shown at all. */
export function minimumCoverage(queryWords: number): number {
  if (queryWords <= 2) return queryWords;
  return Math.ceil(queryWords * 0.5);
}

export function rankRecallCandidates<T extends RecallCandidate>(candidates: readonly T[], opts: RankOptions): (T & { score: number })[] {
  const floor = minimumCoverage(opts.query.words.length);
  return candidates
    .filter((candidate) => candidate.matchedWords.length >= floor)
    .map((candidate) => ({ ...candidate, score: scoreRecallCandidate(candidate, opts) }))
    .sort((a, b) => b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime() || (a.messageId < b.messageId ? -1 : 1));
}

/** Does the decrypted body really contain the words the blind tokens claimed? (truncated-HMAC collisions) */
export function verifyRecallMatch(body: string, matchedWords: readonly string[]): string[] {
  const present = new Set(recallTokens(body, Number.MAX_SAFE_INTEGER));
  return matchedWords.filter((word) => present.has(word));
}
