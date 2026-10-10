import { cellText, parseHtmlTables, tokenCount } from "../tables";
import type { LabParser, ModelFact } from "../types";

/**
 * DeepSeek, from api-docs.deepseek.com's "Models & Pricing" page (HTML).
 *
 * The table is transposed — one COLUMN per model — and every price has an
 * off-peak and a peak figure. Juno bills off-peak (pricing.ts), so off-peak is
 * the rate recorded; the peak multiple goes into the notes for the report.
 * The page's footnote also names the legacy ids it still accepts but no longer
 * serves as themselves ("requests are served by the DeepSeek-V4.1-Flash model").
 */
export const DEEPSEEK_PAGES = { pricing: "https://api-docs.deepseek.com/quick_start/pricing" };

export const deepseek: LabParser = {
  provider: "deepseek",
  pages: [{ key: "pricing", url: DEEPSEEK_PAGES.pricing }],
  parse(pages, fetched) {
    const src = { url: DEEPSEEK_PAGES.pricing, fetched };
    const html = pages.pricing;
    const t = parseHtmlTables(html).find((x) => x.rows.some((r) => r[0] === "MODEL"));
    if (!t) throw new Error("deepseek pricing: model table not found");
    // Transposed, colspans expanded: the label cells repeat and the model
    // values sit in the columns whose MODEL cell is a deepseek id.
    const header = t.rows.find((r) => r[0] === "MODEL")!;
    const cols = header.map((c, i) => [c, i] as const).filter(([c]) => /^deepseek-/.test(c));
    if (!cols.length) throw new Error("deepseek pricing: no model columns");
    const find = (...labels: RegExp[]) => t.rows.find((r) => labels.every((re) => r.some((c) => re.test(c))));
    const money = (r: string[] | undefined, i: number) => {
      const m = r?.[i]?.match(/^\$(\d+(?:\.\d+)?)$/);
      return m ? Number(m[1]) : null;
    };
    const facts: ModelFact[] = [];
    for (const [rawId, i] of cols) {
      const id = rawId.replace(/\(\d+\)$/, "");
      const f: ModelFact = { provider: "deepseek", id, modality: "chat", sources: { listed: src } };
      const input = money(find(/CACHE MISS/i, /^OFF-PEAK$/i), i);
      const output = money(find(/1M OUTPUT TOKENS/i, /^OFF-PEAK$/i), i);
      const hit = money(find(/CACHE HIT/i, /^OFF-PEAK$/i), i);
      const peakIn = money(find(/CACHE MISS/i, /^PEAK$/i), i);
      if (input != null && output != null) {
        f.rates = { input, output, ...(hit != null ? { cacheRead: hit } : {}) };
        f.sources.rates = src;
        f.longContext = null;
        f.sources.longContext = src;
        if (peakIn) f.notes = [`peak hours bill ${Math.round((peakIn / input) * 100) / 100}x the off-peak rate recorded here`];
      }
      const ctx = tokenCount(find(/^CONTEXT LENGTH$/i)?.[i]);
      if (ctx) {
        f.contextWindow = ctx;
        f.sources.contextWindow = src;
      }
      const vision = find(/^Vision$/i)?.[i];
      if (vision) {
        f.vision = vision === "✓";
        f.sources.vision = src;
      }
      facts.push(f);
    }
    const legacy = cellText(html).match(/legacy names ([^.]*?) are still accepted, but the corresponding models have been retired/i);
    if (legacy) {
      const servedBy = facts.map((f) => f.id).find((id) => /flash/.test(id));
      for (const id of [...legacy[1].matchAll(/([a-z0-9][a-z0-9.-]+)/g)].map((m) => m[1]).filter((x) => x.startsWith("deepseek-"))) {
        facts.push({
          provider: "deepseek",
          id,
          lifecycle: "retired",
          replacement: servedBy,
          autoRouted: true,
          sources: { lifecycle: src, replacement: src, autoRoutedFrom: src },
        });
      }
    }
    return facts;
  },
};
