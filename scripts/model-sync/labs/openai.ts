import { cellText, col, isoDate, parseMarkdownTables, tokenCount, usd, type Table } from "../tables";
import type { LabParser, ModelFact, Rates, Source } from "../types";

/**
 * OpenAI, from developers.openai.com's Markdown pages (append `.md`).
 *
 *  - pricing: the Standard, Fast and Ultrafast tables, short- and long-context
 *    columns (the long-context ratio becomes the surcharge Juno bills).
 *  - deprecations: every notice table ("Shutdown date | Model | Replacement").
 *  - models: the catalogue list (id + one-line description).
 *  - one page per model (`models/<id>.md`): context window, max output,
 *    modalities, the default snapshot, and the ultrafast service tier.
 */
const BASE = "https://developers.openai.com/api/docs";
export const OPENAI_PAGES = {
  pricing: `${BASE}/pricing.md`,
  deprecations: `${BASE}/deprecations.md`,
  models: `${BASE}/models.md`,
};

export function openaiModelPage(id: string) {
  return { key: `model:${id}`, url: `${BASE}/models/${id}.md` };
}

/** "gpt-5.5 (<272K context length)" -> "gpt-5.5". */
function rowId(label: string): string {
  return cellText(label).replace(/\s*\(.*\)\s*$/, "").trim();
}

function tierTable(md: string, title: string): Table | null {
  const at = md.indexOf(`### ${title} pricing data`);
  if (at < 0) return null;
  return parseMarkdownTables(md.slice(at))[0] ?? null;
}

function shortRates(t: Table, row: string[]): Rates | null {
  const input = usd(row[col(t, /^Short context input/i)]);
  const output = usd(row[col(t, /^Short context output/i)]);
  if (input == null || output == null) return null;
  const r: Rates = { input, output };
  const cached = usd(row[col(t, /^Short context cached input/i)]);
  const write = usd(row[col(t, /^Short context cache writes/i)]);
  if (cached != null) r.cacheRead = cached;
  if (write != null) r.cacheWrite = write;
  return r;
}

function parsePricing(md: string, src: Source, facts: Map<string, ModelFact>) {
  const standard = tierTable(md, "Standard");
  if (!standard) throw new Error("openai pricing: Standard table not found");
  const threshold = Number(md.match(/Short context:\s*≤\s*(\d+)K/i)?.[1] ?? NaN) * 1000;
  for (const row of standard.rows) {
    const id = rowId(row[0]);
    const rates = shortRates(standard, row);
    if (!rates) continue;
    const f = fact(facts, id);
    f.rates = rates;
    f.sources.rates = src;
    const longIn = usd(row[col(standard, /^Long context input/i)]);
    const longOut = usd(row[col(standard, /^Long context output/i)]);
    if (longIn != null && longOut != null && Number.isFinite(threshold)) {
      f.longContext = {
        threshold,
        inclusive: false, // "Short context: ≤272K", so 272K itself is short
        inputMultiplier: round(longIn / rates.input),
        outputMultiplier: round(longOut / rates.output),
      };
    } else {
      f.longContext = null;
    }
    f.sources.longContext = src;
  }
  for (const [title, key] of [["Fast", "fast"], ["Ultrafast", "ultrafast"]] as const) {
    const t = tierTable(md, title);
    if (!t) continue;
    const listed = new Set<string>();
    for (const row of t.rows) {
      const id = rowId(row[0]);
      const rates = shortRates(t, row);
      if (!rates) continue;
      listed.add(id);
      const f = fact(facts, id);
      f[key] = rates;
      f.sources[key] = src;
    }
    // The tier's table is the whole list of models it serves.
    for (const f of facts.values()) {
      if (f.rates && !listed.has(f.id) && f[key] === undefined) {
        f[key] = null;
        f.sources[key] = src;
      }
    }
  }
}

function parseDeprecations(md: string, src: Source, facts: Map<string, ModelFact>, snapshotOf: Map<string, string>) {
  for (const t of parseMarkdownTables(md)) {
    const when = col(t, /^Shutdown date$/i);
    const what = col(t, /^Model/i);
    const rep = col(t, /Recommended replacement|Substitute model/i);
    if (when < 0 || what < 0 || rep < 0) continue;
    for (const row of t.rows) {
      const day = isoDate(row[when]);
      // The raw cell keeps backticks: cellText would have stripped them.
      const ids = [...row[what].matchAll(/([a-z0-9][a-z0-9.:-]*[a-z0-9])/gi)]
        .map((m) => m[1])
        .filter((x) => /^(gpt|o\d|chatgpt|codex|computer|dall|tts|whisper|text-|omni|babbage|davinci|ft-)/i.test(x));
      const replacement = row[rep].match(/^\s*([a-z0-9][a-z0-9.:-]*[a-z0-9])/i)?.[1];
      for (const raw of ids) {
        // A dated snapshot speaks for its alias only when it IS the alias's
        // default snapshot (gpt-4o-2024-05-13 is on the list; the gpt-4o alias,
        // which points at 2024-08-06, is not).
        const id = snapshotOf.get(raw) ?? raw;
        const f = fact(facts, id);
        f.lifecycle = "deprecated";
        f.sources.lifecycle = src;
        if (day) {
          f.retiresOn = day;
          f.sources.retiresOn = src;
        }
        if (replacement && /^(gpt|o\d)/.test(replacement)) {
          f.replacement = replacement;
          f.sources.replacement = src;
        }
      }
    }
  }
}

function parseModelList(md: string, src: Source, facts: Map<string, ModelFact>) {
  for (const m of md.matchAll(/^- \[([^\]]+)\]\(\/api\/docs\/models\/([a-z0-9.-]+)\.md\):\s*(.+)$/gim)) {
    const id = m[2];
    const f = fact(facts, id);
    f.name ??= m[1];
    f.description ??= m[3].trim();
    f.sources.listed = src;
    f.sources.name ??= src;
    f.sources.description ??= src;
  }
}

/** One model page: context, output cap, modalities, default snapshot, ultrafast mention. */
export function parseModelPage(md: string, src: Source, f: ModelFact): string | null {
  const ctx = md.match(/^- ([\d,]+) context window/m);
  if (ctx) {
    f.contextWindow = tokenCount(ctx[1]) ?? undefined;
    f.sources.contextWindow = src;
  }
  const out = md.match(/^- ([\d,]+) max output tokens/m);
  if (out) {
    f.maxOutput = tokenCount(out[1]) ?? undefined;
    f.sources.maxOutput = src;
  }
  const input = md.match(/^- Input modalities:\s*(.+)$/m);
  const output = md.match(/^- Output modalities:\s*(.+)$/m);
  if (input) {
    f.vision = /\bimage\b/i.test(input[1]);
    f.sources.vision = src;
  }
  if (output) {
    const o = output[1].toLowerCase();
    f.modality = /\btext\b/.test(o) ? "chat" : /image/.test(o) ? "image" : /video/.test(o) ? "video" : /audio/.test(o) ? "audio" : undefined;
  }
  if (/Reasoning token support/i.test(md)) {
    f.reasoning = true;
    f.sources.reasoning = src;
  }
  const title = md.match(/^# (.+)$/m);
  if (title) {
    f.name = title[1].trim();
    f.sources.name = src;
  }
  const tagline = md.match(/^> (?!For the complete)(.+)$/m);
  if (tagline) {
    f.description = tagline[1].trim();
    f.sources.description = src;
  }
  return md.match(/Default snapshot:\s*`([^`]+)`/)?.[1] ?? null;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function fact(facts: Map<string, ModelFact>, id: string): ModelFact {
  let f = facts.get(id);
  if (!f) {
    f = { provider: "openai", id, sources: {} };
    facts.set(id, f);
  }
  return f;
}

export const openai: LabParser = {
  provider: "openai",
  pages: Object.entries(OPENAI_PAGES).map(([key, url]) => ({ key, url })),
  parse(pages, fetched) {
    const facts = new Map<string, ModelFact>();
    const at = (url: string): Source => ({ url: url.replace(/\.md$/, ""), fetched });
    parseModelList(pages.models, at(OPENAI_PAGES.models), facts);
    parsePricing(pages.pricing, at(OPENAI_PAGES.pricing), facts);
    const snapshotOf = new Map<string, string>();
    for (const [key, text] of Object.entries(pages)) {
      const m = key.match(/^model:(.+)$/);
      if (!m) continue;
      const f = fact(facts, m[1]);
      const snap = parseModelPage(text, at(openaiModelPage(m[1]).url), f);
      if (snap && snap !== m[1]) snapshotOf.set(snap, m[1]);
    }
    parseDeprecations(pages.deprecations, at(OPENAI_PAGES.deprecations), facts, snapshotOf);
    return [...facts.values()].filter((f) => !/^(ft-|text-|babbage|davinci)/.test(f.id));
  },
};
