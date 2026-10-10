import { allUsd, cellText, col, isFree, isoDate, parseMarkdownTables } from "../tables";
import type { LabParser, ModelFact, Source } from "../types";

/**
 * Google Gemini API, from ai.google.dev's Markdown mirrors (`.md.txt`).
 *
 *  - pricing: one section per model ("## Gemini 3.8 Flash" + its `id` line),
 *    whose "Standard" table carries the paid-tier input / output / caching
 *    prices. Cells come in three shapes, and only the first is a flat rate:
 *      "$0.30 (text / image / video / audio)"            flat
 *      "$2.00, prompts <= 200k tokens $4.00, prompts > 200k tokens"   banded
 *      "$0.75 through December 31, 2026. $1.50 starting January 1, 2027."  scheduled
 *  - deprecations: release / shutdown dates, recommended replacements and the
 *    "requests to X are automatically routed to Y" notes.
 */
const BASE = "https://ai.google.dev/gemini-api/docs";
export const GOOGLE_PAGES = {
  pricing: `${BASE}/pricing.md.txt`,
  deprecations: `${BASE}/deprecations.md.txt`,
};

interface Cell {
  price: number | null;
  band?: { low: number; high: number; threshold: number };
  scheduled?: string;
}

/** Read one paid-tier price cell. */
export function priceCell(raw: string): Cell {
  const s = cellText(raw);
  if (/\bthrough\b.*\bstarting\b/i.test(s)) {
    return { price: allUsd(s)[0] ?? null, scheduled: s };
  }
  const band = s.match(/^\$(\d+(?:\.\d+)?),\s*prompts\s*<=\s*(\d+)k\b.*?\$(\d+(?:\.\d+)?),\s*prompts\s*>\s*\d+k/i);
  if (band) {
    return { price: Number(band[1]), band: { low: Number(band[1]), high: Number(band[3]), threshold: Number(band[2]) * 1000 } };
  }
  // "$0.25 (text / image / video) $0.50 (audio)": the text rate is the first figure.
  const first = s.match(/^\$(\d+(?:\.\d+)?)(?:\s*\(([^)]*)\))?/);
  if (!first) return { price: null };
  if (first[2] && !/text/i.test(first[2])) return { price: null };
  return { price: Number(first[1]) };
}

function parsePricing(md: string, src: Source, facts: Map<string, ModelFact>) {
  const sections = md.split(/^## /m).slice(1);
  if (!sections.length) throw new Error("google pricing: no model sections");
  for (const section of sections) {
    const ids = [...section.slice(0, 600).matchAll(/\[`([a-z0-9.-]+)`\]\(https:\/\/ai\.google\.dev\/gemini-api\/docs\/models\//g)].map((m) => m[1]);
    // A section can name several ids ("gemini-3.1-pro-preview and
    // gemini-3.1-pro-preview-customtools"); one Input/Output pair then prices
    // them all. Sections pricing ids separately (Lyria 3: per song) have no
    // such pair and are skipped below.
    if (!ids.length) continue;
    const standardAt = section.indexOf("### Standard");
    const table = parseMarkdownTables(standardAt >= 0 ? section.slice(standardAt) : section)[0];
    if (!table) continue;
    const paid = col(table, /^Paid Tier/i);
    if (paid < 0) continue;
    const row = (re: RegExp) => table.rows.find((r) => re.test(r[0]))?.[paid];
    const inRaw = row(/^Input price/i);
    const outRaw = row(/^Output price/i);
    if (!inRaw || !outRaw) continue;
    for (const id of ids) readPrices(fact(facts, id), section, inRaw, outRaw, row(/^Context caching price/i), src);
  }
}

function readPrices(f: ModelFact, section: string, inRaw: string, outRaw: string, cache: string | undefined, src: Source) {
  f.name ??= section.split("\n")[0].replace(/🍌/g, "").trim();
  f.sources.listed = src;
  if (isFree(inRaw) && isFree(outRaw)) {
    f.free = true;
    f.sources.free = src;
    return;
  }
  const input = priceCell(inRaw);
  const output = priceCell(outRaw);
  if (input.scheduled || output.scheduled) {
    f.scheduledPrice = `${input.scheduled ?? ""} / ${output.scheduled ?? ""}`.trim();
    f.sources.scheduledPrice = src;
    return;
  }
  // Image models price output per image in the same cell; never a token rate.
  if (/images?\)/i.test(cellText(outRaw)) || /per (1K )?image/i.test(cellText(outRaw))) return;
  if (input.price == null || output.price == null) return;
  f.rates = { input: input.price, output: output.price };
  if (cache) {
    const c = priceCell(cache);
    if (c.price != null && !c.scheduled) f.rates.cacheRead = c.price;
  }
  f.sources.rates = src;
  if (input.band && output.band && input.band.threshold === output.band.threshold) {
    f.longContext = {
      threshold: input.band.threshold,
      inclusive: false, // "<= 200k" is the low band
      inputMultiplier: round(input.band.high / input.band.low),
      outputMultiplier: round(output.band.high / output.band.low),
    };
  } else {
    f.longContext = null;
  }
  f.sources.longContext = src;
}

function parseDeprecations(md: string, src: Source, facts: Map<string, ModelFact>) {
  for (const t of parseMarkdownTables(md)) {
    const m = col(t, /^Model$/i);
    const shut = col(t, /^Shutdown date$/i);
    const rep = col(t, /Recommended replacement/i);
    const rel = col(t, /^Release date$/i);
    if (m < 0 || shut < 0) continue;
    for (const row of t.rows) {
      const id = cellText(row[m]);
      if (!/^[a-z][a-z0-9.-]+$/.test(id)) continue; // "Preview models" divider rows
      const f = fact(facts, id);
      f.sources.listed = src;
      const released = rel >= 0 ? isoDate(row[rel]) : null;
      if (released) {
        f.released = released;
        f.sources.released = src;
      }
      const day = isoDate(row[shut]);
      if (day) {
        f.retiresOn = day;
        f.lifecycle = "deprecated";
        f.sources.retiresOn = src;
        f.sources.lifecycle = src;
      }
      const repCell = rep >= 0 ? row[rep] : "";
      const replacement = repCell.match(/^\s*([a-z][a-z0-9.-]+)/)?.[1];
      if (replacement) {
        f.replacement = replacement;
        f.sources.replacement = src;
      }
      if (/automatically routed/i.test(repCell) && replacement) {
        // No date is given for the routing itself: it is already in effect.
        f.autoRouted = true;
        f.sources.autoRoutedFrom = src;
      }
    }
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function fact(facts: Map<string, ModelFact>, id: string): ModelFact {
  let f = facts.get(id);
  if (!f) {
    f = { provider: "google", id, sources: {} };
    facts.set(id, f);
  }
  return f;
}

export const google: LabParser = {
  provider: "google",
  pages: Object.entries(GOOGLE_PAGES).map(([key, url]) => ({ key, url })),
  parse(pages, fetched) {
    const facts = new Map<string, ModelFact>();
    parsePricing(pages.pricing, { url: GOOGLE_PAGES.pricing.replace(/\.md\.txt$/, ""), fetched }, facts);
    parseDeprecations(pages.deprecations, { url: GOOGLE_PAGES.deprecations.replace(/\.md\.txt$/, ""), fetched }, facts);
    return [...facts.values()];
  },
};
