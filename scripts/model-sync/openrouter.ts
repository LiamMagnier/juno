import type { Provider } from "../../src/lib/providers";

/**
 * OpenRouter's keyless catalogue, as a DISCOVERY signal only.
 *
 * It is the one place every lab's new ids show up within a day, including
 * labs whose own pages this run cannot parse. It is never a source of truth:
 * its prices are resale rates (discounted hosts, promos) and its slugs are its
 * own spelling, so nothing read here is written into the catalogue. A listing
 * becomes a "check the lab's page" line in the report and nothing more.
 */
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

export interface OrModel {
  id?: string;
  name?: string;
  created?: number;
  context_length?: number;
}

/** OpenRouter's vendor prefix -> Juno provider. */
const VENDOR: Record<string, Provider> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  "x-ai": "xai",
  mistralai: "mistral",
  deepseek: "deepseek",
  qwen: "qwen",
  xiaomi: "mimo",
  "z-ai": "zhipu",
  moonshotai: "moonshot",
  minimax: "minimax",
  meta: "meta",
  "meta-llama": "meta",
  meituan: "longcat",
};

/** Same comparison key the old radar used: lowercase alphanumerics only. */
export const skeleton = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface Discovery {
  provider: Provider;
  slug: string;
  name: string;
  released: string | null;
}

/**
 * OpenRouter models from Juno's labs, released within `days` of `today`, whose
 * slug matches nothing the catalogue (or the official pages) already know.
 */
export function discover(models: OrModel[], known: Set<string>, today: string, days = 45): Discovery[] {
  const cutoff = Date.parse(`${today}T00:00:00Z`) / 1000 - days * 86_400;
  const out: Discovery[] = [];
  for (const m of models) {
    if (!m.id || /:(free|batch|extended|nitro|beta)$/.test(m.id)) continue;
    const [vendor, slug] = m.id.split("/");
    const provider = VENDOR[vendor];
    if (!provider || !slug) continue;
    if ((m.created ?? 0) < cutoff) continue;
    if (known.has(`${provider}:${skeleton(slug)}`)) continue;
    out.push({
      provider,
      slug: m.id,
      name: m.name ?? m.id,
      released: m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : null,
    });
  }
  return out.sort((a, b) => (b.released ?? "").localeCompare(a.released ?? ""));
}
