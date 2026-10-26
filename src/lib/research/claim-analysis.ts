/**
 * Citation validation, the deterministic half (program §8.3).
 *
 * The bar this exists to clear: of the factual claims a research report makes,
 * at least 95% must be genuinely supported by the passage they cite, and
 * anything that is not must be MARKED — not dropped, and never left wearing a
 * citation it does not deserve. A dropped claim looks like the report never
 * said it; a citation on an unsupported claim is worse than no citation at all,
 * because the reader stops checking.
 *
 * An LLM judge alone does not clear that bar. Asked "does this passage support
 * this claim?" a small utility model says yes to almost anything that shares
 * vocabulary with the passage — the failure mode is systematically optimistic,
 * which is precisely the wrong direction. So the judge is treated as one
 * signal, bounded by a deterministic audit of the things that are checkable
 * without judgement: the numbers, the dates, the quoted words, the polarity of
 * the sentence, and whether the claim smuggled in a superlative or a causal
 * story the passage never told. The audit can only ever LOWER the score. A
 * confident judge cannot talk the pipeline past a figure that is not in the
 * passage.
 *
 * Free of `server-only` and of Prisma on purpose, for the same reason
 * conversation-search is: the benchmark in tests/research-citations.test.ts
 * runs under plain `tsx --test`, which has no `react-server` condition, so a
 * `server-only` import anywhere in its module graph is a hard crash. The server
 * half — the runUtilityPrompt-backed judge and every database write — lives in
 * src/lib/research/claims.ts and re-exports this surface.
 */

import { assessSource } from "@/lib/research/source-policy";

// ---------------------------------------------------------------------------
// Shared vocabulary (mirrors the schema comments on ResearchClaim / ClaimLink)
// ---------------------------------------------------------------------------

export type ClaimType = "fact" | "statistic" | "quote" | "prediction" | "opinion";
/** ResearchClaim.status. */
export type ClaimStatus = "unverified" | "supported" | "contradicted" | "unsupported";
/** ResearchClaimLink.stance. */
export type LinkStance = "supports" | "contradicts";

/**
 * What the UI says out loud. The schema has four statuses, but "unsupported
 * with a strength of 0.55" and "unsupported with a strength of 0.05" are
 * different things to a reader — the first is a claim the passage half-makes,
 * the second is a claim the passage is not even about. The label splits them
 * without needing a fifth status column.
 */
export type SupportLabel =
  | "supported"
  | "partially supported"
  | "unsupported"
  | "contradicted"
  | "unverified";

/** At or above this, a claim's citation is honest enough to stand unqualified. */
export const SUPPORTED_MIN = 0.7;
/** Between this and SUPPORTED_MIN the passage is on topic but does not close the claim. */
export const PARTIAL_MIN = 0.4;

export function supportLabel(status: ClaimStatus, strength: number | null | undefined): SupportLabel {
  if (status === "supported") return "supported";
  if (status === "contradicted") return "contradicted";
  if (status === "unverified") return "unverified";
  return (strength ?? 0) >= PARTIAL_MIN ? "partially supported" : "unsupported";
}

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

/** Plain ASCII, which `normalizeText` has nothing to de-accent or flatten in. */
const ASCII_ONLY = /^[\x00-\x7f]*$/;

/**
 * Lowercase, de-accent, and flatten the punctuation a publisher's typography
 * differs on. Curly quotes and en dashes are the reason a verbatim quotation
 * check used to fail on genuine matches: the report is written by a model that
 * emits “ ” and the scraped page carries " ".
 */
export function normalizeText(s: string): string {
  // Plain ASCII has nothing to de-accent or flatten: the same answer, minus
  // the Unicode passes, for the word-by-word calls the figure checks make.
  if (ASCII_ONLY.test(s)) return s.toLowerCase().replace(/\s+/g, " ").trim();
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/*
 * Deliberately short. This is not a search index — the list only has to remove
 * the words that are in EVERY sentence, because overlap is used as a coverage
 * floor and a long stop list starts eating the words that carry the claim.
 */
const STOPWORDS = new Set(
  ("a an the and or but if then than that this these those of in on at to for from by with as is are was were be been being " +
    "has have had do does did will would can could may might must shall should it its their his her they he she we you i " +
    "there here about into over under between also not no more most such which who whom whose what when where while during " +
    "after before across per said says say according report reported reports")
    .split(" ")
);

/** Runs of Chinese, Japanese and Korean script, which have no spaces between words. */
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー\u3099\u309A]{2,}/gu;

/** Content words of a sentence: what is left once the grammar is thrown away. */
export function contentTokens(s: string): Set<string> {
  const out = new Set<string>();
  const normal = normalizeText(s);
  for (const raw of normal.split(/[^a-z0-9%$€£.]+/)) {
    const w = raw.replace(/^[.]+|[.]+$/g, "");
    if (w.length < 3 && !/^\d+$/.test(w)) continue;
    if (STOPWORDS.has(w)) continue;
    // Crude singularisation: "vaccines" and "vaccine" are the same evidence.
    out.add(w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
  }
  // CJK text has no word spaces: its character bigrams stand in for words,
  // so overlap and near-duplicate checks see something rather than nothing.
  // NFKD leaves these scripts intact (bar width forms), so the normalised text is used.
  for (const run of normal.match(CJK_RUN) ?? []) {
    const chars = [...run];
    for (let i = 0; i + 1 < chars.length && out.size < 400; i += 1) out.add(chars[i]! + chars[i + 1]!);
  }
  return out;
}

/** Share of the claim's content words the passage actually contains, 0..1. */
export function tokenCoverage(claim: string, passage: string): number {
  const c = contentTokens(claim);
  if (c.size === 0) return 0;
  const p = contentTokens(passage);
  let hit = 0;
  for (const t of c) if (p.has(t)) hit++;
  return hit / c.size;
}

/** `tokenCoverage` on the per-text caches: what the audit uses, where the same passage is read for many claims. */
function coverageOf(claim: string, passage: string): number {
  const c = cachedContentTokens(claim);
  if (c.size === 0) return 0;
  const p = cachedContentTokens(passage);
  let hit = 0;
  for (const t of c) if (p.has(t)) hit++;
  return hit / c.size;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export interface NumericFact {
  /** Canonical magnitude: "3.4 billion" → 3.4e9, "12%" → 12, "$4.3bn" → 4.3e9. */
  value: number;
  /** What the number measures, coarsely — enough to avoid comparing a % to a headcount. */
  kind: "percent" | "currency" | "plain";
  raw: string;
  start: number;
  end: number;
}

const SCALES: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mn: 1e6,
  million: 1e6,
  bn: 1e9,
  billion: 1e9,
  tn: 1e12,
  trillion: 1e12,
};

const NUMBER_RE =
  /(?<cur>[$€£])?\s?(?<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(?<scale>trillion|billion|million|thousand|bn|tn|mn|[kmb]\b)?\s?(?<pct>%|percent|per cent|percentage points?)?/gi;

/*
 * Reported prose spells small numbers out — "Seventy people were injured" —
 * and a validator that only reads digits is blind to exactly the sentences
 * where a transposed figure does the most damage. This lexicon is deliberately
 * small: past a few hundred, publishers switch to digits anyway.
 */
const WORD_UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const WORD_TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const WORD_SCALES: Record<string, number> = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
const WORD_NUMBER_RE = new RegExp(
  String.raw`\b(?:${[...Object.keys(WORD_UNITS), ...Object.keys(WORD_TENS), ...Object.keys(WORD_SCALES)].join("|")})(?:[- ](?:${[
    ...Object.keys(WORD_UNITS),
    ...Object.keys(WORD_TENS),
    ...Object.keys(WORD_SCALES),
  ].join("|")}))*\b`,
  "gi"
);

function evaluateWordNumber(phrase: string): number | null {
  let total = 0;
  let current = 0;
  let seen = false;
  for (const word of phrase.toLowerCase().split(/[- ]+/)) {
    if (word in WORD_UNITS) {
      current += WORD_UNITS[word];
      seen = true;
    } else if (word in WORD_TENS) {
      current += WORD_TENS[word];
      seen = true;
    } else if (word === "hundred") {
      current = (current || 1) * 100;
      seen = true;
    } else if (word in WORD_SCALES) {
      total += (current || 1) * WORD_SCALES[word];
      current = 0;
      seen = true;
    } else {
      return null;
    }
  }
  return seen ? total + current : null;
}

/**
 * Every quantity in the text, with the spans of anything that is really a date
 * removed first. Without that removal "in 2024" reads as the plain number 2024
 * and a report citing a 2023 page for a 2024 figure trips the numeric
 * MISMATCH rule instead of the date rule — same verdict for the wrong reason,
 * and a wrong reason is what a reader sees when they open the inspector.
 */
export function extractNumbers(text: string, skip: ReadonlyArray<{ start: number; end: number }> = []): NumericFact[] {
  const out: NumericFact[] = [];
  const blocked = (start: number, end: number) => skip.some((s) => start < s.end && end > s.start);
  NUMBER_RE.lastIndex = 0;
  for (let m = NUMBER_RE.exec(text); m; m = NUMBER_RE.exec(text)) {
    const g = m.groups ?? {};
    if (!g.num) continue;
    const start = m.index;
    const end = m.index + m[0].length;
    if (blocked(start, end)) continue;
    const base = Number(g.num.replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    const scale = g.scale ? SCALES[g.scale.toLowerCase()] ?? 1 : 1;
    out.push({
      value: base * scale,
      kind: g.pct ? "percent" : g.cur ? "currency" : "plain",
      raw: m[0].trim(),
      start,
      end,
    });
  }
  WORD_NUMBER_RE.lastIndex = 0;
  for (let m = WORD_NUMBER_RE.exec(text); m; m = WORD_NUMBER_RE.exec(text)) {
    const start = m.index;
    const end = start + m[0].length;
    // A spelled scale word already consumed by the digit pass ("3.4 million")
    // must not be counted a second time as the bare word "million".
    if (blocked(start, end) || out.some((n) => start < n.end && end > n.start)) continue;
    const value = evaluateWordNumber(m[0]);
    if (value === null) continue;
    out.push({ value, kind: "plain", raw: m[0], start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * What a figure is measuring, approximated from the words around it: the noun
 * it counts, and the phrase that introduced it.
 *
 * This exists because "the passage gives a different number" is only a
 * CONTRADICTION when the two numbers measure the same thing. A page saying "the
 * union represents drivers at the three largest depots" contains the number
 * three; a claim saying the union has 45,000 members is unsupported by it, not
 * contradicted by it, and calling that a contradiction puts a false accusation
 * in the inspector.
 */
function numberContext(
  text: string,
  n: NumericFact
): { unit: string | null; next: string | null; before: Set<string> } {
  const memo = figureMemo(text, n);
  memo.context ??= readNumberContext(text, n);
  return memo.context;
}

function readNumberContext(
  text: string,
  n: NumericFact
): { unit: string | null; next: string | null; before: Set<string> } {
  /*
   * The unit is the first WORD after the figure, stopwords aside. Read from
   * the raw words rather than `contentTokens`, which drops anything under
   * three letters as noise — and with it exactly the units figures are
   * measured in: "16.5 GW" and "15.1 GW" had no unit at all, so two totals
   * for the same fleet read as unrelated numbers and a real disagreement was
   * filed as a figure merely "absent".
   */
  const words = normalizeText(text.slice(n.end, n.end + 40))
    .split(/[^a-z]+/)
    .filter((w) => w && !STOPWORDS.has(w));
  const stem = (w: string | undefined) => (w ? (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w) : null);
  return {
    unit: stem(words[0]),
    next: stem(words[1]),
    before: contentTokens(text.slice(Math.max(0, n.start - 48), n.start)),
  };
}

/** Units that say how long, not what: "30-day version history" and "14-day trial" share one and measure different things. */
const PERIOD_UNITS = new Set(["second", "minute", "hour", "day", "week", "month", "year", "quarter"]);

/*
 * Words passed over when looking for the noun a figure is measured on: the
 * verbs that report a figure ("revenue ROSE to", "capacity STOOD at"), the
 * prepositions and hedges in front of it, and the scope words that do not
 * change what is measured ("TOTAL revenue", "revenue for the YEAR"). Short on
 * purpose — a word missing from it is read as the measured noun, or as its
 * qualifier when what precedes it says so (`qualifiesHead`: "the company
 * BOOKED revenue" is a verb, "its LOGISTICS revenue" a qualifier), and the
 * check it feeds can only take a contradiction away, never add one. It is
 * never what lets another cited source stand in for a passage: that gate
 * does not trust these guesses (see `namesOtherSubject`).
 */
const FIGURE_SUBJECT_SKIP = new Set(
  (
    "stood stand stands reached reach reaches rose rise rises risen grew grow grows grown fell fall falls fallen " +
    "climbed climb climbs dropped drop drops declined decline declines totalled totaled total totals amounted amount amounts " +
    "came come comes hit hits increased increase increases decreased decrease decreases jumped jump jumps slipped slip slips " +
    "edged edge edges put puts cost costs raised raise raises earned earn earns posted post posts generated generate generates " +
    "recorded record records hold holds held keep keeps kept cut cuts include includes included contributed contribute contributes " +
    "accounted accounting account accounts represented represent represents made make makes employed employ employs ended ending " +
    "reduced reduce reduces lowered lower lowers boosted boost boosts doubled tripled halved gained gain gains lost lose loses " +
    "sank soared surged plunged tumbled expanded shrank contracted averaged average averages exceeded topped surpassed " +
    "showed show shows saw see sees found find finds stated state states estimated " +
    "against versus toward towards via around nearly almost roughly approximately just only some any up down out off least less " +
    "every each all both our " +
    "overall annual yearly group consolidated combined full whole entire fiscal financial year quarter month period half mid " +
    "first second third fourth final last latest previous prior quarterly monthly " +
    "thousand million billion trillion percent cent " +
    "january february march april june july august september october november december"
  ).split(" ")
);

/** A word as `contentTokens` would store it: lowercased, de-accented, crudely singular. */
function tokenForm(word: string): string {
  const w = normalizeText(word).replace(/['’]s$|['’]$/, "");
  return w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

const WORD_RE = /\p{L}+(?:['’]\p{L}+)*['’]?/gu;

/** Every word of a text in `tokenForm`, short ones included ("EU", "UK"). */
function wordForms(text: string): Set<string> {
  const facts = textFacts(text);
  facts.words ??= new Set((text.match(WORD_RE) ?? []).map(tokenForm));
  return facts.words;
}

/** Where a clause or a sentence ends, as [start, end) offsets in the text, in reading order. */
type Edges = ReadonlyArray<readonly [number, number]>;

/** A figure's own clause, and where its sentence starts (see `figureScope`). */
interface FigureScope {
  clauseStart: number;
  clauseEnd: number;
  sentenceStart: number;
}

/*
 * What the checks read from one text, worked out once per text. The audit
 * compares every figure of a claim with every figure of a passage, and the
 * same passage is audited for several claims (and again by the judge step):
 * re-deriving a passage's words, dates and clause edges for every pair of
 * figures — each a scan of the text before the figure — made one audit of a
 * long page quadratic in its length. Everything here is a pure function of
 * the text; a figure is keyed by its offset, which names one figure of one
 * text. Bounded, oldest out: the texts of the claims and passages being
 * audited, not of a process lifetime.
 */
interface TextFacts {
  dates: DateMention[] | null;
  numbers: NumericFact[] | null;
  words: Set<string> | null;
  tokens: Set<string> | null;
  clauseEdges: Edges | null;
  sentenceEdges: Edges | null;
  /** Per figure, by its offset. */
  figures: Map<number, FigureMemo> | null;
  lowercase: Set<string> | null;
  nameEvidence: NameEvidence | null;
}

/** What one figure of a text has been read as, filled in as each check asks. */
interface FigureMemo {
  scope?: FigureScope;
  clause?: { words: ClauseWord[]; headAt: number };
  /** Undefined until read; null when the figure has no date. */
  date?: DateMention | null;
  grain?: FigureGrain;
  context?: { unit: string | null; next: string | null; before: Set<string> };
  named?: NamedSubject;
}

function figureMemo(text: string, n: NumericFact): FigureMemo {
  const facts = textFacts(text);
  facts.figures ??= new Map();
  let memo = facts.figures.get(n.start);
  if (!memo) {
    memo = {};
    facts.figures.set(n.start, memo);
  }
  return memo;
}

/** At most this many texts, and this many characters of them (a 60k-character page's facts are about a megabyte). */
const TEXT_FACTS_LIMIT = 256;
const TEXT_FACTS_CHARS = 2_000_000;
const TEXT_FACTS = new Map<string, TextFacts>();
let textFactsChars = 0;
let lastFacts: { text: string; facts: TextFacts } | null = null;

function textFacts(text: string): TextFacts {
  if (lastFacts?.text === text) return lastFacts.facts;
  const hit = TEXT_FACTS.get(text);
  if (hit) {
    // Most recently used last, so the oldest is the one dropped.
    TEXT_FACTS.delete(text);
    TEXT_FACTS.set(text, hit);
    lastFacts = { text, facts: hit };
    return hit;
  }
  const facts: TextFacts = {
    dates: null,
    numbers: null,
    words: null,
    tokens: null,
    clauseEdges: null,
    sentenceEdges: null,
    figures: null,
    lowercase: null,
    nameEvidence: null,
  };
  while (TEXT_FACTS.size > 0 && (TEXT_FACTS.size >= TEXT_FACTS_LIMIT || textFactsChars + text.length > TEXT_FACTS_CHARS)) {
    const oldest = TEXT_FACTS.keys().next().value!;
    TEXT_FACTS.delete(oldest);
    textFactsChars -= oldest.length;
  }
  TEXT_FACTS.set(text, facts);
  textFactsChars += text.length;
  lastFacts = { text, facts };
  return facts;
}

/** The dates of a text, and its figures with those dates left out: what `auditEvidence` reads on both sides. */
function figuresOf(text: string): { dates: DateMention[]; numbers: NumericFact[] } {
  const facts = textFacts(text);
  facts.dates ??= extractDates(text);
  facts.numbers ??= extractNumbers(text, facts.dates);
  return { dates: facts.dates, numbers: facts.numbers };
}

/** `contentTokens`, once per text. Callers must not change the set. */
function cachedContentTokens(text: string): Set<string> {
  const facts = textFacts(text);
  facts.tokens ??= contentTokens(text);
  return facts.tokens;
}

function edgesOf(text: string, edge: RegExp): Edges {
  return [...text.matchAll(edge)].map((m) => [m.index, m.index + m[0].length] as const);
}

/** Where the last edge before `at` ends, or 0: the start of the clause (or sentence) holding `at`. */
function edgeEndBefore(edges: Edges, at: number): number {
  let lo = 0;
  let hi = edges.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (edges[mid]![0] < at) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found < 0 ? 0 : Math.min(edges[found]![1], at);
}

/** Where the first edge at or after `at` starts, or the text's length. */
function edgeStartFrom(edges: Edges, at: number, length: number): number {
  let lo = 0;
  let hi = edges.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (edges[mid]![0] >= at) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found < 0 ? length : edges[found]![0];
}

/** Words that never name what a figure measures: days, and the day a thing was said. */
const NOT_A_SUBJECT = new Set(
  "monday tuesday wednesday thursday friday saturday sunday today yesterday tomorrow tonight".split(" ")
);
/** Determiners and possessive pronouns: the word after one opens a noun phrase. */
const DETERMINERS = new Set("the a an its their our his her this that these those".split(" "));
/** Prepositions: a name after one is that preposition's object ("in London", "to the SEC"), not a figure's subject. */
const PREPOSITIONS = new Set(
  "of in on at to for from by with into onto over under about across against among between during after before since until via per toward towards around near inside outside within without".split(" ")
);
/** Verbs that take a person as their object: "told Reuters", "informed investors". */
const TELLING_VERBS = new Set("told tell tells telling informed inform informs briefed brief briefs".split(" "));
/** Verbs that open a reported clause: what follows one starts that clause ("said logistics revenue was"). */
const REPORTING_VERBS = new Set(
  ("said say says saying reported report reports noted note notes stated state states announced announce announces " +
    "showed show shows found find finds estimated estimate estimates disclosed disclose discloses confirmed confirm confirms " +
    "added adds wrote writes revealed reveals according")
    .split(" ")
);
/** A company name's legal or group suffix: "Northwind Group" is still Northwind. */
const CORPORATE_SUFFIXES = new Set(
  "group inc incorporated corp corporation co company ltd limited plc llc lp ag sa nv se gmbh holdings holding international".split(" ")
);
/**
 * Words that end an organisation's name and never a measure's: with one,
 * a run of title-case words is a name on its own evidence ("Contoso Labs
 * earned $3.0bn"). An allow-list, so a word missing from it only means
 * the run needs other evidence (`readFigureNamedSubject`).
 */
const NAME_SUFFIXES = new Set(
  ("group inc incorporated corp corporation co company ltd limited plc llc lp ag sa nv se gmbh " +
    "labs laboratories technologies industries airlines airways motors pharmaceuticals therapeutics bancorp")
    .split(" ")
);

interface ClauseWord {
  raw: string;
  /** Offset in the whole text. */
  start: number;
  end: number;
}

/**
 * The words of a figure's own clause before it, and which of them is the
 * noun it is measured on: read backwards from the figure, past the verbs,
 * prepositions and scope words of FIGURE_SUBJECT_SKIP. `headAt` is -1 when
 * the clause opens with the figure.
 */
function figureClause(text: string, n: NumericFact): { words: ClauseWord[]; headAt: number } {
  const memo = figureMemo(text, n);
  if (memo.clause) return memo.clause;
  const { clauseStart } = figureScope(text, n);
  const words = [...text.slice(clauseStart, n.start).matchAll(WORD_RE)].map((m) => ({
    raw: m[0],
    start: clauseStart + m.index,
    end: clauseStart + m.index + m[0].length,
  }));
  let i = words.length - 1;
  while (i >= 0 && skippedForSubject(words[i]!.raw)) i -= 1;
  memo.clause = { words, headAt: i };
  return memo.clause;
}

function skippedForSubject(raw: string): boolean {
  const form = tokenForm(raw);
  return form.length < 3 || STOPWORDS.has(form) || FIGURE_SUBJECT_SKIP.has(form) || NOT_A_SUBJECT.has(form);
}

const isPossessive = (raw: string) => /['’]s?$/.test(raw);
const isTitleCase = (raw: string) => /^\p{Lu}/u.test(raw);
const isAcronym = (raw: string) => /^\p{Lu}{2,}$/u.test(raw);

/**
 * Whether `words[at]`, the word in front of the measured noun, is a word that
 * qualifies it — read from what comes before it, because the word itself is
 * as often a verb or an object as a modifier:
 *
 *  - "Northwind's logistics revenue", "its cloud revenue", "growth in cloud
 *    revenue", "posted logistics revenue", "Logistics revenue was": after a
 *    possessive, a determiner, a preposition, a figure verb or at the start
 *    of the clause, a lowercase word modifies the noun;
 *  - "the company BOOKED revenue", "Northwind LOGGED revenue": after a noun
 *    or a name it is the verb, and qualifies nothing;
 *  - "EU revenue", "Northwind's EU revenue", "said EU revenue was": a name
 *    or an acronym qualifies at the start of the clause or after a
 *    possessive or a determiner, an acronym also after a reporting verb;
 *  - "told REUTERS revenue was", "said MONDAY revenue", "in LONDON revenue",
 *    "reported to the SEC revenue": a name after a verb or a preposition is
 *    that word's object, not part of the subject.
 */
function qualifiesHead(text: string, words: readonly ClauseWord[], at: number): boolean {
  const word = words[at];
  if (!word || isPossessive(word.raw)) return false;
  if (skippedForSubject(word.raw) && !isAcronym(word.raw)) return false;
  const before = words[at - 1];
  // A figure or a year between the two ("In 2024 logistics revenue") is a boundary.
  if (!before || /\d/.test(text.slice(before.end, word.start))) return true;
  if (isPossessive(before.raw)) return true;
  const b = before.raw.toLowerCase();
  if (DETERMINERS.has(b)) {
    const ahead = words[at - 2]?.raw.toLowerCase();
    return !isTitleCase(word.raw) || !ahead || !(PREPOSITIONS.has(ahead) || TELLING_VERBS.has(ahead));
  }
  if (isTitleCase(word.raw)) return isAcronym(word.raw) && REPORTING_VERBS.has(b);
  return PREPOSITIONS.has(b) || REPORTING_VERBS.has(b) || STOPWORDS.has(b) || FIGURE_SUBJECT_SKIP.has(tokenForm(b));
}

/**
 * The noun a figure is measured on, read backwards from the figure within its
 * own clause, and the word directly in front of that noun when it qualifies
 * it (`qualifiesHead`): "Northwind's logistics revenue was $1.8bn" →
 * revenue, qualified by "logistics". A possessive owner ("the company's
 * revenue"), a determiner and a verb ("the company booked revenue") are not
 * qualifiers. Null head when the clause opens with the figure.
 */
function figureSubject(text: string, n: NumericFact): { head: string | null; qualifier: string | null } {
  const { words, headAt } = figureClause(text, n);
  if (headAt < 0) return { head: null, qualifier: null };
  const head = tokenForm(words[headAt]!.raw);
  return { head, qualifier: qualifiesHead(text, words, headAt - 1) ? tokenForm(words[headAt - 1]!.raw) : null };
}

/** A figure's named subject (`figureNamedSubject`). */
interface NamedSubject {
  /** In `tokenForm`, a corporate suffix dropped; empty when the figure names no subject. */
  words: string[];
  /**
   * Why the run reads as a name: it owns the measured noun ("Contoso's"),
   * ends in an organisation's suffix (NAME_SUFFIXES), or — "elsewhere" —
   * these words of it are names elsewhere in the passage in another run.
   */
  evidence: "possessive" | "suffix" | { elsewhere: string[] };
}

const NO_NAMED_SUBJECT: NamedSubject = { words: [], evidence: { elsewhere: [] } };

/**
 * The name the passage makes a figure's subject, as `tokenForm` words, and
 * the evidence that it is a name; no words when it names none. Two shapes
 * only:
 *
 *  - the measured noun is itself a name, or ends one: "Alpha Free includes
 *    5 GB", "while Contoso Labs earned $3.0bn" — a run of title-case words
 *    directly before the figure's verb, not the object of a verb or a
 *    preposition ("told Reuters it made $3.9bn") and not one word opening a
 *    sentence, where any word is title case ("Revenue reached $4.3bn");
 *  - a possessive owner of the measured noun: "Alpha's revenue was $3.9bn",
 *    "Alpha Pro's cloud revenue".
 *
 * A legal or group suffix is dropped ("Northwind Group" is Northwind).
 *
 * This answer is what lets another cited source's figure stand in for this
 * passage's (`namesOtherSubject`), and title case alone is no evidence of a
 * name: a measure is title case as often ("put Top Line at $3.9bn", "the
 * company's Capital Expenditure came to", "Gross Written Premiums of"), and
 * no list of measure nouns is ever complete. So a run counts only on
 * evidence that does not rest on its own capitals (`NamedSubject.evidence`):
 * it is a possessive owner, it ends in an organisation's suffix, or one of
 * its words is a name elsewhere in the passage in ANOTHER run of words —
 * "Alpha Free" beside "Alpha Pro", which `namesOtherSubject` accepts only
 * when the claim writes that word as a name too. The same run written again
 * is no evidence (a text that capitalises a measure capitalises it every
 * time), and neither is a family of capitalised measures the claim never
 * names ("Gross Receipts" beside "Gross Proceeds").
 *
 * Also no name, whatever the evidence:
 *
 *  - a run ending in a common noun ("Global Revenue was", "Company's
 *    revenue", "Its Revenue"): COMMON_SUBJECT_NOUNS, or a word the passage
 *    itself uses in lowercase (`isCommonNoun`; the claim is checked by the
 *    caller);
 *  - anything in a headline-style sentence ("Global Revenue Was $3.9 Billion
 *    In 2024."), where every word is capitalised (`isHeadline`).
 */
function figureNamedSubject(text: string, n: NumericFact): NamedSubject {
  const memo = figureMemo(text, n);
  memo.named ??= readFigureNamedSubject(text, n);
  return memo.named;
}

function readFigureNamedSubject(text: string, n: NumericFact): NamedSubject {
  const { words, headAt } = figureClause(text, n);
  if (headAt < 0) return NO_NAMED_SUBJECT;
  if (inHeadline(text, n.start)) return NO_NAMED_SUBJECT;
  const nameRun = (end: number, possessive = false): NamedSubject => {
    let start = end;
    while (start > 0) {
      const prev = words[start - 1]!;
      if (!isTitleCase(prev.raw) || /\S/.test(text.slice(prev.end, words[start]!.start))) break;
      const form = tokenForm(prev.raw);
      if (STOPWORDS.has(form) || SENTENCE_STARTERS.has(form) || NOT_A_SUBJECT.has(form)) break;
      start -= 1;
    }
    const run = words.slice(start, end + 1);
    if (run.some((w) => NOT_A_SUBJECT.has(tokenForm(w.raw)))) return NO_NAMED_SUBJECT;
    // One title-case word opening a sentence may be any noun; as a possessive owner it is a name.
    if (run.length === 1 && !possessive && opensSentence(text, run[0]!.start)) return NO_NAMED_SUBJECT;
    const before = words[start - 1]?.raw.toLowerCase();
    if (before && (PREPOSITIONS.has(before) || TELLING_VERBS.has(before) || REPORTING_VERBS.has(before))) return NO_NAMED_SUBJECT;
    const forms = run.map((w) => tokenForm(w.raw));
    // The suffix may close the run, or follow it where it is read as a scope word ("Contoso Group earned": GROUP is skipped).
    const after = words[end + 1];
    const suffixed =
      (forms.length > 1 && NAME_SUFFIXES.has(forms[forms.length - 1]!)) ||
      (!possessive &&
        after !== undefined &&
        isTitleCase(after.raw) &&
        NAME_SUFFIXES.has(tokenForm(after.raw)) &&
        !/\S/.test(text.slice(words[end]!.end, after.start)));
    while (forms.length > 1 && CORPORATE_SUFFIXES.has(forms[forms.length - 1]!)) forms.pop();
    if (isCommonNoun(text, forms[forms.length - 1]!)) return NO_NAMED_SUBJECT;
    if (possessive) return { words: forms, evidence: "possessive" };
    if (suffixed) return { words: forms, evidence: "suffix" };
    const runStart = run[0]!.start;
    const runEnd = run[run.length - 1]!.end;
    const key = nameEvidence(text).runAt.get(run[run.length - 1]!.start) ?? forms.join(" ");
    const elsewhere = run.map((w) => tokenForm(w.raw)).filter((form) => namedElsewhere(text, form, runStart, runEnd, key));
    return elsewhere.length > 0 ? { words: forms, evidence: { elsewhere } } : NO_NAMED_SUBJECT;
  };
  const head = words[headAt]!;
  if (isTitleCase(head.raw)) return nameRun(headAt);
  // A possessive owner, directly before the noun or before its qualifier.
  for (const at of [headAt - 1, headAt - 2]) {
    const owner = words[at];
    if (!owner) break;
    if (isPossessive(owner.raw)) return isTitleCase(owner.raw) ? nameRun(at, true) : NO_NAMED_SUBJECT;
    if (at === headAt - 1 && !qualifiesHead(text, words, at)) break;
  }
  return NO_NAMED_SUBJECT;
}

/*
 * Nouns a figure is measured on, and the common nouns that open a sentence
 * or fill a headline in title case: never a name, however they are cased
 * ("Global Revenue Was $3.9 Billion", "Company's revenue", "Group Sales").
 * In `tokenForm`: lowercase and crudely singular.
 */
const COMMON_SUBJECT_NOUNS = new Set(
  ("revenue sale income profit earning loss margin turnover ebitda ebit cost expense spending budget price fee value valuation " +
    "growth output production capacity demand supply share stake population headcount employee staff worker user customer " +
    "subscriber member visitor download order shipment delivery volume traffic asset debt cash funding investment " +
    "dividend rate tax wage salary payroll emission export import deficit surplus gdp inflation unemployment result figure " +
    "total company firm business industry sector market country nation state city region government group division segment unit")
    .split(" ")
);

/** Every word a text uses in lowercase somewhere, in `tokenForm`. */
function lowercaseForms(text: string): Set<string> {
  const facts = textFacts(text);
  facts.lowercase ??= new Set((text.match(WORD_RE) ?? []).filter((w) => !/\p{Lu}/u.test(w)).map(tokenForm));
  return facts.lowercase;
}

/** Whether a word (in `tokenForm`) is a common noun rather than a name: a known one, or one the text writes in lowercase. */
function isCommonNoun(text: string, form: string): boolean {
  return COMMON_SUBJECT_NOUNS.has(form) || lowercaseForms(text).has(form);
}

/** Title-case function words, scale words and figure verbs: in mid-sentence, only a headline capitalises them. */
const HEADLINE_WORDS = new Set(
  [...STOPWORDS].filter((w) => w !== "i").concat(
    ("thousand million billion trillion percent rose rise rises fell fall falls grew grow grows hit hits reached reach reaches " +
      "totalled totaled totals topped tops jumped jumps climbed climbs dropped drops declined declines surged surges soared soars " +
      "slumped slumps plunged plunges increased increases decreased decreases came comes stood stands").split(" ")
  )
);

/**
 * Whether a sentence is written as a headline: two or more mid-sentence
 * words only a headline capitalises ("Was", "In", "Billion"), or nearly every
 * word after the first in title case. Its title case says nothing about
 * names.
 */
function isHeadline(sentence: string): boolean {
  const words = (sentence.match(WORD_RE) ?? []).slice(1);
  if (words.length === 0) return false;
  let headlineWords = 0;
  let titled = 0;
  for (const word of words) {
    if (!isTitleCase(word)) continue;
    titled += 1;
    if (HEADLINE_WORDS.has(word.toLowerCase())) headlineWords += 1;
  }
  return headlineWords >= 2 || (words.length >= 3 && titled / words.length >= 0.75);
}

/** The sentences of a text as [start, end) spans, by FIGURE_SENTENCE_EDGE. */
function sentenceSpans(text: string): Edges {
  const facts = textFacts(text);
  facts.sentenceEdges ??= edgesOf(text, FIGURE_SENTENCE_EDGE);
  const spans: Array<readonly [number, number]> = [];
  let start = 0;
  for (const [edgeStart, edgeEnd] of facts.sentenceEdges) {
    spans.push([start, edgeStart + 1]);
    start = edgeEnd;
  }
  if (start < text.length) spans.push([start, text.length]);
  return spans;
}

/** Where a word that reads as a name stands, and the run of title-case words it is part of. */
interface NameMention {
  start: number;
  end: number;
  /** The run's words in `tokenForm`, function words left out: "the European Central Bank" → "european central bank". */
  run: string;
}

interface NameEvidence {
  names: Map<string, NameMention[]>;
  /** Per title-case word, by its offset: the run it is part of (`NameMention.run`). */
  runAt: Map<number, string>;
  headlines: Edges;
}

/**
 * Per text: the headline sentences, and where each word that reads as a name
 * stands — title case outside a headline, and either mid-sentence or
 * directly followed by another title-case word ("Alpha Pro costs $20"). A
 * word opening a sentence on its own is no evidence: any word is title case
 * there.
 */
function nameEvidence(text: string): NameEvidence {
  const facts = textFacts(text);
  if (facts.nameEvidence) return facts.nameEvidence;
  const names = new Map<string, NameMention[]>();
  const runAt = new Map<number, string>();
  const headlines: Array<readonly [number, number]> = [];
  for (const [start, end] of sentenceSpans(text)) {
    const sentence = text.slice(start, end);
    if (isHeadline(sentence)) {
      headlines.push([start, end]);
      continue;
    }
    const words = [...sentence.matchAll(WORD_RE)];
    // Runs of title-case words with nothing but spaces between them.
    const runOf: string[] = new Array(words.length).fill("");
    for (let i = 0; i < words.length; ) {
      if (!isTitleCase(words[i]![0])) {
        i += 1;
        continue;
      }
      let j = i + 1;
      while (
        j < words.length &&
        isTitleCase(words[j]![0]) &&
        !/\S/.test(sentence.slice(words[j - 1]!.index + words[j - 1]![0].length, words[j]!.index))
      ) {
        j += 1;
      }
      const key = words
        .slice(i, j)
        .map((m) => tokenForm(m[0]))
        .filter((form) => !STOPWORDS.has(form) && !SENTENCE_STARTERS.has(form))
        .join(" ");
      for (let k = i; k < j; k += 1) {
        runOf[k] = key;
        runAt.set(start + words[k]!.index, key);
      }
      i = j;
    }
    words.forEach((m, i) => {
      if (!isTitleCase(m[0])) return;
      const form = tokenForm(m[0]);
      if (form.length < 2 || STOPWORDS.has(form) || SENTENCE_STARTERS.has(form) || NOT_A_SUBJECT.has(form)) return;
      if (isCommonNoun(text, form)) return;
      const at = start + m.index;
      const next = words[i + 1];
      const joined = next && isTitleCase(next[0]) && !/\S/.test(sentence.slice(m.index + m[0].length, next.index));
      if (opensSentence(text, at) && !joined) return;
      const list = names.get(form) ?? [];
      list.push({ start: at, end: at + m[0].length, run: runOf[i]! });
      names.set(form, list);
    });
  }
  facts.nameEvidence = { names, runAt, headlines };
  return facts.nameEvidence;
}

/**
 * Whether `form` reads as a name somewhere in the text outside [from, to),
 * in a run of words other than `run`: the same run written again is not
 * independent evidence (`readFigureNamedSubject`).
 */
function namedElsewhere(text: string, form: string, from: number, to: number, run: string): boolean {
  return (nameEvidence(text).names.get(form) ?? []).some((mention) => (mention.end <= from || mention.start >= to) && mention.run !== run);
}

/** Whether offset `at` lies in a headline-style sentence (`isHeadline`). */
function inHeadline(text: string, at: number): boolean {
  return nameEvidence(text).headlines.some(([start, end]) => at >= start && at < end);
}

/**
 * Whether two figures are about the same subject: neither side measures a
 * noun the other never mentions, and neither narrows the measured noun with a
 * word the other never uses. "Northwind's revenue was $4.3bn" against
 * "Northwind's logistics revenue was $1.8bn" fails it — that is a segment, not
 * a rival total — while "installed capacity stood at 15.1 GW" against
 * "installed capacity reached 16.5 GW" passes.
 */
function sameSubject(claim: string, a: NumericFact, passage: string, b: NumericFact): boolean {
  const sa = figureSubject(claim, a);
  const sb = figureSubject(passage, b);
  if (!sa.head && !sb.head) return true;
  const claimTokens = wordForms(claim);
  const passageTokens = wordForms(passage);
  if (sb.head && !claimTokens.has(sb.head)) return false;
  if (sa.head && !passageTokens.has(sa.head)) return false;
  if (sb.qualifier && !claimTokens.has(sb.qualifier)) return false;
  if (sa.qualifier && !passageTokens.has(sa.qualifier)) return false;
  return true;
}

/** Whether two figures are plausibly measuring the same quantity, about the same subject, over the same length of period. */
function measuresSameThing(
  claim: { text: string; dates: readonly DateMention[] },
  a: NumericFact,
  passage: { text: string; dates: readonly DateMention[] },
  b: NumericFact
): boolean {
  return (
    sameSubject(claim.text, a, passage.text, b) &&
    sameQuantity(claim.text, a, passage.text, b) &&
    sameGrain(figureGrain(claim.text, a, claim.dates), figureGrain(passage.text, b, passage.dates))
  );
}

/**
 * Whether the passage pins a figure on a NAMED subject the claim never
 * mentions: "Alpha Free includes 5 GB", against a claim about Alpha Pro and
 * Beta Plus. Only a name the passage makes the figure's subject counts
 * (`figureNamedSubject`): the name that IS the measured noun, or its
 * possessive owner. A title-case word that merely sits in front of the
 * measured noun is not one: "told Reuters revenue was", "said Monday revenue
 * was", "Speaking in London revenue was" name who was told, when and where,
 * and the figure is still the claim's subject's. Nor is a verb read as a
 * qualifier ("the company BOOKED revenue of $3.9bn"), a common noun that
 * opens a sentence ("Sales were $3.9bn") or a lowercase subject ("the free
 * plan").
 */
function namesOtherSubject(claim: string, passage: string, p: NumericFact): boolean {
  const { words: name, evidence } = figureNamedSubject(passage, p);
  if (name.length === 0) return false;
  // A run ending in a word the claim writes in lowercase ends in a common noun ("Cloud Revenue" against "revenue").
  if (lowercaseForms(claim).has(name[name.length - 1]!)) return false;
  // A word shared with another run is a family name only when the claim names that family too: "Alpha Free" beside "Alpha Pro".
  if (typeof evidence === "object" && !evidence.elsewhere.some((word) => titleCaseForms(claim).has(word))) return false;
  const claimWords = wordForms(claim);
  return name.some((word) => !claimWords.has(word));
}

/** Every word a text writes in title case, in `tokenForm`. */
function titleCaseForms(text: string): Set<string> {
  return new Set((text.match(WORD_RE) ?? []).filter(isTitleCase).map(tokenForm));
}

/** Where a clause ends, and where a sentence ends, for `figureDate`. */
const FIGURE_CLAUSE_EDGE = /[,;:.!?]\s+|\s[-–—]\s/g;
const FIGURE_SENTENCE_EDGE = /[.!?]\s+/g;

/** The figure's own clause, and where its sentence starts: what `figureDate`, `figureGrain` and `figureRelativePeriod` read. */
function figureScope(text: string, n: NumericFact): FigureScope {
  const memo = figureMemo(text, n);
  if (memo.scope) return memo.scope;
  const facts = textFacts(text);
  facts.clauseEdges ??= edgesOf(text, FIGURE_CLAUSE_EDGE);
  facts.sentenceEdges ??= edgesOf(text, FIGURE_SENTENCE_EDGE);
  memo.scope = {
    clauseStart: edgeEndBefore(facts.clauseEdges, n.start),
    clauseEnd: edgeStartFrom(facts.clauseEdges, n.end, text.length),
    sentenceStart: edgeEndBefore(facts.sentenceEdges, n.start),
  };
  return memo.scope;
}

/**
 * The date a figure is given for: the nearest date in its own clause
 * ("$3.9 billion in 2023"), else the nearest one before it in its sentence
 * ("In 2024, revenue was $4.3 billion, …"). Null when neither holds one: a
 * date later in the sentence is as often the date of something else ("…,
 * the highest since 2019") as the figure's own.
 */
function figureDate(text: string, n: NumericFact, dates: readonly DateMention[]): DateMention | null {
  if (dates.length === 0) return null;
  // Memoised only for the text's own dates (`figuresOf`): the answer depends on the list it is given.
  if (dates !== textFacts(text).dates) return figureDateAmong(text, n, dates);
  const memo = figureMemo(text, n);
  if (memo.date === undefined) memo.date = figureDateAmong(text, n, dates);
  return memo.date;
}

function figureDateAmong(text: string, n: NumericFact, dates: readonly DateMention[]): DateMention | null {
  const { clauseStart, clauseEnd, sentenceStart } = figureScope(text, n);
  const distance = (d: DateMention) => (d.start >= n.end ? d.start - n.end : n.start - d.end);
  const inClause = dates.filter((d) => d.start >= clauseStart && d.end <= clauseEnd);
  if (inClause.length > 0) return inClause.reduce((best, d) => (distance(d) < distance(best) ? d : best));
  const before = dates.filter((d) => d.start >= sentenceStart && d.end <= n.start);
  return before.length > 0 ? before.reduce((best, d) => (d.start > best.start ? d : best)) : null;
}

/*
 * The part of a year a figure covers, when its words say: a quarter, a half,
 * the first nine months, one month. "Northwind's fourth-quarter revenue was
 * $1.1 billion in 2024" is not a rival to "revenue was $4.3 billion in 2024":
 * the year agrees and the measured noun is the same, but a quarter's revenue
 * is a different quantity from a year's, and an annual report or an earnings
 * release carries both side by side.
 */
const ORDINALS: Record<string, string> = { first: "1", "1st": "1", second: "2", "2nd": "2", third: "3", "3rd": "3", fourth: "4", "4th": "4", final: "4" };
/** "Quarterly statistics show …" names the publication, not the period: only "quarterly revenue" and the like count. */
const QUARTER_MARK =
  /\b(?:q([1-4])|([1-4])q|(first|1st|second|2nd|third|3rd|fourth|4th|final)[- ]quarter|(?:the|this|that|each|last|latest|same|per) quarter|quarterly(?!\s+(?:statistics|stats|reports?|data|surveys?|reviews?|bulletins?|updates?|filings?|publications?|newsletters?|meetings?|calls?)\b)|three months (?:to|ended|ending|through))\b/i;
const HALF_MARK =
  /\b(?:h([12])|([12])h|(first|1st|second|2nd)[- ]half|half[- ]year(?:ly)?|semi[- ]?annual(?:ly)?|(?:first|last) six months|six months (?:to|ended|ending|through))\b/i;
const MONTHS_MARK = /\b(?:(?:first|last) )?(nine|eight|seven|five|four|two) months\b/i;
/*
 * "Monthly revenue" is a month's worth; "a monthly fee", "$20 per month" and
 * "$18 a month" are a price's rate, not a period, and stay out of it.
 */
const MONTHLY_MARK =
  /\bmonthly\b(?!\s+(?:fees?|prices?|pricing|costs?|charges?|subscriptions?|plans?|payments?|rents?|rates?|premiums?|bills?|wages?|salar(?:y|ies)|allowances?|budgets?)\b)|\b(?:the|this|that|last) month\b/i;
/** A whole year said out loud: the figure is the year's, whatever a lead-in clause said before it. */
const YEAR_MARK = /\b(?:full[- ]year|annual(?:ly)?|(?:the|this|that|each|per|last|fiscal|financial|calendar) year|year[- ]end|twelve months|12 months|fy\s?'?\d{2,4})\b/i;
/** A date read as a moment, not a period: what a stock stood at, not what a flow added up to. */
const POINT_IN_TIME_CUE = /\b(?:as of|as at|at the end of|end of|by the end of|by|through|until|since|on)\s+(?:the\s+)?$/i;

/** `figureGrain`'s answer: null for a year or an unstated length, otherwise the kind of part and which one ("?" when the text does not say). */
type FigureGrain = { kind: "quarter" | "half" | "months" | "month"; which: string } | null;

const GRAIN_MARKS: ReadonlyArray<{ re: RegExp; grain: (m: RegExpExecArray) => NonNullable<FigureGrain> | "year" }> = [
  { re: QUARTER_MARK, grain: (m) => ({ kind: "quarter", which: m[1] ?? m[2] ?? ORDINALS[(m[3] ?? "").toLowerCase()] ?? "?" }) },
  { re: HALF_MARK, grain: (m) => ({ kind: "half", which: m[1] ?? m[2] ?? ORDINALS[(m[3] ?? "").toLowerCase()] ?? "?" }) },
  { re: MONTHS_MARK, grain: (m) => ({ kind: "months", which: m[1]!.toLowerCase() }) },
  { re: MONTHLY_MARK, grain: () => ({ kind: "month", which: "?" }) },
  { re: YEAR_MARK, grain: () => "year" },
];

/** GRAIN_MARKS compiled once for `matchAll` (which copies a global pattern, so sharing one is safe). */
const GRAIN_MARKS_GLOBAL = GRAIN_MARKS.map(({ re, grain }) => ({ re: new RegExp(re.source, "gi"), grain }));

/**
 * The period marker of `text[from, to)` nearest the figure — "Full-year
 * revenue rose to $4.3bn on a strong fourth quarter" is the year's — and
 * "year" for a whole year said out loud; null when the span says nothing.
 */
function grainIn(text: string, from: number, to: number, n: NumericFact): FigureGrain | "year" {
  const segment = text.slice(from, to);
  let best: { distance: number; grain: NonNullable<FigureGrain> | "year" } | null = null;
  for (const { re, grain } of GRAIN_MARKS_GLOBAL) {
    for (const m of segment.matchAll(re)) {
      const start = from + m.index;
      const end = start + m[0].length;
      const distance = start >= n.end ? start - n.end : end <= n.start ? n.start - end : 0;
      if (!best || distance < best.distance) best = { distance, grain: grain(m) };
    }
  }
  return best?.grain ?? null;
}

/**
 * The part of a year a figure is given for, from its own clause, else from
 * its sentence before it ("In the fourth quarter of 2024, revenue was …").
 * A named month counts when it is the figure's period ("Revenue in December
 * 2024 was …"), not when it dates a reading ("capacity stood at 16.5 GW at
 * the end of June 2026", "as of March 2024"), which stays a year-level date.
 */
function figureGrain(text: string, n: NumericFact, dates: readonly DateMention[]): FigureGrain {
  // Memoised only for the text's own dates (`figuresOf`), like `figureDate`.
  if (dates !== textFacts(text).dates) return readFigureGrain(text, n, dates);
  const memo = figureMemo(text, n);
  if (memo.grain === undefined) memo.grain = readFigureGrain(text, n, dates);
  return memo.grain;
}

function readFigureGrain(text: string, n: NumericFact, dates: readonly DateMention[]): FigureGrain {
  const { clauseStart, clauseEnd, sentenceStart } = figureScope(text, n);
  const own = grainIn(text, clauseStart, clauseEnd, n);
  if (own === "year") return null;
  if (own) return own;
  const at = figureDate(text, n, dates);
  if (at && /^q[1-4]/i.test(at.raw)) return { kind: "quarter", which: at.raw[1]! };
  if (at?.month != null && !POINT_IN_TIME_CUE.test(text.slice(Math.max(0, at.start - 24), at.start))) {
    return { kind: "month", which: String(at.month) };
  }
  const lead = grainIn(text, sentenceStart, clauseStart, n);
  return lead === "year" ? null : lead;
}

/** Whether two figures cover the same length of period: both a year (or unstated), or the same kind of part and no different one. */
function sameGrain(a: FigureGrain, b: FigureGrain): boolean {
  if (!a || !b) return !a && !b;
  return a.kind === b.kind && (a.which === "?" || b.which === "?" || a.which === b.which);
}

/*
 * A period named relative to another one: "a year earlier", "in the prior
 * year", "two years ago", "next year". No date to extract, but plainly not
 * the period of a figure stated beside it without one.
 */
const RELATIVE_PERIOD =
  /\b(?:(a|one|two|three|four|five|\d+) years? (?:earlier|ago|before|previously)|year[- ](?:earlier|ago)|(?:the )?(?:prior|previous|preceding|last) (?:fiscal |financial |calendar )?year|prior[- ]year|previous[- ]year|the year before|(?:the )?(next|following|coming) year)\b/i;
const COUNT_WORDS: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };

/** "previous:1", "previous:2", "next:1" for a figure its own clause or sentence lead-in places relative to another period; null otherwise. */
function figureRelativePeriod(text: string, n: NumericFact): string | null {
  const { clauseStart, clauseEnd, sentenceStart } = figureScope(text, n);
  for (const segment of [text.slice(clauseStart, clauseEnd), text.slice(sentenceStart, clauseStart)]) {
    const m = RELATIVE_PERIOD.exec(segment);
    if (!m) continue;
    if (m[2]) return "next:1";
    const count = m[1] ? COUNT_WORDS[m[1].toLowerCase()] ?? Number(m[1]) : 1;
    return `previous:${count}`;
  }
  return null;
}

/**
 * The passage figures that give a different value than the claim's figure
 * `n` for the same thing: the contradiction behind `figure_mismatch`.
 *
 * A passage figure equal to ANOTHER of the claim's figures is that figure's
 * evidence ("100 GB against 50 GB": the 100 GB page), not a rival to this one
 * — unless both are dated and the dates differ: a page's "$3.9 billion in
 * 2024" is not the evidence for a claim's "up from $3.9 billion in 2023", it
 * is a different figure for the claim's 2024.
 */
function rivalFigures(
  claim: { text: string; dates: readonly DateMention[]; numbers: readonly NumericFact[] },
  n: NumericFact,
  passage: { text: string; dates: readonly DateMention[]; numbers: readonly NumericFact[] }
): NumericFact[] {
  return passage.numbers.filter(
    (p) =>
      p.kind === n.kind &&
      !numbersAgree(p.value, n.value) &&
      !evidenceForAnotherFigure(claim, n, passage, p, { strict: false }) &&
      measuresSameThing(claim, n, passage, p)
  );
}

/**
 * Whether passage figure `p` is the evidence for a claim figure other than
 * `n`: equal to it, and given for the same date. `strict` also refuses the
 * pair when only one of the two is dated — the bar for letting another cited
 * source stand in for this passage, where a wrong guess shows a disagreeing
 * passage as support.
 */
function evidenceForAnotherFigure(
  claim: { text: string; dates: readonly DateMention[]; numbers: readonly NumericFact[] },
  n: NumericFact,
  passage: { text: string; dates: readonly DateMention[] },
  p: NumericFact,
  opts: { strict: boolean }
): boolean {
  const at = figureDate(passage.text, p, passage.dates);
  return claim.numbers.some((m) => {
    if (m === n || m.kind !== p.kind || !numbersAgree(m.value, p.value)) return false;
    const mAt = figureDate(claim.text, m, claim.dates);
    if (mAt && at) return datesAgree(mAt, at);
    return !opts.strict || (!mAt && !at);
  });
}

/** Whether two figures could be the same quantity, whatever they are about: unit and introducing phrase only. */
function sameQuantity(claim: string, a: NumericFact, passage: string, b: NumericFact): boolean {
  const ca = numberContext(claim, a);
  const cb = numberContext(passage, b);
  if (ca.unit && cb.unit && ca.unit === cb.unit) {
    // A bare count of days (or months, or years) is only the same quantity
    // when it is the same thing being counted: the word after the unit has to
    // agree too. Currency and percentages are not affected — "$18 per month"
    // and "$15 per month" are rival prices whatever follows them.
    if (a.kind === "plain" && PERIOD_UNITS.has(ca.unit)) return !!ca.next && ca.next === cb.next;
    return true;
  }
  // A percentage or a currency amount carries its own unit, so for those the
  // introducing phrase is enough ("The settlement was $50m" / "$500m").
  if (a.kind === "plain") return false;
  for (const t of ca.before) if (cb.before.has(t)) return true;
  return false;
}

/**
 * Two figures are "the same figure" when they round to each other. Reports
 * legitimately round ("roughly 3.4 million" for 3,412,000) and refusing that
 * would mark honest prose unsupported, which is its own kind of lying to the
 * reader. 2% is wide enough for a one-decimal rounding and narrow enough that
 * 12% and 21% never reconcile.
 */
const NUMERIC_TOLERANCE = 0.02;

export function numbersAgree(a: number, b: number): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return true;
  return Math.abs(a - b) / scale <= NUMERIC_TOLERANCE;
}

// ---------------------------------------------------------------------------
// Dates — and the publication/event distinction §8.2 asks for
// ---------------------------------------------------------------------------

export interface DateMention {
  year: number;
  /** 1-12 when the text was that specific. */
  month?: number;
  day?: number;
  raw: string;
  start: number;
  end: number;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const MONTH_ALT = MONTHS.map((m) => `${m}|${m.slice(0, 3)}`).join("|");
const DATE_RE = new RegExp(
  [
    // 2024-03-11 / 2024/03/11
    String.raw`\b(?<iso>(?<iy>(?:19|20)\d{2})[-/](?<im>0?[1-9]|1[0-2])[-/](?<id>0?[1-9]|[12]\d|3[01]))\b`,
    // 11 March 2024 / 11 Mar 2024
    String.raw`\b(?<dmyD>\d{1,2})\s+(?<dmyM>${MONTH_ALT})\.?,?\s+(?<dmyY>(?:19|20)\d{2})\b`,
    // March 11, 2024 / Mar 2024
    String.raw`\b(?<mdyM>${MONTH_ALT})\.?\s+(?:(?<mdyD>\d{1,2})(?:st|nd|rd|th)?,?\s+)?(?<mdyY>(?:19|20)\d{2})\b`,
    // Q3 2023
    String.raw`\b(?<qQ>[Qq][1-4])\s*(?<qY>(?:19|20)\d{2})\b`,
    // FY2023 / FY 2023 / FY23: a fiscal year, read as its year.
    String.raw`\bFY\s?'?(?<fy>(?:19|20)\d{2}|\d{2})\b`,
    // A bare year, last so the richer patterns win the span.
    String.raw`\b(?<bare>(?:19|20)\d{2})\b`,
  ].join("|"),
  "gi"
);

const QUARTER_MONTH: Record<string, number> = { q1: 1, q2: 4, q3: 7, q4: 10 };

export function extractDates(text: string): DateMention[] {
  const out: DateMention[] = [];
  DATE_RE.lastIndex = 0;
  for (let m = DATE_RE.exec(text); m; m = DATE_RE.exec(text)) {
    const g = m.groups ?? {};
    const at = { raw: m[0], start: m.index, end: m.index + m[0].length };
    if (g.iy) out.push({ year: +g.iy, month: +g.im!, day: +g.id!, ...at });
    else if (g.dmyY) out.push({ year: +g.dmyY, month: monthIndex(g.dmyM!), day: +g.dmyD!, ...at });
    else if (g.mdyY)
      out.push({
        year: +g.mdyY,
        month: monthIndex(g.mdyM!),
        ...(g.mdyD ? { day: +g.mdyD } : {}),
        ...at,
      });
    else if (g.qY) out.push({ year: +g.qY, month: QUARTER_MONTH[g.qQ!.toLowerCase()], ...at });
    else if (g.fy) out.push({ year: g.fy.length === 2 ? 2000 + +g.fy : +g.fy, ...at });
    else if (g.bare) out.push({ year: +g.bare, ...at });
  }
  return out;
}

function monthIndex(name: string): number {
  const n = name.toLowerCase().replace(/\.$/, "");
  const i = MONTHS.findIndex((m) => m === n || m.slice(0, 3) === n);
  return i + 1;
}

/**
 * Compatible at the coarser of the two precisions: "March 2024" and
 * "11 March 2024" are the same date being described at different resolutions,
 * and treating them as a mismatch would flag correct reporting.
 */
export function datesAgree(a: DateMention, b: DateMention): boolean {
  if (a.year !== b.year) return false;
  if (a.month != null && b.month != null && a.month !== b.month) return false;
  if (a.day != null && b.day != null && a.day !== b.day) return false;
  return true;
}

/*
 * Phrases that introduce WHEN THE THING HAPPENED rather than when the page was
 * written. §8.2's requirement is exactly this distinction: a wire story
 * published in 2026 about a 2019 merger must not license the sentence "the
 * merger closed in 2026", even though 2026 is a perfectly real date attached to
 * that source.
 */
const EVENT_DATE_CUES =
  /\b(?:on|in|since|as of|dated|took place|occurred|happened|announced on|filed on|signed on|published on|effective|beginning|starting|launched|closed|reported for|for the (?:quarter|year) end(?:ing|ed))\b/i;

/**
 * The date the passage says the EVENT happened, as distinct from the source's
 * publication date. Returns null when the text names no date at all, or when
 * every date in it is just the publication date repeated.
 */
export function extractEventDate(text: string, publishedAt?: Date | null): DateMention | null {
  const dates = extractDates(text);
  if (dates.length === 0) return null;
  const pub = publishedAt ? { year: publishedAt.getUTCFullYear(), month: publishedAt.getUTCMonth() + 1, day: publishedAt.getUTCDate() } : null;

  // A date introduced by a temporal cue in the ~40 characters before it is the
  // strongest signal available without parsing the sentence properly.
  const cued = dates.filter((d) => EVENT_DATE_CUES.test(text.slice(Math.max(0, d.start - 40), d.start)));
  const pool = cued.length > 0 ? cued : dates;
  const notPublication = pool.filter(
    (d) => !pub || d.year !== pub.year || (d.month != null && d.month !== pub.month)
  );
  return (notPublication[0] ?? pool[0]) ?? null;
}

// ---------------------------------------------------------------------------
// Quotations, polarity, hedging, and the other things a judge waves through
// ---------------------------------------------------------------------------

const QUOTE_RE = /[""«]([^""»]{8,400})[""»]|"([^"]{8,400})"/g;

export function extractQuotes(text: string): string[] {
  const out: string[] = [];
  QUOTE_RE.lastIndex = 0;
  for (let m = QUOTE_RE.exec(text); m; m = QUOTE_RE.exec(text)) {
    const body = (m[1] ?? m[2] ?? "").trim();
    if (body) out.push(body);
  }
  return out;
}

const NEGATORS =
  /\b(?:not|never|no longer|denied|denies|deny|rejected|rejects|refused|declined to|failed to|did not|does not|do not|was not|were not|is not|are not|isn't|wasn't|weren't|doesn't|didn't|cannot|can't|won't|ruled out|found no|without)\b/gi;

/** Whether a (normalised) text holds any negation at all. */
const ANY_NEGATOR = new RegExp(NEGATORS.source, "i");

/** Parity, not count: two negations in a sentence cancel. */
export function negationParity(sentence: string): 0 | 1 {
  const n = (normalizeText(sentence).match(NEGATORS) ?? []).length;
  return (n % 2) as 0 | 1;
}

/*
 * "would" is deliberately absent. In reported speech it is future-in-past, not
 * uncertainty — "the executive said every unit would be replaced" is a firm
 * commitment — and including it capped correctly cited quotations at the hedged
 * ceiling, which is a false accusation against an honest citation.
 */
const HEDGES =
  /\b(?:might|could|expected to|is likely|are likely|likely to|reportedly|alleg(?:e|es|ed|edly|ation|ations)|apparent|apparently|preliminary|unconfirmed|estimates?|projected|forecast|proposed|draft|if approved|plans to|aims to|intends to|on track to|suggests?|indicates?|potential(?:ly)?)\b/i;
/**
 * "may" is a hedge and also a month. Case-sensitive and lowercase-only, because
 * "in May 2024" is a date and treating it as uncertainty would cap every
 * correctly cited May story at the hedged ceiling. The cost is a sentence that
 * opens with "May" as a modal, which is vanishingly rare in reported prose.
 */
const HEDGE_MAY = /\bmay\b/;

function isHedged(text: string): boolean {
  return HEDGES.test(text) || HEDGE_MAY.test(text);
}

const SUPERLATIVES =
  /\b(?:first|only|sole|largest|biggest|smallest|best|worst|highest|lowest|fastest|slowest|leading|record|unprecedented|never before|all[- ]time)\b/i;

const CAUSAL = /\b(?:because|caused|causing|due to|led to|leading to|as a result of|resulted in|drove|driven by|triggered|thanks to|blamed on)\b/i;

const ATTRIBUTION = /\b(?:according to|as reported by|citing|cited by|sources? said|spokesperson said|in a statement)\b/i;

/*
 * A sentence that states the PRESENT: what is true now, not what was true when
 * some page was written. "Plus costs $20 a month" cited to a 2022 review is the
 * failure — the page supports the figure as of 2022 and says nothing about
 * today, and a reader takes the sentence as today's price. Only explicit
 * present-state markers count; an undated present-tense sentence is too common
 * in reported prose to treat every one of them as a freshness claim.
 *
 * "still", "now" and "remain(s)" count only next to the verb they put in the
 * present ("is still", "now costs", "remains the"): bare, they are also "still
 * images", "until now" and "human remains". "Remains" counts only as a verb,
 * so never after a determiner, a modal or a word that makes it the noun
 * ("human remains at the site", "the fossil remains in a collection", "will
 * remain"), nor before what only the noun takes ("remains of", "remains were
 * found"); as the verb it takes any predicate ("prices remain high", "it
 * remains unprofitable"). "Current" counts only where it heads a role, price
 * or version that the sentence says IS something, either way round ("the
 * current CEO is", "its current price is", "Jane Doe is the current CEO"):
 * bare, it is also "the current account deficit"; "currently" stays. "This year" and
 * "today" stay: both are relative to the day the report is read, so a
 * sentence using them on a page from more than a year ago is exactly the case.
 */
const PRESENT_VERB =
  "is|are|has|have|costs?|offers?|holds?|leads?|operates?|employs?|runs?|uses?|includes?|supports?|requires?|charges?|stands?|accounts?|lists?|sells?|serves?|owns?|controls?|provides?|allows?|ranks?";
/** Words after which "remains" is the noun: determiners, and what describes a body or a find. */
const REMAINS_NOUN_BEFORE =
  "the|a|an|his|her|their|its|our|whose|of|human|fossil|fossilised|fossilized|skeletal|mortal|earthly|archaeological|ancient|animal|dinosaur|charred|burnt|burned|cremated|burial|plant|organic|unidentified|recovered|bone|bodily|mummified|partial|scattered|fragmentary|excavated|exhumed|any|no|these|those|such|will|would|could|might|may|should|must|can|cannot|to";
/** Words after which "remains" is the noun: what is found, dated or made of it. */
const REMAINS_NOUN_AFTER =
  "of|were|was|are|have|had|found|discovered|recovered|unearthed|excavated|identified|show|showed|shows|date|dated|dates|dating|belong|belonged|belonging|belongs|suggest|suggested|suggests|indicate|indicated|indicates|lay|lie|lies|rest|rested|rests";
/** What "current" heads when a sentence states a present fact with it: a role, a price, a version. */
const CURRENT_HEADS =
  "ceo|cfo|cto|coo|chief executive|chief executive officer|chair|chairman|chairwoman|chairperson|president|director|head|leader|manager|owner|holder|champion|prime minister|minister|governor|mayor|coach|editor|price|prices|pricing|fee|fees|cost|rate|rates|tariff|version|release|edition|model|record";
const PRESENT_STATE = new RegExp(
  String.raw`\b(?:currently|presently|nowadays|today|at present|at the moment|right now|this year|latest|newest|most recent|up[- ]to[- ]date|as of (?:today|now|this year)` +
    String.raw`|(?:is|are|has|have) (?:still|now)|(?:still|now) (?:${PRESENT_VERB})` +
    String.raw`|current (?:[a-z-]+ )?(?:${CURRENT_HEADS}) (?:is|are)` +
    String.raw`|(?:is|are) (?:the|its|their|his|her|our) current (?:[a-z-]+ )?(?:${CURRENT_HEADS})` +
    String.raw`|(?<!\b(?:${REMAINS_NOUN_BEFORE})\s)remains? (?!(?:${REMAINS_NOUN_AFTER})\b)[a-z]+)\b`,
  "i"
);

/**
 * How old a dated source may be and still stand behind a sentence that says
 * something is true NOW. A year: prices, limits, versions and policies move on
 * about that cadence, and the gap audit's 540-day window is for figures on a
 * question where recency merely matters, not for a sentence that says "today".
 */
export const STALE_FOR_PRESENT_DAYS = 365;

const DAY_MS = 86_400_000;

function describeAge(days: number): string {
  if (days >= 730) return `${Math.floor(days / 365)} years`;
  const months = Math.max(1, Math.round(days / 30.44));
  return months === 1 ? "a month" : `${months} months`;
}

// ---------------------------------------------------------------------------
// Claim extraction
// ---------------------------------------------------------------------------

export interface ExtractedClaim {
  /** The sentence with citation markers and markdown syntax removed. */
  text: string;
  type: ClaimType;
  /** "start:end" char offsets into the report — ResearchClaim.answerSpan. */
  answerSpan: string;
  /** 1-based source numbers cited on this sentence, in order, deduplicated. */
  citations: number[];
  /**
   * `table`: built from a Markdown table row (`tableClaims`). Its text names
   * the row and the column headers; its span is the last cell it covers, so
   * a repair annotates that cell and leaves the table's pipes intact.
   */
  form?: "table";
}

export function formatAnswerSpan(start: number, end: number): string {
  return `${start}:${end}`;
}

export function parseAnswerSpan(span: string | null | undefined): { start: number; end: number } | null {
  const m = /^(\d+):(\d+)$/.exec(span ?? "");
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  return end > start ? { start, end } : null;
}

/** Below this a "sentence" is a fragment, a label, or a table cell. */
const MIN_CLAIM_CHARS = 30;
const MAX_CLAIM_CHARS = 600;

/** Abbreviations whose full stop must not end a sentence. */
const ABBREVIATIONS = /\b(?:mr|mrs|ms|dr|prof|st|vs|etc|inc|ltd|corp|co|fig|no|approx|e\.g|i\.e|u\.s|u\.k|a\.m|p\.m)\.$/i;

function splitSentences(line: string, baseOffset: number): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    const next = line[i + 1];
    if (next && !/\s/.test(next)) continue; // 3.5, example.com, [1].
    const head = line.slice(start, i + 1);
    // "1.2 million" and "Dr." are not sentence ends. Checking the tail of the
    // candidate rather than the character before the stop keeps multi-token
    // abbreviations ("e.g.") together.
    if (ABBREVIATIONS.test(head.trimEnd()) || /\d\.$/.test(head.trimEnd())) continue;
    out.push({ text: head, start: baseOffset + start, end: baseOffset + i + 1 });
    start = i + 1;
    while (start < line.length && /\s/.test(line[start])) start++;
    i = start - 1;
  }
  if (start < line.length) out.push({ text: line.slice(start), start: baseOffset + start, end: baseOffset + line.length });
  return out;
}

const CITATION_MARKER_RE = /\[(\d{1,3})\]/g;

/** Markdown emphasis/link syntax stripped, so the judge reads prose not source. */
function plainify(s: string): string {
  return s
    .replace(CITATION_MARKER_RE, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function classify(text: string): ClaimType {
  if (extractQuotes(text).length > 0) return "quote";
  if (/\b(?:will|by 20\d{2}|forecast|projected|expected to|is set to|predicts?)\b/i.test(text)) return "prediction";
  if (extractNumbers(text, extractDates(text)).length > 0) return "statistic";
  if (/\b(?:arguably|seems|appears to be|critics|proponents|believe|argue|controversial|should)\b/i.test(text)) return "opinion";
  return "fact";
}

/**
 * A sentence is LOAD-BEARING when it asserts something a reader could be misled
 * by. Two ways to qualify: it carries a citation (the report itself said this
 * rests on a source), or it states a checkable particular — a figure, a date, a
 * quotation, a named entity. Framing sentences ("This section covers three
 * areas") assert nothing and would only dilute the precision number with
 * material no reader would ever check.
 */
function isLoadBearing(text: string, citations: number[]): boolean {
  if (text.length < MIN_CLAIM_CHARS || text.length > MAX_CLAIM_CHARS) return false;
  if (citations.length > 0) return true;
  if (/[?]\s*$/.test(text)) return false;
  const dates = extractDates(text);
  if (extractNumbers(text, dates).length > 0 || dates.length > 0) return true;
  if (extractQuotes(text).length > 0) return true;
  // A capitalised word that is not sentence-initial: a name, an organisation, a
  // place. Weak on its own, which is why it is the last resort.
  return /\s[A-Z][a-zA-Z]{2,}/.test(text);
}

/**
 * The load-bearing claims of a synthesised report, in reading order, each with
 * its span in the answer so the UI can point at it.
 *
 * Headings, fenced code, and everything from the "## Sources" heading onward are
 * skipped: the reference list is a list of citations, not of claims, and
 * extracting "[3] Reuters — https://…" as a factual claim would put a
 * permanently unsupportable row in every report's audit.
 */
export function extractClaims(report: string): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  let offset = 0;
  let fenced = false;
  let stop = false;
  /** The Markdown table being accumulated, line by line with offsets. */
  let table: Array<{ text: string; start: number }> = [];
  /** Inside the methodology section, whose tables attribute sources rather than state facts. */
  let methodology = false;
  const flushTable = () => {
    if (table.length && !methodology) claims.push(...tableClaims(table));
    table = [];
  };
  // The prose block being accumulated, as offsets into the report.
  let blockStart = -1;
  let blockEnd = -1;

  const flush = () => {
    if (blockStart < 0) return;
    /*
     * Newlines become spaces so a sentence the model wrapped across two lines
     * is read as ONE sentence. A one-character-for-one-character replacement is
     * the whole trick: every offset inside the block still points at the same
     * character of the original report, so answerSpan stays usable by the UI.
     */
    const text = report.slice(blockStart, blockEnd).replace(/\n/g, " ");
    for (const sentence of splitSentences(text, blockStart)) {
      const citations: number[] = [];
      CITATION_MARKER_RE.lastIndex = 0;
      for (let m = CITATION_MARKER_RE.exec(sentence.text); m; m = CITATION_MARKER_RE.exec(sentence.text)) {
        const n = Number(m[1]);
        if (n >= 1 && !citations.includes(n)) citations.push(n);
      }
      const plain = plainify(sentence.text);
      if (!isLoadBearing(plain, citations)) continue;
      claims.push({
        text: plain,
        type: classify(plain),
        answerSpan: formatAnswerSpan(sentence.start, sentence.end),
        citations,
      });
    }
    blockStart = -1;
  };

  for (const line of report.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    if (stop) continue;
    const trimmed = line.trim();
    // A table row is cells rather than sentences: rows are collected and read
    // as a table (`tableClaims`) when the table ends.
    if (!fenced && /^\|/.test(trimmed)) {
      flush();
      table.push({ text: line, start: lineStart });
      continue;
    }
    flushTable();
    if (/^(?:```|~~~)/.test(trimmed)) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (!trimmed) {
      flush();
      continue;
    }
    if (/^#{1,6}\s+(?:sources|references|citations)\b/i.test(trimmed)) {
      flush();
      stop = true;
      continue;
    }
    const marker = /<!--\s*juno:section\s*=\s*([a-z0-9:_-]+)\s*-->/i.exec(trimmed);
    if (marker) {
      methodology = marker[1]!.toLowerCase() === "method";
      flush();
      continue;
    }
    // Headings assert nothing on their own and end whatever paragraph preceded them.
    if (/^#{1,6}\s/.test(trimmed)) {
      flush();
      if (METHOD_HEADING.test(trimmed)) methodology = true;
      continue;
    }
    const lead = /^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)/.exec(line)?.[0];
    if (lead) {
      // A new list item is a new claim, not a continuation of the last one.
      flush();
      blockStart = lineStart + lead.length;
    } else if (blockStart < 0) {
      blockStart = lineStart;
    }
    blockEnd = lineStart + line.length;
  }
  flush();
  flushTable();
  return claims.sort((a, b) => (parseAnswerSpan(a.answerSpan)?.start ?? 0) - (parseAnswerSpan(b.answerSpan)?.start ?? 0));
}

/** A methodology / traceability heading, in the report languages the writer uses. */
const METHOD_HEADING = /^#{1,6}\s.*(?:method|traceab|m[ée]thodolog|methodik|metodolog|quellen|fuentes|fonti|fontes|方法|出典|来源|來源)/i;
/** Cells that state that nothing is known: nothing to check. */
const EMPTY_CELL = /^(?:not published|not disclosed|unknown|n\/?a|none|tbd|[-–—✓✗✔✘×]|yes|no|—)$/i;

interface TableCellSpan {
  text: string;
  start: number;
  end: number;
}

/** A row's cells, split on unescaped pipes, each with its trimmed content's offsets in the report. */
function rowCells(line: string, lineStart: number): TableCellSpan[] {
  const pipes: number[] = [];
  for (let i = 0; i < line.length; i += 1) if (line[i] === "|" && line[i - 1] !== "\\") pipes.push(i);
  const cells: TableCellSpan[] = [];
  const bounds = [...pipes];
  if (line.trim() && !line.trimEnd().endsWith("|")) bounds.push(line.length);
  for (let k = 0; k + 1 < bounds.length; k += 1) {
    const raw = line.slice(bounds[k]! + 1, bounds[k + 1]);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    const start = lineStart + bounds[k]! + 1 + lead;
    cells.push({ text, start, end: start + text.length });
  }
  return cells;
}

function citationsIn(text: string): number[] {
  const out: number[] = [];
  CITATION_MARKER_RE.lastIndex = 0;
  for (let m = CITATION_MARKER_RE.exec(text); m; m = CITATION_MARKER_RE.exec(text)) {
    const n = Number(m[1]);
    if (n >= 1 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Most claims a single table contributes; a 60-row matrix is not 60 times as checkable. */
const MAX_TABLE_CLAIMS = 24;

/**
 * The claims of one Markdown table (research protocol Stage 5's decision and
 * comparative matrices).
 *
 * A row states facts about its first cell under each column's header, so a
 * cell becomes "row — header: value". Each cell is cited by its own [n]
 * markers; a cell without any falls back to the row label's markers (one
 * source for the whole row), then to its column header's (one source per
 * option in a comparison). Cells of one row that share a citation set are
 * one claim, so a row backed by one page is one check and a comparison row
 * with a source per option is one check per option. A cell with a figure and
 * no citation at all is still a claim — uncited, as an uncited figure in
 * prose is. Each claim's span is the last cell it covers.
 */
export function tableClaims(lines: ReadonlyArray<{ text: string; start: number }>): ExtractedClaim[] {
  const rows = lines.map((line) => rowCells(line.text, line.start)).filter((cells) => cells.length > 0);
  if (rows.length < 2) return [];
  const isSeparator = (cells: TableCellSpan[]) => cells.every((cell) => /^:?-{2,}:?$/.test(cell.text));
  const separatorAt = rows.findIndex(isSeparator);
  const header = separatorAt === 1 ? rows[0]! : null;
  const body = rows.filter((cells, i) => !isSeparator(cells) && !(header && i === 0));
  const out: ExtractedClaim[] = [];
  for (const cells of body) {
    const label = plainify(cells[0]?.text ?? "");
    const labelCites = citationsIn(cells[0]?.text ?? "");
    const groups = new Map<string, { parts: string[]; citations: number[]; last: TableCellSpan; figure: boolean }>();
    const valueCells = cells.length === 1 ? cells.map((cell, c) => ({ cell, c })) : cells.slice(1).map((cell, i) => ({ cell, c: i + 1 }));
    for (const { cell, c } of valueCells) {
      const value = plainify(cell.text);
      if (!value || EMPTY_CELL.test(value)) continue;
      const own = citationsIn(cell.text);
      const head = header?.[c];
      const citations = own.length ? own : labelCites.length ? labelCites : head ? citationsIn(head.text) : [];
      const dates = extractDates(value);
      const figure = extractNumbers(value, dates).length > 0 || dates.length > 0;
      const headText = head ? plainify(head.text) : "";
      const key = citations.join(",");
      const group = groups.get(key) ?? { parts: [], citations, last: cell, figure: false };
      group.parts.push(headText ? `${headText}: ${value}` : value);
      group.last = cell;
      group.figure ||= figure;
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (!group.citations.length && !group.figure) continue;
      const text = `${label && cells.length > 1 ? `${label} — ` : ""}${group.parts.join("; ")}`.slice(0, MAX_CLAIM_CHARS);
      out.push({
        text,
        type: classify(text),
        answerSpan: formatAnswerSpan(group.last.start, group.last.end),
        citations: group.citations,
        form: "table",
      });
      if (out.length >= MAX_TABLE_CLAIMS) return out;
    }
  }
  return out;
}

/**
 * The claims one audit checks, at most `cap`: table claims may take at most
 * `TABLE_CLAIM_SHARE` of the slots so a long matrix cannot crowd the deep
 * dives' prose out of the audit, and what is kept stays in reading order.
 */
export const TABLE_CLAIM_SHARE = 0.4;

export function claimsForAudit(claims: readonly ExtractedClaim[], cap: number): ExtractedClaim[] {
  const limit = Math.max(1, Math.floor(cap));
  if (claims.length <= limit) return [...claims];
  const tableCap = Math.max(1, Math.ceil(limit * TABLE_CLAIM_SHARE));
  const tables = claims.filter((claim) => claim.form === "table");
  const prose = claims.filter((claim) => claim.form !== "table");
  const keptTables = tables.slice(0, Math.max(tableCap, limit - prose.length));
  const keptProse = prose.slice(0, limit - Math.min(keptTables.length, limit));
  const kept = new Set([...keptTables, ...keptProse]);
  return claims.filter((claim) => kept.has(claim)).slice(0, limit);
}

export interface RepairableClaim extends ExtractedClaim {
  status: ClaimStatus;
  supportStrength: number | null;
  /**
   * `[n]` markers on this claim that name no source in the corpus. They are
   * stripped from the sentence whatever its verdict: a citation to nothing is
   * an invented citation, and leaving it in place is the one repair this
   * function must never skip.
   */
  unresolvedCitations?: readonly number[];
  /**
   * The publication date (YYYY-MM-DD) of the source behind a present-tense
   * claim that the freshness check held to "partly supported". The generic
   * "supports only part of this statement" would name the wrong defect: the
   * source supports all of it, as of a date that is no longer now.
   */
  staleSince?: string | null;
}

export interface ReportRepairResult {
  report: string;
  repaired: boolean;
  repairedClaims: number;
}

/** `text` with the given `[n]` markers removed, along with the space in front of each. */
function stripCitationMarkers(text: string, numbers: readonly number[] | undefined): string {
  if (!numbers?.length) return text;
  const drop = new Set(numbers);
  return text.replace(/\s*\[(\d{1,3})\]/g, (marker, n: string) => (drop.has(Number(n)) ? "" : marker));
}

/**
 * Make a report honest without inventing replacement facts. Unsupported
 * language is weakened in place and contradictions stay visible.
 * Replacements run from the end of the document so the stored answer spans
 * remain valid while the repair is applied.
 *
 * A claim nobody checked is never rewritten (B4): `unverified` means the
 * judge did not look — its cap was reached, or it only had a search snippet —
 * and prose rewritten on that basis told the reader the evidence failed when
 * nobody had read it. The reader's support mark says "not checked" instead,
 * and since nothing changed, no paid revision follows either.
 *
 * The one exception to "verdict decides" is an invented citation: a marker
 * pointing past the end of the corpus is removed from supported and unchecked
 * claims too, because no verdict makes `[9]` in a nine-source-short corpus
 * mean anything.
 */
export function repairReportFromClaims(report: string, claims: readonly RepairableClaim[]): ReportRepairResult {
  const replacements = claims
    .map((claim) => {
      const span = parseAnswerSpan(claim.answerSpan);
      if (!span) return null;
      const original = report.slice(span.start, span.end);
      const text = stripCitationMarkers(original, claim.unresolvedCitations);
      const rewrite = claim.status !== "supported" && claim.status !== "unverified";
      if (!rewrite) return text === original ? null : { ...span, replacement: text };
      const label = supportLabel(claim.status, claim.supportStrength);
      // Every marker it carried named nothing: there was never a cited passage
      // for "the cited passage does not establish this" to be about.
      const unsourced =
        !!claim.unresolvedCitations?.length && claim.citations.every((n) => claim.unresolvedCitations!.includes(n));
      const stale = label === "partially supported" && !!claim.staleSince;
      if (claim.form === "table") {
        // A cell is annotated in place: the table keeps its pipes and its shape.
        const note =
          claim.status === "contradicted"
            ? "conflicting evidence"
            : unsourced
            ? "cites no source in this research"
            : stale
            ? `source dated ${claim.staleSince}`
            : label === "partially supported"
            ? "only partly supported"
            : "not established by the cited source";
        return { ...span, replacement: `${text.trim()} (${note})` };
      }
      const prefix =
        claim.status === "contradicted"
          ? "Conflicting evidence: "
          : unsourced
          ? "Unsourced: "
          : stale
          ? "Possibly out of date: "
          : label === "partially supported"
          ? "Evidence is incomplete: "
          : claim.status === "unverified"
          ? "Unverified: "
          : "The cited evidence is insufficient: ";
      const suffix =
        claim.status === "contradicted"
          ? " (the cited source reports conflicting evidence.)"
          : unsourced
          ? " (the citation it carried names no source in this research.)"
          : stale
          ? ` (the cited source dates from ${claim.staleSince} and may no longer be current.)`
          : label === "partially supported"
          ? " (the cited source supports only part of this statement.)"
          : claim.status === "unverified"
          ? " (this claim could not be checked within the run limits.)"
          : " (the cited passage does not establish this.)";
      return { ...span, replacement: `${prefix}${text.trim()}${suffix}` };
    })
    .filter((value): value is { start: number; end: number; replacement: string } => !!value)
    .sort((a, b) => b.start - a.start);

  let repairedReport = report;
  for (const replacement of replacements) {
    repairedReport =
      repairedReport.slice(0, replacement.start) +
      replacement.replacement +
      repairedReport.slice(replacement.end);
  }
  return {
    report: repairedReport,
    repaired: replacements.length > 0,
    repairedClaims: replacements.length,
  };
}

// ---------------------------------------------------------------------------
// Passages
// ---------------------------------------------------------------------------

export interface PassageDraft {
  text: string;
  /** ResearchPassage.locator — char offsets into the fetched body. */
  locator: string;
  ordinal: number;
}

const MIN_PASSAGE_CHARS = 120;
const MAX_PASSAGE_CHARS = 900;

/**
 * Split a fetched page into citable passages on paragraph boundaries, merging
 * runs that are too short to stand as evidence and hard-splitting any that are
 * too long to show a reader in an inspector. The locator carries the char
 * offsets so the inspector can prove it is quoting the snapshot verbatim rather
 * than paraphrasing it.
 */
export function splitPassages(body: string, opts: { maxPassages?: number } = {}): PassageDraft[] {
  const max = opts.maxPassages ?? 40;
  const out: PassageDraft[] = [];
  let cursor = 0;
  let bufStart = 0;
  let buf = "";

  const flush = (end: number) => {
    const text = buf.trim();
    if (text.length >= 40 && out.length < max) {
      out.push({ text, locator: `chars:${bufStart}-${end}`, ordinal: out.length });
    }
    buf = "";
  };

  for (const block of body.split(/\n{2,}/)) {
    const start = body.indexOf(block, cursor);
    const blockStart = start >= 0 ? start : cursor;
    cursor = blockStart + block.length;
    if (!block.trim()) continue;
    if (buf === "") bufStart = blockStart;
    buf = buf ? `${buf}\n\n${block}` : block;
    if (buf.length < MIN_PASSAGE_CHARS) continue;
    if (buf.length <= MAX_PASSAGE_CHARS) {
      flush(cursor);
      continue;
    }
    // An overlong Markdown table (the extractor writes page tables that way):
    // cut between rows, each passage carrying the header so a cell is still
    // read under its column's name.
    const tableChunks = splitTableBlock(buf, bufStart);
    if (tableChunks) {
      for (const chunk of tableChunks) {
        if (out.length >= max) break;
        out.push({ ...chunk, ordinal: out.length });
      }
      buf = "";
      continue;
    }
    // Overlong block: cut on sentence ends so a passage never opens mid-word.
    for (const s of splitSentences(buf, bufStart)) {
      if (out.length >= max) break;
      const text = s.text.trim();
      if (text.length < 40) continue;
      out.push({ text, locator: `chars:${s.start}-${s.end}`, ordinal: out.length });
    }
    buf = "";
  }
  flush(cursor);
  return out.slice(0, max);
}

/**
 * A block that is (mostly) one Markdown table, cut into passages of whole
 * rows with the header and separator repeated; null when it is not a table.
 * The locator spans the rows the passage quotes.
 */
function splitTableBlock(block: string, blockStart: number): Array<Omit<PassageDraft, "ordinal">> | null {
  const lines = block.split("\n");
  const tableAt = lines.findIndex((line) => line.trim().startsWith("|"));
  if (tableAt < 0) return null;
  const rows = lines.slice(tableAt);
  if (!rows.every((line) => line.trim().startsWith("|")) || rows.length < 3) return null;
  if (!/^\|(?:\s*:?-{2,}:?\s*\|)+\s*$/.test(rows[1]!.trim())) return null;
  const header = `${rows[0]!.trim()}\n${rows[1]!.trim()}`;
  const out: Array<Omit<PassageDraft, "ordinal">> = [];
  // Text above the table (a caption, a lead-in sentence) rides on the first passage.
  const lead = lines.slice(0, tableAt).join("\n").trim();
  let offset = blockStart + lines.slice(0, tableAt + 2).reduce((n, line) => n + line.length + 1, 0);
  let chunk: string[] = [];
  let chunkStart = offset;
  const flushChunk = (end: number) => {
    if (!chunk.length) return;
    const prefix = out.length === 0 && lead ? `${lead}\n\n` : "";
    out.push({ text: `${prefix}${header}\n${chunk.join("\n")}`, locator: `chars:${chunkStart}-${end}` });
    chunk = [];
  };
  for (const row of rows.slice(2)) {
    if (chunk.length && header.length + chunk.join("\n").length + row.length > MAX_PASSAGE_CHARS) {
      flushChunk(offset - 1);
      chunkStart = offset;
    }
    chunk.push(row.trim());
    offset += row.length + 1;
  }
  flushChunk(offset - 1);
  return out;
}

// ---------------------------------------------------------------------------
// Linking claims to passages
// ---------------------------------------------------------------------------

export interface PassageRef {
  /** 1-based index of the source in the report's numbered corpus. */
  sourceIndex: number;
  passage: PassageDraft;
}

export interface ClaimLinkDraft extends PassageRef {
  /** Lexical relevance, 0..1 — how this passage was chosen, before validation. */
  relevance: number;
}

/**
 * Relevance of a passage to a claim. Token coverage carries most of it, with a
 * deliberate bonus for a shared FIGURE or DATE: for a statistic, the sentence
 * carrying the number is the evidence and every other sentence on the page is
 * noise, however much vocabulary it shares.
 */
export function passageRelevance(claim: string, passage: string): number {
  const coverage = tokenCoverage(claim, passage);
  const claimDates = extractDates(claim);
  const claimNums = extractNumbers(claim, claimDates);
  let bonus = 0;
  if (claimNums.length > 0) {
    const passageNums = extractNumbers(passage, extractDates(passage));
    const matched = claimNums.filter((c) => passageNums.some((p) => p.kind === c.kind && numbersAgree(c.value, p.value)));
    bonus += 0.35 * (matched.length / claimNums.length);
  }
  if (claimDates.length > 0) {
    const passageDates = extractDates(passage);
    const matched = claimDates.filter((c) => passageDates.some((p) => datesAgree(c, p)));
    bonus += 0.15 * (matched.length / claimDates.length);
  }
  return Math.min(1, coverage * 0.7 + bonus);
}

/**
 * For each source the claim cites, the passages most likely to be the evidence.
 * A citation names a SOURCE, not a passage — the validator has to find the
 * passage itself, and getting that wrong marks a true claim unsupported. Hence
 * more than one candidate per source: the top passage is often the headline
 * paragraph while the figure lives two paragraphs down.
 */
export function selectPassagesForClaim(
  claim: ExtractedClaim,
  passagesBySource: ReadonlyMap<number, PassageDraft[]>,
  opts: { perSource?: number } = {}
): ClaimLinkDraft[] {
  const perSource = opts.perSource ?? 2;
  const drafts: ClaimLinkDraft[] = [];
  for (const sourceIndex of claim.citations) {
    const passages = passagesBySource.get(sourceIndex);
    if (!passages?.length) continue;
    const ranked = passages
      .map((passage) => ({ sourceIndex, passage, relevance: passageRelevance(claim.text, passage.text) }))
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, perSource);
    drafts.push(...ranked);
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// The deterministic audit
// ---------------------------------------------------------------------------

/** A reason code plus the sentence a reader sees in the inspector. */
export interface AuditReason {
  code:
    | "enumeration_incomplete"
    | "figure_absent"
    | "figure_mismatch"
    | "date_absent"
    | "date_is_publication_date"
    | "quote_absent"
    | "polarity_mismatch"
    | "superlative_unstated"
    | "causation_unstated"
    | "passage_hedged"
    | "attribution_dropped"
    | "source_stale"
    | "stated_by_other_citation"
    | "off_topic"
    | "thin_overlap";
  detail: string;
  /**
   * The support ceiling THIS reason imposed, 0..1 — the severity, stated once
   * by the side that decided it.
   *
   * Without it a reader (or an inspector trying to rank findings) has only the
   * sentence, and every sentence looks equally grave: "the quoted words are not
   * in the passage" (0.2 — the citation is fabricated) reads exactly like "the
   * passage attributes this to someone" (0.75 — the claim is true but flattened).
   * The alternative was a severity table keyed by `code` on the consuming side,
   * which is `CEILING` copied into a second place and free to drift from it the
   * first time one of these numbers is tuned.
   */
  ceiling: number;
}

export interface EvidenceAudit {
  /** The highest support strength the text itself can justify, 0..1. */
  ceiling: number;
  /** The passage asserts the opposite of the claim — not merely silent on it. */
  contradicted: boolean;
  reasons: AuditReason[];
}

/** Ceilings, ordered by how badly each failure misleads a reader. */
const CEILING = {
  offTopic: 0.12,
  quoteAbsent: 0.2,
  dateWrong: 0.3,
  figureAbsent: 0.35,
  entityThin: 0.5,
  unstatedLeap: 0.55,
  hedged: 0.6,
  /*
   * The same weight as a hedge, for the same reason: the passage is real
   * evidence for the figure, and what it cannot carry is the sentence's claim
   * that the figure is still true. Under the supported bar, over the partial
   * floor — "partly supported", never "unsupported".
   */
  stale: 0.6,
  attribution: 0.75,
} as const;

/*
 * Where one clause of a sentence ends and the next begins, for the polarity
 * check: commas, semicolons, dashes, and the conjunctions that start a new
 * predicate. Crude, and deliberately so — it only has to stop a negation in
 * a trailing clause ("…, a difference the authors described as not
 * significant") from flipping the sentence it is attached to.
 */
const CLAUSE_BREAK = /\s*[,;:]\s+|\s+[-–—]\s+|\s+(?=(?:and|but|while|whereas|although|though|which|who)\s)/i;

/**
 * Where one sentence ends and the next begins, for the clause split: a full
 * stop, question or exclamation mark (and any closing quote or bracket),
 * whitespace, then a capital or an opening quote or bracket before one.
 *
 * `splitSentences` does not end a sentence after a figure ("…in 2024. Most of
 * its rules…"), so the span `bestMatchingSentence` hands the polarity check
 * can be two sentences — and a claim clause lined up against a "clause"
 * spanning both read the second sentence's "not" as its own. Here a figure
 * ends a sentence like any other word; abbreviations and initials do not.
 */
const SENTENCE_END = /(?<=[.!?]["'”’)\]]?)\s+(?=["'“‘(\[]?\p{Lu})/gu;
const INITIAL = /(?:^|[\s(])\p{Lu}\.$/u;

function sentencesIn(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of text.matchAll(SENTENCE_END)) {
    const head = text.slice(start, m.index);
    if (ABBREVIATIONS.test(head) || INITIAL.test(head)) continue;
    out.push(head);
    start = m.index + m[0].length;
  }
  out.push(text.slice(start));
  return out;
}

/** A clause whose verb is elided after its auxiliary, negated or not: "but the House did", "but Beta did too". */
const ELIDED_VERB =
  /\b(?:(?:did|does|do|has|have|had|is|are|was|were|could|would|will|can|should)(?:\s+not)?(?:\s+(?:too|also|so))?|didn't|doesn't|don't|hasn't|haven't|hadn't|isn't|aren't|wasn't|weren't|couldn't|wouldn't|won't|can't)\s*[.!?]?$/i;

/** A clause whose verb is elided after its negation: "but its profits did not", "though costs haven't". */
const ELIDED_NEGATION =
  /\b(?:(?:did|does|do|has|have|had|is|are|was|were|could|would|will|can|should)\s+not|didn't|doesn't|don't|hasn't|haven't|hadn't|isn't|aren't|wasn't|weren't|couldn't|wouldn't|won't|can't)\s*[.!?]?$/i;

/**
 * The clauses of a text: its sentences (`sentencesIn`), each split at
 * CLAUSE_BREAK.
 *
 * A piece with no content word of its own is one of two things. An elided
 * negation of the clause before it ("Revenue was expected to rise, but did
 * not") joins that clause: on its own it would carry the "not" away from the
 * predicate it denies. Anything else — an alternative or a hedge tail such
 * as "if not more", "not 3%" or "or not" — denies nothing the claim states,
 * names nothing a claim clause could line up with, and is left out; joined
 * to the main clause it read "shares rose 5%, if not more" as shares not
 * rising.
 */
export function clausesOf(sentence: string): string[] {
  const out: string[] = [];
  for (const part of sentencesIn(sentence)) {
    for (const piece of part.split(CLAUSE_BREAK).map((c) => c.trim()).filter((c) => c.length > 0)) {
      if (contentTokens(piece).size > 0) out.push(piece);
      else if (out.length > 0 && ELIDED_NEGATION.test(piece)) out[out.length - 1] = `${out[out.length - 1]} ${piece}`;
    }
  }
  return out.length > 0 ? out : [sentence];
}

/**
 * The clause of `sentence` the claim is about: the one sharing the most of
 * its content words, the first on a tie.
 */
export function bestMatchingClause(claim: string, sentence: string): string {
  const clauses = clausesOf(sentence);
  let best = clauses[0]!;
  let bestScore = -1;
  for (const clause of clauses) {
    const score = tokenCoverage(claim, clause);
    if (score > bestScore) {
      bestScore = score;
      best = clause;
    }
  }
  return best;
}

/**
 * The alignment (`fullAlignment`) a claim clause needs with a passage clause
 * before their negations are compared. A clause that matches nothing in the
 * passage ("the trial found") says nothing about the passage's polarity.
 */
const CLAUSE_MATCH_MIN = 0.5;

/**
 * Whether `passageClause` is an elided negation answering `claimClause`:
 * every word it names is in the claim clause, and its own verb is left out
 * ("Profits rose" ← "but profits did not"). Such a clause is short by
 * construction, so it never wins on shared words alone.
 */
function elidedAnswer(claimClause: string, passageClause: string): boolean {
  return ELIDED_NEGATION.test(passageClause.trim()) && tokenCoverage(passageClause, claimClause) === 1;
}

/** Words that join a clause to the one before it and say nothing about what either is about. */
const CONNECTIVES = new Set("although though whereas however yet because since unless despite instead meanwhile".split(" "));

/** Past tenses no suffix rule reaches, by bare form: "did not pay" is "paid", "did not meet" is "met". */
const IRREGULAR_PAST: Record<string, string> = {
  pay: "paid", meet: "met", rise: "rose", fall: "fell", grow: "grew", make: "made", take: "took", give: "gave",
  win: "won", lose: "lost", sell: "sold", buy: "bought", hold: "held", keep: "kept", leave: "left", begin: "began",
  see: "saw", go: "went", come: "came", become: "became", build: "built", lead: "led", spend: "spent", send: "sent",
  bring: "brought", find: "found", tell: "told", write: "wrote", choose: "chose", drive: "drove", run: "ran",
  hit: "hit", cut: "cut", set: "set", put: "put", say: "said", think: "thought", know: "knew", show: "showed",
};

function pastOf(verb: string): string {
  if (IRREGULAR_PAST[verb]) return IRREGULAR_PAST[verb];
  if (verb.endsWith("e")) return `${verb}d`;
  if (/[^aeiou]y$/.test(verb)) return `${verb.slice(0, -1)}ied`;
  return `${verb}ed`;
}

function thirdPersonOf(verb: string): string {
  if (verb === "have") return "has";
  if (/(?:s|sh|ch|x|z|o)$/.test(verb)) return `${verb}es`;
  if (/[^aeiou]y$/.test(verb)) return `${verb.slice(0, -1)}ies`;
  return `${verb}s`;
}

/**
 * A negation with "do" puts the verb in its bare form and the tense on the
 * auxiliary: "approved" → "did not approve", "pays" → "does not pay", "met"
 * → "did not meet". For lining clauses up, the verb gets its tense back
 * ("did not approved", "does not pays"), so the clause that denies a claim
 * shares the claim's verb rather than one word fewer than an unrelated
 * clause naming the same subject — and "paid in 2019" still differs from
 * "does not pay". The negation itself is untouched (parity is read on the
 * clause as written).
 */
function inflectDoSupport(text: string): string {
  return text.replace(
    /\b(did|does)(\s+not|n['’]t)(\s+)((?:[a-z]+ly\s+)?)(?!not\b)([a-z]+)\b/gi,
    (_whole, aux: string, neg: string, gap: string, adverb: string, verb: string) => {
      const v = verb.toLowerCase();
      return `${aux}${neg}${gap}${adverb}${aux.toLowerCase() === "did" ? pastOf(v) : thirdPersonOf(v)}`;
    }
  );
}

/** What a contraction leaves behind once its apostrophe splits it ("didn't" → "didn"): no content. */
const CONTRACTION_STUBS = new Set("didn doesn don isn wasn weren aren hasn haven hadn won wouldn couldn shouldn mustn needn".split(" "));

/** The content words of a clause as `fullAlignment` compares them: do-support undone, connectives left out. */
function alignmentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of contentTokens(inflectDoSupport(text))) {
    if (!CONNECTIVES.has(token) && !CONTRACTION_STUBS.has(token)) out.add(token);
  }
  return out;
}

function shareOf(of: Set<string>, within: Set<string>): number {
  if (of.size === 0) return 0;
  let hit = 0;
  for (const t of of) if (within.has(t)) hit += 1;
  return hit / of.size;
}

/** The harmonic mean of the share of each token set the other holds: how well two clauses line up. */
function alignmentOf(a: Set<string>, b: Set<string>): number {
  const forward = shareOf(a, b);
  const backward = shareOf(b, a);
  return forward + backward === 0 ? 0 : (2 * forward * backward) / (forward + backward);
}

/** Two alignment scores this close are a tie: neither clause is the better match. */
const ALIGNMENT_TIE = 1e-9;

/** Words that open a clause and join it to the one before: never part of its subject. */
const CLAUSE_OPENERS = new Set("and but while whereas although though which who yet so however meanwhile instead then also".split(" "));
/** Personal pronouns that stand for the subject of an earlier clause. */
const SUBJECT_PRONOUNS = new Set("it they he she".split(" "));
/** Auxiliaries, copulas, modals and negators: the first of them opens the predicate. */
const AUXILIARIES = new Set(
  ("is are was were be been am has have had do does did will would shall should can could may might must not never cannot " +
    "isn't aren't wasn't weren't hasn't haven't hadn't doesn't don't didn't won't wouldn't can't couldn't shouldn't")
    .split(" ")
);
const IRREGULAR_PAST_FORMS = new Set(Object.values(IRREGULAR_PAST));

/**
 * A clause split into its subject and its predicate, by where the verb
 * starts: the first auxiliary or negator ("The European Central Bank | did
 * not raise rates"), else the first lowercase past tense ("The city council |
 * approved the plan", "Prices | rose") or present tense in front of an object
 * ("Acme Robotics | sells its robots"). A lead-in phrase before the subject
 * ("In 2024 the firm | was …") stays with the predicate. Word heuristics:
 * the predicate comparison they feed can only take a contradiction away
 * (`polarityDisagrees`), and the subject only stands in for a later
 * pronoun (`readClauses`), where a misplaced split costs the pronoun's
 * clause an extra word or a missing one.
 *
 * `predicate` is null when no verb is found; `pronoun` is the subject when
 * it is one personal pronoun ("It did not raise rates in 2024").
 */
function clauseParts(clause: string): { subject: string; predicate: string | null; pronoun: string | null; elliptic: boolean } {
  const words = [...clause.matchAll(WORD_RE)];
  const lower = (i: number) => words[i]![0].toLowerCase().replace(/’/g, "'");
  let first = 0;
  while (first < words.length && CLAUSE_OPENERS.has(lower(first))) first += 1;
  if (first >= words.length) return { subject: "", predicate: null, pronoun: null, elliptic: false };
  if (SUBJECT_PRONOUNS.has(lower(first)) && first + 1 < words.length) {
    return { subject: words[first]![0], predicate: clause.slice(words[first + 1]!.index), pronoun: lower(first), elliptic: false };
  }
  // "but not suspended", "and did not raise prices": joined on, the subject left out.
  if (first > 0 && AUXILIARIES.has(lower(first))) {
    return { subject: "", predicate: clause.slice(words[first]!.index), pronoun: null, elliptic: true };
  }
  let verb = -1;
  for (let j = first; j < words.length && verb < 0; j += 1) {
    const w = lower(j);
    if (AUXILIARIES.has(w)) verb = j;
    else if (j === first || isTitleCase(words[j]![0])) continue;
    else if (IRREGULAR_PAST_FORMS.has(w)) verb = j;
    else if (w.length > 4 && w.endsWith("ed") && !DETERMINERS.has(lower(j - 1))) verb = j;
    else if (w.length > 3 && /[^su'i]s$/.test(w) && !DETERMINERS.has(lower(j - 1)) && !PREPOSITIONS.has(lower(j - 1))) {
      const next = words[j + 1];
      const after = clause.slice(words[j]!.index + words[j]![0].length, next?.index ?? clause.length);
      if (/\d/.test(after) || (next && DETERMINERS.has(next[0].toLowerCase()))) verb = j;
    }
  }
  if (verb < 0) return { subject: "", predicate: null, pronoun: null, elliptic: false };
  let from = first;
  if (PREPOSITIONS.has(lower(first))) {
    from = verb;
    for (let k = verb - 1; k > first; k -= 1) {
      if (DETERMINERS.has(lower(k))) {
        from = k;
        break;
      }
    }
  }
  const subjectStart = words[from]?.index ?? clause.length;
  const verbStart = words[verb]!.index;
  return {
    subject: clause.slice(subjectStart, verbStart).trim(),
    predicate: `${clause.slice(0, subjectStart)} ${clause.slice(verbStart)}`.trim(),
    pronoun: null,
    elliptic: false,
  };
}

/** A clause as the polarity check compares it. */
interface ReadClause {
  /** As written: its negations are counted here, never on the resolved text. */
  text: string;
  parity: 0 | 1;
  /** `alignmentTokens`, with a pronoun subject read as the subject it stands for. */
  tokens: Set<string>;
  /** `alignmentTokens` of the predicate alone; null when no verb was found. */
  predicate: Set<string> | null;
  /** `alignmentTokens` of the subject, a pronoun read as the subject it stands for; null when no verb was found. */
  subject: Set<string> | null;
  dates: DateMention[];
}

/** The context-free half of `ReadClause`, per clause text: a long page repeats the work for every claim otherwise. */
const CLAUSE_READINGS = new Map<string, { parts: ReturnType<typeof clauseParts>; read: ReadClause }>();
const CLAUSE_READINGS_LIMIT = 4096;

function readingOf(text: string): { parts: ReturnType<typeof clauseParts>; read: ReadClause } {
  const known = CLAUSE_READINGS.get(text);
  if (known) return known;
  const parts = clauseParts(text);
  const reading = {
    parts,
    read: {
      text,
      parity: negationParity(text),
      tokens: alignmentTokens(text),
      predicate: parts.predicate === null ? null : alignmentTokens(parts.predicate),
      subject: parts.predicate === null || parts.pronoun || parts.elliptic ? null : alignmentTokens(parts.subject),
      dates: extractDates(text),
    },
  };
  if (CLAUSE_READINGS.size >= CLAUSE_READINGS_LIMIT) CLAUSE_READINGS.delete(CLAUSE_READINGS.keys().next().value!);
  CLAUSE_READINGS.set(text, reading);
  return reading;
}

/**
 * The clauses of a text, read in order, each pronoun subject standing for the
 * last subject named before it: "The European Central Bank raised rates in
 * 2023. It did not raise rates in 2024." reads its second clause as "The
 * European Central Bank did not raise rates in 2024". Without that, a
 * subject of several words gave the first clause all of them and the second
 * none, and a claim restating the denial lined up with the clause it denies.
 * Only a personal pronoun is resolved: "the company", "the regulator" may be
 * another entity, and are left to the predicate comparison.
 *
 * Ellipsis is read the same way. A clause joined on without a subject ("The
 * dividend was cut, but not suspended") has the last subject named; a
 * clause whose verb is left out after its auxiliary ("Revenue rose, but the
 * dividend did not"; "The Senate did not pass the bill, but the House did")
 * has the predicate of the clause before it. Its negation is still counted
 * on the clause as written: "but the House did" denies nothing.
 */
function readClauses(clauses: readonly string[]): ReadClause[] {
  let antecedent: string | null = null;
  let lastPredicate: string | null = null;
  return clauses.map((text) => {
    const { parts, read } = readingOf(text);
    const borrowsSubject = parts.pronoun !== null || parts.elliptic;
    const borrowsPredicate =
      !borrowsSubject && read.predicate !== null && read.predicate.size === 0 && ELIDED_VERB.test(text.trim());
    if (!borrowsSubject && parts.subject && contentTokens(parts.subject).size > 0) antecedent = parts.subject;
    if (!borrowsPredicate && read.predicate && read.predicate.size > 0) lastPredicate = parts.predicate;
    if (borrowsSubject && antecedent && parts.predicate) {
      return { ...read, tokens: alignmentTokens(`${antecedent} ${parts.predicate}`), subject: alignmentTokens(antecedent) };
    }
    if (borrowsPredicate && lastPredicate) {
      const predicate = alignmentTokens(lastPredicate);
      return { ...read, tokens: new Set([...read.tokens, ...predicate]), predicate };
    }
    return read;
  });
}

/**
 * The candidates scoring best, every one of them when several tie; empty when
 * none reaches `min`.
 */
function tiedBest(candidates: readonly ReadClause[], score: (c: ReadClause) => number, min: number): ReadClause[] {
  let best: ReadClause[] = [];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const value = score(candidate);
    if (value < min - ALIGNMENT_TIE) continue;
    if (value > bestScore + ALIGNMENT_TIE) {
      bestScore = value;
      best = [candidate];
    } else if (value >= bestScore - ALIGNMENT_TIE) {
      best.push(candidate);
    }
  }
  return best;
}

/** Of tied clauses, those naming no date the claim clause does not: the others are about another time. */
function sameTimeOnly(clause: ReadClause, best: ReadClause[]): ReadClause[] {
  if (best.length < 2 || clause.dates.length === 0) return best;
  const sameTime = best.filter((candidate) => candidate.dates.every((d) => clause.dates.some((c) => datesAgree(c, d))));
  return sameTime.length > 0 ? sameTime : best;
}

/**
 * The candidates worth lining a claim clause up with: when the claim clause
 * names a date, a clause naming only other dates is about another time
 * ("Northwind did not raise prices in 2023" beside a claim about 2024) —
 * unless every clause is.
 */
function sameTimeCandidates(clause: ReadClause, candidates: readonly ReadClause[]): readonly ReadClause[] {
  if (clause.dates.length === 0) return candidates;
  const kept = candidates.filter(
    (candidate) => candidate.dates.length === 0 || candidate.dates.some((d) => clause.dates.some((c) => datesAgree(c, d)))
  );
  return kept.length > 0 ? kept : candidates;
}

/** How well a claim clause lines up with a passage clause, an elided negation whose every word is in the claim clause counting as aligned. */
function fullAlignment(clause: ReadClause, candidate: ReadClause): number {
  const f1 = alignmentOf(clause.tokens, candidate.tokens);
  return elidedAnswer(clause.text, candidate.text) ? Math.max(f1, CLAUSE_MATCH_MIN) : f1;
}

/**
 * The passage clauses a claim clause lines up with best on everything it
 * says (`fullAlignment`), every one when several tie, a tie broken by the
 * dates (`sameTimeOnly`).
 */
function bestAlignedClauses(clause: ReadClause, candidates: readonly ReadClause[], min: number): ReadClause[] {
  return sameTimeOnly(clause, tiedBest(candidates, (c) => fullAlignment(clause, c), min));
}

/**
 * The passage clauses holding the largest share of the claim clause's words,
 * whatever else they say, among those lined up at `min` at least; a tie
 * broken by the dates. "Northwind opened a factory in Ohio in 2024. It did
 * not open a factory in Texas." holds all of "Northwind opened a factory" in
 * both clauses: the second lines up better only for adding less, and denying
 * a narrower statement than the claim's is not denying the claim.
 */
function bestCoveringClauses(clause: ReadClause, candidates: readonly ReadClause[], min: number): ReadClause[] {
  const aligned = candidates.filter((c) => fullAlignment(clause, c) >= min - ALIGNMENT_TIE);
  return sameTimeOnly(clause, tiedBest(aligned, (c) => shareOf(clause.tokens, c.tokens), ALIGNMENT_TIE));
}

/**
 * The passage clauses a claim clause lines up with best on its PREDICATE —
 * subjects left out on both sides — at CLAUSE_MATCH_MIN at least, with every
 * clause whose predicate holds the claim clause's whole predicate ("…did not
 * fine Apple in 2024 either"). Empty when the claim clause has no predicate
 * to compare.
 *
 * When those clauses disagree with one another, only the subject can say
 * which one the claim is about, and only when a best-matching clause names
 * the claim clause's subject in the same words, no more and no fewer
 * ("Alpha did not raise prices" beside "Beta raised prices", for a claim
 * about Alpha; a pronoun counts as the subject it stands for); then the
 * clauses that do are kept. "A rival vaccine" holds every word of "the
 * vaccine" and is another vaccine. Otherwise every clause is kept: "Contoso Air added flights to Lisbon. The
 * low-cost carrier did not add flights to Porto. Ryanair added flights to
 * Porto." gives "Contoso Air did not add flights to Porto" two clauses with
 * its predicate, neither naming Contoso Air, and the carrier may or may not
 * be Contoso Air while Ryanair is not. Breaking that tie by the full
 * alignment favoured the clause whose subject has fewer words of its own —
 * the rival's — and declared the honest claim contradicted. Dates break
 * what is left (`sameTimeOnly`).
 */
function bestPredicateClauses(clause: ReadClause, candidates: readonly ReadClause[]): ReadClause[] {
  const own = clause.predicate;
  if (!own || own.size === 0) return [];
  const predicateOf = (c: ReadClause) => c.predicate ?? c.tokens;
  const best = tiedBest(candidates, (c) => alignmentOf(own, predicateOf(c)), CLAUSE_MATCH_MIN);
  if (best.length === 0) return best;
  const holding = candidates.filter(
    (c) => !best.includes(c) && shareOf(own, predicateOf(c)) === 1 && alignmentOf(own, predicateOf(c)) >= CLAUSE_MATCH_MIN
  );
  const picked = [...best, ...holding];
  if (picked.every((c) => c.parity === picked[0]!.parity)) return sameTimeOnly(clause, picked);
  const subject = clause.subject;
  const named =
    subject && subject.size > 0
      ? picked.filter((c) => c.subject !== null && shareOf(subject, c.subject) === 1 && shareOf(c.subject, subject) === 1)
      : [];
  // Only a best match settles it: a clause that merely holds the predicate is there to stop a contradiction, never to make one.
  return sameTimeOnly(clause, named.some((c) => best.includes(c)) ? named : picked);
}

/**
 * Whether the passage states the opposite of the claim, with negation
 * compared clause against clause — the SAME level on both sides, and never
 * across a sentence end on either (`clausesOf`).
 *
 * Whole sentence against whole sentence read "Serious adverse events occurred
 * in 3% …, a difference described as not significant" as denying the 3%: the
 * "not" negates another predicate. But narrowing only the passage is worse:
 * a claim identical to its source, "Sales rose sharply, but profits did not",
 * then had its whole-sentence "not" compared with the passage's one negation-
 * free clause, and an honest sentence was rewritten as "Conflicting
 * evidence". So each clause of the claim is compared with the passage clause
 * it lines up with best.
 *
 * "Best" is the alignment both ways (`fullAlignment`), not the share of the
 * claim's words a clause holds, with a pronoun read as the subject it stands
 * for (`readClauses`): "The European Central Bank raised rates in 2023. It
 * did not raise rates in 2024." lines "The European Central Bank did not
 * raise rates in 2024" up with the second clause, not with the first that
 * holds its subject's words. A clause naming only another date than the
 * claim clause's is about another time and is passed over
 * (`sameTimeCandidates`); a tie is broken by the dates too; when nothing
 * breaks it ("Northwind was profitable in Asia. The company was not
 * profitable in Europe."), the text cannot say which clause the claim is
 * about: if any of them agrees with the claim, it is no contradiction, and
 * the judge decides.
 *
 * The predicate decides too. "The Federal Reserve cut rates in March. The
 * central bank did not cut rates in June." — "the central bank" may or may
 * not be the Federal Reserve, so the subject's words line the claim "The
 * Federal Reserve did not cut rates in June" up with the first clause, and
 * its predicate with the second. When the clause the subject picks and the
 * clause the predicate picks (`bestPredicateClauses`) disagree, the text
 * settles nothing: a contradiction needs every clause either one picks — and
 * every clause holding as much of the claim (`bestCoveringClauses`) — to
 * deny the claim. Those extra picks can only take a contradiction away.
 *
 * `sentence` is what the claim is matched to (`focusSentences`); `context`
 * that plus its neighbours, where a pronoun or a renamed subject carries the
 * denial on ("…in 2023. It did not…"). A one-clause claim is also compared
 * with any elided negation in `sentence` that answers it: "Profits rose in
 * 2024" against "Sales rose in 2024, but profits did not" shares more words
 * with the sales clause, and the "not" that denies it sits in a clause with
 * no verb of its own — and one agreeing with it ("Beta did not raise prices"
 * ← "Alpha raised prices. Beta did not.") is a clause it is about, so the
 * clause about Alpha no longer settles it. A claim of several clauses keeps
 * to the best match only, because "Revenue rose, but revenue did not" lines
 * each of its clauses up with both of its source's.
 */
export function polarityDisagrees(claim: string, sentence: string, context: string = sentence): boolean {
  // No negation on either side: every clause has the same parity, and nothing to line up.
  if (!ANY_NEGATOR.test(normalizeText(claim)) && !ANY_NEGATOR.test(normalizeText(context))) return false;
  const clauses = readClauses(clausesOf(claim));
  const candidates = readClauses(clausesOf(context));
  const deniedBy = (clause: ReadClause, min: number, alsoPicked: readonly ReadClause[] = []) => {
    const pool = sameTimeCandidates(clause, candidates);
    const full = bestAlignedClauses(clause, pool, min);
    if (full.length === 0) return false;
    const picked = [...full, ...bestCoveringClauses(clause, pool, min), ...bestPredicateClauses(clause, pool), ...alsoPicked];
    return picked.every((candidate) => candidate.parity !== clause.parity);
  };
  if (clauses.length <= 1) {
    // The clause, not the whole claim: a hedge tail left out of it ("…, if
    // not more") must not flip it either. No alignment floor: the caller
    // already holds the sentence to a coverage floor against the claim.
    const clause = clauses[0]!;
    const elided = clausesOf(sentence).filter((candidate) => elidedAnswer(clause.text, candidate));
    if (elided.some((candidate) => negationParity(candidate) !== clause.parity)) return true;
    // An elided answer agreeing with the claim ("Beta did not raise prices"
    // ← "Alpha raised prices. Beta did not.") is the clause it is about.
    return deniedBy(clause, 0, elided.map((candidate) => readingOf(candidate).read));
  }
  return clauses.some((clause) => deniedBy(clause, CLAUSE_MATCH_MIN));
}

/** The sentence in the passage the claim is actually about. */
export function bestMatchingSentence(claim: string, passage: string): string {
  return focusSentences(claim, passage).sentences[0] ?? passage;
}

/**
 * Every sentence of the passage that shares the most of the claim's content
 * words, in reading order. More than one when they tie: "The vaccine was
 * approved for adults. It was not approved for children." gives both two of
 * the three words of "The vaccine was not approved for children", and only
 * the clauses can say which one the claim is about.
 *
 * `context` is those sentences with the one before each and the two after:
 * a subject named once and then carried on by a pronoun or another name
 * ("Acme Robotics sells its robots in Japan. The startup does not sell its
 * robots in China.") puts the denial in a sentence holding fewer of the
 * claim's words than the one naming the subject.
 */
function focusSentences(claim: string, passage: string): { sentences: string[]; context: string } {
  const all = splitSentences(passage.replace(/\n+/g, " "), 0).map((s) => s.text.trim());
  const claimTokens = cachedContentTokens(claim);
  const scores = all.map((s) => {
    if (s.length <= 20 || claimTokens.size === 0) return Number.NEGATIVE_INFINITY;
    const tokens = contentTokens(s);
    let hit = 0;
    for (const t of claimTokens) if (tokens.has(t)) hit += 1;
    return hit / claimTokens.size;
  });
  const top = Math.max(...scores);
  if (!Number.isFinite(top)) return { sentences: [passage], context: passage };
  const picked = new Set<number>();
  const window = new Set<number>();
  scores.forEach((score, i) => {
    if (score < top - ALIGNMENT_TIE) return;
    picked.add(i);
    for (let k = Math.max(0, i - 1); k <= Math.min(all.length - 1, i + 2); k += 1) window.add(k);
  });
  return {
    sentences: all.filter((_, i) => picked.has(i)),
    context: all.filter((_, i) => window.has(i)).join(" "),
  };
}

/*
 * Capitalised words that name nothing even in mid-sentence ("…; However, …").
 * The first word of every sentence is skipped outright (see `namedSubjects`).
 */
const SENTENCE_STARTERS = new Set(
  ("this that these those it its there here some most many all every each both our we they you he she his her " +
    "however meanwhile overall today yesterday since until unless although though because while when where after before " +
    "during under over above below between among across against about around")
    .split(" ")
);

/** Whether the word at `at` opens a sentence: nothing but opening punctuation since the text began or since a full stop. */
function opensSentence(text: string, at: number): boolean {
  const before = text.slice(0, at).replace(/[\s"'“‘«(\[*_|#>-]+$/u, "");
  return before === "" || /[.!?:]$/.test(before);
}

/**
 * Title-case words of a text, lowercased: the named subjects it talks about
 * (Northwind, Alpha, Plus).
 *
 * The first word of a sentence is skipped unless `withSentenceStarts`: any
 * word opens a sentence in title case, so "Revenue rose to $4.3bn" must not
 * make "revenue" a named subject. On the CLAIM side that is the strict
 * direction for the corroboration rule — fewer names, fewer to find
 * elsewhere. A name that opens the claim is lost to it, which only means its
 * figure has to be in the passage itself.
 */
export function namedSubjects(text: string, opts: { withSentenceStarts?: boolean } = {}): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(/\b[A-Z][a-z][A-Za-z'’-]*/g)) {
    if (!opts.withSentenceStarts && opensSentence(text, match.index)) continue;
    const word = match[0].toLowerCase().replace(/['’]s$/, "");
    if (word.length < 3 || STOPWORDS.has(word) || SENTENCE_STARTERS.has(word)) continue;
    out.add(word);
  }
  return out;
}

/** Every word of a text, lowercased, possessives cut: whether it mentions a name in any case. */
function mentionedWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z'’-]*/g) ?? []).map((w) => w.replace(/['’]s?$/, "")));
}

/**
 * The figures and dates of the other cited sources that may stand in for this
 * passage — only those sources that cover a named subject of the claim this
 * passage does not mention, in any case (see `corroborating` on
 * `auditEvidence`). Each side is read in its strict direction: the claim's
 * names without sentence openers, the passage's mentions in any case, so a
 * common noun can only make the rule harder to meet.
 */
function corroboratingFacts(
  claim: string,
  passage: string,
  others: readonly string[] | undefined
): Array<{ numbers: NumericFact[]; dates: DateMention[] }> {
  if (!others?.length) return [];
  const mentioned = mentionedWords(passage);
  const missing = [...namedSubjects(claim)].filter((name) => !mentioned.has(name));
  if (missing.length === 0) return [];
  return others
    .filter((text) => {
      const names = namedSubjects(text, { withSentenceStarts: true });
      return missing.some((name) => names.has(name));
    })
    .map((text) => figuresOf(text));
}

/**
 * Everything about this claim/passage pair that can be decided without
 * judgement. The result only ever caps the judge's score — it never raises it —
 * because every check here is a reason to trust the citation LESS.
 */
export function auditEvidence(opts: {
  claim: string;
  claimType?: ClaimType;
  passage: string;
  /** The source's publication date, for the publication-vs-event check. */
  publishedAt?: Date | null;
  /**
   * When the audit is being run — "now" for a sentence that says something is
   * true now. Absent: no freshness check at all, which is what keeps every
   * audit recorded before this existed reading back exactly as it was judged
   * (the inspector recomputes reasons, and must not invent a finding the
   * stored strength never paid for).
   */
  asOf?: Date | null;
  /**
   * The text of the OTHER sources this same claim cites. A comparison —
   * "Alpha has 100 GB against Beta's 50 GB [1][2]" — takes one figure from
   * each source, and judged one passage at a time it read as source [1]
   * contradicting the 50 GB (it gives Alpha Free's 5 GB, same unit) and
   * source [2] contradicting the 100. A figure or date the passage lacks is
   * accepted from another cited source when that source covers a named
   * subject of the claim THIS passage does not: so a second subject's figure
   * is found where the claim says it is, while two sources disagreeing about
   * the SAME subject still read as the contradiction they are.
   */
  corroborating?: readonly string[];
}): EvidenceAudit {
  const { claim, passage } = opts;
  const claimType = opts.claimType ?? classify(claim);
  const reasons: AuditReason[] = [];
  let ceiling = 1;
  let contradicted = false;
  // `cap` stamps the ceiling onto the reason rather than asking each call site
  // to repeat it: the two are the same decision, and a site that passed
  // CEILING.quoteAbsent to one and a stale number to the other would publish a
  // severity the validator does not actually enforce.
  const cap = (value: number, reason: Omit<AuditReason, "ceiling">) => {
    ceiling = Math.min(ceiling, value);
    reasons.push({ ...reason, ceiling: value });
  };

  const coverage = coverageOf(claim, passage);
  if (coverage < 0.22) {
    cap(CEILING.offTopic, {
      code: "off_topic",
      detail: "The cited passage barely shares any subject matter with this claim.",
    });
  } else if (coverage < 0.42) {
    cap(CEILING.entityThin, {
      code: "thin_overlap",
      detail: "The passage touches the topic but does not cover most of what the claim names.",
    });
  }

  // ── Quotations ───────────────────────────────────────────────────────────
  // A quotation is the one thing a reader can check character by character, so
  // a near-miss is not close enough: fabricated or "tidied" quotes are the most
  // damaging citation failure there is.
  let normalizedPassage: string | null = null;
  for (const quote of extractQuotes(claim)) {
    normalizedPassage ??= normalizeText(passage);
    if (!normalizedPassage.includes(normalizeText(quote))) {
      cap(CEILING.quoteAbsent, {
        code: "quote_absent",
        detail: `The quoted words are not in the cited passage: “${quote.slice(0, 120)}”.`,
      });
      break;
    }
  }

  // ── Figures ──────────────────────────────────────────────────────────────
  const { dates: claimDates, numbers: claimNums } = figuresOf(claim);
  const { dates: passageDates, numbers: passageNums } = figuresOf(passage);
  const elsewhere = corroboratingFacts(claim, passage, opts.corroborating);
  const statedElsewhere = (raw: string) =>
    cap(1, {
      code: "stated_by_other_citation",
      detail: `${raw} is not in this passage; another source cited for this sentence states it.`,
    });
  const claimFacts = { text: claim, dates: claimDates, numbers: claimNums };
  const passageFacts = { text: passage, dates: passageDates, numbers: passageNums };
  for (const n of claimNums) {
    const sameKind = passageNums.filter((p) => p.kind === n.kind);
    if (sameKind.some((p) => numbersAgree(p.value, n.value))) continue;
    const rival = rivalFigures(claimFacts, n, passageFacts);
    /*
     * Another cited source may supply a figure this passage lacks, never one
     * it may disagree with. `rival` rests on guesses about the measured noun
     * (`sameSubject`), and a wrong guess there only turns a contradiction
     * into an omission; here it would let another source's figure stand in
     * and show the disagreeing passage as SUPPORT. So every figure in the
     * passage that could be the same quantity — any amount of money or
     * percentage, and a count in the same unit — has to be accounted for:
     * the evidence for another of the claim's figures, for the same date, or
     * pinned on a named subject the claim never mentions.
     */
    const accountedFor = () =>
      sameKind.every(
        (p) =>
          (p.kind === "plain" && !sameQuantity(claim, n, passage, p)) ||
          evidenceForAnotherFigure(claimFacts, n, passageFacts, p, { strict: true }) ||
          namesOtherSubject(claim, passage, p)
      );
    if (
      rival.length === 0 &&
      elsewhere.some((facts) => facts.numbers.some((p) => p.kind === n.kind && numbersAgree(p.value, n.value))) &&
      accountedFor()
    ) {
      statedElsewhere(n.raw);
      continue;
    }
    if (rival.length > 0) {
      // The passage measures the same thing and says something else. That is a
      // contradiction, not an omission — the difference matters, because a
      // contradicted claim must never read as merely unverified.
      contradicted = true;
      cap(0, {
        code: "figure_mismatch",
        detail: `The passage gives ${rival.map((p) => p.raw).slice(0, 3).join(", ")} where the claim says ${n.raw}.`,
      });
    } else {
      cap(CEILING.figureAbsent, {
        code: "figure_absent",
        detail: `The figure ${n.raw} does not appear in the cited passage.`,
      });
    }
  }

  // ── Dates, and the publication/event trap ────────────────────────────────
  const pubYear = opts.publishedAt?.getUTCFullYear();
  for (const d of claimDates) {
    if (passageDates.some((p) => datesAgree(p, d))) continue;
    if (elsewhere.some((facts) => facts.dates.some((p) => datesAgree(p, d)))) {
      statedElsewhere(d.raw);
      continue;
    }
    if (pubYear != null && d.year === pubYear) {
      cap(CEILING.dateWrong, {
        code: "date_is_publication_date",
        detail: `${d.raw} is when this source was published, not a date the passage attaches to the event.`,
      });
    } else {
      cap(CEILING.dateWrong, {
        code: "date_absent",
        detail: `The cited passage does not place this in ${d.raw}.`,
      });
    }
  }

  // ── Polarity ─────────────────────────────────────────────────────────────
  // Only meaningful where the two sentences are about the same thing; on an
  // unrelated passage a negation difference says nothing.
  // Every sentence tied for the claim goes to the clause check, which picks
  // between them; the hedge and attribution checks below read the first.
  const focused = focusSentences(claim, passage);
  const focus = focused.sentences[0]!;
  if (tokenCoverage(claim, focus) >= 0.45 && polarityDisagrees(claim, focused.sentences.join(" "), focused.context)) {
    contradicted = true;
    cap(0, {
      code: "polarity_mismatch",
      detail: "The passage states the opposite of this claim.",
    });
  }

  // ── Lists where the passage only covers part of the list ─────────────────
  /*
   * "The ban covers single-use plastics, packaging foam and disposable vapes"
   * cited to a passage that covers only the plastics is a very common and very
   * quiet failure: overall word overlap stays high, so neither the judge nor
   * the coverage floor notices that a third of the sentence has no evidence
   * behind it. Only enumerations of three or more are checked — a two-part
   * sentence is usually one assertion with a qualifier, not a list.
   */
  const items = claim.split(/,\s+|\s+and\s+/).filter((seg) => contentTokens(seg).size > 0);
  if (items.length >= 3) {
    const passageTokens = cachedContentTokens(passage);
    const missing = items.filter((seg) => [...contentTokens(seg)].every((t) => !passageTokens.has(t)));
    if (missing.length > 0) {
      cap(CEILING.unstatedLeap, {
        code: "enumeration_incomplete",
        detail: `The passage says nothing about ${missing.map((s) => `“${s.trim()}”`).join(", ")}.`,
      });
    }
  }

  // ── Leaps the passage never made ─────────────────────────────────────────
  if (SUPERLATIVES.test(claim) && !SUPERLATIVES.test(passage)) {
    cap(CEILING.unstatedLeap, {
      code: "superlative_unstated",
      detail: "The claim asserts a first/largest/only that the passage never states.",
    });
  }
  if (CAUSAL.test(claim) && !CAUSAL.test(passage)) {
    cap(CEILING.unstatedLeap, {
      code: "causation_unstated",
      detail: "The claim asserts a cause the passage does not draw.",
    });
  }

  // ── Certainty laundering ─────────────────────────────────────────────────
  // A passage saying a merger "is expected to close" cannot support a report
  // saying it closed. Predictions are exempt: a hedged source is exactly the
  // right evidence for a claim that presents itself as a forecast.
  if (claimType !== "prediction" && claimType !== "opinion" && isHedged(focus) && !isHedged(claim)) {
    cap(CEILING.hedged, {
      code: "passage_hedged",
      detail: "The passage hedges what the claim states as settled fact.",
    });
  }
  if (ATTRIBUTION.test(focus) && !ATTRIBUTION.test(claim)) {
    cap(CEILING.attribution, {
      code: "attribution_dropped",
      detail: "The passage attributes this to someone; the claim presents it as established.",
    });
  }

  // ── Freshness: a sentence about NOW, resting on a page from THEN ─────────
  const stale = staleForPresent({
    claim,
    claimType,
    claimDates,
    passageDates,
    publishedAt: opts.publishedAt ?? null,
    asOf: opts.asOf ?? null,
  });
  if (stale) {
    cap(CEILING.stale, {
      code: "source_stale",
      detail: `This source was published ${stale.published}, ${describeAge(stale.days)} before this check, so it cannot show the claim is still true today.`,
    });
  }

  return { ceiling, contradicted, reasons };
}

/**
 * For a claim that names no date: whether a passage that gives a different
 * figure is about another period than the passage that supports it, so the
 * difference is not a disagreement. "Northwind's revenue was $4.3 billion",
 * supported by an annual report's "$4.3 billion in 2024", is not disputed by
 * the same report's "$3.9 billion in 2023": each figure is pinned to its own
 * year and the years differ. Nor by "A year earlier, revenue was $3.9
 * billion", "… in the prior year" or "… two years ago": a figure its own
 * words place before (or after) another period is not the period of the one
 * beside it, dated or not (`figureRelativePeriod`). A fiscal year is a date
 * ("FY2023", `extractDates`).
 *
 * False — record the disagreement — whenever the claim is dated (the date
 * checks already decide that: `disagreesForSamePeriod`), whenever a differing
 * figure neither carries a date of its own nor places itself relative to
 * another period, when the supporting figure carries no date for a dated
 * rival to differ from, and when the two dates agree.
 */
export function differentPeriodForUndatedClaim(claim: string, supporting: string, conflicting: string): boolean {
  const claimDates = extractDates(claim);
  if (claimDates.length > 0) return false;
  const facts = (text: string) => {
    const dates = extractDates(text);
    return { text, dates, numbers: extractNumbers(text, dates) };
  };
  const claimFacts = facts(claim);
  const supportFacts = facts(supporting);
  const conflictFacts = facts(conflicting);
  let differs = false;
  for (const n of claimFacts.numbers) {
    if (conflictFacts.numbers.some((p) => p.kind === n.kind && numbersAgree(p.value, n.value))) continue;
    const rivals = rivalFigures(claimFacts, n, conflictFacts);
    if (rivals.length === 0) continue;
    const support = supportFacts.numbers.find((p) => p.kind === n.kind && numbersAgree(p.value, n.value));
    const supportAt = support ? figureDate(supporting, support, supportFacts.dates) : null;
    const supportRelative = support ? figureRelativePeriod(supporting, support) : null;
    for (const rival of rivals) {
      const relative = figureRelativePeriod(conflicting, rival);
      if (relative && relative !== supportRelative) continue;
      const at = figureDate(conflicting, rival, conflictFacts.dates);
      if (!supportAt || !at || datesAgree(at, supportAt)) return false;
    }
    differs = true;
  }
  return differs;
}

/**
 * Whether a present-tense claim rests on a source too old to say anything
 * about the present. Null when the check does not apply or passes.
 *
 * It applies only when every one of these holds, because each one missing is
 * a case where "old source" says nothing about the sentence:
 *  - the audit knows when it is running (`asOf`);
 *  - the claim says something is true NOW (`PRESENT_STATE`) and is neither a
 *    forecast nor an opinion;
 *  - the claim names no date of its own — "as of March 2024" anchors the
 *    sentence, and the date checks above already judge that;
 *  - the source has a publication date. An undated page is the live page as
 *    fetched (a pricing or docs page usually carries no date), which is
 *    evidence about the present, not against it;
 *  - the passage itself carries no recent date ("As of September 2026, …"):
 *    an old page that was updated says when.
 */
function staleForPresent(input: {
  claim: string;
  claimType: ClaimType;
  claimDates: readonly DateMention[];
  passageDates: readonly DateMention[];
  publishedAt: Date | null;
  asOf: Date | null;
}): { published: string; days: number } | null {
  const { asOf, publishedAt } = input;
  if (!asOf || !publishedAt || !Number.isFinite(asOf.getTime()) || !Number.isFinite(publishedAt.getTime())) return null;
  if (input.claimType === "prediction" || input.claimType === "opinion") return null;
  if (input.claimDates.length > 0 || !PRESENT_STATE.test(input.claim)) return null;
  const days = (asOf.getTime() - publishedAt.getTime()) / DAY_MS;
  if (days <= STALE_FOR_PRESENT_DAYS) return null;
  // A date AFTER the audit is a target or a deadline ("50 GW by 2030"), not
  // evidence the page was updated; only a recent past date counts.
  const recentInPassage = input.passageDates.some((d) => {
    const at = Date.UTC(d.year, (d.month ?? 1) - 1, d.day ?? 1);
    const age = (asOf.getTime() - at) / DAY_MS;
    return age >= 0 && age <= STALE_FOR_PRESENT_DAYS;
  });
  if (recentInPassage) return null;
  return { published: publishedAt.toISOString().slice(0, 10), days };
}

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

export interface JudgeVerdict {
  verdict: "supported" | "partial" | "unsupported" | "contradicted";
  /** The judge's own confidence that the passage entails the claim, 0..1. */
  strength: number;
  reason?: string;
}

/**
 * The LLM step, injected. Returning null means "no model answered" — which must
 * NOT be read as "unsupported": a claim nobody checked is unverified, and
 * saying otherwise would be a different lie in the other direction.
 */
export type CitationJudge = (input: {
  claim: string;
  claimType: ClaimType;
  passage: string;
  sourceTitle?: string;
  publishedAt?: Date | null;
}) => Promise<JudgeVerdict | null>;

export interface LinkVerdict {
  status: ClaimStatus;
  stance: LinkStance;
  /** ResearchClaimLink.strength / ResearchClaim.supportStrength. */
  strength: number;
  label: SupportLabel;
  reasons: AuditReason[];
  /** True when no model was available, so this verdict rests on the audit alone. */
  degraded: boolean;
  judgeReason?: string;
}

/**
 * Re-read the cited passage and decide whether it genuinely supports the claim.
 *
 * Order matters. The audit runs FIRST and unconditionally, so a contradiction
 * that is visible in the text (a different figure, a flipped polarity) is
 * settled without spending a model call and without giving an optimistic judge
 * the chance to override it. The judge then supplies the entailment reasoning
 * the audit cannot do, and its score is clamped by the audit's ceiling.
 */
export async function validateClaimAgainstPassage(opts: {
  claim: string;
  claimType?: ClaimType;
  passage: string;
  sourceTitle?: string;
  publishedAt?: Date | null;
  /** When the audit runs, for the freshness check. See `auditEvidence`. */
  asOf?: Date | null;
  /** The claim's other cited sources' text. See `auditEvidence`. */
  corroborating?: readonly string[];
  judge: CitationJudge;
}): Promise<LinkVerdict> {
  const claimType = opts.claimType ?? classify(opts.claim);
  const audit = auditEvidence({
    claim: opts.claim,
    claimType,
    passage: opts.passage,
    publishedAt: opts.publishedAt,
    asOf: opts.asOf,
    corroborating: opts.corroborating,
  });

  if (audit.contradicted) {
    return {
      status: "contradicted",
      stance: "contradicts",
      strength: 0,
      label: "contradicted",
      reasons: audit.reasons,
      degraded: false,
    };
  }

  const verdict = await opts.judge({
    claim: opts.claim,
    claimType,
    passage: opts.passage,
    sourceTitle: opts.sourceTitle,
    publishedAt: opts.publishedAt,
  });

  if (!verdict) {
    // No judge. The audit alone can rule a citation OUT but never in — entailment
    // is the part it cannot do — so the honest answer is "unverified", carrying
    // the ceiling so the UI can still show what the text objected to.
    return {
      status: "unverified",
      stance: "supports",
      strength: 0,
      label: "unverified",
      reasons: audit.reasons,
      degraded: true,
    };
  }

  if (verdict.verdict === "contradicted") {
    return {
      status: "contradicted",
      stance: "contradicts",
      strength: 0,
      label: "contradicted",
      reasons: audit.reasons,
      degraded: false,
      judgeReason: verdict.reason,
    };
  }

  const claimed = verdict.verdict === "supported" ? verdict.strength : Math.min(verdict.strength, PARTIAL_MIN + 0.2);
  const strength = Math.max(0, Math.min(1, Math.min(claimed, audit.ceiling)));
  const status: ClaimStatus = strength >= SUPPORTED_MIN ? "supported" : "unsupported";
  return {
    status,
    stance: "supports",
    strength,
    label: supportLabel(status, strength),
    reasons: audit.reasons,
    degraded: false,
    judgeReason: verdict.reason,
  };
}

/**
 * Roll several link verdicts up into the claim's own status.
 *
 * One genuinely supporting passage is enough to support a claim — that is what
 * a citation is for. A contradiction does not cancel that, but it does have to
 * stay visible, which is why the link row keeps its own stance and the UI shows
 * both. A claim with no links at all is UNSUPPORTED, never dropped: a
 * load-bearing sentence with no evidence behind it is the single most important
 * thing this whole subsystem exists to surface.
 */
export function resolveClaimStatus(
  verdicts: readonly LinkVerdict[],
  opts: {
    /**
     * The audit's judge cap was reached before this claim got a verdict
     * (B4, B22). No verdict then means nobody looked, not that the evidence
     * failed: the claim is `unverified`, never `unsupported`.
     */
    judgeCapReached?: boolean;
  } = {}
): {
  status: ClaimStatus;
  supportStrength: number | null;
} {
  if (verdicts.length === 0) {
    return opts.judgeCapReached ? { status: "unverified", supportStrength: null } : { status: "unsupported", supportStrength: 0 };
  }
  const best = verdicts.reduce((a, b) => (b.strength > a.strength ? b : a));
  if (best.status === "supported") return { status: "supported", supportStrength: best.strength };
  if (verdicts.some((v) => v.status === "contradicted")) return { status: "contradicted", supportStrength: 0 };
  if (verdicts.every((v) => v.degraded)) return { status: "unverified", supportStrength: null };
  return { status: "unsupported", supportStrength: best.strength };
}

// ---------------------------------------------------------------------------
// Source scoring
// ---------------------------------------------------------------------------

export interface SourceScore {
  /** How much weight the publisher itself earns, 0..1 — ResearchSource.authority. */
  authority: number;
  /** How close the source is in time to what it describes, 0..1. */
  freshness: number;
  /** First-hand (filing, transcript, dataset) vs "according to someone else", 0..1. */
  directness: number;
  /** Whether this source is its own witness, or a copy of another one, 0..1. */
  independence: number;
  /** The single number the run loop can rank by. */
  composite: number;
}

/** Coarse policy classes used by an evidence requirement. */
export type ResearchSourceType =
  | "official"
  | "primary"
  | "reputable_secondary"
  | "general"
  | "user_generated"
  | "unknown";

/*
 * Authority is a host heuristic, not a verdict on truth. It is recorded (the
 * schema keeps it on the row) precisely so a reader can see WHY a source was
 * weighted and disagree, rather than having a hidden ranking decide for them.
 */
const AUTHORITY_RULES: Array<{ test: RegExp; score: number }> = [
  { test: /(^|\.)(gov|mil|int)$|(^|\.)gov\.[a-z]{2}$|(^|\.)europa\.eu$/i, score: 0.95 },
  { test: /(^|\.)(edu|ac\.[a-z]{2})$/i, score: 0.88 },
  { test: /(^|\.)(who|un|imf|oecd|worldbank|iea|nih|nasa|esa)\.(org|int|gov)$/i, score: 0.92 },
  { test: /(^|\.)(nature|science|thelancet|nejm|bmj|sciencedirect|arxiv|pubmed|ncbi\.nlm\.nih)\.(com|org|gov)$/i, score: 0.9 },
  { test: /(^|\.)(reuters|apnews|afp|bloomberg|ft|wsj|economist|nytimes|washingtonpost|bbc|theguardian)\.(com|co\.uk)$/i, score: 0.78 },
  { test: /(^|\.)(techcrunch|theverge|arstechnica|wired|cnbc|forbes|businessinsider)\.com$/i, score: 0.62 },
  { test: /(^|\.)(wikipedia|wikimedia)\.org$/i, score: 0.55 },
  { test: /(^|\.)(medium|substack|blogspot|wordpress|tumblr)\.com$/i, score: 0.3 },
  { test: /(^|\.)(reddit|quora|x|twitter|facebook|tiktok|pinterest)\.com$/i, score: 0.22 },
];

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export function authorityOf(url: string): number {
  const host = hostOfUrl(url);
  if (!host) return 0.25;
  for (const rule of AUTHORITY_RULES) if (rule.test.test(host)) return rule.score;
  // An unknown publisher is neither trusted nor dismissed. Content farms tend
  // to hyphenate and stack keywords into the host; that is a weak signal and it
  // is treated as one.
  return /-.*-/.test(host.split(".")[0] ?? "") ? 0.3 : 0.45;
}

const OFFICIAL_HOST =
  /(?:^|\.)(?:gov|gov\.[a-z]{2,3}|mil|int|edu|ac\.[a-z]{2}|europa\.eu|who\.int|un\.org|oecd\.org|imf\.org|worldbank\.org|iea\.org)$/i;
const USER_GENERATED_HOST =
  /(?:^|\.)(?:reddit|quora|facebook|x|twitter|tiktok|pinterest|medium|substack|blogspot|wordpress|tumblr)\.(?:com|org)$/i;

/**
 * Classifies a source for a requirement without pretending that a hostname is
 * a truth verdict. The class is persisted beside the snapshot so an old run
 * remains explainable when this heuristic changes.
 */
export function sourceTypeOf(input: {
  url: string;
  text: string;
  authority?: number | null;
}): ResearchSourceType {
  const host = hostOfUrl(input.url);
  if (!host) return "unknown";
  if (OFFICIAL_HOST.test(host)) return "official";
  if (USER_GENERATED_HOST.test(host)) return "user_generated";
  // The vendor's own record (docs, pricing, changelog, repo, filing, paper)
  // satisfies a "primary source" requirement; an aggregator never does,
  // whatever primary-sounding words its text happens to use.
  const policy = assessSource({ url: input.url, text: input.text }).tier;
  if (policy === "primary") return "primary";
  if (policy === "aggregator") return "general";
  if (
    PRIMARY_MARKERS.test(input.text) ||
    /\/(?:filings?|datasets?|data|transcripts?|press[-_ ]?releases?|statements?|methodology)\b/i.test(input.url)
  ) {
    return "primary";
  }
  const authority = input.authority ?? authorityOf(input.url);
  if (authority >= 0.72) return "reputable_secondary";
  return "general";
}

/** Whether a classified source satisfies a persisted source-type contract. */
export function sourceTypeMatchesRequirement(
  sourceType: ResearchSourceType,
  preferredSourceTypes: readonly string[],
  requiresPrimarySource: boolean
): boolean {
  if (requiresPrimarySource && sourceType !== "official" && sourceType !== "primary") return false;
  if (preferredSourceTypes.length === 0) return true;
  return preferredSourceTypes.some((preferred) => {
    const normalized = preferred.trim().toLowerCase().replace(/[ -]+/g, "_");
    return normalized === sourceType || (normalized === "primary" && sourceType === "official");
  });
}

/** Six months of half-life: news decays fast, a standards document barely at all. */
const FRESHNESS_HALF_LIFE_DAYS = 180;

/**
 * Freshness measured against the EVENT, not against today.
 *
 * A 2019 page describing a 2019 event is a perfect contemporaneous record, and
 * scoring it as stale would push the run toward whichever blog rewrote it last
 * week. What actually decays is the gap between publication and the event: a
 * piece written years after the fact is recollection, not reporting.
 */
export function freshnessOf(opts: { publishedAt?: Date | null; eventDate?: Date | null; now?: Date }): number {
  const { publishedAt } = opts;
  // No date at all is a real defect — an undated page cannot be placed in time —
  // but not a disqualification, so it lands mid-scale rather than at zero.
  if (!publishedAt) return 0.35;
  const reference = opts.eventDate ?? opts.now ?? new Date();
  const days = Math.abs(reference.getTime() - publishedAt.getTime()) / 86_400_000;
  return Math.max(0.05, Math.min(1, 2 ** (-days / FRESHNESS_HALF_LIFE_DAYS)));
}

const PRIMARY_MARKERS =
  /\b(?:we (?:found|report|measured|surveyed)|our (?:study|analysis|data)|in a statement|press release|filed with|form 10-[kq]|transcript|full text|dataset|methodology|official)\b/i;

/** How first-hand the text reads: a filing or a transcript vs a rewrite of one. */
export function directnessOf(text: string): number {
  const secondary = (normalizeText(text).match(/\b(?:according to|as reported by|citing|reported that|told reporters|via)\b/g) ?? []).length;
  const primary = PRIMARY_MARKERS.test(text) ? 1 : 0;
  return Math.max(0.1, Math.min(1, 0.6 + 0.3 * primary - 0.12 * secondary));
}

export function scoreSource(input: {
  url: string;
  text: string;
  /** The page or hit title, for the listicle test of the source policy. */
  title?: string | null;
  publishedAt?: Date | null;
  eventDate?: Date | null;
  /** Set when detectSyndication found this to be a copy of another source. */
  duplicate?: boolean;
  now?: Date;
}): SourceScore {
  /*
   * The protocol's source policy (Stage 2, `source-policy.ts`) on top of the
   * host table: a vendor's own docs, pricing page, changelog or repository is
   * the primary record and is lifted to at least 0.85 authority; a review
   * marketplace, affiliate page or listicle is held at 0.25 at most, whatever
   * its host would otherwise score; and the composite carries the policy's
   * weight so the read stage and the writer's corpus reach the record first.
   */
  const policy = assessSource({ url: input.url, title: input.title, text: input.text });
  const hostAuthority = authorityOf(input.url);
  const authority =
    policy.tier === "primary"
      ? Math.max(hostAuthority, 0.85)
      : policy.tier === "aggregator"
        ? Math.min(hostAuthority, 0.25)
        : hostAuthority;
  const freshness = freshnessOf({ publishedAt: input.publishedAt, eventDate: input.eventDate, now: input.now });
  const directness = directnessOf(input.text);
  // A syndicated copy is not a second witness. Zero, not "a bit less": the
  // whole point of the independence axis is that counting a wire story twice is
  // the corroboration failure §8.3 names by name.
  const independence = input.duplicate ? 0 : 1;
  const base = 0.4 * authority + 0.2 * freshness + 0.25 * directness + 0.15 * independence;
  const composite = independence === 0 ? 0 : Math.max(0, Math.min(1, base * policy.weight));
  return { authority, freshness, directness, independence, composite };
}

// ---------------------------------------------------------------------------
// Duplicate syndication
// ---------------------------------------------------------------------------

export interface SyndicationInput {
  id: string;
  url: string;
  title: string;
  text: string;
  publishedAt?: Date | null;
}

/** Word 5-grams, the cheap way to ask "is this the same prose". */
function shingles(text: string, size = 5): Set<string> {
  const words = normalizeText(text).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(" "));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Set high on purpose. Marking two independent reports as one costs the run a
 * real witness and silently weakens corroboration — the exact harm this is
 * meant to prevent, inverted. Genuine syndication shares whole paragraphs and
 * clears this easily.
 */
const SYNDICATION_JACCARD = 0.45;

const WIRE_MARKERS = /\((?:reuters|ap|afp|bloomberg|pa media|dpa)\)|\b(?:associated press|agence france-presse)\b/i;

/**
 * Group sources that are the same story, and name one canonical row per group.
 *
 * Returns `sourceId -> canonicalSourceId` for every copy, which is exactly what
 * goes in ResearchSource.duplicateOfId. The canonical member is the earliest
 * published (the originator, when dates are known), then the most authoritative
 * host — so the wire itself wins over the paper that reprinted it.
 */
export function detectSyndication(sources: readonly SyndicationInput[]): Map<string, string> {
  const prints = sources.map((s) => ({ src: s, shingles: shingles(`${s.title}\n${s.text}`) }));
  const parent = new Map<string, string>(sources.map((s) => [s.id, s.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };

  for (let i = 0; i < prints.length; i++) {
    for (let j = i + 1; j < prints.length; j++) {
      const a = prints[i];
      const b = prints[j];
      const overlap = jaccard(a.shingles, b.shingles);
      const sameTitle = normalizeText(a.src.title) === normalizeText(b.src.title) && a.src.title.trim().length > 12;
      const wire = WIRE_MARKERS.test(a.src.text) && WIRE_MARKERS.test(b.src.text);
      // A shared byline on a wire story lowers the bar, because syndicators cut
      // paragraphs: the reprint is a subset of the original, not a twin of it.
      const threshold = wire || sameTitle ? SYNDICATION_JACCARD * 0.6 : SYNDICATION_JACCARD;
      if (overlap < threshold) continue;
      // Same host is not syndication — it is one outlet's own follow-up.
      if (hostOfUrl(a.src.url) && hostOfUrl(a.src.url) === hostOfUrl(b.src.url)) continue;
      const ra = find(a.src.id);
      const rb = find(b.src.id);
      if (ra !== rb) parent.set(rb, ra);
    }
  }

  const groups = new Map<string, SyndicationInput[]>();
  for (const s of sources) {
    const root = find(s.id);
    const members = groups.get(root) ?? [];
    members.push(s);
    groups.set(root, members);
  }

  const duplicates = new Map<string, string>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const canonical = [...members].sort((a, b) => {
      const ta = a.publishedAt?.getTime() ?? Number.POSITIVE_INFINITY;
      const tb = b.publishedAt?.getTime() ?? Number.POSITIVE_INFINITY;
      if (ta !== tb) return ta - tb;
      return authorityOf(b.url) - authorityOf(a.url);
    })[0];
    for (const m of members) if (m.id !== canonical.id) duplicates.set(m.id, canonical.id);
  }
  return duplicates;
}

/**
 * How many INDEPENDENT sources back a claim. Copies of one wire story collapse
 * to the witness they came from, so "three sources agree" cannot be three
 * reprints of the same paragraph.
 */
export function independentWitnessCount(
  sourceIds: readonly string[],
  duplicates: ReadonlyMap<string, string>
): number {
  const roots = new Set<string>();
  for (const id of sourceIds) roots.add(duplicates.get(id) ?? id);
  return roots.size;
}
