import { PROVIDERS, type Provider } from "../../src/lib/providers";
import { getJson } from "./fetch";

/**
 * Each lab's own model-list API — the most trusted answer to "is this id
 * served?" — read with the lab key from the environment when there is one.
 * No key, no call: the run reports the lab as "not checked" and moves on.
 *
 * The key is only ever placed in a request header; nothing here logs, prints,
 * or writes it, and errors are reduced to an HTTP status.
 *
 * What a listing can and cannot prove is narrower than it looks, which is why
 * the report treats it as evidence rather than as an instruction:
 *  - Listed is not callable. Google lists gemini-2.5-flash to keys that get a
 *    404 on every call; Qwen lists Beijing-only ids to international keys.
 *  - Absent is not retired. A key's tier or region hides ids that exist.
 * So an id missing from a listing is flagged for a person to confirm, and the
 * retirement itself comes from the lab's deprecation page.
 */
export interface Listing {
  provider: Provider;
  ids: Set<string>;
  /** Anthropic's Models API reports token limits per model. */
  limits: Map<string, { maxInput?: number; maxOutput?: number }>;
}

export interface ListingResult {
  listings: Listing[];
  skipped: { provider: Provider; reason: string }[];
}

function keyFor(provider: Provider): string | undefined {
  const cfg = PROVIDERS[provider];
  for (const name of [cfg.apiKeyEnv, ...(cfg.apiKeyEnvAliases ?? [])]) {
    const v = process.env[name];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

function baseFor(provider: Provider): string | undefined {
  const cfg = PROVIDERS[provider];
  return (cfg.baseUrlEnv && process.env[cfg.baseUrlEnv]) || cfg.defaultBaseUrl;
}

type Lister = (key: string) => Promise<Omit<Listing, "provider">>;

const openAiShape = (url: string, header: (k: string) => Record<string, string>): Lister => async (key) => {
  const body = (await getJson(url, header(key))) as { data?: { id?: string }[] };
  return { ids: new Set((body.data ?? []).map((m) => m.id).filter((x): x is string => !!x)), limits: new Map() };
};

const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

function listerFor(provider: Provider): Lister | null {
  switch (provider) {
    case "anthropic":
      return async (key) => {
        const ids = new Set<string>();
        const limits = new Map<string, { maxInput?: number; maxOutput?: number }>();
        let after: string | undefined;
        for (let page = 0; page < 10; page++) {
          const url = `https://api.anthropic.com/v1/models?limit=100${after ? `&after_id=${after}` : ""}`;
          const body = (await getJson(url, { "x-api-key": key, "anthropic-version": "2023-06-01" })) as {
            data?: { id: string; max_input_tokens?: number; max_tokens?: number }[];
            has_more?: boolean;
            last_id?: string;
          };
          for (const m of body.data ?? []) {
            const id = m.id.replace(/-\d{8}$/, "");
            ids.add(id);
            limits.set(id, { maxInput: m.max_input_tokens, maxOutput: m.max_tokens });
          }
          if (!body.has_more || !body.last_id) break;
          after = body.last_id;
        }
        return { ids, limits };
      };
    case "google":
      return async (key) => {
        const ids = new Set<string>();
        let token: string | undefined;
        for (let page = 0; page < 10; page++) {
          const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${token ? `&pageToken=${token}` : ""}`;
          const body = (await getJson(url, { "x-goog-api-key": key })) as { models?: { name: string }[]; nextPageToken?: string };
          for (const m of body.models ?? []) ids.add(m.name.replace(/^models\//, ""));
          if (!body.nextPageToken) break;
          token = body.nextPageToken;
        }
        return { ids, limits: new Map() };
      };
    case "seedance":
    case "meta":
    case "longcat":
      return null; // no documented list endpoint Juno relies on
    default: {
      const base = baseFor(provider);
      if (!base) return null;
      return openAiShape(`${base.replace(/\/$/, "")}/models`, bearer);
    }
  }
}

export async function readLabListings(providers: readonly Provider[]): Promise<ListingResult> {
  const listings: Listing[] = [];
  const skipped: ListingResult["skipped"] = [];
  await Promise.all(
    providers.map(async (provider) => {
      const lister = listerFor(provider);
      if (!lister) return skipped.push({ provider, reason: "no model-list API used" });
      const key = keyFor(provider);
      if (!key) return skipped.push({ provider, reason: `no ${PROVIDERS[provider].apiKeyEnv} in the environment` });
      try {
        listings.push({ provider, ...(await lister(key)) });
      } catch (err) {
        // Only the status survives: a provider error body can echo request details.
        skipped.push({ provider, reason: `list call failed (${err instanceof Error ? err.message.replace(/[^\w\s()-]/g, "").slice(0, 60) : "error"})` });
      }
    })
  );
  return { listings, skipped };
}
