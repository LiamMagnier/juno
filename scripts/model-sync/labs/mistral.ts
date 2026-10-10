import { cellText, tokenCount } from "../tables";
import type { LabParser, ModelFact, Source } from "../types";

/**
 * Mistral, from docs.mistral.ai's model pages.
 *
 * The pages are rendered by Next.js, but the server HTML carries the model
 * card's data as escaped JSON: the API names (`"names":["mistral-large-2512",
 * "mistral-large-latest"]`, the card's "Click to copy" badges), the pricing
 * (`"pricing":{..."input":[{"price":0.68,"originalPrice":1.36,...}]}`) and the
 * "Context 1M" figure. The names are what settle an alias: on 2026-10-10
 * `mistral-large-latest` was still listed on Mistral Large 3's card, not on
 * Large 4's (whose names are `mistral-large-4` and `mistral-large-4-0`).
 *
 * A sale price is reported, and the list price (`originalPrice`) is the rate
 * recorded: the page gives the sale no end date, and billing at a price that
 * can lapse unannounced would under-charge the day it does.
 */
const BASE = "https://docs.mistral.ai";
export const MISTRAL_PAGES = { models: `${BASE}/getting-started/models/` };

export function mistralModelPage(slug: string) {
  return { key: `model:${slug}`, url: `${BASE}/models/${slug}` };
}

/** Model-card slugs on the overview page that are worth reading (current generations). */
export function mistralSlugs(overview: string): string[] {
  const slugs = [...new Set([...overview.matchAll(/href="\/models\/([a-z0-9-]+)"/g)].map((m) => m[1]))];
  return slugs.filter((slug) => {
    if (/embed|moderation|ocr|voxtral|mamba|mathstral|nemo|leanstral|-7b-/.test(slug)) return false;
    const dated = slug.match(/-(\d{2})-(\d{2})$/);
    if (dated) return Number(dated[1]) * 100 + Number(dated[2]) >= 2508;
    return /-\d+-0$/.test(slug); // the newer undated cards: mistral-large-4-0
  });
}

const unescape = (s: string) => s.replace(/\\"/g, '"');

/** One model card's facts, keyed by every API name it lists. */
export function parseMistralModelPage(html: string, src: Source): ModelFact[] {
  const flat = unescape(html);
  const names = flat.match(/"names":\[([^\]]*)\]/)?.[1];
  if (!names) return [];
  const ids = [...names.matchAll(/"([a-z0-9.-]+)"/g)].map((m) => m[1]);
  const title = cellText(flat.match(/<title>([^|<]+)/)?.[1] ?? "").replace(/\s*-\s*Mistral AI\s*$/, "");
  const pricing = flat.match(/"pricing":\{"type":"[^"]*","free":(true|false),"input":\[(.*?)\],"output":\[(.*?)\]/);
  const entry = (block: string | undefined, label: RegExp) => {
    const all = [...(block ?? "").matchAll(/\{[^{}]*\}/g)].map((x) => x[0]);
    // Cards with one price per side carry no label; the first entry is the rate.
    const m = all.find((x) => label.test(x)) ?? (label.source.includes("Cached") ? undefined : all.find((x) => !/"label"/.test(x)));
    if (!m) return null;
    const price = Number(m.match(/"price":([\d.]+)/)?.[1]);
    const original = m.match(/"originalPrice":([\d.]+)/)?.[1];
    return { price, list: original ? Number(original) : price, sale: !!original };
  };
  const input = entry(pricing?.[2], /"label":"Input"/);
  const cached = entry(pricing?.[2], /"label":"Cached input"/);
  const output = entry(pricing?.[3], /"label":"Output"/);
  // Tags become spaces first: the card writes "<span>Context</span>...<div>256k</div>".
  const text = cellText(html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " "));
  const ctx = tokenCount(text.match(/Context\s+(?:i\s+)?(\d+(?:\.\d+)?\s*[kKM])\b/)?.[1]);
  const retired = /"isRetired":true/.test(flat);
  const preview = /Public Preview/.test(text);
  return ids.map((id) => {
    const f: ModelFact = { provider: "mistral", id, modality: "chat", name: title || undefined, sources: { listed: src, name: src } };
    if (pricing?.[1] === "true") {
      f.free = true;
      f.sources.free = src;
    } else if (input && output && Number.isFinite(input.list) && Number.isFinite(output.list)) {
      f.rates = { input: input.list, output: output.list, ...(cached ? { cacheRead: cached.list } : {}) };
      f.sources.rates = src;
      f.longContext = null;
      f.sources.longContext = src;
      if (input.sale || output.sale) {
        f.notes = [`on sale at $${input.price} / $${output.price} (list price recorded; the page gives no end date)`];
      }
    }
    if (ctx) {
      f.contextWindow = ctx;
      f.sources.contextWindow = src;
    }
    if (retired) {
      f.lifecycle = "retired";
      f.sources.lifecycle = src;
    }
    if (preview) f.notes = [...(f.notes ?? []), "public preview"];
    return f;
  });
}

export const mistral: LabParser = {
  provider: "mistral",
  pages: [{ key: "models", url: MISTRAL_PAGES.models }],
  parse(pages, fetched) {
    if (!/href="\/models\//.test(pages.models)) throw new Error("mistral models: no model cards on the overview page");
    const facts: ModelFact[] = [];
    for (const [key, html] of Object.entries(pages)) {
      const slug = key.match(/^model:(.+)$/)?.[1];
      if (!slug) continue;
      facts.push(...parseMistralModelPage(html, { url: mistralModelPage(slug).url, fetched }));
    }
    return facts;
  },
};
