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

import { findUnresolvedDenial, measureGroupOf, provePolarityContradiction, readPropositions, stemOf } from "@/lib/research/claim-polarity";
import { assessSource } from "@/lib/research/source-policy";

// ---------------------------------------------------------------------------
// Shared vocabulary (mirrors the schema comments on ResearchClaim / ClaimLink)
// ---------------------------------------------------------------------------

export type ClaimType = "fact" | "statistic" | "quote" | "prediction" | "opinion";
/** ResearchClaim.status. */
export type ClaimStatus = "unverified" | "supported" | "contradicted" | "unsupported";
/**
 * ResearchClaimLink.stance. `differs` is neutral: a cited passage that may
 * disagree with the claim beside one that supports it — a figure or a date
 * the text cannot settle as the claim's own. It makes a supported claim
 * contested, and is never a contradiction: only a passage whose own text
 * proves the opposite `contradicts`.
 */
export type LinkStance = "supports" | "contradicts" | "differs";

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
  /**
   * For an amount of money, which money: "USD", "EUR", "GBP", "JPY"…, or "$"
   * for a dollar sign that names no country. "$4.3bn" and "€4.3bn" are not the
   * same figure, and "$4.6bn" against "€4.3bn" is a conversion, not a rival.
   */
  currency?: string;
  /**
   * The precision it is stated to, in `value` units: "4.3 billion" → 1e8,
   * "12%" → 1, "6.8%" → 0.1. A figure the passage gives to more places rounds
   * to the claim's when it is within half a step of it ("7%" for "6.8%").
   */
  step?: number;
  /** Stated with a decimal point ("$6.0bn", "4.3%"): its last place is meant. */
  decimals?: boolean;
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
  /(?<code>\b(?:USD|EUR|GBP|JPY|CNY|RMB|CHF|CAD|AUD|NZD|HKD|SGD|INR|KRW|SEK|NOK|DKK)\s?)?(?<cur>[$€£¥₹₩])?\s?(?<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(?<scale>trillion|billion|million|thousand|bn|tn|mn|[kmb]\b)?\s?(?<pct>%|percent|per cent|percentage points?)?/gi;

/** Letters written against a dollar sign that say whose dollar: "US$", "C$", "HK$". */
const DOLLAR_PREFIX: Record<string, string> = {
  us: "USD", "u.s.": "USD", c: "CAD", ca: "CAD", can: "CAD", a: "AUD", au: "AUD", nz: "NZD", hk: "HKD", s: "SGD", sg: "SGD",
  nt: "TWD", r: "BRL", mx: "MXN",
};
const SYMBOL_CURRENCY: Record<string, string> = { "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR", "₩": "KRW" };
/** Currency names written after a figure ("4.3 billion euros"). "Pounds" alone is as often a weight, so it needs "sterling". */
const CURRENCY_AFTER =
  /^\s*(?:(USD|EUR|GBP|JPY|CNY|RMB|CHF|CAD|AUD|NZD|HKD|SGD|INR|KRW|SEK|NOK|DKK)\b|(dollars?|euros?|pounds sterling|sterling|yen|yuan|renminbi|rupees?|swiss francs?|francs?)\b)/i;
const CURRENCY_WORD: Record<string, string> = {
  dollar: "$", dollars: "$", euro: "EUR", euros: "EUR", "pounds sterling": "GBP", sterling: "GBP", yen: "JPY", yuan: "CNY", renminbi: "CNY",
  rupee: "INR", rupees: "INR", "swiss franc": "CHF", "swiss francs": "CHF", franc: "CHF", francs: "CHF",
};
const DOLLARS = new Set(["$", "USD", "CAD", "AUD", "NZD", "HKD", "SGD", "TWD"]);

/** Whether two amounts may be in the same money: the same currency, or a bare "$" against any dollar. */
function sameCurrency(a: NumericFact, b: NumericFact): boolean {
  if (a.kind !== "currency" || b.kind !== "currency") return a.kind === b.kind;
  const x = a.currency ?? "$";
  const y = b.currency ?? "$";
  return x === y || (x === "$" && DOLLARS.has(y)) || (y === "$" && DOLLARS.has(x));
}

/** The same kind of quantity, and for money the same money: what may be compared at all. */
function comparable(a: NumericFact, b: NumericFact): boolean {
  return a.kind === b.kind && sameCurrency(a, b);
}

/**
 * Whether `fine` rounds to `coarse` at the precision `coarse` is stated to,
 * half up: 6.5% and 6.8% round to 7%, 7.5% rounds to 8% and is not 7%.
 */
function roundsTo(fine: NumericFact, coarse: NumericFact): boolean {
  const step = coarse.step ?? 0;
  if (step <= 0) return fine.value === coarse.value;
  const slack = 1e-9 * Math.max(Math.abs(fine.value), Math.abs(coarse.value), 1);
  const d = fine.value - coarse.value;
  return d >= -step / 2 - slack && d < step / 2 - slack;
}

/**
 * Whether `fine` is within half a step of `coarse` either way: the bar for a
 * doubt, not for agreement. "7.5%" for a stated "7%" is not the same figure
 * (`roundsTo`), but a writer rounding half down, or cutting the decimal off,
 * writes exactly that, so the text alone does not prove them rivals.
 */
function mayRoundTo(fine: NumericFact, coarse: NumericFact): boolean {
  const step = coarse.step ?? 0;
  if (step <= 0) return fine.value === coarse.value;
  const slack = 1e-9 * Math.max(Math.abs(fine.value), Math.abs(coarse.value), 1);
  return Math.abs(fine.value - coarse.value) <= step / 2 + slack;
}

/** How many more decimal places `fine` is stated to than `coarse`: "6.8%" against "7%" is 1, "3.25%" against "3%" is 2. */
function placesBeyond(fine: NumericFact, coarse: NumericFact): number {
  if (!fine.step || !coarse.step) return 0;
  return Math.round(Math.log10(coarse.step / fine.step));
}

/**
 * Whether passage figure `p` states claim figure `n`: the same kind of
 * quantity in the same money, and either `p` rounds to `n` at the precision
 * the claim states it to, dropping one place ("7%" for "6.8%", "$4.3bn" for
 * "$4.32bn"), or the two agree within `NUMERIC_TOLERANCE` ("3.4 million" for
 * 3,412,000) — except when both are stated to the same decimal place, where
 * "$6.0bn" and "$5.9bn" are two different figures, not one rounded. Dropping
 * more places than one outside the tolerance ("3%" for "3.25%") is not
 * agreement; `unambiguousRival` leaves it to the judge.
 */
export function figuresAgree(n: NumericFact, p: NumericFact): boolean {
  if (!comparable(n, p)) return false;
  if (roundsTo(p, n) && placesBeyond(p, n) <= 1) return true;
  if (n.decimals && p.decimals && n.step !== undefined && n.step === p.step) return false;
  return numbersAgree(n.value, p.value);
}

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
    const dot = g.num.indexOf(".");
    // Whose money: a symbol, a code before the figure, the letters against a dollar sign, or a name after it.
    let currency: string | undefined;
    if (g.code) currency = g.code.trim().toUpperCase().replace("RMB", "CNY");
    else if (g.cur === "$") {
      const prefix = /(?:^|[^A-Za-z.])((?:[A-Za-z]{1,3})|u\.s\.)$/i.exec(text.slice(Math.max(0, start - 6), start))?.[1]?.toLowerCase();
      currency = (prefix && DOLLAR_PREFIX[prefix]) || "$";
    } else if (g.cur) currency = SYMBOL_CURRENCY[g.cur];
    else if (!g.pct) {
      const after = CURRENCY_AFTER.exec(text.slice(end, end + 24));
      if (after) currency = after[1] ? after[1].toUpperCase().replace("RMB", "CNY") : CURRENCY_WORD[after[2]!.toLowerCase()];
    }
    out.push({
      value: base * scale,
      kind: g.pct ? "percent" : currency ? "currency" : "plain",
      ...(currency && !g.pct ? { currency } : {}),
      step: (dot >= 0 ? Math.pow(10, -(g.num.length - dot - 1)) : 1) * scale,
      decimals: dot >= 0,
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
    out.push({ value, kind: "plain", step: 1, decimals: false, raw: m[0], start, end });
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
 * check it feeds can only take a contradiction away, never add one.
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

// ── Strict readings: what the text settles on its own ──────────────────────

/*
 * Everything below decides one of two things the audit may settle WITHOUT the
 * judge — a figure contradiction (`unambiguousRival`) and a rival figure the
 * passage provably gives for another subject the claim names
 * (`strictlyAnotherEntity`) — so every reading here is strict: a figure
 * qualifies only on evidence a reader could point at, and anything less is
 * left to the judge. A wrong "no" here costs a judge call or shows a doubt; a
 * wrong "yes" is a false contradiction or a disagreeing passage hidden.
 */

/** Words before a figure that make it approximate or a bound: "about $4bn", "more than 40%". */
const APPROX_BEFORE =
  /\b(?:about|around|roughly|approximately|nearly|almost|some|over|more than|less than|fewer than|at least|at most|up to|under|above|below|exceeding|close to|an estimated|estimated|as much as|as many as|as little as|upwards of|in excess of)\s*$/i;
const APPROX_AFTER = /^\s*(?:or more|or so|plus|or less|or fewer|odd)\b|^\+/i;
/** The word in front of a figure when it is a change ("rose 8%", "cut by 10%"), not a level ("rose to $4.3bn"). */
const CHANGE_BEFORE =
  /\b(?:by|up|down|rose|rise|rises|risen|grew|grow|grows|fell|fall|falls|increased|increases|decreased|decreases|jumped|jumps|declined|declines|climbed|climbs|dropped|drops|gained|gains|slipped|slips|surged|surges|soared|soars|plunged|plunges|tumbled|slumped|lost|cut|cuts|raised|raises|lifted|lowered|shrank|expanded|contracted)\s*$/i;

/** Whether a figure is approximate, a bound, or one end of a range. */
function figureApprox(text: string, n: NumericFact): boolean {
  const before = text.slice(Math.max(0, n.start - 24), n.start);
  const after = text.slice(n.end, n.end + 12);
  if (APPROX_BEFORE.test(before) || APPROX_AFTER.test(after) || /~\s*$/.test(before)) return true;
  return /\b(?:between|from)\s*$/i.test(before) || /^\s*(?:to|and|[-–])\s*[$£€]?\d/i.test(after) || /\d\s*(?:to|and|[-–])\s*$/i.test(before);
}

/** Whether passage figure `p` opens or closes a range ("$3.9bn to $4.5bn", "between 3% and 5%") that holds `value`. */
function rangeHolds(passage: { text: string; numbers: readonly NumericFact[] }, p: NumericFact, value: number): boolean {
  for (const q of passage.numbers) {
    if (q === p || !comparable(q, p)) continue;
    const [lo, hi] = q.start > p.end ? [p, q] : q.end < p.start ? [q, p] : [null, null];
    if (!lo || !hi || !/^\s*(?:to|and|[-–])\s*$/i.test(passage.text.slice(lo.end, hi.start))) continue;
    const min = Math.min(lo.value, hi.value);
    const max = Math.max(lo.value, hi.value);
    if ((value >= min && value <= max) || numbersAgree(value, min) || numbersAgree(value, max)) return true;
  }
  return false;
}

/** Whether the figure's sentence, up to the end of its clause, hedges it ("expects revenue of", "could reach"). */
function figureHedged(text: string, n: NumericFact): boolean {
  const { sentenceStart, clauseEnd } = figureScope(text, n);
  return isHedged(text.slice(sentenceStart, clauseEnd));
}

function levelOrChange(text: string, n: NumericFact): "level" | "change" {
  return CHANGE_BEFORE.test(text.slice(Math.max(0, n.start - 16), n.start)) ? "change" : "level";
}

const POSSESSIVE_PRONOUN_WORDS = new Set("its their his her".split(" "));
/** Verbs whose subject owns the figure: "Northwind reported revenue of …", "Contoso Labs earned …". */
const ENTITY_VERBS = new Set(
  ("earned earns earn reported reports report booked books book posted posts post had has have generated generates generate recorded records " +
    "record logged logs registered achieved delivered made makes saw sees notched clocked collected produced secured announced disclosed tallied " +
    "raised raises spent spends paid pays received receives lost loses won wins sold sells shipped ships employed employs employ held holds " +
    "include includes included offer offers offered cost costs charge charges charged").split(" ")
);

/** An owner as compared: lowercase, possessive and leading article cut, a legal suffix dropped ("Northwind Group" is Northwind). */
function ownerKey(raws: readonly string[]): string {
  const words = raws
    .map((w) => w.toLowerCase().replace(/[’']s$|[’']$/, "").replace(/\.$/, ""))
    .filter((w, i) => !(i === 0 && (w === "the" || w === "a" || w === "an")));
  while (words.length > 1 && CORPORATE_SUFFIXES.has(words[words.length - 1]!)) words.pop();
  return words.join(" ");
}

/**
 * Whose figure it is, as written: a possessive owner ("Northwind's revenue",
 * "its revenue" with "its" read as the subject that opens the sentence), the
 * subject of a verb that takes the figure ("Northwind reported revenue of"),
 * or a name the measured noun is "at" or "of" ("deposits at Northwind Bank").
 * Null when the text names no owner; `certain` false when it names one that
 * cannot be read (a possessive pronoun with nothing to stand for).
 */
function figureOwner(text: string, n: NumericFact): { owner: string | null; certain: boolean } {
  const { words, headAt } = figureClause(text, n);
  if (headAt < 0) return { owner: null, certain: true };
  const lower = (w: ClauseWord) => w.raw.toLowerCase().replace(/’/g, "'");
  for (const at of [headAt - 1, headAt - 2]) {
    const w = words[at];
    if (!w) break;
    if (POSSESSIVE_PRONOUN_WORDS.has(lower(w))) {
      const { sentenceStart } = figureScope(text, n);
      const opening = readPropositions(text.slice(sentenceStart, n.start)).props[0]?.subject;
      if (!opening || opening.pronoun || opening.ownerPronoun) return { owner: null, certain: false };
      return { owner: opening.key.replace(/^(?:the|a|an) /, ""), certain: true };
    }
    if (isPossessive(w.raw)) {
      let start = at;
      while (start > 0 && isTitleCase(words[start - 1]!.raw) && !/\S/.test(text.slice(words[start - 1]!.end, words[start]!.start))) start -= 1;
      return { owner: ownerKey(words.slice(start, at + 1).map((x) => x.raw)), certain: true };
    }
    if (at === headAt - 1 && !qualifiesHead(text, words, at)) break;
  }
  // "Deposits at Northwind Bank rose to …": the name the head belongs to is the owner.
  if (isTitleCase(words[headAt]!.raw)) {
    let start = headAt;
    while (start > 0 && isTitleCase(words[start - 1]!.raw) && !/\S/.test(text.slice(words[start - 1]!.end, words[start]!.start))) start -= 1;
    const prep = words[start - 1] ? lower(words[start - 1]!) : "";
    if (["at", "of", "for", "from", "in", "by"].includes(prep)) return { owner: ownerKey(words.slice(start, headAt + 1).map((x) => x.raw)), certain: true };
  }
  const verb = words[headAt - 1];
  if (verb && ENTITY_VERBS.has(lower(verb))) {
    let start = 0;
    for (let k = headAt - 2; k >= 0; k -= 1) {
      if (["that", "said", "says"].includes(lower(words[k]!))) {
        start = k + 1;
        break;
      }
    }
    const subject = words.slice(start, headAt - 1);
    if (subject.length > 0 && subject.length <= 6) {
      if (subject.length === 1 && POSSESSIVE_PRONOUN_WORDS.has(lower(subject[0]!))) return { owner: null, certain: false };
      return { owner: ownerKey(subject.map((x) => x.raw)), certain: true };
    }
  }
  return { owner: null, certain: true };
}

/**
 * Whether passage figure `p` contradicts claim figure `n` beyond doubt. It
 * must already be a rival (`rivalFigures`: the same kind of quantity, a
 * different value, not the evidence for another of the claim's figures) and
 * also: neither figure approximate, a bound, a range end or hedged; money in
 * the same currency, written the same way ("$" against "US$" is the judge's);
 * neither within half a step of the other at the coarser one's precision
 * ("3%" against "3.25%", "7%" against "7.5%"); both a level or both a change;
 * the same measured noun and qualifier (`figureSubject`), or for a figure that
 * opens its clause the same unit and the word after it ("70 people were
 * injured"); a count in the same word for its unit ("travellers" is not
 * "passengers" beyond doubt); nothing narrowing one figure that does not
 * narrow the other (`figureQualifiers`: "in Europe", "excluding
 * acquisitions", "a month on average", "among young people"); the same owner
 * as written, or none on either side; the same date or none on either side,
 * the same part of a year, and neither placed relative to another period.
 *
 * "The company's revenue", "Total revenue", "Revenue for the year" and "Net
 * revenue" against "Northwind's revenue" all fail it: each may be the
 * claim's quantity, and only a reader can say. They are `figure_differs`.
 */
/**
 * A table cell's claim, "Beta Plus — Price: $18 per month; Storage: 50 GB":
 * the row it names and the column of the part holding figure `n`.
 */
function tableCellOf(text: string, n: NumericFact): { row: string; column: string } | null {
  const m = /^\s*(.+?) — /.exec(text);
  if (!m) return null;
  let at = m[0].length;
  for (const part of text.slice(at).split("; ")) {
    const end = at + part.length;
    if (n.start >= at && n.end <= end) {
      const column = /^([^:]{1,40}):\s/.exec(part)?.[1];
      return column ? { row: ownerKey(m[1]!.split(/\s+/)), column: tokenForm(column.trim().split(/\s+/).pop()!) } : null;
    }
    at = end + 2;
  }
  return null;
}

/** Verbs that state a price. */
const PRICE_VERBS = new Set("cost costs costing charge charges charged priced".split(" "));

/** A table cell's figure against a passage that gives its row's figure for the same column: "Beta Plus costs $15 per month". */
function unambiguousCellRival(claim: string, n: NumericFact, cell: { row: string; column: string }, passage: string, p: NumericFact): boolean {
  const run = figureEntityRun(passage, p);
  if (!run || ownerKey(run.map((w) => w.raw)) !== cell.row) return false;
  const ca = numberContext(claim, n);
  const cb = numberContext(passage, p);
  if ((ca.unit || cb.unit) && ca.unit !== cb.unit) return false;
  const b = figureSubject(passage, p);
  const verb = passage.slice(Math.max(0, p.start - 12), p.start).trim().split(/\s+/).pop()?.toLowerCase() ?? "";
  const about = new Set([b.head, b.qualifier, cb.unit, cb.next].filter((x): x is string => !!x));
  return about.has(cell.column) || (["price", "cost", "fee"].includes(cell.column) && PRICE_VERBS.has(verb));
}

/** Conjunctions that end one noun phrase and open the next clause's. */
const PHRASE_CONJUNCTIONS = new Set("and but while whereas or nor yet".split(" "));

/**
 * The noun phrase a figure is given for, as far as its own clause shows it:
 * the words from the start of the clause (or from after a verb of saying or
 * telling, "that", a conjunction or another figure: "… carried 12.4 million
 * passengers in 2024 and its revenue was") to the measured noun
 * `figureClause` found, in `tokenForm`, with function words, determiners,
 * scope words and figure verbs left out; and whether a preposition joins two
 * of its words. Read backwards from the verb, "Youth unemployment in
 * Freedonia was 14.2%" and "Spending on rail in Freedonia was $2.2bn" both
 * end in "Freedonia", and the measured noun with whatever narrows it
 * ("youth", "on rail") sits before the preposition, where `figureSubject`
 * never looks.
 */
function subjectPhrase(text: string, n: NumericFact): { words: Set<string>; joined: boolean } {
  const { words, headAt } = figureClause(text, n);
  const out = new Set<string>();
  if (headAt < 0) return { words: out, joined: false };
  const { numbers } = figuresOf(text);
  let start = 0;
  for (let i = headAt - 1; i >= 0; i -= 1) {
    const lower = words[i]!.raw.toLowerCase();
    const next = words[i + 1]!;
    if (
      lower === "that" ||
      REPORTING_VERBS.has(lower) ||
      TELLING_VERBS.has(lower) ||
      PHRASE_CONJUNCTIONS.has(lower) ||
      numbers.some((m) => m.start >= words[i]!.end && m.end <= next.start)
    ) {
      start = i + 1;
      break;
    }
  }
  let joined = false;
  for (let i = start; i <= headAt; i += 1) {
    const raw = words[i]!.raw;
    const lower = raw.toLowerCase();
    if (PREPOSITIONS.has(lower)) {
      if (out.size > 0) joined = true;
      continue;
    }
    if (DETERMINERS.has(lower) || (skippedForSubject(raw) && !isAcronym(raw))) continue;
    out.add(tokenForm(raw));
  }
  return { words: out, joined };
}

/**
 * Words in a figure's own clause, before it, that make it an expectation, a
 * hope, a plan or a supposition rather than a figure reported as fact:
 * "Analysts expected revenue to reach", "Investors hoped revenue would hit",
 * "Bankers estimated revenue would be", "A consensus of analysts put revenue
 * at", "revenue would have been". Nouns that only look like these verbs
 * ("the project cost", "the Pro plan costs", "the budget deficit") are left
 * out.
 */
const SUPPOSED_BEFORE =
  /\b(?:expect(?:s|ed|ing|ation|ations)?|hop(?:e|es|ed|ing)|estimat(?:e|es|ed|ing)|predict(?:s|ed|ing|ion|ions)?|projected|projecting|projections?|forecast(?:s|ed|ing|er|ers)?|anticipat(?:e|es|ed|ing)|targeted|targeting|targets? of|aimed|aiming|aims? (?:to|for)|planned|planning|plans? to|guidance|consensus|would|could have|might have|should have|put(?:s|ting)?\b[^.;]{0,80}\bat)\b/i;
/** A clause before the figure's that opens a supposition: "Had fuel prices held, …", "If the strike had ended, …". */
const SUPPOSITION_OPENING = /^\s*(?:had|if|were|unless|without|but for)\b/i;

/**
 * Whether a figure is supposed rather than reported: an expectation, a hope,
 * an estimate, a plan or a counterfactual (`SUPPOSED_BEFORE`, or a sentence
 * that opens with a supposition before the figure's clause). Such a figure
 * for the claim's period is not the claim's actual figure stated otherwise,
 * so it never proves a contradiction: the judge reads it.
 */
function figureSupposed(text: string, n: NumericFact): boolean {
  const { clauseStart, sentenceStart } = figureScope(text, n);
  if (SUPPOSED_BEFORE.test(text.slice(clauseStart, n.start))) return true;
  return clauseStart > sentenceStart && SUPPOSITION_OPENING.test(text.slice(sentenceStart, clauseStart));
}

function unambiguousRival(
  claim: { text: string; dates: readonly DateMention[]; numbers: readonly NumericFact[] },
  n: NumericFact,
  passage: { text: string; dates: readonly DateMention[]; numbers: readonly NumericFact[] },
  p: NumericFact
): boolean {
  if (figureApprox(claim.text, n) || figureApprox(passage.text, p)) return false;
  if (figureHedged(claim.text, n) || figureHedged(passage.text, p)) return false;
  // An expected, hoped-for, estimated or hypothetical figure is not the claim's actual one stated otherwise.
  if (figureSupposed(claim.text, n) || figureSupposed(passage.text, p)) return false;
  // The same money, named the same way: "$" against "US$" may be one figure, and is the judge's to read.
  if (n.kind === "currency" && (n.currency ?? "$") !== (p.currency ?? "$")) return false;
  // One figure rounding to the other at the coarser one's precision ("4.4 billion" for "4 billion", "3%" for
  // "3.25%", "7%" for "7.5%" rounded down) may be the same figure stated to other places: a doubt, not a different figure.
  if (mayRoundTo(n, p) || mayRoundTo(p, n)) return false;
  const cell = tableCellOf(claim.text, n);
  if (cell) {
    const db = figureDate(passage.text, p, passage.dates);
    const da = figureDate(claim.text, n, claim.dates);
    if ((da || db) && !(da && db && datesAgree(da, db))) return false;
    return unambiguousCellRival(claim.text, n, cell, passage.text, p);
  }
  if (levelOrChange(claim.text, n) !== levelOrChange(passage.text, p)) return false;
  const a = figureSubject(claim.text, n);
  const b = figureSubject(passage.text, p);
  if (a.head !== b.head || a.qualifier !== b.qualifier) return false;
  // A noun phrase joined by a preposition is compared whole: "Youth unemployment in Freedonia" and "Spending on rail
  // in Freedonia" end in the same name as "Unemployment in Freedonia" and "Spending on roads in Freedonia".
  const pa = subjectPhrase(claim.text, n);
  const pb = subjectPhrase(passage.text, p);
  if ((pa.joined || pb.joined) && !sameWords(pa.words, pb.words)) return false;
  const ca = numberContext(claim.text, n);
  const cb = numberContext(passage.text, p);
  if (!a.head && (!ca.unit || ca.unit !== cb.unit || ca.next !== cb.next)) return false;
  // A count in another word for its unit ("11.9 million travellers" for "passengers") may be the same count or not.
  if (n.kind === "plain" && ca.unit !== cb.unit) return false;
  // Whatever narrows either figure must narrow both: "$1.1 billion in Europe", "excluding acquisitions", "a month on
  // average", "among young people", "at its Ohio plant" — a segment, a basis or a rate, not a rival total.
  if (!sameWords(figureQualifiers(claim, n), figureQualifiers(passage, p))) return false;
  const oa = figureOwner(claim.text, n);
  const ob = figureOwner(passage.text, p);
  if (!oa.certain || !ob.certain || oa.owner !== ob.owner) return false;
  const da = figureDate(claim.text, n, claim.dates);
  const db = figureDate(passage.text, p, passage.dates);
  if ((da || db) && !(da && db && datesAgree(da, db))) return false;
  if (!sameGrain(figureGrain(claim.text, n, claim.dates), figureGrain(passage.text, p, passage.dates))) return false;
  return figureRelativePeriod(claim.text, n) === null && figureRelativePeriod(passage.text, p) === null;
}

/** Words in a figure's own phrase that say how it moved, what it is compared with or that it is the whole year's: not what it measures. */
const TAIL_NEUTRAL = new Set("up down rising falling rose fell compared respectively full whole year calendar annual annually".split(" "));
/** Where a figure's own phrase ends: a new clause, a verb of saying, a comparison. */
const TAIL_END = /\b(?:and|but|while|whereas|which|who|that|said|says|according|told|reported|wrote|noted|added|versus|vs|compared|against)\b/i;
/** What opens a lead-in phrase that narrows the figure after it: "In Europe, …", "Excluding acquisitions, …". */
const LEAD_QUALIFIER =
  /^\s*(?:in|at|for|among|amongst|across|within|outside|excluding|including|excl|incl|ex|net of|before|after|on|from|by|per|barring|ignoring|adjusted|adjusting|stripping out|leaving out|not counting|counting)\b/i;
/** Lead-in phrases that frame where a figure was said, not what it measures. */
const LEAD_FRAMING = /\b(?:statement|filing|report|interview|letter|release|speech|presentation|update|call|according|said|says|told)\b/i;
/**
 * What opens a phrase after the figure's clause that still narrows it: "…,
 * excluding acquisitions", "…, on a constant-currency basis", "…, mostly at
 * its Ohio plant", "…, a month on average", "…, from subscriptions". "From"
 * only without a figure of its own: "…, from $3.5 billion a year earlier" is
 * a comparison.
 */
const TRAIL_QUALIFIER =
  /^\s*(?:(?:mostly|mainly|largely|chiefly|primarily|partly|only|almost all|nearly all|all)\s+)?(?:in|at|for|among|amongst|across|within|outside|excluding|including|excl|incl|ex|net of|before|after|on|per|barring|ignoring|adjusted|adjusting|stripping out|leaving out|not counting|mostly|mainly|largely|chiefly|primarily|(?:a|an|each|every)\s+(?:day|week|month|quarter|year|hour))\b/i;
const TRAIL_FROM = /^\s*(?:(?:mostly|mainly|largely|chiefly|primarily|partly|only)\s+)?from\b/i;
/** A phrase or a next sentence that says what the figure covers: "…, a figure that excludes acquisitions", "That figure excludes …", "That was in Europe alone". */
const COVERS =
  /^\s*(?:(?:a|the|that|this|these|those|it|which)\s+)?(?:(?:figure|number|total|amount|sum|estimate|count|tally|data|statistic|figures|numbers)\s+)?(?:that\s+|which\s+)?(?:excludes?|excluding|includes?|including|covers?|counts?|reflects?|refers?|applies|relates?|(?:is|was|are|were)\s+(?:for|in|from|at|among|only|limited|based|net|before|after|excluding|including|on|per|outside|within))\b/i;

/** Two sets with the same members. */
function sameWords(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * The words that narrow a figure beyond its measured noun, owner and date:
 * its own phrase after it, to the end of its clause or the next figure
 * ("$1.1 billion in Europe", "$4.0 billion excluding acquisitions", "$360
 * million a month on average", "9.8% among young people", "3,000 people at
 * its Ohio plant"), and a lead-in phrase of its sentence that opens with a
 * preposition or a basis ("In Europe, …", "Excluding acquisitions, …").
 * Dates, function words and the unit right after the figure are left out;
 * so is a lead-in that frames where it was said ("In its annual report, …").
 */
function figureQualifiers(facts: { text: string; dates: readonly DateMention[]; numbers: readonly NumericFact[] }, n: NumericFact): Set<string> {
  const { text, dates, numbers } = facts;
  const { clauseStart, clauseEnd, sentenceStart } = figureScope(text, n);
  const out = new Set<string>();
  const add = (from: number, to: number, unitFirst: boolean) => {
    let span = text.slice(from, to);
    for (const d of [...dates, ...numbers]) {
      if (d.start >= from && d.end <= to) span = span.slice(0, d.start - from) + " ".repeat(d.end - d.start) + span.slice(d.end - from);
    }
    [...span.matchAll(WORD_RE)].forEach((m, i) => {
      const form = tokenForm(m[0]);
      if (STOPWORDS.has(form) || PREPOSITIONS.has(form) || TAIL_NEUTRAL.has(form) || form.length < 2) return;
      // The unit the figure counts in ("3,000 people"), compared on its own (`sameQuantity`).
      if (unitFirst && i === 0 && !/\S/.test(span.slice(0, m.index))) return;
      out.add(form);
    });
  };
  let end = clauseEnd;
  const next = numbers.find((q) => q.start >= n.end);
  if (next && next.start < end) end = next.start;
  const cut = TAIL_END.exec(text.slice(n.end, end));
  if (cut) end = n.end + cut.index;
  add(n.end, end, true);
  const pieces = (from: number, to: number) => {
    const list: Array<{ from: number; text: string }> = [];
    let at = from;
    for (const piece of text.slice(from, to).split(/([,;:()]\s*|\s[-–—]\s)/)) {
      list.push({ from: at, text: piece });
      at += piece.length;
    }
    return list.filter((p) => /\w/.test(p.text));
  };
  // Lead-in phrases before the figure's clause, in its sentence.
  if (clauseStart > sentenceStart) {
    for (const piece of pieces(sentenceStart, clauseStart)) {
      if (!LEAD_QUALIFIER.test(piece.text) || LEAD_FRAMING.test(piece.text)) continue;
      add(piece.from, piece.from + piece.text.length, false);
    }
  }
  // Phrases after it that still narrow it, up to the first that does not.
  if (clauseEnd < text.length && !/^[.!?]/.test(text.slice(clauseEnd).trimStart())) {
    const sentenceEnd = edgeStartFrom(textFacts(text).sentenceEdges ?? edgesOf(text, FIGURE_SENTENCE_EDGE), clauseEnd, text.length);
    for (const piece of pieces(clauseEnd, sentenceEnd)) {
      const end = piece.from + piece.text.length;
      const from = TRAIL_FROM.test(piece.text) && !numbers.some((q) => q.start >= piece.from && q.end <= end);
      if ((!TRAIL_QUALIFIER.test(piece.text) && !from && !COVERS.test(piece.text)) || LEAD_FRAMING.test(piece.text)) break;
      add(piece.from, end, false);
    }
  }
  // The next sentence, when it says what this figure covers ("That figure excludes acquisitions.").
  const spans = sentenceSpans(text);
  const at = spans.findIndex(([from, to]) => n.start >= from && n.start < to);
  const following = at >= 0 ? spans[at + 1] : undefined;
  if (following && COVERS.test(text.slice(following[0], following[1]))) add(following[0], following[1], false);
  return out;
}

/**
 * Whether passage figure `p` may be for the claim figure's own period: not
 * provably another date, part of the year or relative period.
 *
 * A relative period ("last year", "a year earlier") is another period than
 * the claim's only when the passage anchors it: a figure of the same kind
 * beside it that is not itself relative ("$4.3 billion in 2024, up from $3.9
 * billion a year earlier"). Alone in its passage, "last year" counts back
 * from the day the page was written: with the publication year known it is
 * resolved against the claim's year; without it, it may well be the claim's
 * year — a doubt, not another period.
 */
function samePeriodOrUnknown(
  claim: { text: string; dates: readonly DateMention[] },
  n: NumericFact,
  passage: { text: string; dates: readonly DateMention[]; numbers: readonly NumericFact[] },
  p: NumericFact,
  publishedYear?: number
): boolean {
  const da = figureDate(claim.text, n, claim.dates);
  const db = figureDate(passage.text, p, passage.dates);
  if (da && db && !datesAgree(da, db)) return false;
  if (!sameGrain(figureGrain(claim.text, n, claim.dates), figureGrain(passage.text, p, passage.dates))) return false;
  const ra = figureRelativePeriod(claim.text, n);
  const rb = figureRelativePeriod(passage.text, p);
  if (ra === rb) return true;
  if (ra !== null || rb === null || !da || db) return false;
  const anchored = passage.numbers.some((q) => q !== p && q.kind === p.kind && figureRelativePeriod(passage.text, q) === null);
  if (anchored) return false;
  if (publishedYear == null) return true;
  const [direction, count] = rb.split(":");
  return da.year === publishedYear + (direction === "next" ? 1 : -Number(count));
}

/** Words that change the basis of a measure, not what it measures: "Net Revenue", "total revenue", "Adjusted Free Cash Flow". */
const BASIS_WORDS = new Set(
  "net gross total reported adjusted underlying operating annual group consolidated full-year gaap core organic headline statutory overall".split(" ")
);

/**
 * Whether passage figure `p` may measure what claim figure `n` measures,
 * though named differently: the same measured noun on another basis ("Net
 * Revenue", "Total revenue"), a near-synonym ("turnover" for "sales"), or a
 * metric the passage names in title case ("Gross Bookings", "Top Line").
 * Not a narrower subject ("logistics revenue", "European revenue"), not a
 * figure with no measured noun before it, not two measures of different
 * kinds ("operating profit" against "revenue").
 */
function measureMayMatch(claim: string, n: NumericFact, passage: string, p: NumericFact): boolean {
  if (p.kind === "plain") {
    const unit = numberContext(passage, p).unit;
    if (unit && !sameQuantity(claim, n, passage, p) && !/^\d/.test(unit)) return false;
  }
  const a = figureSubject(claim, n);
  const b = figureSubject(passage, p);
  if (!b.head) return false;
  const ga = a.head ? measureGroupOf(a.head) : undefined;
  const gb = measureGroupOf(b.head);
  if (ga !== undefined && gb !== undefined) return ga === gb && (b.qualifier === null || b.qualifier === a.qualifier || BASIS_WORDS.has(b.qualifier));
  if (a.head && a.head === b.head) return b.qualifier === null || b.qualifier === a.qualifier || BASIS_WORDS.has(b.qualifier);
  const { words, headAt } = figureClause(passage, p);
  const head = words[headAt];
  return !!head && isTitleCase(head.raw) && (MEASURE_NOUNS.has(b.head) || COMMON_SUBJECT_NOUNS.has(b.head) || b.head === "flow" || b.head === "line");
}

/** Nouns an owner's possessive takes for an organisation or a body without naming one: "The Bank's", "Company's". */
const GENERIC_OWNERS = new Set(
  ("bank lender insurer company firm group business corporation agency regulator authority ministry department government council committee " +
    "board court commission fund state city country nation region county town university hospital school club party union team " +
    "shareholder stockholder policyholder depositor investor customer owner holder member parent unit division subsidiary").split(" ")
);

/** Legal and group suffixes that end an organisation's name and never a measure's. */
const STRICT_NAME_SUFFIXES = new Set(
  ("inc incorporated corp corporation ltd limited plc llc llp lp ag sa nv se gmbh bv oyj asa spa holdings group labs laboratories " +
    "technologies airlines airways motors pharmaceuticals therapeutics bancorp").split(" ")
);
/** Measured nouns a filing capitalises as often as not: never a name on their own capitals. */
const MEASURE_NOUNS = new Set(
  ("booking billing receipt taking proceed premium deposit loan provision fine royalty backlog borrowing outlay spend capex opex expenditure " +
    "asset liability equity reserve capital fund balance intake membership registration shipment delivery earning line growth expansion " +
    "profitability holding segment surplus intake order").split(" ")
);

/** Runs of two or more adjacent title-case words in a text, in `tokenForm`: "Alpha Pro", "Beta Plus". */
function titleCaseRuns(text: string): string[][] {
  const runs: string[][] = [];
  let run: string[] = [];
  let lastEnd = -1;
  for (const m of text.matchAll(WORD_RE)) {
    const contiguous = lastEnd >= 0 && !/\S/.test(text.slice(lastEnd, m.index));
    if (isTitleCase(m[0]) && (run.length === 0 || contiguous)) run.push(tokenForm(m[0]));
    else {
      if (run.length >= 2) runs.push(run);
      run = isTitleCase(m[0]) ? [tokenForm(m[0])] : [];
    }
    lastEnd = m.index + m[0].length;
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

/** Whether `form` is written in title case mid-sentence somewhere in the text other than at `except`, outside a headline. */
function capitalisedMidSentence(text: string, form: string, except: number): boolean {
  for (const m of text.matchAll(WORD_RE)) {
    if (m.index === except || !isTitleCase(m[0]) || tokenForm(m[0]) !== form) continue;
    if (!opensSentence(text, m.index) && !inHeadline(text, m.index)) return true;
  }
  return false;
}

/**
 * The name a figure is given for when the figure is the object of what that
 * name does: "Contoso Labs earned $3.0bn", "Alpha Free includes 5 GB", "Beta
 * Basic is free and includes 2 GB". The run of title-case words that is the
 * subject of the figure's clause, followed by the verb; null when the clause
 * opens with anything else, or the run is the object of a preposition or of
 * a verb of telling ("told Reuters revenue was …").
 */
function figureEntityRun(text: string, p: NumericFact): ClauseWord[] | null {
  const { words, headAt } = figureClause(text, p);
  if (headAt < 0) return null;
  const runFrom = (end: number) => {
    let start = end;
    while (start > 0 && isTitleCase(words[start - 1]!.raw) && !/\S/.test(text.slice(words[start - 1]!.end, words[start]!.start))) start -= 1;
    return start;
  };
  const head = words[headAt]!;
  // A suffix after the head is read as a scope word ("Contoso Group earned": GROUP is skipped): it closes the run.
  let end = headAt;
  while (
    words[end + 1] &&
    isTitleCase(words[end + 1]!.raw) &&
    (STRICT_NAME_SUFFIXES.has(tokenForm(words[end + 1]!.raw)) || CORPORATE_SUFFIXES.has(tokenForm(words[end + 1]!.raw))) &&
    !/\S/.test(text.slice(words[end]!.end, words[end + 1]!.start))
  ) {
    end += 1;
  }
  if (isTitleCase(head.raw) && words[end + 1] && ENTITY_VERBS.has(words[end + 1]!.raw.toLowerCase())) {
    const start = runFrom(headAt);
    const before = words[start - 1]?.raw.toLowerCase();
    if (before && (PREPOSITIONS.has(before) || TELLING_VERBS.has(before) || REPORTING_VERBS.has(before))) return null;
    return words.slice(start, end + 1);
  }
  // "Beta Basic is free and includes 2 GB": the clause's own subject, the verb taking the figure joined on.
  if (words.length > 0 && isTitleCase(words[0]!.raw)) {
    let end = 0;
    while (end + 1 < words.length && isTitleCase(words[end + 1]!.raw) && !/\S/.test(text.slice(words[end]!.end, words[end + 1]!.start))) end += 1;
    const next = words[end + 1]?.raw.toLowerCase();
    const takes = words.slice(end + 1).some((w) => ENTITY_VERBS.has(w.raw.toLowerCase()));
    if (next && (["is", "are", "was", "were"].includes(next) || ENTITY_VERBS.has(next)) && takes && !words.slice(end + 1).some((w) => isTitleCase(w.raw))) {
      return words.slice(0, end + 1);
    }
  }
  return null;
}

/**
 * The owner a passage gives figure `p` for, as it writes it: a singular
 * possessive name ("Contoso's revenue", "the Trust's revenue") or the run of
 * title-case words that is the subject of the verb taking the figure
 * (`figureEntityRun`). Its words in `tokenForm`, function words left out.
 * Null when it names none, or names it with a plural possessive
 * ("Shareholders' funds"), a lowercase or common noun, or one word that only
 * opens its sentence and only a headline would capitalise.
 */
function passageFigureOwner(passage: string, p: NumericFact): string[] | null {
  const { words, headAt } = figureClause(passage, p);
  if (headAt < 0) return null;
  const common = (form: string) =>
    COMMON_SUBJECT_NOUNS.has(form) || MEASURE_NOUNS.has(form) || lowercaseForms(passage).has(form) || STOPWORDS.has(form);
  for (const at of [headAt - 1, headAt - 2]) {
    const w = words[at];
    if (!w) break;
    if (isPossessive(w.raw)) {
      if (/s['’]$/i.test(w.raw) || !isTitleCase(w.raw)) return null;
      let start = at;
      while (start > 0 && isTitleCase(words[start - 1]!.raw) && !/\S/.test(passage.slice(words[start - 1]!.end, words[start]!.start))) start -= 1;
      const run = words.slice(start, at + 1);
      const forms = run.map((x) => tokenForm(x.raw)).filter((f) => !STOPWORDS.has(f));
      if (forms.length === 0 || common(forms[forms.length - 1]!) || GENERIC_OWNERS.has(forms[forms.length - 1]!)) return null;
      if (run.length === 1 && opensSentence(passage, run[0]!.start) && !capitalisedMidSentence(passage, forms[0]!, run[0]!.start) && HEADLINE_WORDS.has(forms[0]!)) return null;
      return forms;
    }
    if (at === headAt - 1 && !qualifiesHead(passage, words, at)) break;
  }
  const run = figureEntityRun(passage, p);
  if (!run) return null;
  const forms = run.map((x) => tokenForm(x.raw)).filter((f) => !STOPWORDS.has(f));
  return forms.length > 0 ? forms : null;
}

/**
 * Whether the claim itself uses `owner` for a subject OTHER than the one
 * figure `n` is about: every word of the owner (a legal suffix aside) is a
 * word the claim writes in title case, none of them is in `n`'s own clause,
 * and that clause names a subject of its own. "Northwind earned $4.3bn, while
 * Southwind earned $2.1bn" uses Northwind for another subject than the $2.1bn
 * is about; "Revenue at General Motors rose to $187bn" never uses GM, so for
 * all the text shows "GM's revenue" is the claim's own subject by another
 * name.
 */
function claimNamesAnotherSubject(claim: string, n: NumericFact, owner: readonly string[]): boolean {
  const core = [...owner];
  while (core.length > 1 && (CORPORATE_SUFFIXES.has(core[core.length - 1]!) || STRICT_NAME_SUFFIXES.has(core[core.length - 1]!))) core.pop();
  const claimNames = new Set(
    (claim.match(WORD_RE) ?? []).filter((w) => isTitleCase(w)).map(tokenForm).filter((f) => !STOPWORDS.has(f) && !SENTENCE_STARTERS.has(f))
  );
  if (!core.every((f) => claimNames.has(f))) return false;
  const { clauseStart, clauseEnd } = figureScope(claim, n);
  const clause = claim.slice(clauseStart, clauseEnd);
  const clauseWords = [...clause.matchAll(WORD_RE)];
  if (clauseWords.some((m) => core.includes(tokenForm(m[0])))) return false;
  // The clause names whose figure it is: a title-case word that is no function word, basis word or common noun.
  return clauseWords.some((m) => {
    const form = tokenForm(m[0]);
    return isTitleCase(m[0]) && !STOPWORDS.has(form) && !SENTENCE_STARTERS.has(form) && !BASIS_WORDS.has(form) && !HEADLINE_WORDS.has(form) && !isCommonNoun(claim, form) && !MEASURE_NOUNS.has(form);
  });
}

/*
 * Words that end an organisation's name and say what kind of business it is:
 * "Woodgrove Bank", "Woodgrove Bancorp" and "Woodgrove Financial" may be one
 * company, its parent or its arm, and only a reader can tell which. Never
 * what sets a sibling apart.
 */
const BUSINESS_NAME_WORDS = new Set(
  ("bank bancorp bancshares banking financial finance capital securities investment partner industrie industry global worldwide " +
    "system solution service enterprise brand trust venture media communication network software electronic insurance assurance " +
    "trader trading retail health healthcare energy resource food pharma tech intl co air airline airway motor").split(" ")
);

/** Whether one name word is a clipping, an abbreviation or an expansion of the other: "Labs"/"Laboratories", "Intl"/"International". */
function clippedForm(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 3 || short[0] !== long[0]) return false;
  if (long.startsWith(short)) return true;
  let at = 0;
  for (const ch of long) if (ch === short[at]) at += 1;
  return at >= short.length;
}

/** Whether `run` holds `part` as consecutive words. */
function containsRun(run: readonly string[], part: readonly string[]): boolean {
  for (let i = 0; i + part.length <= run.length; i += 1) if (part.every((w, k) => run[i + k] === w)) return true;
  return false;
}

/**
 * Whether passage figure `p` is given for a sibling of a name the claim uses:
 * "Alpha Free" beside the claim's "Alpha Pro". The passage must name both —
 * the claim's own name and the sibling — so the text itself shows they are
 * two things; the sibling must share the first word and add a word of its
 * own that the claim never uses, no text writes in lowercase, and that is no
 * company ending ("Bancorp", "Holdings", "Financial") and no clipping or
 * expansion of the claim's own word ("Labs" for "Laboratories", "Intl" for
 * "International", "Pharma" for "Pharmaceuticals"): those may be the claim's
 * subject under another name. A run that is itself a measure ("Gross
 * Bookings") names no family.
 */
function siblingOfClaimName(claim: string, passage: string, owner: readonly string[]): boolean {
  if (owner.length < 2) return false;
  const claimWords = wordForms(claim);
  const lowerIn = (form: string) => lowercaseForms(passage).has(form) || lowercaseForms(claim).has(form);
  const passageRuns = titleCaseRuns(passage);
  for (const claimRun of titleCaseRuns(claim)) {
    if (claimRun.some((f) => MEASURE_NOUNS.has(f) || COMMON_SUBJECT_NOUNS.has(f) || BASIS_WORDS.has(f))) continue;
    if (claimRun[0] !== owner[0]) continue;
    if (!passageRuns.some((run) => containsRun(run, claimRun))) continue;
    const own = owner.slice(1).filter((f) => !claimRun.includes(f));
    const theirs = claimRun.slice(1).filter((f) => !owner.includes(f));
    const setsApart = (f: string) =>
      !lowerIn(f) &&
      !claimWords.has(f) &&
      !MEASURE_NOUNS.has(f) &&
      !COMMON_SUBJECT_NOUNS.has(f) &&
      !STRICT_NAME_SUFFIXES.has(f) &&
      !CORPORATE_SUFFIXES.has(f) &&
      !BUSINESS_NAME_WORDS.has(f) &&
      !theirs.some((t) => clippedForm(f, t));
    if (own.length > 0 && own.every(setsApart)) return true;
  }
  return false;
}

/**
 * Whether the passage provably gives figure `p` for a DIFFERENT entity than
 * the one claim figure `n` is about: what keeps a rival figure from reading
 * as a disagreement. The proof has to come from the claim: the passage's owner is
 * a name the claim itself uses for another subject (`claimNamesAnotherSubject`)
 * or a sibling of one (`siblingOfClaimName`).
 *
 * An owner the claim never names is unknown, not another entity. "GM's",
 * "IBM's", "Britain's", "the Fed's", "the Trust's", "Threadneedle Street's",
 * "the Foundation raised": acronyms, short names, nicknames, metonyms and
 * capitalised defined terms are how pages name the claim's OWN subject, and
 * no amount of capitals or company suffixes tells them from a stranger. So
 * their figure stays this passage's, and the judge and the reader see it.
 * Never in a headline-style sentence.
 */
function strictlyAnotherEntity(claim: string, n: NumericFact, passage: string, p: NumericFact): boolean {
  if (inHeadline(passage, p.start)) return false;
  const owner = passageFigureOwner(passage, p);
  if (!owner) return false;
  return claimNamesAnotherSubject(claim, n, owner) || siblingOfClaimName(claim, passage, owner);
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
 * "$18 a month" are a price's rate, not a period, and stay out of it. So is
 * the moment something was said: "said this month", "told investors last
 * month" dates the saying, not the figure said.
 */
const MONTHLY_MARK =
  /\bmonthly\b(?!\s+(?:fees?|prices?|pricing|costs?|charges?|subscriptions?|plans?|payments?|rents?|rates?|premiums?|bills?|wages?|salar(?:y|ies)|allowances?|budgets?)\b)|\b(?<!\b(?:said|says|told(?:\s+\w+)?|reported|announced|disclosed|stated|wrote|added|noted|confirmed)\s+)(?:the|this|that|last) month\b/i;
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

/** A relative period named from the present rather than from another period of the text: "last year", "two years ago", "next year". */
const PRESENT_RELATIVE = /\bago\b|^(?:the )?(?:last|next|coming|this) /i;

/**
 * `figureRelativePeriod`, for a period named relative to another period the
 * text states — "a year earlier", "the prior year", "the year before", "the
 * following year" — and never to the present ("last year", "two years ago",
 * "next year"): the figure's own words then say it is a comparison figure,
 * not the period the text is about.
 */
function figureComparisonPeriod(text: string, n: NumericFact): string | null {
  const { clauseStart, clauseEnd, sentenceStart } = figureScope(text, n);
  const global = new RegExp(RELATIVE_PERIOD.source, "gi");
  for (const segment of [text.slice(clauseStart, clauseEnd), text.slice(sentenceStart, clauseStart)]) {
    for (const m of segment.matchAll(global)) {
      if (PRESENT_RELATIVE.test(m[0])) continue;
      if (m[2]) return "next:1";
      const count = m[1] ? COUNT_WORDS[m[1].toLowerCase()] ?? Number(m[1]) : 1;
      return `previous:${count}`;
    }
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
      comparable(n, p) &&
      !figuresAgree(n, p) &&
      !evidenceForAnotherFigure(claim, n, passage, p, { strict: false }) &&
      measuresSameThing(claim, n, passage, p)
  );
}

/**
 * Whether passage figure `p` is the evidence for a claim figure other than
 * `n`: equal to it, and given for the same date. `strict` also refuses the
 * pair when only one of the two is dated — the bar for setting a figure aside
 * as no doubt at all, where a wrong guess hides a disagreeing figure.
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
    if (m === n || !figuresAgree(m, p)) return false;
    const mAt = figureDate(claim.text, m, claim.dates);
    if (mAt && at) return datesAgree(mAt, at);
    return !opts.strict || (!mAt && !at);
  });
}

/*
 * Units a count is given in under more than one word, in `tokenForm`: "11.9
 * million travellers" may be the "12.4 million passengers" a claim counts,
 * and "480 shops" its "520 stores"; "people" may be any count of people.
 * Such a pair is the same quantity for finding a disagreement, never for
 * proving one (`unambiguousRival` wants the same word).
 */
const UNIT_SYNONYMS: ReadonlyArray<ReadonlySet<string>> = [
  "passenger traveller traveler flyer rider people person",
  "store shop outlet branch location",
  "home house dwelling residence",
  "employee worker staff personnel people person",
  "job position role post",
  "customer subscriber user client account people person",
  "vehicle car",
  "visitor tourist guest people person",
  "student pupil people person",
  "flight departure",
  "tonne ton",
  "delivery shipment",
].map((group) => new Set(group.split(" ")));

function unitSynonyms(a: string, b: string): boolean {
  // `tokenForm` keeps the plural of a short word ("jobs", "tons").
  const one = (w: string) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
  return UNIT_SYNONYMS.some((group) => group.has(one(a)) && group.has(one(b)));
}

/** Whether two figures could be the same quantity, whatever they are about: unit and introducing phrase only. */
function sameQuantity(claim: string, a: NumericFact, passage: string, b: NumericFact): boolean {
  const ca = numberContext(claim, a);
  const cb = numberContext(passage, b);
  if (ca.unit && cb.unit && ca.unit !== cb.unit && a.kind === "plain" && unitSynonyms(ca.unit, cb.unit)) return true;
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
    const matched = claimNums.filter((c) => passageNums.some((p) => figuresAgree(c, p)));
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
    | "figure_differs"
    | "negation_unresolved"
    | "date_absent"
    | "date_is_publication_date"
    | "quote_absent"
    | "polarity_mismatch"
    | "superlative_unstated"
    | "causation_unstated"
    | "passage_hedged"
    | "attribution_dropped"
    | "source_stale"
    | "off_topic"
    | "thin_overlap"
    /** Beside the passage that supported the claim, this one may give another figure or date for the same thing: a note. */
    | "differs_from_support";
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

/** Two alignment scores this close are a tie: neither clause is the better match. */
const ALIGNMENT_TIE = 1e-9;

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

/** A day of the week as a text gives it. */
interface DayMention {
  day: string;
  raw: string;
  start: number;
  end: number;
}

const WEEKDAY_RE = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;

function weekdaysIn(text: string): DayMention[] {
  return [...text.matchAll(WEEKDAY_RE)].map((m) => ({ day: m[0].toLowerCase(), raw: m[0], start: m.index, end: m.index + m[0].length }));
}

/** A change given as a multiple in words: "doubled", "trebled", "threefold", "halved". */
const MULTIPLE_RE = /\b(?:doubl(?:ed|ing)|two-?fold|tripl(?:ed|ing)|trebl(?:ed|ing)|three-?fold|quadrupl(?:ed|ing)|four-?fold|halv(?:ed|ing))\b/gi;

function multiplesIn(text: string): Array<{ factor: number; raw: string }> {
  return [...text.matchAll(MULTIPLE_RE)].map((m) => {
    const w = m[0].toLowerCase();
    const factor = /^(?:doubl|two)/.test(w) ? 2 : /^(?:tripl|trebl|three)/.test(w) ? 3 : /^(?:quadrupl|four)/.test(w) ? 4 : 0.5;
    return { factor, raw: m[0] };
  });
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
  const claimFacts = { text: claim, dates: claimDates, numbers: claimNums };
  const passageFacts = { text: passage, dates: passageDates, numbers: passageNums };
  for (const n of claimNums) {
    const sameKind = passageNums.filter((p) => comparable(n, p));
    if (sameKind.some((p) => figuresAgree(n, p))) continue;
    // An amount in another currency is neither this figure nor a rival to it: a conversion the text cannot check.
    const foreign = n.kind === "currency" ? passageNums.filter((p) => p.kind === "currency" && !sameCurrency(n, p)) : [];
    if (sameKind.some((p) => rangeHolds(passageFacts, p, n.value))) continue;
    const rival = rivalFigures(claimFacts, n, passageFacts);
    /*
     * Three tiers, and only the first is settled by the text (see
     * `unambiguousRival`): the passage gives a different figure for the
     * claim's own quantity, named the same way, for the same owner, period
     * and basis, with nothing approximate or hedged about either. A figure
     * that may be the same quantity but is named, owned or dated differently
     * ("The company's revenue", "Total revenue", "Net Bookings") is a
     * disagreement the judge must read — `figure_differs`, which also makes a
     * supported claim contested — never a contradiction.
     */
    const proof = rival.filter((p) => unambiguousRival(claimFacts, n, passageFacts, p));
    if (proof.length > 0) {
      contradicted = true;
      cap(0, {
        code: "figure_mismatch",
        detail: `The passage gives ${proof.map((p) => p.raw).slice(0, 3).join(", ")} where the claim says ${n.raw}.`,
      });
      continue;
    }
    // A rival the passage provably gives for another subject the claim names ("…, ahead of Contoso") is not a disagreement.
    const disputed = rival.filter((p) => !strictlyAnotherEntity(claim, n, passage, p));
    if (disputed.length > 0) {
      cap(CEILING.figureAbsent, {
        code: "figure_differs",
        detail: `The passage gives ${disputed.map((p) => p.raw).slice(0, 3).join(", ")} where the claim says ${n.raw}; it may measure something else, so the text alone does not settle it.`,
      });
      continue;
    }
    /*
     * Each passage is judged on its own text: another source cited for the
     * same sentence never supplies a figure this passage lacks, and never
     * excuses one it may disagree with. A figure for what may be the same
     * measure, under another name, is a doubt, and a doubt is shown as one.
     */
    const doubtful = sameKind.filter(
      (p) =>
        measureMayMatch(claim, n, passage, p) &&
        samePeriodOrUnknown(claimFacts, n, passageFacts, p, opts.publishedAt?.getUTCFullYear()) &&
        !evidenceForAnotherFigure(claimFacts, n, passageFacts, p, { strict: true }) &&
        !strictlyAnotherEntity(claim, n, passage, p)
    );
    if (doubtful.length > 0) {
      cap(CEILING.figureAbsent, {
        code: "figure_differs",
        detail: `The passage gives ${doubtful.map((p) => p.raw).slice(0, 3).join(", ")} where the claim says ${n.raw}; it may measure something else, so the text alone does not settle it.`,
      });
      continue;
    }
    cap(CEILING.figureAbsent, {
      code: "figure_absent",
      detail:
        foreign.length > 0
          ? `The passage gives ${foreign.map((p) => p.raw).slice(0, 3).join(", ")}, in another currency; the figure ${n.raw} does not appear in it.`
          : `The figure ${n.raw} does not appear in the cited passage.`,
    });
  }

  /*
   * A multiple or a day of the week written as a word: the claim's "doubled"
   * or "on Tuesday" against "tripled" or "on Thursday" in the clause of the
   * passage the claim is about, the claim's own word nowhere in the passage.
   * Never proof — "revenue tripled while profit doubled" is one clause away —
   * so a doubt and a missing date, which the judge reads.
   */
  const focused = focusSentences(claim, passage);
  const claimMultiples = multiplesIn(claim);
  const claimDays = weekdaysIn(claim);
  if (claimMultiples.length > 0 || claimDays.length > 0) {
    const aboutClauses = focused.sentences.map((sentence) => bestMatchingClause(claim, sentence)).join(" ");
    const passageMultiples = multiplesIn(passage);
    for (const m of claimMultiples) {
      if (passageMultiples.some((x) => x.factor === m.factor)) continue;
      const other = multiplesIn(aboutClauses).find((x) => x.factor !== m.factor);
      if (!other) continue;
      cap(CEILING.figureAbsent, {
        code: "figure_differs",
        detail: `The passage says “${other.raw}” where the claim says “${m.raw}”; it may describe something else, so the text alone does not settle it.`,
      });
    }
    const passageDays = weekdaysIn(passage);
    for (const d of claimDays) {
      if (passageDays.some((x) => x.day === d.day)) continue;
      const other = weekdaysIn(aboutClauses).find((x) => x.day !== d.day);
      if (!other) continue;
      cap(CEILING.dateWrong, {
        code: "date_absent",
        detail: `The cited passage places this on ${other.raw}, not ${d.raw}.`,
      });
    }
  }

  // ── Dates, and the publication/event trap ────────────────────────────────
  const pubYear = opts.publishedAt?.getUTCFullYear();
  for (const d of claimDates) {
    if (passageDates.some((p) => datesAgree(p, d))) continue;
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
  const focus = focused.sentences[0]!;
  const denial = provePolarityContradiction(claim, passage);
  if (denial) {
    contradicted = true;
    cap(0, {
      code: "polarity_mismatch",
      detail: `The passage states the opposite of this claim: “${denial.passage.slice(0, 160)}”.`,
    });
  } else {
    // A denial the text cannot line up with the claim: shown, and left to the judge.
    const unresolved = findUnresolvedDenial(claim, passage);
    if (unresolved) {
      cap(1, {
        code: "negation_unresolved",
        detail: `The passage also says “${unresolved.slice(0, 160)}”; the text alone cannot tell whether that denies this claim, so it needs a reader's review.`,
      });
    }
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
 * figure says, in its own words, that the figure is another period's — so the
 * difference is not a disagreement with the claim. Judged on the passage's
 * own text alone: no other passage, the supporting one included, ever says
 * which period the claim is about, or excuses a figure another passage pins
 * to another year (an undated "operates 96 vessels" supported by "96 vessels
 * in 2021" is disputed by "81 vessels in 2025", and by "81 vessels in 2024"
 * beside "96 vessels in 2024" alike).
 *
 * What excuses a figure is a period its own clause or lead-in names relative
 * to ANOTHER period of the text (`figureComparisonPeriod`): "A year earlier,
 * revenue was $3.9 billion", "… in the prior year", "the year before". A date
 * ("in 2023", "FY2023") and a period named relative to the present ("last
 * year", "two years ago", "next year") say when the figure was, not that it
 * is not the claim's: for a claim that names no period, either may be the
 * claim's own, and the difference is a disagreement the reader is shown —
 * as a doubt beside support, never a contradiction.
 *
 * False — record the disagreement — whenever the claim is dated (the date
 * checks already decide that: `disagreesForSamePeriod`), and whenever any
 * differing figure is not placed relative to another period, or is placed
 * the way the claim's own figure is.
 */
export function differentPeriodForUndatedClaim(claim: string, conflicting: string): boolean {
  const claimDates = extractDates(claim);
  if (claimDates.length > 0) return false;
  const facts = (text: string) => {
    const dates = extractDates(text);
    return { text, dates, numbers: extractNumbers(text, dates) };
  };
  const claimFacts = facts(claim);
  const conflictFacts = facts(conflicting);
  let differs = false;
  for (const n of claimFacts.numbers) {
    if (conflictFacts.numbers.some((p) => figuresAgree(n, p))) continue;
    const rivals = rivalFigures(claimFacts, n, conflictFacts);
    if (rivals.length === 0) continue;
    const claimRelative = figureRelativePeriod(claim, n);
    for (const rival of rivals) {
      const relative = figureComparisonPeriod(conflicting, rival);
      if (!relative || relative === claimRelative) return false;
    }
    differs = true;
  }
  return differs;
}

/*
 * ── Beside support: a cited passage that may disagree ────────────────────
 *
 * Each passage is audited on its own text (`auditEvidence`), and no other
 * passage ever stands in for one. What a single passage cannot show is that
 * it disagrees with what ANOTHER passage, the one that supported the claim,
 * states: "IBM's revenue rose to $61.0 billion" says nothing provable about
 * "Revenue at International Business Machines rose to $62.8 billion", but
 * beside a passage that gives the $62.8 billion it is a second figure for
 * what may be the same thing, and the reader is owed "sources disagree".
 * `differsFromSupportingPassage` finds those. It only ever makes a supported
 * claim contested — it never supports, contradicts or caps anything.
 */

/*
 * Title-case words that name nothing even mid-sentence: the words of the
 * claim's dates ("in March 2024") and the days of the week.
 */
const DATE_NAME_WORDS = new Set([...MONTHS, ...MONTHS.map((m) => m.slice(0, 3)), ...NOT_A_SUBJECT]);

/**
 * Title-case words of a text, lowercased: the named subjects it talks about
 * (Northwind, Alpha, Plus). The first word of a sentence is skipped unless
 * `withSentenceStarts`: any word opens a sentence in title case, so "Revenue
 * rose to $4.3bn" must not make "revenue" a named subject.
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
 * Whether the passage leaves out, in any case, a name the claim gives its
 * subject mid-sentence that the supporting passage names: the passage may
 * call the claim's subject something else ("IBM", "the Trust", "Britain"),
 * or be about another one. A measured noun the claim capitalises
 * ("Northwind's Receipts"), a word the claim also writes in lowercase and
 * the words of a date ("March", "Tuesday") are no names.
 */
function leavesOutSupportedName(claim: string, passage: string, supporting: string): boolean {
  const mentioned = mentionedWords(passage);
  const missing = [...namedSubjects(claim)].filter((name) => {
    const form = tokenForm(name);
    return (
      !mentioned.has(name) &&
      !COMMON_SUBJECT_NOUNS.has(form) &&
      !MEASURE_NOUNS.has(form) &&
      !lowercaseForms(claim).has(form) &&
      !DATE_NAME_WORDS.has(name)
    );
  });
  if (missing.length === 0) return false;
  const names = namedSubjects(supporting, { withSentenceStarts: true });
  return missing.some((name) => names.has(name));
}

/*
 * Unit words that count the same things, for reading a count beside the
 * passage that supports the claim (`countsSameThing`). Wider than
 * UNIT_SYNONYMS on purpose, and used nowhere else: what it decides is only
 * ever a doubt shown beside support ("may differ"), never a finding on a
 * passage of its own, so "11.2 million fliers" for "12.4 million passengers"
 * may be the same count while "3 ports" for "12 vessels" is not.
 */
const COUNT_ALIASES: ReadonlyArray<ReadonlySet<string>> = [
  "passenger traveller traveler flyer flier rider holidaymaker tourist visitor customer people person",
  "store shop outlet branch location restaurant site",
  "home house dwelling residence household property",
  "employee worker staff staffer personnel people person",
  "customer subscriber sub user client account member household people person",
  "vehicle car",
  "ship vessel boat",
  "aircraft plane jet airliner",
  "flight departure service",
  "job position role post",
  "student pupil",
  "visitor tourist guest",
  "delivery shipment",
  "barrel bbl bpd",
].map((group) => new Set(group.split(" ").map(stemOf)));
/** Counters that name no kind of thing of their own: "372,000 units" may be the claim's 410,000 vehicles. */
const GENERIC_COUNTERS = new Set(["unit"].map(stemOf));
/**
 * Words between a count and what it counts that say nothing of WHAT is
 * counted: a scale ("two dozen ships") or a rate or a scope ("1,150 weekly
 * departures", "40 new stores").
 */
const COUNT_SCALE_WORDS = new Set(
  "dozen score hundred thousand million billion trillion pair weekly daily monthly yearly annual new additional extra more total".split(" ")
);

/**
 * Whether passage count `p` counts the same thing as claim count `n`, on
 * positive evidence only: the same quantity by unit (`sameQuantity`), a unit
 * word that counts the same things (COUNT_ALIASES — "fliers" for
 * "passengers", "outlets" for "restaurants", "vessels" for "ships") or no
 * kind of thing at all ("units"), or a unit word the claim itself uses
 * ("79.2 million passengers" against "passenger numbers reached 83.9
 * million"). A count of another thing for the same owner — "3 ports" against
 * "12 vessels", "800,000 shares" against "2.1 million cases of soup", "2.3
 * million broadband subscribers" against "6.1 million subscribers" — is
 * another quantity, and no disagreement with the claim's. (An amount of
 * money or a percentage carries its own unit; whether it is the claim's
 * measure under another heading is read by the checks around it.)
 */
function countsSameThing(claim: string, n: NumericFact, passage: string, p: NumericFact): boolean {
  if (sameQuantity(claim, n, passage, p)) return true;
  const unitOf = (text: string, x: NumericFact) => {
    const context = numberContext(text, x);
    return context.unit && COUNT_SCALE_WORDS.has(context.unit) ? context.next : context.unit;
  };
  const theirs = unitOf(passage, p);
  if (!theirs || /^\d/.test(theirs)) return false;
  const ours = unitOf(claim, n);
  if (ours && !/^\d/.test(ours)) {
    const [a, b] = [stemOf(ours), stemOf(theirs)];
    if (a === b || GENERIC_COUNTERS.has(a) || GENERIC_COUNTERS.has(b)) return true;
    if (COUNT_ALIASES.some((group) => group.has(a) && group.has(b))) return true;
  }
  const forms = wordForms(claim);
  return forms.has(theirs) || forms.has(tokenForm(theirs));
}

/** Units that measure an amount of something rather than count things: never another word for the claim's count. */
const MEASURE_UNITS = new Set(
  ("tonne ton kg kilogram gram pound lb ounce litre liter gallon barrel bbl km kilometre kilometer mile metre meter foot feet " +
    "inch acre hectare hour minute second day week month year quarter gb tb mb kb gw mw kw kwh mwh gwh twh watt degree " +
    "percent point bp basis").split(" ")
);

/**
 * Whether two counts are given by the same owner and the same verb: "Kestrel
 * Air carried 11.9 million travellers" against "Kestrel Air carried 12.4
 * million passengers". Every word of the claim figure's clause before it is
 * in the passage figure's, and the word right before each is the same, in
 * any tense ("operates" and "operated" alike, `stemOf`). A
 * count in a unit of measure ("300,000 tonnes") counts no things. Whether the
 * two count the same thing is `countsSameThing`'s to say, and asked first.
 */
function sameCountClause(claim: string, n: NumericFact, passage: string, p: NumericFact): boolean {
  if (n.kind !== "plain" || p.kind !== "plain") return false;
  const unit = numberContext(passage, p).unit;
  if (unit && MEASURE_UNITS.has(unit)) return false;
  const a = figureClause(claim, n).words;
  const b = figureClause(passage, p).words;
  // In any tense: an undated "operates 96 vessels" and a dated "operated 81 vessels in 2024" are the same verb.
  const last = (words: readonly ClauseWord[]) => (words.length > 0 ? stemOf(words[words.length - 1]!.raw) : null);
  if (!last(a) || last(a) !== last(b)) return false;
  const content = (words: readonly ClauseWord[]) =>
    new Set(words.filter((w) => tokenForm(w.raw).length >= 2 && !STOPWORDS.has(tokenForm(w.raw))).map((w) => stemOf(w.raw)));
  const ca = content(a);
  const cb = content(b);
  return ca.size > 0 && [...ca].every((f) => cb.has(f));
}

/** Content words of a text with its dates, days and figures cut out: the words of an event, whenever it was. */
function eventWords(text: string): Set<string> {
  const { dates, numbers } = figuresOf(text);
  let cut = text;
  for (const m of [...dates, ...numbers].sort((x, y) => y.start - x.start)) cut = cut.slice(0, m.start) + " " + cut.slice(m.end);
  return new Set([...contentTokens(cut)].filter((t) => !/^[\d.,%$€£]+$/.test(t) && !NOT_A_SUBJECT.has(t)));
}

/** A clause that is only a date or a day, as a lead-in to the next one: "In 2021, …", "On Thursday, …". */
const DATE_LEAD_IN = /^\s*(?:(?:in|on|by|during|since|as of|at the end of)\s+)?$/i;

/**
 * The clauses of the passage that tell the event of the claim's clause
 * holding `raw` (a date or a day): each holds every content word of that
 * clause, dates, days and figures aside — at least two of them — and comes
 * with the clause before it in its sentence, which may be its date ("In
 * 2021, …"). None when the claim's clause gives a figure: its date is the
 * figure's period ("revenue was $4.3 billion in 2024"), and another year's
 * figure is last year, not another date for the same event.
 */
function eventClauses(claim: string, raw: string, passage: string): Array<{ clause: string; lead: string | null }> {
  const claimClause = clausesOf(claim).find((c) => c.includes(raw));
  if (!claimClause || figuresOf(claimClause).numbers.length > 0) return [];
  const words = eventWords(claimClause);
  if (words.size < 2) return [];
  const out: Array<{ clause: string; lead: string | null }> = [];
  for (const sentence of sentencesIn(passage.replace(/\n+/g, " "))) {
    const clauses = clausesOf(sentence);
    clauses.forEach((clause, i) => {
      const tokens = contentTokens(clause);
      if ([...words].every((w) => tokens.has(w))) out.push({ clause, lead: i > 0 ? clauses[i - 1]! : null });
    });
  }
  return out;
}

/** What is left of a lead-in clause once its dates and days are cut: a bare lead-in leaves only "In" or "On". */
function leadInRest(lead: string, spans: ReadonlyArray<{ start: number; end: number }>): string {
  let rest = lead;
  for (const x of [...spans].sort((a, b) => b.start - a.start)) rest = rest.slice(0, x.start) + rest.slice(x.end);
  return rest;
}

/**
 * Whether the passage gives claim date `d` another date for the same event:
 * a clause of the passage holding every content word of the claim's clause
 * with `d` in it (dates and figures aside, at least two of them), dated —
 * in that clause, or by a date-only lead-in before it — and by no date that
 * agrees with `d`. "Quillon launched in Italy in May 2024" against "Quillon
 * launched in Italy in March 2024"; never "Quillon, founded in 2019,
 * launched in Italy", whose date is another clause's.
 */
function anotherDateForEvent(claim: string, d: DateMention, passage: string): DateMention | null {
  for (const { clause, lead } of eventClauses(claim, d.raw, passage)) {
    let dates = extractDates(clause);
    if (dates.length === 0 && lead) {
      const leadDates = extractDates(lead);
      if (leadDates.length > 0 && DATE_LEAD_IN.test(leadInRest(lead, leadDates))) dates = leadDates;
    }
    if (dates.length > 0 && !dates.some((x) => datesAgree(x, d))) return dates[0]!;
  }
  return null;
}

/** `anotherDateForEvent` for a day of the week: "passed the bill on Thursday" against the claim's "on Tuesday". */
function anotherDayForEvent(claim: string, day: DayMention, passage: string): DayMention | null {
  for (const { clause, lead } of eventClauses(claim, day.raw, passage)) {
    let days = weekdaysIn(clause);
    if (days.length === 0 && lead) {
      const leadDays = weekdaysIn(lead);
      if (leadDays.length > 0 && DATE_LEAD_IN.test(leadInRest(lead, leadDays))) days = leadDays;
    }
    if (days.length > 0 && !days.some((x) => x.day === day.day)) return days[0]!;
  }
  return null;
}

/**
 * Whether `passage`, cited for the claim beside `supporting` (the passage
 * that supported it), gives a different figure or date for something the
 * supporting passage states as the claim does. For each claim figure the
 * passage lacks and the supporting passage gives: a figure of the same kind
 * in the passage, for the claim's period or none — for a count, one that
 * counts the same thing (`countsSameThing`: never another thing counted for
 * the same owner, "3 ports" against "12 vessels") — that is
 * not the evidence for another of the claim's figures
 * (`evidenceForAnotherFigure`) or a figure the passage provably gives for
 * another subject the claim names (`strictlyAnotherEntity`), and either
 *  - it is a count by the same owner and verb (`sameCountClause`); or
 *  - the passage leaves out a name the claim and the supporting passage give
 *    the subject (`leavesOutSupportedName`), so it may be that subject under
 *    another name.
 * For each claim date or day of the week the passage lacks and the
 * supporting passage gives: the passage dates the same event otherwise
 * (`anotherDateForEvent`, `anotherDayForEvent`).
 *
 * It never contradicts, supports or caps anything: what it finds is a doubt
 * the text cannot settle, recorded beside the claim with the neutral finding
 * `supportingPassageDifference` words, and it makes a supported claim
 * contested at most.
 */
export function differsFromSupportingPassage(claim: string, passage: string, supporting: string): boolean {
  return supportingPassageDifference(claim, passage, supporting) !== null;
}

/**
 * `differsFromSupportingPassage` as the finding a reader is shown: which of
 * the passage's figures or dates may disagree with which of the supporting
 * passage's, in neutral words. A note, not an objection — it caps nothing
 * (ceiling 1), and the passage's own findings stay as they were.
 */
export function supportingPassageDifference(claim: string, passage: string, supporting: string): AuditReason | null {
  if (passage === supporting) return null;
  const c = figuresOf(claim);
  const p = figuresOf(passage);
  const s = figuresOf(supporting);
  const claimFacts = { text: claim, dates: c.dates, numbers: c.numbers };
  const passageFacts = { text: passage, dates: p.dates, numbers: p.numbers };
  const supportFacts = { text: supporting, dates: s.dates, numbers: s.numbers };
  const note = (theirs: string, ours: string, what: "figure" | "date" | "day"): AuditReason => ({
    code: "differs_from_support",
    detail:
      what === "figure"
        ? `This passage gives ${theirs} where the passage that supports the claim gives ${ours}, for what may be the same measure, so the sources may disagree.`
        : `This passage dates the same event ${theirs} where the passage that supports the claim gives ${ours}, so the sources may disagree.`,
    ceiling: 1,
  });
  let unnamed: boolean | null = null;
  for (const n of c.numbers) {
    const statedBy = (facts: typeof passageFacts) =>
      facts.numbers.find((q) => comparable(n, q) && (figuresAgree(n, q) || rangeHolds(facts, q, n.value)));
    const supported = statedBy(supportFacts);
    if (statedBy(passageFacts) || !supported) continue;
    for (const q of p.numbers) {
      if (!comparable(n, q)) continue;
      if (!samePeriodOrUnknown(claimFacts, n, passageFacts, q)) continue;
      if (q.kind === "plain" && !countsSameThing(claim, n, passage, q)) continue;
      if (evidenceForAnotherFigure(claimFacts, n, passageFacts, q, { strict: true }) || strictlyAnotherEntity(claim, n, passage, q)) continue;
      if (sameCountClause(claim, n, passage, q)) return note(q.raw, supported.raw, "figure");
      unnamed ??= leavesOutSupportedName(claim, passage, supporting);
      if (unnamed) return note(q.raw, supported.raw, "figure");
    }
  }
  for (const d of c.dates) {
    const supported = s.dates.find((x) => datesAgree(x, d));
    if (p.dates.some((x) => datesAgree(x, d)) || !supported) continue;
    const theirs = anotherDateForEvent(claim, d, passage);
    if (theirs) return note(theirs.raw, supported.raw, "date");
  }
  const passageDays = weekdaysIn(passage);
  const supportDays = weekdaysIn(supporting);
  for (const day of weekdaysIn(claim)) {
    const supported = supportDays.find((x) => x.day === day.day);
    if (passageDays.some((x) => x.day === day.day) || !supported) continue;
    const theirs = anotherDayForEvent(claim, day, passage);
    if (theirs) return note(theirs.raw, supported.raw, "day");
  }
  return null;
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
  judge: CitationJudge;
}): Promise<LinkVerdict> {
  const claimType = opts.claimType ?? classify(opts.claim);
  const audit = auditEvidence({
    claim: opts.claim,
    claimType,
    passage: opts.passage,
    publishedAt: opts.publishedAt,
    asOf: opts.asOf,
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
