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

/**
 * Lowercase, de-accent, and flatten the punctuation a publisher's typography
 * differs on. Curly quotes and en dashes are the reason a verbatim quotation
 * check used to fail on genuine matches: the report is written by a model that
 * emits “ ” and the scraped page carries " ".
 */
export function normalizeText(s: string): string {
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

/** Content words of a sentence: what is left once the grammar is thrown away. */
export function contentTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of normalizeText(s).split(/[^a-z0-9%$€£.]+/)) {
    const w = raw.replace(/^[.]+|[.]+$/g, "");
    if (w.length < 3 && !/^\d+$/.test(w)) continue;
    if (STOPWORDS.has(w)) continue;
    // Crude singularisation: "vaccines" and "vaccine" are the same evidence.
    out.add(w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
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
function numberContext(text: string, n: NumericFact): { unit: string | null; before: Set<string> } {
  const after = text.slice(n.end, n.end + 28);
  const unit = [...contentTokens(after)][0] ?? null;
  return { unit, before: contentTokens(text.slice(Math.max(0, n.start - 48), n.start)) };
}

/** Whether two figures are plausibly measuring the same quantity. */
function measuresSameThing(claim: string, a: NumericFact, passage: string, b: NumericFact): boolean {
  const ca = numberContext(claim, a);
  const cb = numberContext(passage, b);
  if (ca.unit && cb.unit && ca.unit === cb.unit) return true;
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
    // Headings assert nothing on their own, and a table row is cells rather
    // than sentences. Both end whatever paragraph preceded them.
    if (/^#{1,6}\s/.test(trimmed) || /^\|/.test(trimmed)) {
      flush();
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
  return claims;
}

export interface RepairableClaim extends ExtractedClaim {
  status: ClaimStatus;
  supportStrength: number | null;
}

export interface ReportRepairResult {
  report: string;
  repaired: boolean;
  repairedClaims: number;
}

/**
 * Make a report honest without inventing replacement facts. Unsupported
 * language is weakened in place, contradictions stay visible, and claims the
 * bounded judge could not check are labelled as such. Replacements run from
 * the end of the document so the stored answer spans remain valid while the
 * repair is applied.
 */
export function repairReportFromClaims(report: string, claims: readonly RepairableClaim[]): ReportRepairResult {
  const replacements = claims
    .filter((claim) => claim.status !== "supported")
    .map((claim) => {
      const span = parseAnswerSpan(claim.answerSpan);
      if (!span) return null;
      const label = supportLabel(claim.status, claim.supportStrength);
      const prefix =
        claim.status === "contradicted"
          ? "Conflicting evidence: "
          : label === "partially supported"
          ? "Evidence is incomplete: "
          : claim.status === "unverified"
          ? "Unverified: "
          : "The cited evidence is insufficient: ";
      const suffix =
        claim.status === "contradicted"
          ? " (the cited source reports conflicting evidence.)"
          : label === "partially supported"
          ? " (the cited source supports only part of this statement.)"
          : claim.status === "unverified"
          ? " (this claim could not be checked within the run limits.)"
          : " (the cited passage does not establish this.)";
      return { ...span, replacement: `${prefix}${report.slice(span.start, span.end).trim()}${suffix}` };
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
  attribution: 0.75,
} as const;

/** The sentence in the passage the claim is actually about. */
export function bestMatchingSentence(claim: string, passage: string): string {
  const sentences = splitSentences(passage.replace(/\n+/g, " "), 0)
    .map((s) => s.text.trim())
    .filter((s) => s.length > 20);
  if (sentences.length === 0) return passage;
  let best = sentences[0];
  let bestScore = -1;
  for (const s of sentences) {
    const score = tokenCoverage(claim, s);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
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

  const coverage = tokenCoverage(claim, passage);
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
  const normalizedPassage = normalizeText(passage);
  for (const quote of extractQuotes(claim)) {
    if (!normalizedPassage.includes(normalizeText(quote))) {
      cap(CEILING.quoteAbsent, {
        code: "quote_absent",
        detail: `The quoted words are not in the cited passage: “${quote.slice(0, 120)}”.`,
      });
      break;
    }
  }

  // ── Figures ──────────────────────────────────────────────────────────────
  const claimDates = extractDates(claim);
  const passageDates = extractDates(passage);
  const claimNums = extractNumbers(claim, claimDates);
  const passageNums = extractNumbers(passage, passageDates);
  for (const n of claimNums) {
    const sameKind = passageNums.filter((p) => p.kind === n.kind);
    if (sameKind.some((p) => numbersAgree(p.value, n.value))) continue;
    const rival = sameKind.filter((p) => measuresSameThing(claim, n, passage, p));
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
  const focus = bestMatchingSentence(claim, passage);
  if (tokenCoverage(claim, focus) >= 0.45 && negationParity(claim) !== negationParity(focus)) {
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
    const passageTokens = contentTokens(passage);
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

  return { ceiling, contradicted, reasons };
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
  judge: CitationJudge;
}): Promise<LinkVerdict> {
  const claimType = opts.claimType ?? classify(opts.claim);
  const audit = auditEvidence({
    claim: opts.claim,
    claimType,
    passage: opts.passage,
    publishedAt: opts.publishedAt,
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
export function resolveClaimStatus(verdicts: readonly LinkVerdict[]): {
  status: ClaimStatus;
  supportStrength: number | null;
} {
  if (verdicts.length === 0) return { status: "unsupported", supportStrength: 0 };
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
  publishedAt?: Date | null;
  eventDate?: Date | null;
  /** Set when detectSyndication found this to be a copy of another source. */
  duplicate?: boolean;
  now?: Date;
}): SourceScore {
  const authority = authorityOf(input.url);
  const freshness = freshnessOf({ publishedAt: input.publishedAt, eventDate: input.eventDate, now: input.now });
  const directness = directnessOf(input.text);
  // A syndicated copy is not a second witness. Zero, not "a bit less": the
  // whole point of the independence axis is that counting a wire story twice is
  // the corroboration failure §8.3 names by name.
  const independence = input.duplicate ? 0 : 1;
  const composite = independence === 0
    ? 0
    : 0.4 * authority + 0.2 * freshness + 0.25 * directness + 0.15 * independence;
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
