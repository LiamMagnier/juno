import { col, parseMarkdownTables, tokenCount, usd } from "../tables";
import type { LabParser, ModelFact } from "../types";

/**
 * xAI, from docs.x.ai's Markdown models page: "Text API Pricing" lists every
 * chat model with its context and rates, two rows per model when a long-context
 * band applies ("(< 200k prompt tokens)" / "(≥ 200k prompt tokens)": a prompt
 * that REACHES the threshold bills every token at the higher rate).
 */
export const XAI_PAGES = { models: "https://docs.x.ai/developers/models.md" };

export const xai: LabParser = {
  provider: "xai",
  pages: [{ key: "models", url: XAI_PAGES.models }],
  parse(pages, fetched) {
    const src = { url: XAI_PAGES.models.replace(/\.md$/, ""), fetched };
    const t = parseMarkdownTables(pages.models).find((x) => /text api pricing/i.test(x.heading));
    if (!t) throw new Error("xai models: Text API Pricing table not found");
    const facts = new Map<string, ModelFact>();
    const bands = new Map<string, { low?: number[]; high?: number[]; threshold?: number }>();
    for (const row of t.rows) {
      const m = row[0].match(/^([a-z0-9.-]+)\s*(?:\((<|≥)\s*(\d+)k prompt tokens\))?$/i);
      if (!m) continue;
      const id = m[1];
      const input = usd(row[col(t, /^Input/i)]);
      const cached = usd(row[col(t, /^Cached input/i)]);
      const output = usd(row[col(t, /^Output/i)]);
      if (input == null || output == null) continue;
      let f = facts.get(id);
      if (!f) {
        f = { provider: "xai", id, modality: "chat", sources: { listed: src } };
        facts.set(id, f);
      }
      const ctx = tokenCount(row[col(t, /^Context/i)]);
      if (ctx) {
        f.contextWindow = ctx;
        f.sources.contextWindow = src;
      }
      if (!m[2] || m[2] === "<") {
        f.rates = { input, output, ...(cached != null ? { cacheRead: cached } : {}) };
        f.sources.rates = src;
        f.longContext = null;
        f.sources.longContext = src;
      }
      if (m[2]) {
        const b = bands.get(id) ?? {};
        if (m[2] === "<") b.low = [input, output];
        else b.high = [input, output];
        b.threshold = Number(m[3]) * 1000;
        bands.set(id, b);
      }
    }
    for (const [id, b] of bands) {
      if (!b.low || !b.high || !b.threshold) continue;
      const f = facts.get(id)!;
      f.longContext = {
        threshold: b.threshold,
        inclusive: true,
        inputMultiplier: Math.round((b.high[0] / b.low[0]) * 1000) / 1000,
        outputMultiplier: Math.round((b.high[1] / b.low[1]) * 1000) / 1000,
      };
    }
    return [...facts.values()];
  },
};
