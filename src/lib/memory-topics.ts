import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * TOPIC EXCLUSIONS — "don't remember anything about my divorce".
 *
 * A suppression ("forget that I work at Acme") names one STATEMENT, and its
 * rule is containment of that statement's words in order — right for "forget
 * this", useless for "never remember anything about X": the extractor's next
 * sentence about the divorce ("The user is going through a divorce", "The
 * user's ex-wife lives in Leeds") contains no stored statement at all, so the
 * block-list let every one of them through. The sensitive-topic switches
 * cannot help either: they are six fixed categories, and the person's topic
 * is theirs.
 *
 * A topic exclusion is stored as a SUPPRESSION row whose text is the topic
 * phrased the way a person would say it — "Anything about my divorce" — and
 * whose category is `topic`. Two consequences, both deliberate:
 *
 *   1. Every place that already honours the block-list honours topics with no
 *      second list to thread through: `findSuppression` (memory-suppression.ts)
 *      recognises the phrasing and switches to the topic rule below, so the
 *      ingestion gate, the manual-write door, the native sync door, the edit
 *      route, "forget" retirement (`factsCoveredByForget`) and retrieval all
 *      apply it the same way, by construction.
 *   2. The row reads correctly everywhere it is SHOWN without special casing:
 *      the memory page's "never remember" list, the export, the edit drafter's
 *      "[forgotten] Anything about my divorce", and the consolidation prompt's
 *      SUPPRESSED block, which a model understands as a whole topic.
 *
 * THE TOPIC RULE is word-level, not substring-level, on purpose. Substring
 * matching is what the statement rule does, and over a one-word topic it is
 * wrong in both directions: "ex" is inside "next" and "experience", and
 * "divorce" is not inside "divorcing". So both sides are reduced to words
 * (accents folded, filler and pronouns dropped, a light suffix trim) and every
 * word of the topic has to be present in the fact as a word or a close
 * inflection of one ("therapy" / "therapist", "politics" / "political").
 *
 * WHAT THIS IS NOT. It is lexical: "my divorce" does not catch "the user's
 * marriage ended" (no shared word), and the person can add "my marriage" too.
 * Like the sensitive gate, both failure modes are visible — a miss is a row
 * the person can forget on the memory page, an over-match is a fact that was
 * not kept — and a topic the person writes is narrower than one a classifier
 * guesses.
 *
 * Pure: no Prisma, no SDK, no import of the lifecycle module (which imports
 * the suppression rule, which imports this).
 */

/** `MemoryEntry.category` on a SUPPRESSION row that excludes a whole topic. */
export const TOPIC_EXCLUSION_CATEGORY = "topic";

/** Longest topic kept, in characters — a topic is a phrase, not a paragraph. */
export const TOPIC_MAX_CHARS = 80;

/**
 * "Anything about X", "never remember anything to do with X", "everything
 * regarding X", "topic: X". The lead is what makes a suppression a topic; a
 * plain statement keeps the statement rule.
 */
const TOPIC_LEAD =
  /^\s*(?:(?:please\s+)?(?:never|don['’]?t|do not|stop)\s+(?:remember(?:ing)?|keep(?:ing)?|stor(?:e|ing)|sav(?:e|ing))\s+)?(?:anything|everything|all|whatever)\s+(?:at all\s+)?(?:about|regarding|concerning|related to|relating to|to do with|on the (?:topic|subject) of|involving|around)\s+(.+?)\s*[.!]*\s*$/i;
const TOPIC_PREFIX = /^\s*(?:topic|subject)\s*:\s*(.+?)\s*[.!]*\s*$/i;

/** Words that carry no topic of their own: function words, pronouns, and the extractor's "the user". */
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "am",
  "to", "of", "in", "on", "at", "for", "with", "that", "this", "these", "those",
  "it", "its", "and", "or", "as", "by", "from", "has", "have", "had", "does", "do", "did",
  "i", "me", "my", "mine", "myself", "we", "us", "our", "ours", "you", "your", "yours",
  "he", "him", "his", "she", "her", "hers", "they", "them", "their", "theirs", "s",
  "user", "users", "anything", "everything", "about", "any", "all", "some", "stuff", "things", "thing",
]);

/** A consistent, crude suffix trim — both sides of every comparison go through it. */
function trim(word: string): string {
  if (word.length <= 3) return word;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      const base = word.slice(0, word.length - suffix.length);
      const doubled = (suffix === "ed" || suffix === "ing") && base.length > 3 && base.at(-1) === base.at(-2);
      return doubled ? base.slice(0, -1) : base;
    }
  }
  return word;
}

/** The meaning-bearing words of a phrase, folded and trimmed. */
export function topicWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9À-ɏ一-鿿]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word))
    .map(trim);
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Whether two trimmed words are the same word for topic purposes.
 *
 *   - Short words (under four letters) must match exactly: "ex" is not "exam",
 *     "art" is not "artist".
 *   - One word extending the other by at most two letters is an inflection
 *     the trim missed ("divorce" / "divorc", "worker" / "work") — but a longer
 *     extension is a different word ("mother" / "motherboard", "work" /
 *     "workout").
 *   - Two words that share a long stem and then diverge are one family
 *     ("therapy" / "therapist", "religion" / "religious", "finance" /
 *     "financial"): at least five shared letters, covering three quarters of
 *     the shorter word.
 */
export function topicWordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter < 4) return false;
  const shared = commonPrefix(a, b);
  if (shared === shorter) return Math.max(a.length, b.length) - shorter <= 2;
  return shared >= 5 && shared >= Math.ceil(0.75 * shorter);
}

/**
 * The topic a person typed, tidied: whitespace collapsed, a trailing full stop
 * dropped, clamped. Null when nothing in it names a topic ("my stuff").
 */
export function cleanTopic(raw: string): string | null {
  const text = raw.replace(/\s+/g, " ").trim().replace(/[.!?;:,]+$/, "").trim();
  if (!text) return null;
  const clamped = text.length > TOPIC_MAX_CHARS ? text.slice(0, TOPIC_MAX_CHARS).trimEnd() : text;
  return topicWords(clamped).length > 0 ? clamped : null;
}

/** The topic a block-list statement excludes, or null when it is an ordinary statement. */
export function topicOfStatement(statement: string): string | null {
  const match = TOPIC_LEAD.exec(statement) ?? TOPIC_PREFIX.exec(statement);
  return match ? cleanTopic(match[1]) : null;
}

/** The stored form of a topic exclusion — readable on every surface that lists the block-list. */
export function topicStatement(topic: string): string {
  return `Anything about ${topic}`;
}

/** Whether `content` is about `topic`: every word of the topic is in it, as a word. */
export function contentMatchesTopic(content: string, topic: string): boolean {
  const wanted = topicWords(topic);
  if (wanted.length === 0) return false;
  const have = topicWords(content);
  return wanted.every((word) => have.some((candidate) => topicWordsMatch(word, candidate)));
}

/** The first topic exclusion among `statements` that covers `content`, or null. */
export function findExcludedTopic(content: string, statements: readonly string[]): string | null {
  for (const statement of statements) {
    const topic = topicOfStatement(statement);
    if (topic !== null && contentMatchesTopic(content, topic)) return statement;
  }
  return null;
}

/** The refusal shown when a write falls under an excluded topic. */
const TOPIC_REFUSAL = {
  lead: `You asked ${PRODUCT_NAME} not to remember anything about`,
  tail: "This wasn’t saved — remove it from “Topics not remembered” on the memory page if that has changed.",
};

export function topicRefusalMessage(topic: string): string {
  return `${TOPIC_REFUSAL.lead} “${topic}”. ${TOPIC_REFUSAL.tail}`;
}

/**
 * Sentences of generated prose (a consolidated summary) that a block-list
 * entry covers, removed.
 *
 * The consolidation prompt TELLS the summarising model to leave suppressed
 * content out, and a model usually does. "Usually" is not what a person who
 * said "never remember anything about my divorce" was promised, so the output
 * is checked as well: any sentence the block-list covers is cut before the
 * summary is stored. Headings and blank lines are kept; a section left with no
 * sentence at all is dropped with its heading.
 *
 * `covers` is the block-list rule itself (findSuppression), passed in so this
 * module stays free of the suppression module it is imported by.
 */
export function scrubCoveredSentences(
  prose: string,
  covers: (sentence: string) => boolean
): { content: string; removed: number } {
  let removed = 0;
  const lines = prose.split("\n").map((line) => {
    if (/^\s*#/.test(line) || !line.trim()) return line;
    const bullet = /^(\s*(?:[-*+]|\d+[.)])\s+)/.exec(line)?.[1] ?? "";
    const body = line.slice(bullet.length);
    const sentences = body.match(/[^.!?]+(?:[.!?]+["”’)]*|$)\s*/g) ?? [body];
    const kept = sentences.filter((sentence) => {
      if (!sentence.trim()) return false;
      if (covers(sentence)) {
        removed++;
        return false;
      }
      return true;
    });
    const text = kept.join("").trim();
    return text ? `${bullet}${text}` : "";
  });
  if (removed === 0) return { content: prose, removed: 0 };
  // Drop headings whose section is now empty, then collapse blank runs.
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length || /^\s*#/.test(lines[j])) continue;
    }
    if (!line.trim() && (out.length === 0 || !out[out.length - 1].trim())) continue;
    out.push(line);
  }
  return { content: out.join("\n").trim(), removed };
}
