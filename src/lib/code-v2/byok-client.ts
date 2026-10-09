/**
 * Typed client for the user's own API keys (SPEC §2 BYOK, DESIGN §5.13).
 * The models lane owns storage (`byok-store.ts`, sealed per user and lab) and
 * the routes; this client is what the Connections screen calls:
 *
 *   GET    /api/provider-keys                   → { keys: ProviderKeyView[] }
 *   POST   /api/provider-keys                   { provider, key } → { key }   (tested with the lab first)
 *   POST   /api/provider-keys/:provider/test    → { result, detail, key }
 *   DELETE /api/provider-keys/:provider         → { ok: true }
 *   GET    /api/provider-keys/openrouter/models → { models: ProviderModel[] }  (BYOK-only labs)
 *
 * The secret is sent once and never comes back: records carry only a hint.
 */
import { BYOK_PROVIDER_VALUES, isByokProvider, type ByokProvider, type ProviderModel } from "@/lib/code-v2/contracts";

export interface ByokKeyRecord {
  provider: ByokProvider;
  /** "…4f2a" (the server keeps only the last four characters). */
  hint: string;
  /** ISO-8601 */
  addedAt: string;
  lastUsedAt?: string | null;
  /** The lab refused it on the last test: runs stop routing to it. */
  invalid?: boolean;
  /** Why, in the lab's words. */
  detail?: string | null;
}

export type FetchJson = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class ByokError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ByokError";
  }
}

const BASE = "/api/provider-keys";

function record(v: unknown): ByokKeyRecord | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isByokProvider(o.provider)) return null;
  // ProviderKeyView (keyHint, createdAt, status) or the older {hint, addedAt} shape.
  const hint = typeof o.keyHint === "string" ? `…${o.keyHint}` : typeof o.hint === "string" ? o.hint : null;
  const addedAt = typeof o.createdAt === "string" ? o.createdAt : typeof o.addedAt === "string" ? o.addedAt : null;
  if (!hint || !addedAt) return null;
  return {
    provider: o.provider,
    hint,
    addedAt,
    lastUsedAt: typeof o.lastUsedAt === "string" ? o.lastUsedAt : null,
    invalid: o.status === "invalid" ? true : undefined,
    detail: typeof o.statusDetail === "string" ? o.statusDetail : null,
  };
}

async function errorOf(res: { status: number; json(): Promise<unknown> }, fallback: string): Promise<ByokError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  return new ByokError(body.message ?? body.error ?? fallback, res.status);
}

export function createByokClient(fetcher: FetchJson = (i, init) => fetch(i, init)) {
  return {
    async list(): Promise<ByokKeyRecord[]> {
      const res = await fetcher(BASE);
      if (res.status === 404) return []; // routes not deployed yet
      if (!res.ok) throw await errorOf(res, "Could not load your keys.");
      const body = (await res.json()) as { keys?: unknown[] };
      return (body.keys ?? []).map(record).filter((r): r is ByokKeyRecord => r !== null);
    },
    async add(provider: ByokProvider, apiKey: string): Promise<ByokKeyRecord> {
      const key = apiKey.trim();
      if (!key) throw new ByokError("Paste a key first.", 400);
      const res = await fetcher(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, key }) });
      if (!res.ok) throw await errorOf(res, "That key did not work.");
      const body = (await res.json()) as { key?: unknown };
      const r = record(body.key);
      if (!r) throw new ByokError("The server answered with something unexpected.", 500);
      return r;
    },
    /** Re-test a stored key with the lab; answers the updated record. */
    async test(provider: ByokProvider): Promise<{ valid: boolean; detail: string | null; key: ByokKeyRecord | null }> {
      const res = await fetcher(`${BASE}/${provider}/test`, { method: "POST" });
      if (!res.ok) throw await errorOf(res, "Could not test the key.");
      const body = (await res.json()) as { result?: string; detail?: string | null; key?: unknown };
      return { valid: body.result === "valid", detail: body.detail ?? null, key: record(body.key) };
    },
    /** Models a BYOK-only lab offers (OpenRouter's list, in the picker's shape). */
    async models(provider: ByokProvider): Promise<ProviderModel[]> {
      const res = await fetcher(`${BASE}/${provider}/models`);
      if (!res.ok) throw await errorOf(res, "Could not load the models.");
      const body = (await res.json()) as { models?: unknown };
      return Array.isArray(body.models) ? (body.models as ProviderModel[]).filter((m) => m && typeof m.id === "string" && typeof m.label === "string") : [];
    },
    async remove(provider: ByokProvider): Promise<void> {
      const res = await fetcher(`${BASE}/${provider}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw await errorOf(res, "Could not remove the key.");
    },
  };
}

export type ByokClient = ReturnType<typeof createByokClient>;

/** Mask a pasted key for display before it is saved ("sk-ant-…4f2a"). */
export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 10) return "…";
  const prefix = /^[a-z]+-[a-z]+-|^[a-z]+-/i.exec(k)?.[0] ?? k.slice(0, 3);
  return `${prefix}…${k.slice(-4)}`;
}

/** Cheap shape check before the server validates with a real call. */
export function looksLikeKey(provider: ByokProvider, key: string): boolean {
  const k = key.trim();
  if (k.length < 20 || /\s/.test(k)) return false;
  switch (provider) {
    case "anthropic":
      return k.startsWith("sk-ant-");
    case "openai":
      return k.startsWith("sk-");
    case "xai":
      return k.startsWith("xai-");
    case "openrouter":
      return k.startsWith("sk-or-");
    default:
      return true;
  }
}

export const BYOK_LABELS: Record<ByokProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
};

export { BYOK_PROVIDER_VALUES };
