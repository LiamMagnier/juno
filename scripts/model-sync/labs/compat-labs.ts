import { cellText, col, isFree, parseHtmlTables, parseJsxDocTables, parseMarkdownTables, tokenCount, usd } from "../tables";
import type { LabParser, ModelFact, Source } from "../types";

/**
 * The labs whose price list is one table: Z.ai (GLM), Moonshot (Kimi),
 * MiniMax and Alibaba Model Studio (Qwen, Singapore / international).
 */

function fact(facts: Map<string, ModelFact>, provider: ModelFact["provider"], id: string): ModelFact {
  let f = facts.get(id);
  if (!f) {
    f = { provider, id, modality: "chat", sources: {} };
    facts.set(id, f);
  }
  return f;
}

// —— Z.ai ——
export const ZHIPU_PAGES = { pricing: "https://docs.z.ai/guides/overview/pricing.md" };

export const zhipu: LabParser = {
  provider: "zhipu",
  pages: [{ key: "pricing", url: ZHIPU_PAGES.pricing }],
  parse(pages, fetched) {
    const src: Source = { url: ZHIPU_PAGES.pricing.replace(/\.md$/, ""), fetched };
    const facts = new Map<string, ModelFact>();
    const tables = parseMarkdownTables(pages.pricing).filter((t) => col(t, /^Model$/i) === 0 && col(t, /^Input$/i) > 0 && col(t, /^Output$/i) > 0);
    if (!tables.length) throw new Error("zhipu pricing: no model tables");
    for (const t of tables) {
      for (const row of t.rows) {
        // Z.ai prints display names ("GLM-5.3-Flash"); its API ids are the same
        // string lowercased (docs.z.ai chat-completion model enum).
        const id = cellText(row[0]).toLowerCase();
        if (!/^glm-/.test(id) || /ocr|image|slide|agent/.test(id)) continue;
        const f = fact(facts, "zhipu", id);
        f.sources.listed = src;
        const inRaw = row[col(t, /^Input$/i)];
        const outRaw = row[col(t, /^Output$/i)];
        if (isFree(inRaw) && isFree(outRaw)) {
          f.free = true;
          f.sources.free = src;
          continue;
        }
        const input = usd(inRaw);
        const output = usd(outRaw);
        if (input == null || output == null) continue;
        const cached = usd(row[col(t, /^Cached Input$/i)]);
        f.rates = { input, output, ...(cached != null ? { cacheRead: cached } : {}) };
        f.sources.rates = src;
        f.longContext = null;
        f.sources.longContext = src;
      }
    }
    return [...facts.values()];
  },
};

// —— Moonshot ——
export const MOONSHOT_PAGES = { pricing: "https://platform.kimi.ai/docs/pricing/chat.md" };

export const moonshot: LabParser = {
  provider: "moonshot",
  pages: [{ key: "pricing", url: MOONSHOT_PAGES.pricing }],
  parse(pages, fetched) {
    const src: Source = { url: MOONSHOT_PAGES.pricing.replace(/\.md$/, ""), fetched };
    const facts = new Map<string, ModelFact>();
    const tables = parseJsxDocTables(pages.pricing);
    if (!tables.length) throw new Error("moonshot pricing: no DocTable");
    for (const t of tables) {
      const m = col(t, /^Model$/i);
      const input = col(t, /^Input Price( \(Cache Miss\))?$/i);
      const output = col(t, /^Output Price$/i);
      const cached = col(t, /^(Cached Input Price|Input Price \(Cache Hit\))$/i);
      const ctx = col(t, /Context Window/i);
      if (m < 0 || input < 0 || output < 0) continue;
      for (const row of t.rows) {
        const id = row[m];
        const i = usd(row[input]);
        const o = usd(row[output]);
        if (!/^kimi-/.test(id) || i == null || o == null) continue;
        const f = fact(facts, "moonshot", id);
        f.rates = { input: i, output: o, ...(cached >= 0 && usd(row[cached]) != null ? { cacheRead: usd(row[cached])! } : {}) };
        f.sources.rates = src;
        f.sources.listed = src;
        f.longContext = null;
        f.sources.longContext = src;
        const tokens = tokenCount(row[ctx]);
        if (tokens) {
          f.contextWindow = tokens;
          f.sources.contextWindow = src;
        }
      }
    }
    return [...facts.values()];
  },
};

// —— MiniMax ——
export const MINIMAX_PAGES = { pricing: "https://platform.minimax.io/docs/guides/pricing-paygo.md" };

export const minimax: LabParser = {
  provider: "minimax",
  pages: [{ key: "pricing", url: MINIMAX_PAGES.pricing }],
  parse(pages, fetched) {
    const src: Source = { url: MINIMAX_PAGES.pricing.replace(/\.md$/, ""), fetched };
    const facts = new Map<string, ModelFact>();
    // The first table naming MiniMax-M3 is the pay-as-you-go text table; the
    // second (higher) one on the page is a different plan, so only the first
    // row set per id is read.
    const bands = new Map<string, { low?: [number, number]; high?: [number, number]; threshold?: number }>();
    for (const t of parseMarkdownTables(pages.pricing)) {
      const m = col(t, /^Model$/i);
      const input = col(t, /^Input$/i);
      const output = col(t, /^Output$/i);
      const read = col(t, /Prompt caching Read/i);
      if (m !== 0 || input < 0 || output < 0) continue;
      for (const row of t.rows) {
        const label = cellText(row[m]);
        const id = label.match(/^(MiniMax-[A-Za-z0-9.-]+)/)?.[1];
        if (!id) continue;
        const i = usd(row[input].replace(/\s*\/\s*M tokens/i, ""));
        const o = usd(row[output].replace(/\s*\/\s*M tokens/i, ""));
        if (i == null || o == null) continue;
        const band = label.match(/(≤|>)\s*(\d+)k input tokens/i);
        if (band) {
          const b = bands.get(id) ?? {};
          if (band[1] === "≤" && !b.low) b.low = [i, o];
          if (band[1] === ">" && !b.high) b.high = [i, o];
          b.threshold ??= Number(band[2]) * 1000;
          bands.set(id, b);
          if (band[1] !== "≤") continue;
        }
        if (facts.get(id)?.rates) continue;
        const f = fact(facts, "minimax", id);
        const r = read >= 0 ? usd(row[read].replace(/\s*\/\s*M tokens/i, "")) : null;
        f.rates = { input: i, output: o, ...(r != null ? { cacheRead: r } : {}) };
        f.sources.rates = src;
        f.sources.listed = src;
        f.longContext = null;
        f.sources.longContext = src;
      }
    }
    for (const [id, b] of bands) {
      const f = facts.get(id);
      if (!f || !b.low || !b.high || !b.threshold) continue;
      f.longContext = {
        threshold: b.threshold,
        inclusive: false, // "≤ 512k" is the low band
        inputMultiplier: Math.round((b.high[0] / b.low[0]) * 1000) / 1000,
        outputMultiplier: Math.round((b.high[1] / b.low[1]) * 1000) / 1000,
      };
    }
    if (!facts.size) throw new Error("minimax pricing: no text model rows");
    return [...facts.values()];
  },
};

// —— Qwen (Alibaba Model Studio) ——
export const QWEN_PAGES = { pricing: "https://www.alibabacloud.com/help/en/model-studio/model-pricing.md" };

export const qwen: LabParser = {
  provider: "qwen",
  pages: [{ key: "pricing", url: QWEN_PAGES.pricing }],
  parse(pages, fetched) {
    const src: Source = { url: QWEN_PAGES.pricing.replace(/\.md$/, ""), fetched };
    const facts = new Map<string, ModelFact>();
    // Only the Singapore tabs: Juno calls the international endpoint, and the
    // same id costs differently in Beijing or Virginia.
    const tabs = [...pages.pricing.matchAll(/<Tab title="Singapore">([\s\S]*?)<\/Tab>/g)].map((m) => m[1]);
    if (!tabs.length) throw new Error("qwen pricing: no Singapore tabs");
    for (const tab of tabs) {
      // A few sections (Qwen-Omni) write the Singapore price as a Markdown
      // table with "USD 0.15" cells rather than an HTML one.
      for (const t of parseMarkdownTables(tab)) {
        const m = col(t, /^Model ID$/i);
        const scope = col(t, /Deployment scope/i);
        const input = col(t, /^Input price/i);
        const hit = col(t, /^Cache-hit input price/i);
        const output = col(t, /^Output price/i);
        if (m < 0 || input < 0 || output < 0) continue;
        const usdCell = (cell: string | undefined) => usd(cellText(cell ?? "").replace(/^USD\s*/i, "$"));
        for (const row of t.rows) {
          const id = cellText(row[m]).split(" ")[0];
          if (!/^(qwen|qwq)/.test(id) || facts.get(id)?.rates) continue;
          if (scope >= 0 && !/international/i.test(row[scope])) continue;
          const i = usdCell(row[input]);
          const o = usdCell(row[output]);
          if (i == null || o == null) continue;
          const f = fact(facts, "qwen", id);
          const c = hit >= 0 ? usdCell(row[hit]) : null;
          f.rates = { input: i, output: o, ...(c != null ? { cacheRead: c } : {}) };
          f.sources.rates = src;
          f.sources.listed = src;
          f.longContext = null;
          f.sources.longContext = src;
        }
      }
      for (const t of parseHtmlTables(tab)) {
        const m = col(t, /^Model ID$/i);
        const scope = col(t, /Deployment scope/i);
        const tier = col(t, /Input tokens per request/i);
        const input = col(t, /^Input price/i);
        const output = col(t, /^Output price/i);
        if (m < 0 || input < 0 || output < 0) continue;
        for (const row of t.rows) {
          const id = cellText(row[m]).split(" ")[0];
          if (!/^(qwen|qwq)/.test(id)) continue;
          if (scope >= 0 && !/international/i.test(row[scope])) continue;
          if (facts.get(id)?.rates) continue; // first (lowest) tier only
          // "List price $0.4 (Limited-time 20% off)": the list price is the
          // rate; the temporary discount is reported, never billed as truth.
          const promo = /Limited-time\s+(\d+)% off/i.exec(cellText(row[input]))?.[1];
          const list = (cell: string) => usd(cellText(cell).replace(/^List price\s*/i, "").replace(/\s*\(Limited-time[^)]*\)\s*$/i, ""));
          const i = list(row[input]);
          const o = list(row[output]);
          if (i == null || o == null) continue;
          const f = fact(facts, "qwen", id);
          if (promo) f.notes = [...(f.notes ?? []), `limited-time ${promo}% off the list price recorded here`];
          f.rates = { input: i, output: o };
          f.sources.rates = src;
          f.sources.listed = src;
          const tierText = tier >= 0 ? row[tier] : "";
          // A tiered model quotes several rows; anything but a single
          // "0<Token≤<window>" tier is a band Juno does not bill, so the
          // report shows it rather than the code guessing a multiplier.
          if (tierText && !/no tiered/i.test(tierText) && !/^0\s*<\s*Token\s*≤\s*1M$/i.test(tierText.replace(/\s+/g, ""))) {
            f.notes = [...(f.notes ?? []), `tiered pricing: lowest tier ${tierText}`];
          }
        }
      }
    }
    return [...facts.values()];
  },
};
