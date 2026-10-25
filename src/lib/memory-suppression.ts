import { PRODUCT_NAME } from "@/lib/brand/names";
import {
  foldForTopics,
  topicOfStatement,
  topicPrefixes,
  topicRefusalMessage,
  topicWords,
  topicWordsOfFolded,
  wordsCoverTopic,
} from "@/lib/memory-topics";

/**
 * The one door every MemoryEntry write goes through.
 *
 * "Forget my old job" is stored as a SUPPRESSION entry holding the statement
 * verbatim, and it worked — for exactly one writer. `saveCandidates()` (the
 * automatic extractor) consulted the block-list; nothing else did. A manual add
 * via POST /api/memory, an applied natural-language edit via
 * /api/memory/edit/apply, and the native sync mutations `memory.create` /
 * `memory.update` all wrote straight to the table, so a forgotten statement
 * came back the moment it was typed on the web or synced from a phone. A
 * block-list that only one writer reads is not a block-list, and "forget this"
 * is a promise the product has to keep on every path or on none.
 *
 * Deliberately free of `server-only`, Prisma and SDK imports, for the same
 * reason background-provider-policy.ts is: the rule has to be unit-testable
 * without a database, and the door has to be callable both from a request
 * client and from inside a `$transaction` without either being baked in.
 */

export type MemoryEntryKind = "FACT" | "SUPPRESSION";

/** Mirrors the zod caps on every memory write route. */
export const MEMORY_CONTENT_LIMIT = 500;

/** How much of a suppression is quoted back in a refusal before it is elided. */
const QUOTED_SUPPRESSION_LIMIT = 120;

/**
 * Comparable form for matching. Punctuation, case and spacing are noise here —
 * "The user works at Acme." and "the user works at acme" are the same claim,
 * and a block-list that could be defeated by a full stop would be theatre.
 * Latin-1/Latin Extended and CJK ranges are kept so the rule is not
 * English-only.
 */
export function normalizeStatement(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9À-ɏ一-鿿]+/g, " ")
    .trim();
}

/** One block-list entry, parsed once: a topic's words, or a statement's comparable form. */
type CompiledEntry =
  | { statement: string; topic: string[]; prefixes: string[]; normalized?: undefined }
  | { statement: string; topic?: undefined; prefixes?: undefined; normalized: string };

/**
 * The block-list, parsed once for a run of checks.
 *
 * Matching one candidate against one entry is cheap; what is not cheap is
 * re-deriving every entry for every candidate. The read gate checks every fact
 * a chat turn considers (a crowded account has thousands) against every entry,
 * and recognising a topic, normalising a statement and splitting a topic into
 * words were all redone per pair: 20 entries over 2,000 facts cost a chat turn
 * about 45 ms at the median. Compiled, each entry is parsed once per call and
 * each candidate is split into words once, whatever the list's length.
 *
 * `findSuppression` and `proseCoveredBySuppression` accept either form, so a
 * single check stays a one-liner and a loop compiles once.
 */
export interface CompiledBlockList {
  readonly kind: "compiled-block-list";
  /** Entries that can match anything (an empty statement never does). */
  readonly size: number;
  readonly entries: readonly CompiledEntry[];
}

export function compileBlockList(suppressions: readonly string[] | CompiledBlockList): CompiledBlockList {
  if (!Array.isArray(suppressions)) return suppressions as CompiledBlockList;
  const entries: CompiledEntry[] = [];
  for (const statement of suppressions as readonly string[]) {
    // A TOPIC exclusion ("Anything about my divorce") is matched by the topic
    // rule — every word of the topic present in the candidate as a word — not
    // by containment of its own sentence, which no fact about the topic would
    // ever contain. See memory-topics.ts. It is still one block-list, read by
    // every writer through this module.
    const topic = topicOfStatement(statement);
    if (topic !== null) {
      const words = topicWords(topic);
      if (words.length > 0) entries.push({ statement, topic: words, prefixes: topicPrefixes(words) });
      continue;
    }
    const normalized = normalizeStatement(statement);
    if (normalized.length > 0) entries.push({ statement, normalized });
  }
  return { kind: "compiled-block-list", size: entries.length, entries };
}

/**
 * The suppression covering `candidate`, or null when nothing does.
 *
 * Containment is checked in BOTH directions on purpose. A suppression saying
 * "works at Acme" has to catch the fuller fact "The user works at Acme as a
 * staff designer", and a suppression that spells out the whole sentence has to
 * catch the terser paraphrase the model produces next week. The asymmetry cost
 * is real — a broad suppression refuses more than the user pictured — but the
 * failure modes are not equal: an over-broad refusal is visible and reversible
 * ("remember that again"), while a miss silently resurrects the one thing they
 * asked to be rid of.
 */
export function findSuppression(
  candidate: string,
  suppressions: readonly string[] | CompiledBlockList
): string | null {
  const list = compileBlockList(suppressions);
  if (list.size === 0) return null;
  const c = normalizeStatement(candidate);
  if (!c) return null;
  const topic = topicMatcher(candidate);
  for (const entry of list.entries) {
    if (entry.topic) {
      if (topic(entry)) return entry.statement;
      continue;
    }
    const n = entry.normalized;
    if (c === n || c.includes(n) || n.includes(c)) return entry.statement;
  }
  return null;
}

/**
 * The topic rule for one candidate against many topic entries: folded once,
 * split into words only when some entry's prefixes are all in the text (most
 * facts are about none of the person's excluded topics, and never split).
 */
function topicMatcher(candidate: string): (entry: { topic: string[]; prefixes: string[] }) => boolean {
  let folded: string | null = null;
  let words: string[] | null = null;
  return (entry) => {
    folded ??= foldForTopics(candidate);
    if (!entry.prefixes.every((prefix) => folded!.includes(prefix))) return false;
    words ??= topicWordsOfFolded(folded);
    return wordsCoverTopic(words, entry.topic);
  };
}

/**
 * Whether one sentence of GENERATED prose (a consolidated summary) says
 * something on the block-list — the check run over a summary before it is
 * stored, so a model that ignored "never include this" cannot put it back
 * into every chat's context.
 *
 * Narrower than `findSuppression` on purpose. A topic is matched by the topic
 * rule as everywhere else. A statement only when the sentence CONTAINS the
 * whole forgotten statement: the reverse containment that `findSuppression`
 * also accepts (a short candidate inside a long suppression) is right for a
 * terse extracted fact and wrong for prose, where a one-word sentence ("Yes.")
 * would be inside some suppression by accident and a paragraph would lose it.
 */
export function proseCoveredBySuppression(
  sentence: string,
  suppressions: readonly string[] | CompiledBlockList
): boolean {
  const list = compileBlockList(suppressions);
  if (list.size === 0) return false;
  const c = normalizeStatement(sentence);
  if (!c) return false;
  const topic = topicMatcher(sentence);
  for (const entry of list.entries) {
    if (entry.topic) {
      if (topic(entry)) return true;
      continue;
    }
    if (c.includes(entry.normalized)) return true;
  }
  return false;
}

/**
 * The sentence shown wherever a write is refused. Built here rather than at the
 * three call sites so the explanation cannot drift between the web add, the
 * applied edit and the native sync — and so it always names the statement being
 * honoured, which is the only part that tells the user what to do next.
 */
const REFUSAL_MESSAGE = {
  // Split around the quoted statement, which is the user's own text and cannot
  // be part of a translatable string. The name and the `*Message` suffix are
  // what put both halves in the i18n catalog — see
  // scripts/generate-i18n-catalog.mjs.
  lead: `You asked ${PRODUCT_NAME} to forget`,
  tail: `This wasn’t saved — tell ${PRODUCT_NAME} to remember it again if that has changed.`,
};

export function suppressionRefusalMessage(suppression: string): string {
  // A topic exclusion is refused in its own words: "not anything about my
  // divorce" tells the person which switch to look for, where quoting the
  // stored "Anything about my divorce" back as a forgotten statement does not.
  const topic = topicOfStatement(suppression);
  if (topic !== null) return topicRefusalMessage(topic);
  const quoted =
    suppression.length > QUOTED_SUPPRESSION_LIMIT
      ? `${suppression.slice(0, QUOTED_SUPPRESSION_LIMIT - 1)}…`
      : suppression;
  return `${REFUSAL_MESSAGE.lead} “${quoted}”. ${REFUSAL_MESSAGE.tail}`;
}

export type MemoryWriteRefusal =
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "suppressed"; suppression: string; message: string };

export type MemoryWriteDecision = { ok: true; content: string } | MemoryWriteRefusal;

/**
 * Decide whether `content` may be written. Pure, so the rule can be tested
 * exhaustively without a database standing in the way.
 *
 * SUPPRESSION entries are never screened against the block-list. They ARE the
 * block-list: running them through it would make "forget my old job" refuse
 * itself the second time it was asked, and would make the un-forget/re-forget
 * round trip in the memory editor impossible.
 */
export function screenMemoryWrite(opts: {
  content: string;
  kind?: MemoryEntryKind;
  suppressions: readonly string[];
}): MemoryWriteDecision {
  const content = opts.content.trim().slice(0, MEMORY_CONTENT_LIMIT);
  if (!content || !normalizeStatement(content)) return { ok: false, reason: "empty" };
  if ((opts.kind ?? "FACT") === "SUPPRESSION") return { ok: true, content };

  const suppression = findSuppression(content, opts.suppressions);
  if (suppression) {
    return {
      ok: false,
      reason: "suppressed",
      suppression,
      message: suppressionRefusalMessage(suppression),
    };
  }
  return { ok: true, content };
}

export type MemoryWriteOutcome<T> =
  | { ok: true; value: T; content: string }
  | MemoryWriteRefusal;

/**
 * Run `write` only if the content clears the block-list.
 *
 * The callback shape is what makes this a door rather than a suggestion: no
 * call site can reach the table except through the `write` argument, and that
 * argument is not invoked on a refusal. The SQL still belongs to the caller
 * because it genuinely differs — a create, an ownership-scoped `updateMany`,
 * and one of each inside a Serializable transaction — but the decision does
 * not, and now lives in exactly one place.
 *
 * `loadSuppressions` is lazy so the extra query is skipped for suppression
 * writes and for content that was empty to begin with.
 */
export async function guardedMemoryWrite<T>(opts: {
  content: string;
  kind?: MemoryEntryKind;
  loadSuppressions: () => Promise<readonly string[]>;
  write: (content: string) => Promise<T>;
}): Promise<MemoryWriteOutcome<T>> {
  const kind = opts.kind ?? "FACT";
  const trimmed = opts.content.trim().slice(0, MEMORY_CONTENT_LIMIT);
  if (!trimmed || !normalizeStatement(trimmed)) return { ok: false, reason: "empty" };

  const suppressions = kind === "SUPPRESSION" ? [] : await opts.loadSuppressions();
  const decision = screenMemoryWrite({ content: trimmed, kind, suppressions });
  if (!decision.ok) return decision;

  return { ok: true, value: await opts.write(decision.content), content: decision.content };
}
