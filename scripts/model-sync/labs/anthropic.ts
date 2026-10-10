import { cellText, col, isoDate, parseMarkdownTables, tokenCount, usd, type Table } from "../tables";
import type { LabParser, ModelFact, Rates, Source } from "../types";

/**
 * Anthropic, from platform.claude.com's Markdown pages (append `.md`).
 *
 *  - models overview: the current lineup's ids, context, output cap, thinking.
 *  - pricing: every model's base / cache / output rate, long-context bands,
 *    and the fast-mode table.
 *  - model deprecations: the status table (Active / Deprecated / Retired) with
 *    retirement dates, and each notice's recommended replacement.
 *  - each new model's own overview page, for its release date and modalities.
 */
const BASE = "https://platform.claude.com/docs/en";
export const ANTHROPIC_PAGES = {
  overview: `${BASE}/models/overview.md`,
  pricing: `${BASE}/about-claude/pricing.md`,
  deprecations: `${BASE}/about-claude/model-deprecations.md`,
};

/** "Claude Opus 4.8" -> "claude-opus-4-8"; the convention every Claude id since 4.6 follows. */
export function claudeIdFromName(name: string): string | null {
  const m = cellText(name).match(/^Claude\s+([A-Za-z]+)\s+(\d+(?:\.\d+)?)\b/);
  if (!m) return null;
  return `claude-${m[1].toLowerCase()}-${m[2].replace(".", "-")}`;
}

/** `claude-sonnet-4-5-20250929` -> `claude-sonnet-4-5` (the alias the catalog uses). */
export function claudeAlias(id: string): string {
  return id.replace(/-\d{8}$/, "");
}

function rateRow(t: Table, row: string[]): Rates | null {
  const input = usd(row[col(t, /base input/i)]);
  const output = usd(row[col(t, /^output/i)]);
  if (input == null || output == null) return null;
  const r: Rates = { input, output };
  const w5 = usd(row[col(t, /5m cache/i)]);
  const w1 = usd(row[col(t, /1h cache/i)]);
  const hit = usd(row[col(t, /cache hits/i)]);
  if (w5 != null) r.cacheWrite5m = w5;
  if (w1 != null) r.cacheWrite1h = w1;
  if (hit != null) r.cacheRead = hit;
  return r;
}

function parsePricing(md: string, src: Source, facts: Map<string, ModelFact>) {
  const tables = parseMarkdownTables(md);
  const main = tables.find((t) => col(t, /base input/i) >= 0 && col(t, /1h cache/i) >= 0);
  if (!main) throw new Error("anthropic pricing: model pricing table not found");
  const bands = new Map<string, { low?: Rates; high?: Rates; threshold?: number }>();
  for (const row of main.rows) {
    const label = row[0];
    if (/retired/i.test(label)) continue;
    const id = claudeIdFromName(label);
    const rates = rateRow(main, row);
    if (!id || !rates) continue;
    const band = label.match(/prompts (up to|over) ([\d,]+) tokens/i);
    if (band) {
      const b = bands.get(id) ?? {};
      if (/up to/i.test(band[1])) b.low = rates;
      else b.high = rates;
      b.threshold = Number(band[2].replace(/,/g, ""));
      bands.set(id, b);
      continue;
    }
    const f = fact(facts, id);
    f.name ??= label.replace(/\s*\(.*$/, "");
    if (/limited availability|limited access/i.test(label)) f.notes = [...(f.notes ?? []), "limited availability"];
    f.rates = rates;
    f.longContext = null;
    f.sources.rates = src;
  }
  for (const [id, b] of bands) {
    if (!b.low || !b.high || !b.threshold) continue;
    const f = fact(facts, id);
    f.rates = b.low;
    f.sources.rates = src;
    const im = b.high.input / b.low.input;
    const om = b.high.output / b.low.output;
    // Only a clean multiple of the whole low band is a surcharge Juno can bill;
    // anything else is left unwritten and reported by compare.
    if (Number.isFinite(im) && Number.isFinite(om)) {
      f.longContext = { threshold: b.threshold, inclusive: false, inputMultiplier: round(im), outputMultiplier: round(om) };
      f.sources.longContext = src;
    }
  }

  // Fast mode: "| Claude Opus 5 / Claude Opus 4.8 | $10 / MTok | $50 / MTok |".
  const fastHeading = md.indexOf("### Fast mode pricing");
  if (fastHeading >= 0) {
    const fastTables = parseMarkdownTables(md.slice(fastHeading)).filter((t) => /fast mode/i.test(t.heading));
    const ft = fastTables[0];
    if (ft) {
      const fastIds = new Set<string>();
      for (const row of ft.rows) {
        const input = usd(row[col(ft, /^input/i)]);
        const output = usd(row[col(ft, /^output/i)]);
        if (input == null || output == null) continue;
        for (const name of row[0].split("/")) {
          const id = claudeIdFromName(name.trim());
          if (!id) continue;
          fastIds.add(id);
          const f = fact(facts, id);
          f.fast = { input, output };
          f.sources.fast = src;
        }
      }
      // The table is the whole list: every other priced model has no fast mode.
      for (const f of facts.values()) {
        if (f.rates && !fastIds.has(f.id) && f.fast === undefined) {
          f.fast = null;
          f.sources.fast = src;
        }
      }
    }
  }
}

function parseOverview(md: string, src: Source, facts: Map<string, ModelFact>) {
  const t = parseMarkdownTables(md).find((x) => /^feature$/i.test(x.headers[0] ?? "") && x.rows.some((r) => /Claude API ID/i.test(r[0])));
  if (!t) throw new Error("anthropic overview: compare table not found");
  const row = (re: RegExp) => t.rows.find((r) => re.test(r[0]));
  const ids = row(/^Claude API ID/i);
  if (!ids) throw new Error("anthropic overview: no Claude API ID row");
  for (let c = 1; c < t.headers.length; c++) {
    const id = cellText(ids[c] ?? "");
    if (!/^claude-/.test(id)) continue;
    const f = fact(facts, id);
    f.name = t.headers[c];
    f.lifecycle = "active";
    f.sources.name = src;
    f.sources.lifecycle = src;
    const desc = row(/^Description/i)?.[c];
    if (desc) {
      f.description = desc;
      f.sources.description = src;
    }
    const ctx = tokenCount(row(/^Context window/i)?.[c]);
    if (ctx) {
      f.contextWindow = ctx;
      f.sources.contextWindow = src;
    }
    const out = tokenCount(row(/^Max output/i)?.[c]);
    if (out) {
      f.maxOutput = out;
      f.sources.maxOutput = src;
    }
    const thinking = row(/^Thinking/i)?.[c];
    if (thinking) {
      f.reasoning = /adaptive|extended/i.test(thinking);
      f.sources.reasoning = src;
    }
    // "All current models support text and image input" (the paragraph above the table).
    if (/All current models support text and image input/i.test(md)) {
      f.vision = true;
      f.sources.vision = src;
    }
    f.modality = "chat";
  }
  // "Legacy models (still available): [Claude Fable 5](...), ..."
  const legacy = md.match(/Legacy models \(still available\):([^\n]*)/i);
  if (legacy) {
    for (const name of [...legacy[1].matchAll(/\[([^\]]+)\]/g)].map((x) => x[1])) {
      const id = claudeIdFromName(name);
      if (!id) continue;
      const f = fact(facts, id);
      f.name ??= name;
      f.lifecycle = "legacy";
      f.sources.lifecycle = src;
    }
  }
}

function parseDeprecations(md: string, src: Source, facts: Map<string, ModelFact>) {
  const tables = parseMarkdownTables(md);
  const status = tables.find((t) => col(t, /API model name/i) === 0 && col(t, /Current state/i) > 0);
  if (!status) throw new Error("anthropic deprecations: model status table not found");
  const stateCol = col(status, /Current state/i);
  const retireCol = col(status, /retirement date/i);
  for (const row of status.rows) {
    const id = claudeAlias(row[0]);
    if (!/^claude-/.test(id)) continue;
    const f = fact(facts, id);
    const state = row[stateCol].toLowerCase();
    // "Active" here is a support status, not a place in the lineup — the
    // overview's legacy list is what says a model was superseded.
    if (state === "deprecated" || state === "retired") {
      f.lifecycle = state;
      f.sources.lifecycle = src;
    } else {
      f.sources.listed = src;
    }
    const when = row[retireCol];
    // "Not sooner than ..." is a promise, not a date: never a retiresOn. It
    // is kept as a note so the report can flag one that is close.
    const floor = when.match(/not sooner than (.+)$/i);
    if (floor && isoDate(floor[1])) f.notes = [...(f.notes ?? []), `earliest retirement ${isoDate(floor[1])}`];
    if (!/not sooner|to be announced|n\/a/i.test(when)) {
      const day = isoDate(when);
      if (day) {
        // "Requests to models past the retirement date will fail": the
        // printed day is still served, which is what `retiresOn` means.
        f.retiresOn = day;
        f.sources.retiresOn = src;
      }
    }
  }
  // Each notice: "| November 30, 2026 | `claude-sonnet-4-5-20250929` | `claude-sonnet-5-5` |".
  for (const t of tables) {
    const dep = col(t, /Deprecated model/i);
    const rep = col(t, /Recommended replacement/i);
    if (dep < 0 || rep < 0) continue;
    for (const row of t.rows) {
      const id = claudeAlias(row[dep]);
      const replacement = claudeAlias(row[rep]);
      if (!/^claude-/.test(id) || !/^claude-/.test(replacement)) continue;
      const f = fact(facts, id);
      f.replacement ??= replacement;
      f.sources.replacement ??= src;
    }
  }
}

/** Released date from a model's own overview page ("Released October 7, 2026."). */
export function parseModelPage(md: string, src: Source, f: ModelFact) {
  const rel = md.match(/Released\s+([A-Z][a-z]+ \d{1,2}, \d{4})/);
  if (rel) {
    const d = isoDate(rel[1]);
    if (d) {
      f.released = d;
      f.sources.released = src;
    }
  }
  const io = md.match(/\|\s*Input → output\s*\|\s*([^|]+)\|/);
  if (io) {
    f.vision = /image/i.test(io[1].split("→")[0]);
    f.sources.vision = src;
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function fact(facts: Map<string, ModelFact>, id: string): ModelFact {
  let f = facts.get(id);
  if (!f) {
    f = { provider: "anthropic", id, sources: {} };
    facts.set(id, f);
  }
  return f;
}

export const anthropic: LabParser = {
  provider: "anthropic",
  pages: Object.entries(ANTHROPIC_PAGES).map(([key, url]) => ({ key, url })),
  parse(pages, fetched) {
    const facts = new Map<string, ModelFact>();
    const at = (key: keyof typeof ANTHROPIC_PAGES): Source => ({ url: ANTHROPIC_PAGES[key].replace(/\.md$/, ""), fetched });
    parseOverview(pages.overview, at("overview"), facts);
    parsePricing(pages.pricing, at("pricing"), facts);
    parseDeprecations(pages.deprecations, at("deprecations"), facts);
    for (const [key, text] of Object.entries(pages)) {
      const m = key.match(/^model:(.+)$/);
      if (!m) continue;
      const f = facts.get(m[1]);
      if (f) parseModelPage(text, { url: `${BASE}/models/${m[1].replace(/^claude-/, "")}/overview`, fetched }, f);
    }
    return [...facts.values()];
  },
};

/** The per-model page key for a new Claude id (fetched only for ids the catalog lacks). */
export function anthropicModelPage(id: string) {
  return { key: `model:${id}`, url: `${BASE}/models/${id.replace(/^claude-/, "")}/overview.md` };
}
