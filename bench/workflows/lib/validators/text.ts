/**
 * Validators over text deliverables: answers, facts files, HTML, citations,
 * constraint puzzles and extraction outputs.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CheckResult, ValidatorSpec } from "../types";
import {
  fail,
  foldForMatch,
  matches,
  normalizeSpace,
  notRun,
  pass,
  patternLabel,
  readOutput,
  wordCount,
} from "./util";

type Spec<K extends ValidatorSpec["kind"]> = Extract<ValidatorSpec, { kind: K }>;

function readText(outputsDir: string, file: string): string | Error {
  try {
    return readOutput(outputsDir, file).toString("utf8");
  } catch (error) {
    return error as Error;
  }
}

// ---------------------------------------------------------------------------
// Language identification (stopword profile; enough to tell a French answer
// from an English one, which is the failure that matters)
// ---------------------------------------------------------------------------

const STOPWORDS: Record<"en" | "fr" | "es" | "de", string[]> = {
  en: ["the", "and", "is", "of", "to", "in", "that", "it", "was", "for", "with", "are", "on", "this", "not"],
  fr: ["le", "la", "les", "et", "est", "des", "du", "un", "une", "que", "pour", "pas", "dans", "sur", "au", "ce", "qui", "en"],
  es: ["el", "la", "los", "las", "y", "es", "de", "que", "en", "un", "una", "por", "con", "para", "del", "se", "al"],
  de: ["der", "die", "das", "und", "ist", "nicht", "ein", "eine", "zu", "mit", "den", "von", "auf", "für", "im"],
};

export function detectLanguage(text: string): { language: string; scores: Record<string, number> } {
  const japanese = (text.match(/[぀-ヿ㐀-鿿]/g) ?? []).length;
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (japanese > Math.max(10, words.length)) return { language: "ja", scores: { ja: japanese } };
  const scores: Record<string, number> = {};
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    scores[lang] = words.filter((w) => set.has(w)).length / Math.max(1, words.length);
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return { language: best && best[1] > 0.04 ? best[0] : "unknown", scores };
}

// ---------------------------------------------------------------------------

export function validateText(spec: Spec<"text">, outputsDir: string): CheckResult[] {
  const id = (what: string) => `text:${spec.file}:${what}`;
  const text = readText(outputsDir, spec.file);
  if (text instanceof Error) return [fail(id("exists"), text.message)];
  const checks: CheckResult[] = [];
  checks.push(text.trim() ? pass(id("non-empty"), `${text.length} characters`) : fail(id("non-empty"), "empty answer"));
  if (spec.wordCount) {
    const n = wordCount(text);
    const ok = (spec.wordCount.min === undefined || n >= spec.wordCount.min) && (spec.wordCount.max === undefined || n <= spec.wordCount.max);
    checks.push(ok ? pass(id("word-count"), `${n} words`) : fail(id("word-count"), `${n} words, expected ${spec.wordCount.min ?? 0}–${spec.wordCount.max ?? "∞"}`));
  }
  for (const pattern of spec.requireAll ?? []) {
    checks.push(matches(text, pattern) ? pass(id(`requires:${patternLabel(pattern)}`), "present") : fail(id(`requires:${patternLabel(pattern)}`), "missing"));
  }
  for (const group of spec.requireAny ?? []) {
    const hit = group.find((p) => matches(text, p));
    const label = group.map(patternLabel).join(" | ");
    checks.push(hit ? pass(id(`any:${label}`), `matched ${patternLabel(hit)}`) : fail(id(`any:${label}`), "none of the accepted forms present"));
  }
  for (const pattern of spec.forbid ?? []) {
    checks.push(matches(text, pattern) ? fail(id(`forbids:${patternLabel(pattern)}`), "present but forbidden") : pass(id(`forbids:${patternLabel(pattern)}`), "absent"));
  }
  if (spec.language) {
    const detected = detectLanguage(text);
    checks.push(detected.language === spec.language ? pass(id(`language:${spec.language}`), `detected ${detected.language}`) : fail(id(`language:${spec.language}`), `detected ${detected.language} (${JSON.stringify(detected.scores)})`));
  }
  for (const script of spec.scripts ?? []) {
    const re = script === "japanese" ? /[぀-ヿ㐀-鿿]/ : script === "arabic" ? /[؀-ۿ]/ : /[A-Za-z]/;
    checks.push(re.test(text) ? pass(id(`script:${script}`), "present") : fail(id(`script:${script}`), "no characters of this script"));
  }
  if (spec.bullets) {
    const n = text.split("\n").filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line)).length;
    const ok = (spec.bullets.min === undefined || n >= spec.bullets.min) && (spec.bullets.max === undefined || n <= spec.bullets.max);
    checks.push(ok ? pass(id("bullets"), `${n} bullet(s)`) : fail(id("bullets"), `${n} bullet(s), expected ${spec.bullets.min ?? 0}–${spec.bullets.max ?? "∞"}`));
  }
  if (spec.firstLineMaxWords !== undefined) {
    const first = text.split("\n").find((line) => line.trim()) ?? "";
    const n = wordCount(first);
    checks.push(n > 0 && n <= spec.firstLineMaxWords ? pass(id("headline"), `${n} words: "${first.trim().slice(0, 80)}"`) : fail(id("headline"), `first line has ${n} words (max ${spec.firstLineMaxWords})`));
  }
  if (spec.finalAnswer) {
    const all = [...text.matchAll(new RegExp(spec.finalAnswer.regex, "gim"))];
    const last = all.at(-1)?.[1]?.trim();
    if (last === undefined) {
      checks.push(fail(id("final-answer"), `no line matches /${spec.finalAnswer.regex}/`));
    } else if (typeof spec.finalAnswer.equals === "number") {
      const value = Number(last.replace(/[,\s]/g, ""));
      const ok = Number.isFinite(value) && Math.abs(value - spec.finalAnswer.equals) <= (spec.finalAnswer.tolerance ?? 0);
      checks.push(ok ? pass(id("final-answer"), `${value}`) : fail(id("final-answer"), `answered ${last}, expected ${spec.finalAnswer.equals}`));
    } else {
      const ok = foldForMatch(last).toLowerCase() === foldForMatch(spec.finalAnswer.equals).toLowerCase();
      checks.push(ok ? pass(id("final-answer"), last) : fail(id("final-answer"), `answered "${last}", expected "${spec.finalAnswer.equals}"`));
    }
  }
  return checks;
}

export function validateFacts(spec: Spec<"facts">, outputsDir: string): CheckResult[] {
  const id = (what: string) => `facts:${spec.file}:${what}`;
  const text = readText(outputsDir, spec.file);
  if (text instanceof Error) return [fail(id("exists"), text.message)];
  let facts: Record<string, unknown>;
  try {
    facts = JSON.parse(text) as Record<string, unknown>;
    if (!facts || typeof facts !== "object" || Array.isArray(facts)) throw new Error("not an object");
  } catch (error) {
    return [fail(id("json"), `not a JSON object: ${(error as Error).message}`)];
  }
  const checks: CheckResult[] = [pass(id("json"), "valid JSON object")];
  for (const [key, expected] of Object.entries(spec.expect)) {
    const got = facts[key];
    let ok: boolean;
    if (typeof expected === "number") {
      const n = typeof got === "string" ? Number(got.replace(/[^\d.-]/g, "")) : got;
      ok = typeof n === "number" && Number.isFinite(n) && Math.abs(n - expected) <= (spec.tolerance ?? 0.005);
    } else if (typeof expected === "string") {
      ok = typeof got === "string" && foldForMatch(got).toLowerCase() === foldForMatch(expected).toLowerCase();
    } else {
      ok = got === expected;
    }
    checks.push(ok ? pass(id(key), `${JSON.stringify(got)}`) : fail(id(key), `got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`));
  }
  return checks;
}

export function validateHtml(spec: Spec<"html">, outputsDir: string): CheckResult[] {
  const id = (what: string) => `html:${spec.file}:${what}`;
  const html = readText(outputsDir, spec.file);
  if (html instanceof Error) return [fail(id("exists"), html.message)];
  const checks: CheckResult[] = [];
  checks.push(/<html[\s>]/i.test(html) && /<\/html>/i.test(html) ? pass(id("document"), "a complete HTML document") : fail(id("document"), "not a complete HTML document"));
  checks.push(/<meta\s[^>]*charset\s*=\s*["']?utf-8/i.test(html) ? pass(id("charset"), "declares UTF-8") : fail(id("charset"), "no UTF-8 charset declaration"));
  const scripts = html.match(/<script\b/gi)?.length ?? 0;
  checks.push(scripts === 0 ? pass(id("no-script"), "no script elements") : fail(id("no-script"), `${scripts} <script> element(s) in a printable report`));
  const headings = [...html.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)].map((m) => normalizeSpace(m[1].replace(/<[^>]+>/g, "")));
  for (const wanted of spec.requiredHeadings ?? []) {
    const found = headings.some((h) => h.toLowerCase().includes(wanted.toLowerCase()));
    checks.push(found ? pass(id(`heading:${wanted}`), "present") : fail(id(`heading:${wanted}`), `missing (headings: ${headings.slice(0, 10).join(" | ")})`));
  }
  const visible = html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ");
  for (const pattern of spec.requiredText ?? []) {
    checks.push(matches(visible, pattern) ? pass(id(`text:${patternLabel(pattern)}`), "present") : fail(id(`text:${patternLabel(pattern)}`), "missing"));
  }
  for (const pattern of spec.forbid ?? []) {
    checks.push(matches(html, pattern) ? fail(id(`forbid:${patternLabel(pattern)}`), "present in the markup") : pass(id(`forbid:${patternLabel(pattern)}`), "absent"));
  }
  for (const escaped of spec.requireEscaped ?? []) {
    checks.push(html.includes(escaped) ? pass(id(`escaped:${escaped}`), "hostile input rendered as text") : fail(id(`escaped:${escaped}`), "escaped form not found (input may have been dropped or injected raw)"));
  }
  if (spec.printStylesheet) {
    const print = /@media\s+print/i.test(html) || /@page\b/i.test(html);
    checks.push(print ? pass(id("print"), "has print rules (@media print / @page)") : fail(id("print"), "no print stylesheet"));
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

export function validateCitations(spec: Spec<"citations">, outputsDir: string, fixturesDir: string): CheckResult[] {
  const id = (what: string) => `citations:${spec.file}:${what}`;
  const text = readText(outputsDir, spec.file);
  if (text instanceof Error) return [fail(id("exists"), text.message)];
  const allowed = new Map(spec.sources.map((s) => [path.basename(s).toLowerCase(), s]));
  const cites = [...text.matchAll(/\[([^\]\n]{1,120})\]/g)].flatMap((m) => m[1].split(/[;,]/).map((s) => s.trim().replace(/^source:\s*/i, "")));
  const fileCites = cites.filter((c) => /\.[a-z0-9]{2,5}$/i.test(c));
  const unknown = fileCites.filter((c) => !allowed.has(path.basename(c).toLowerCase()));
  const known = fileCites.filter((c) => allowed.has(path.basename(c).toLowerCase()));
  const checks: CheckResult[] = [];
  checks.push(known.length >= spec.minCitations ? pass(id("count"), `${known.length} citation(s) to provided sources`) : fail(id("count"), `${known.length} citation(s), need ${spec.minCitations}`));
  checks.push(unknown.length === 0 ? pass(id("no-invented-sources"), "every cited file was provided") : fail(id("no-invented-sources"), `cites files that were not provided: ${[...new Set(unknown)].join(", ")}`));
  const distinct = new Set(known.map((c) => path.basename(c).toLowerCase()));
  if (spec.minDistinctSources !== undefined) {
    checks.push(distinct.size >= spec.minDistinctSources ? pass(id("distinct"), `${distinct.size} distinct sources`) : fail(id("distinct"), `${distinct.size} distinct sources, need ${spec.minDistinctSources}`));
  }
  if (spec.verifyQuotes) {
    // "quoted span" … [file.md] within the same sentence/line.
    const quoteRe = /["“]([^"”\n]{6,300})["”][^\n[]{0,120}\[([^\]\n]+)\]/g;
    let verified = 0;
    const misquoted: string[] = [];
    for (const m of text.matchAll(quoteRe)) {
      const target = m[2].split(/[;,]/).map((s) => s.trim().replace(/^source:\s*/i, "")).find((c) => allowed.has(path.basename(c).toLowerCase()));
      if (!target) continue;
      const fixture = path.join(fixturesDir, allowed.get(path.basename(target).toLowerCase())!);
      const source = existsSync(fixture) ? foldForMatch(readFileSync(fixture, "utf8")).toLowerCase() : "";
      if (source.includes(foldForMatch(m[1]).toLowerCase())) verified += 1;
      else misquoted.push(`"${m[1].slice(0, 60)}" ≠ ${target}`);
    }
    checks.push(misquoted.length === 0 ? pass(id("quotes-faithful"), `${verified} quote(s) verified verbatim against the cited source`) : fail(id("quotes-faithful"), `misattributed or altered quotes: ${misquoted.slice(0, 4).join("; ")}`));
    const min = spec.minVerifiedQuotes ?? 1;
    checks.push(verified >= min ? pass(id("quotes-count"), `${verified} verified quote(s)`) : fail(id("quotes-count"), `${verified} verified quote(s), need ${min}`));
  }
  return checks;
}

export async function validateWebCitations(
  spec: Spec<"web_citations">,
  outputsDir: string,
  options: { network: boolean; fetchImpl?: typeof fetch }
): Promise<CheckResult[]> {
  const id = (what: string) => `web-citations:${spec.file}:${what}`;
  const text = readText(outputsDir, spec.file);
  if (text instanceof Error) return [fail(id("exists"), text.message)];
  const urls = [...new Set([...text.matchAll(/https?:\/\/[^\s)\]>"'`]+/g)].map((m) => m[0].replace(/[.,;:]+$/, "")))];
  const checks: CheckResult[] = [];
  const onDomain = urls.filter((u) => {
    try {
      const host = new URL(u).hostname.toLowerCase();
      return spec.allowedDomains.some((d) => host === d || host.endsWith(`.${d}`));
    } catch {
      return false;
    }
  });
  checks.push(onDomain.length >= spec.minUrls ? pass(id("official-urls"), `${onDomain.length} URL(s) on ${spec.allowedDomains.join(", ")}`) : fail(id("official-urls"), `${onDomain.length} URL(s) on allowed domains, need ${spec.minUrls} (found: ${urls.slice(0, 5).join(", ") || "none"})`));
  if (spec.requireAccessDate) {
    const dated = /(accessed|retrieved|consulted|as of)[^\n]{0,40}\b(20\d\d-\d\d-\d\d|\d{1,2} \w+ 20\d\d|\w+ \d{1,2},? 20\d\d)/i.test(text);
    checks.push(dated ? pass(id("access-date"), "states an access date") : fail(id("access-date"), "no access date stated"));
  }
  if (spec.checkLiveness) {
    if (!options.network) {
      checks.push(notRun(id("liveness"), "URL liveness needs network access; this run is offline"));
    } else {
      const fetcher = options.fetchImpl ?? fetch;
      const dead: string[] = [];
      for (const url of onDomain.slice(0, 10)) {
        try {
          const res = await fetcher(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(15_000) });
          if (res.status >= 400) dead.push(`${url} → ${res.status}`);
        } catch (error) {
          dead.push(`${url} → ${(error as Error).message}`);
        }
      }
      checks.push(dead.length ? fail(id("liveness"), dead.join("; ")) : pass(id("liveness"), `${Math.min(10, onDomain.length)} URL(s) resolve`));
    }
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Constraint puzzles: any assignment that satisfies the rules passes.
// ---------------------------------------------------------------------------

const MEETING_SLOTS = ["9:00", "10:00", "11:00", "13:00", "14:00"];

export function meetingsViolations(assignment: Record<string, string>): string[] {
  const slot = (m: string) => MEETING_SLOTS.indexOf((assignment[m] ?? "").replace(/^0/, "").replace(/\s/g, ""));
  const problems: string[] = [];
  const letters = ["A", "B", "C", "D", "E"];
  for (const m of letters) if (slot(m) < 0) problems.push(`${m} has no valid slot`);
  if (new Set(letters.map(slot)).size !== letters.length) problems.push("two meetings share a slot");
  if (problems.length) return problems;
  if (!(slot("A") < slot("C"))) problems.push("A must be before C");
  if (slot("B") === 0 || slot("B") === 4) problems.push("B cannot be at 9:00 or 14:00");
  if (slot("D") !== slot("B") + 1) problems.push("D must be in the slot right after B");
  if (slot("E") < 3) problems.push("E must be at 13:00 or later");
  if (slot("C") === 2) problems.push("C cannot be at 11:00");
  return problems;
}

export function validateConstraints(spec: Spec<"constraints">, outputsDir: string): CheckResult[] {
  const id = (what: string) => `constraints:${spec.puzzle}:${what}`;
  const text = readText(outputsDir, spec.file);
  if (text instanceof Error) return [fail(id("exists"), text.message)];
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  let assignment: Record<string, string>;
  try {
    assignment = JSON.parse(json ?? "") as Record<string, string>;
  } catch {
    return [fail(id("json"), "no JSON object in the answer")];
  }
  const problems = meetingsViolations(assignment);
  return [pass(id("json"), "parsed"), problems.length ? fail(id("satisfied"), problems.join("; ")) : pass(id("satisfied"), "every constraint holds")];
}

// ---------------------------------------------------------------------------
// Extraction coverage (offline file analysis): every fact the answer depends
// on must be extracted, with the locator a citation would need.
// ---------------------------------------------------------------------------

interface ExtractedBlockLike {
  text?: string;
  sheet?: string;
  cellRange?: string;
  page?: number;
  heading?: string[];
}

function cellPosition(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(ref.trim());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]), col };
}

/** True when `locator` (a cell "D2" or a range "A2:D2") covers the expected cell. */
export function rangeCovers(locator: string | undefined, expected: string): boolean {
  if (!locator) return false;
  const want = cellPosition(expected);
  const [a, b] = locator.split(":");
  const from = cellPosition(a ?? "");
  const to = cellPosition(b ?? a ?? "");
  if (!want || !from || !to) return locator === expected;
  return want.row >= Math.min(from.row, to.row) && want.row <= Math.max(from.row, to.row) && want.col >= Math.min(from.col, to.col) && want.col <= Math.max(from.col, to.col);
}

export function validateExtraction(spec: Spec<"extraction">, outputsDir: string): CheckResult[] {
  const id = (what: string) => `extraction:${spec.file}:${what}`;
  const raw = readText(outputsDir, spec.file);
  if (raw instanceof Error) return [fail(id("exists"), raw.message)];
  let blocks: ExtractedBlockLike[];
  try {
    const parsed = JSON.parse(raw) as { blocks?: ExtractedBlockLike[] };
    blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
  } catch {
    return [fail(id("json"), "not JSON")];
  }
  const checks: CheckResult[] = [blocks.length ? pass(id("blocks"), `${blocks.length} block(s)`) : fail(id("blocks"), "no blocks extracted")];
  for (const want of spec.expect) {
    const label = `${want.text}${want.sheet ? `@${want.sheet}!${want.cellRange ?? "*"}` : ""}${want.page ? `@p${want.page}` : ""}${want.heading ? `@${want.heading}` : ""}`;
    const hit = blocks.find(
      (b) =>
        typeof b.text === "string" &&
        foldForMatch(b.text).toLowerCase().includes(foldForMatch(want.text).toLowerCase()) &&
        (want.sheet === undefined || b.sheet === want.sheet) &&
        (want.cellRange === undefined || rangeCovers(b.cellRange, want.cellRange)) &&
        (want.page === undefined || b.page === want.page) &&
        (want.heading === undefined || (b.heading ?? []).some((h) => h.toLowerCase().includes(want.heading!.toLowerCase())))
    );
    checks.push(
      hit
        ? pass(id(label), `extracted with locator ${[hit.sheet, hit.cellRange, hit.page ? `p${hit.page}` : null].filter(Boolean).join("!") || (hit.heading ?? []).join(" > ")}`)
        : fail(id(label), "not extracted, or extracted without a locator that covers it")
    );
  }
  return checks;
}
