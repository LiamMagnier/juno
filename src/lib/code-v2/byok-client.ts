/**
 * Typed client for the user's own API keys (SPEC §2 BYOK, DESIGN §5.13).
 * The models lane owns storage (`src/lib/crypto.ts`, AES keyring) and the
 * routes; this client is what the Connections screen calls. Route shape:
 *
 *   GET    /api/code/v2/byok             → { keys: ByokKeyRecord[] }
 *   POST   /api/code/v2/byok             { provider, apiKey } → { key: ByokKeyRecord }   (validated with a 1-token call)
 *   DELETE /api/code/v2/byok/:provider   → { ok: true }
 *
 * The secret is sent once and never comes back: records carry only a hint.
 */
import { BYOK_PROVIDER_VALUES, isByokProvider, type ByokProvider } from "@/lib/code-v2/contracts";

export interface ByokKeyRecord {
  provider: ByokProvider;
  /** "sk-ant-…4f2a" */
  hint: string;
  /** ISO-8601 */
  addedAt: string;
  lastUsedAt?: string | null;
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

const BASE = "/api/code/v2/byok";

function record(v: unknown): ByokKeyRecord | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isByokProvider(o.provider) || typeof o.hint !== "string" || typeof o.addedAt !== "string") return null;
  return { provider: o.provider, hint: o.hint, addedAt: o.addedAt, lastUsedAt: typeof o.lastUsedAt === "string" ? o.lastUsedAt : null };
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
      const res = await fetcher(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, apiKey: key }) });
      if (!res.ok) throw await errorOf(res, "That key did not work.");
      const body = (await res.json()) as { key?: unknown };
      const r = record(body.key);
      if (!r) throw new ByokError("The server answered with something unexpected.", 500);
      return r;
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
};

export { BYOK_PROVIDER_VALUES };
