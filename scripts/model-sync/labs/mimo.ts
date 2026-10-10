import { addDays, cellText, col, isoDate, parseHtmlTables, usd } from "../tables";
import type { LabParser, ModelFact, Source } from "../types";

/**
 * Xiaomi MiMo, from mimo.mi.com's static Markdown docs.
 *
 *  - pay-as-you-go pricing: the "Overseas Pricing" section's Real-time API
 *    table (USD), cache-hit / cache-miss / output per model, rowspans and all.
 *  - model deprecation: one table per wave with the "Deprecated Time" (the
 *    name stops answering), the "System replacement time" (from which requests
 *    are silently served by the replacement, at its price) and the model.
 *
 * Both times are printed in UTC+8. Converted to UTC, a 10:00 cutoff is 02:00
 * UTC the same day, so the last whole day a model answers as itself is the
 * day before — that is what `retiresOn` holds.
 */
export const MIMO_PAGES = {
  pricing: "https://mimo.mi.com/static/docs/price/pay-as-you-go.md",
  deprecations: "https://mimo.mi.com/static/docs/updates/deprecate.md",
};

/** "10:00, October 14,2026 (UTC+8)" -> the last UTC day fully served before it. */
export function lastFullDayBefore(raw: string): string | null {
  const day = isoDate(raw);
  if (!day) return null;
  const time = raw.match(/(\d{1,2}):(\d{2})/);
  const offset = raw.match(/UTC\s*([+-])\s*(\d{1,2})/i);
  if (!time) return addDays(day, -1);
  const hours = Number(time[1]) - (offset ? (offset[1] === "+" ? 1 : -1) * Number(offset[2]) : 0);
  // The cutoff falls on `day` (UTC) when hours >= 0, on the day before otherwise.
  const cutoffDay = hours >= 0 ? (hours >= 24 ? addDays(day, 1) : day) : addDays(day, -1);
  return addDays(cutoffDay, -1);
}

function parsePricing(md: string, src: Source, facts: Map<string, ModelFact>) {
  const overseas = md.indexOf("Overseas Pricing");
  if (overseas < 0) throw new Error("mimo pricing: Overseas Pricing section not found");
  const t = parseHtmlTables(md.slice(overseas))[0];
  if (!t) throw new Error("mimo pricing: overseas table not found");
  const name = col(t, /Model Name/i);
  const hit = col(t, /Cache Hit/i);
  const miss = col(t, /Cache Miss/i);
  const out = col(t, /^Output/i);
  const kind = col(t, /Inference Type/i);
  for (const row of t.rows) {
    if (!/real-time/i.test(row[kind] ?? "")) continue; // Batch rows are a discount, not the rate
    const id = cellText(row[name]).replace(/\(.*\)$/, "").trim();
    const input = usd(row[miss]);
    const output = usd(row[out]);
    if (!/^mimo-/.test(id) || input == null || output == null) continue;
    const f = fact(facts, id);
    f.rates = { input, output, ...(usd(row[hit]) != null ? { cacheRead: usd(row[hit])! } : {}) };
    f.sources.rates = src;
    f.sources.listed = src;
    f.longContext = null;
    f.sources.longContext = src;
  }
}

function parseDeprecations(md: string, src: Source, facts: Map<string, ModelFact>) {
  for (const t of parseHtmlTables(md)) {
    const m = col(t, /^Deprecated Model$/i);
    const dep = col(t, /^Deprecated Time$/i);
    const swap = col(t, /System replacement time/i);
    const rep = col(t, /System Replacement Model/i);
    const impact = col(t, /Replacement Impact/i);
    if (m < 0 || dep < 0) continue;
    for (const row of t.rows) {
      const id = cellText(row[m]);
      if (!/^mimo-/.test(id)) continue;
      const f = fact(facts, id);
      f.lifecycle = "deprecated";
      f.sources.lifecycle = src;
      const replacement = rep >= 0 ? cellText(row[rep]) : "";
      if (/^mimo-/.test(replacement)) {
        f.replacement = replacement;
        f.sources.replacement = src;
      }
      // From the replacement time on, the old name is answered by the new
      // model: the model the reader picked is no longer the one replying. That
      // is the effective retirement, earlier than the name's own cutoff.
      const routed = swap >= 0 ? lastFullDayBefore(row[swap]) : null;
      const dead = lastFullDayBefore(row[dep]);
      if (routed) {
        f.autoRoutedFrom = addDays(routed, 1);
        f.sources.autoRoutedFrom = src;
      }
      const last = routed && dead ? (routed < dead ? routed : dead) : routed ?? dead;
      if (last) {
        f.retiresOn = last;
        f.sources.retiresOn = src;
      }
      if (impact >= 0 && /only supports text input/i.test(row[impact])) {
        f.vision = false;
        f.sources.vision = src;
      }
      f.notes = [`name stops answering ${cellText(row[dep])}; requests auto-route from ${swap >= 0 ? cellText(row[swap]) : "?"}`];
    }
  }
}

function fact(facts: Map<string, ModelFact>, id: string): ModelFact {
  let f = facts.get(id);
  if (!f) {
    f = { provider: "mimo", id, modality: "chat", sources: {} };
    facts.set(id, f);
  }
  return f;
}

export const mimo: LabParser = {
  provider: "mimo",
  pages: Object.entries(MIMO_PAGES).map(([key, url]) => ({ key, url })),
  parse(pages, fetched) {
    const facts = new Map<string, ModelFact>();
    parsePricing(pages.pricing, { url: "https://mimo.mi.com/docs/en-US/price/pay-as-you-go", fetched }, facts);
    parseDeprecations(pages.deprecations, { url: "https://mimo.mi.com/docs/en-US/updates/deprecate", fetched }, facts);
    return [...facts.values()];
  },
};
