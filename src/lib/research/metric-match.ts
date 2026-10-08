/**
 * Does a finding state the figure a vector asked for? Deterministic,
 * unit-aware matching for the gap audit (research protocol Stage 4).
 *
 * The audit used to compare a metric's words with a finding's words
 * (`tokenCoverage ≥ 0.4`), so "price per seat per month" looked missing when
 * the finding said "$19 per user per month", "monthly" and "/mo" were
 * different words, "USD" and "$" never met, and "$19 a month" and "$228 a
 * year" were reported as two pages disagreeing. Each false gap became a paid
 * search for something the run already had.
 *
 * This normalises both sides first — seat/user/member/licence, month/mo/
 * monthly, year/annual/yearly, currency words and symbols, price/cost/fee,
 * limit/cap/quota, rate limit/RPM, context window — then matches on the
 * metric's concept words with a numeric-kind check (a price metric wants a
 * currency figure, a share wants a percentage). Figures are compared with
 * their currency, per-seat basis and billing period, a yearly figure divided
 * down to the month, within a tolerance for rounding.
 *
 * It also names the options a comparison is between ("GitHub Copilot or
 * Cursor"), so the audit can ask for each option's own figure: Copilot's
 * price must not satisfy "price per seat" for Cursor.
 *
 * Pure and client-safe.
 */

import { contentTokens, extractDates, extractNumbers, normalizeText, type NumericFact } from "@/lib/research/claim-analysis";

/** Phrase → canonical token, applied to normalised text, most specific first. */
const SYNONYMS: Array<[RegExp, string]> = [
  [/\brate[- ]?limit(?:s|ed|ing)?\b|\brequests? per (?:minute|second|hour|day)\b|\b(?:rpm|rps|tpm|rpd)\b/g, " ratelimit "],
  [/\bcontext (?:window|length|size)s?\b/g, " contextwindow "],
  [/\bper (?:seat|user|member|licen[cs]e|head|developer|editor|person|agent|active user)s?\b|\/ ?(?:seat|user|member|licen[cs]e)s?\b|\beach (?:seat|user|member)\b/g, " perseat "],
  [/\bper (?:month|mo)\b|\/ ?mo(?:nth)?\b|\bmonthly\b|\ba month\b|\bp\/m\b|\bmo\b|\bper mensem\b/g, " permonth "],
  [/\bper (?:year|annum|yr)\b|\/ ?y(?:ea)?r\b|\bannual(?:ly)?\b|\byearly\b|\ba year\b|\bp\.?a\.?(?=\s|$)/g, " peryear "],
  [/\bus\$|\busd\b|\bdollars?\b/g, " usd "],
  [/\beur(?:os?)?\b/g, " eur "],
  [/\bgbp\b|\bpounds? sterling\b/g, " gbp "],
  [/\b(?:pric(?:e|es|ed|ing)|costs?|costing|fees?|charges?|charged|subscription)\b/g, " price "],
  [/\b(?:limits?|caps?|capped|quotas?|maximum|max|allowance|ceilings?)\b/g, " limit "],
  [/\b(?:requests?|calls?|messages?|prompts?|queries)\b/g, " request "],
  [/\b(?:discounts?|discounted|savings?|saves?)\b/g, " discount "],
  [/\b(?:percent|per cent|percentage)\b|%/g, " pct "],
  [/\b(?:seats?|licen[cs]es?|users?|members?)\b/g, " seat "],
  [/\b(?:storage|disk space)\b/g, " storage "],
  [/\b(?:latency|response time)\b/g, " latency "],
  [/\b(?:uptime|availability sla|sla)\b/g, " uptime "],
];

/** Words a metric uses to say "a number", which no finding has to repeat. */
const GENERIC = new Set([
  "exact", "figure", "number", "official", "current", "amount", "value", "total", "each", "specific", "published", "stated",
  "documented", "page", "documentation", "data", "metric", "level", "actual", "real", "list", "available", "tier", "plan",
]);

/** Text with its units and synonyms folded to canonical tokens. */
export function canonicalText(text: string): string {
  let out = ` ${normalizeText(text).replace(/[$€£]/g, (symbol) => (symbol === "$" ? " usd " : symbol === "€" ? " eur " : " gbp "))} `;
  for (const [pattern, token] of SYNONYMS) out = out.replace(pattern, token);
  return out.replace(/\s+/g, " ").trim();
}

export function canonicalTokens(text: string): Set<string> {
  return contentTokens(canonicalText(text));
}

/** The concept words a metric is about, units folded, generic words dropped. */
export function metricSignature(metric: string): Set<string> {
  const tokens = canonicalTokens(metric);
  for (const word of GENERIC) tokens.delete(word);
  return tokens;
}

function hasFigure(text: string): boolean {
  return extractNumbers(text, extractDates(text)).length > 0 || extractDates(text).length > 0;
}

/** What kind of figure a metric wants, from its concept words. */
function expectedKind(signature: ReadonlySet<string>): NumericFact["kind"] | null {
  if (signature.has("pct") || signature.has("discount")) return "percent";
  if (signature.has("price") || signature.has("usd") || signature.has("eur") || signature.has("gbp")) return "currency";
  return null;
}

/** Share of the metric's concept words the text carries, after folding units. */
export function metricCoverage(metric: string, text: string): number {
  const signature = metricSignature(metric);
  if (signature.size === 0) return 0;
  const tokens = canonicalTokens(text);
  let hit = 0;
  for (const token of signature) if (tokens.has(token)) hit += 1;
  return hit / signature.size;
}

/**
 * Whether `text` states the figure `metric` names: it carries a figure, and
 * either most of the metric's concept words, or a good part of them plus a
 * figure of the kind the metric wants (a currency amount for a price).
 */
export function statesMetric(metric: string, text: string): boolean {
  if (!hasFigure(text)) return false;
  const coverage = metricCoverage(metric, text);
  if (coverage >= 0.5) return true;
  const kind = expectedKind(metricSignature(metric));
  if (coverage >= 0.3 && kind) {
    const numbers = extractNumbers(text, extractDates(text));
    const canon = canonicalTokens(text);
    if (numbers.some((n) => n.kind === kind) || (kind === "currency" && (canon.has("usd") || canon.has("eur") || canon.has("gbp")))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Figures with their units
// ---------------------------------------------------------------------------

export interface UnitFigure {
  value: number;
  kind: NumericFact["kind"];
  currency: "usd" | "eur" | "gbp" | null;
  /** The billing period the figure was stated for, when it said. */
  period: "month" | "year" | null;
  perSeat: boolean;
}

/** Tolerance two figures may differ by and still be "the same": rounding, not disagreement. */
export const FIGURE_TOLERANCE = 0.03;

/** Each figure in the text with the currency, period and per-seat basis stated in the 40 characters after it. */
export function unitFigures(text: string): UnitFigure[] {
  const out: UnitFigure[] = [];
  for (const n of extractNumbers(text, extractDates(text))) {
    const around = canonicalText(`${text.slice(Math.max(0, n.start - 4), n.start)} ${text.slice(n.start, n.end + 40)}`);
    const tokens = new Set(around.split(" "));
    const currency = /[$]/.test(n.raw) || tokens.has("usd") ? "usd" : /€/.test(n.raw) || tokens.has("eur") ? "eur" : /£/.test(n.raw) || tokens.has("gbp") ? "gbp" : null;
    out.push({
      value: n.value,
      kind: currency && n.kind === "plain" ? "currency" : n.kind,
      currency,
      period: tokens.has("permonth") ? "month" : tokens.has("peryear") ? "year" : null,
      perSeat: tokens.has("perseat"),
    });
  }
  return out;
}

function close(a: number, b: number, tolerance = FIGURE_TOLERANCE): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 || Math.abs(a - b) / scale <= tolerance;
}

/** Whether two figures can be compared at all: same kind, currency, and seat basis. */
export function comparable(a: UnitFigure, b: UnitFigure): boolean {
  if (a.kind !== b.kind) return false;
  if (a.currency && b.currency && a.currency !== b.currency) return false;
  if (a.kind === "currency" && a.perSeat !== b.perSeat && (a.period || b.period)) return false;
  return true;
}

/** Same figure: within tolerance, a yearly price compared at its monthly rate. */
export function figuresAgree(a: UnitFigure, b: UnitFigure): boolean {
  if (close(a.value, b.value)) return true;
  if (a.period && b.period && a.period !== b.period) {
    const monthly = (f: UnitFigure) => (f.period === "year" ? f.value / 12 : f.value);
    return close(monthly(a), monthly(b));
  }
  return false;
}

/**
 * Two texts state different values for the same thing: they share a
 * comparable figure kind, and no figure of one agrees with any comparable
 * figure of the other.
 */
export function figuresConflict(a: string, b: string): boolean {
  const fa = unitFigures(a);
  const fb = unitFigures(b);
  const pairs = fa.flatMap((x) => fb.filter((y) => comparable(x, y)).map((y) => [x, y] as const));
  if (pairs.length === 0) return false;
  return !pairs.some(([x, y]) => figuresAgree(x, y));
}

// ---------------------------------------------------------------------------
// Options in a comparison
// ---------------------------------------------------------------------------

const COMPARISON_CUE = /\b(?:or|vs\.?|versus|compare[ds]?|comparison|between|against|better than|alternatives? to|instead of)\b/i;
const NAME = /\b([A-Z][\w.+-]*(?:\s+(?:[A-Z][\w.+-]*|\d[\w.]*)){0,3})/g;
const NOT_OPTION = new Set([
  "Should", "Which", "What", "How", "Is", "Are", "Do", "Does", "Can", "Could", "Would", "Will", "Why", "When", "Where", "Who",
  "Compare", "Comparing", "Our", "We", "I", "My", "The", "A", "An", "For", "In", "On", "Between", "Versus", "Or", "And",
  "Please", "Help", "Find", "Give", "Tell", "Research", "Evaluate", "Recommend", "Best", "Top",
]);

/**
 * The options a goal compares, when it compares any: capitalised names
 * around a comparison cue ("GitHub Copilot or Cursor", "Postgres vs MySQL",
 * "compare Stripe, Adyen and Mollie"). At most five; empty when the goal is
 * not a comparison.
 */
export function comparisonOptions(goal: string): string[] {
  if (!COMPARISON_CUE.test(goal)) return [];
  const names: string[] = [];
  for (const match of goal.matchAll(NAME)) {
    const words = match[1]!.split(/\s+/);
    while (words.length && NOT_OPTION.has(words[0]!)) words.shift();
    const name = words.join(" ").replace(/[.,;:?!]+$/, "");
    if (name.length < 2 || /^\d/.test(name)) continue;
    if (!names.some((existing) => existing.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  // Lower-case "x vs y" (no capitals): the words either side of the cue.
  if (names.length < 2) {
    const vs = /([a-z0-9][\w.+-]{1,30})\s+(?:vs\.?|versus)\s+([a-z0-9][\w.+-]{1,30})/i.exec(goal);
    if (vs) return [vs[1]!, vs[2]!];
  }
  return names.length >= 2 ? names.slice(0, 5) : [];
}

/** The tokens that tell one option apart from the others ("copilot" for GitHub Copilot vs Cursor). */
export function optionKeys(options: readonly string[]): Map<string, string[]> {
  const tokensOf = (option: string) => normalizeText(option).split(/[^a-z0-9.+-]+/).filter((t) => t.length >= 2);
  const counts = new Map<string, number>();
  for (const option of options) for (const token of new Set(tokensOf(option))) counts.set(token, (counts.get(token) ?? 0) + 1);
  return new Map(
    options.map((option) => {
      const distinct = tokensOf(option).filter((token) => counts.get(token) === 1);
      return [option, distinct.length ? distinct : tokensOf(option)];
    })
  );
}

/** Whether a finding (its text and page) is about this option. */
export function mentionsOption(keys: readonly string[], text: string, url: string): boolean {
  const words = new Set(normalizeText(text).split(/[^a-z0-9.+-]+/));
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = "";
  }
  return keys.some((key) => words.has(key) || (key.length >= 4 && host.includes(key.replace(/[.+]/g, ""))));
}
