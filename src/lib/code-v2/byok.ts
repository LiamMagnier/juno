/**
 * Bring your own key (Alevr Code v2 SPEC §2) — the pure half.
 *
 * Everything here is free of Prisma and Next so tests and the proxy can use it
 * directly: key shape checks, the hint a list may show, the sealing context,
 * the base URL a user's key is sent to, and the cheap validation request.
 *
 * Two rules the rest of BYOK leans on:
 *
 *  1. A user's key only ever goes to the lab's PUBLIC endpoint
 *     (`byokBaseUrl`), never to the deployment's `*_BASE_URL` override. That
 *     override may point at a proxy, a regional gateway or Azure, configured
 *     for the server's own key; sending a stranger's key there would hand it to
 *     infrastructure the user never agreed to.
 *  2. The plaintext leaves the store in exactly one place — the proxy's
 *     upstream request header — and is never logged, returned or echoed.
 */
import { BYOK_PROVIDER_VALUES, isByokProvider, type ByokProvider } from "@/lib/code-v2/contracts";
import { PROVIDERS } from "@/lib/providers";

export { BYOK_PROVIDER_VALUES, isByokProvider, type ByokProvider };

export const BYOK_KEY_MIN_LENGTH = 20;
export const BYOK_KEY_MAX_LENGTH = 512;

/** What the settings page names each lab, and where a user makes a key. */
export const BYOK_PROVIDER_INFO: Readonly<Record<ByokProvider, { label: string; docsUrl: string }>> = {
  anthropic: { label: "Anthropic", docsUrl: PROVIDERS.anthropic.docsUrl },
  openai: { label: "OpenAI", docsUrl: PROVIDERS.openai.docsUrl },
  google: { label: "Google Gemini", docsUrl: PROVIDERS.google.docsUrl },
  xai: { label: "xAI", docsUrl: PROVIDERS.xai.docsUrl },
  deepseek: { label: "DeepSeek", docsUrl: PROVIDERS.deepseek.docsUrl },
  openrouter: { label: "OpenRouter", docsUrl: "https://openrouter.ai/settings/keys" },
};

/**
 * Labs that exist in Alevr only as the user's own key: no Alevr key, no plan
 * billing, never an `alevr` route. OpenRouter fronts many labs' models behind
 * one OpenAI-compatible endpoint, billed to the user's OpenRouter account.
 */
export const BYOK_ONLY_PROVIDERS: ReadonlySet<ByokProvider> = new Set<ByokProvider>(["openrouter"]);

export function isByokOnlyProvider(provider: unknown): provider is ByokProvider {
  return typeof provider === "string" && BYOK_ONLY_PROVIDERS.has(provider as ByokProvider);
}

/** What the agent proxy needs to know about a BYOK-only lab (wire kind and label), in place of a PROVIDERS entry. */
export const BYOK_ONLY_DEFS: Readonly<Record<string, { label: string; kind: "openai" }>> = {
  openrouter: { label: "OpenRouter", kind: "openai" },
};

export type KeyShapeResult = { ok: true; key: string } | { ok: false; error: string };

/**
 * Trim and sanity-check a pasted key. Deliberately loose about prefixes: labs
 * change key formats, and the validation call is what decides whether a key
 * works. This only refuses things that cannot be a key at all.
 */
export function checkKeyShape(raw: unknown): KeyShapeResult {
  if (typeof raw !== "string") return { ok: false, error: "Paste an API key." };
  const key = raw.trim();
  if (key.length < BYOK_KEY_MIN_LENGTH) return { ok: false, error: "That key is too short to be an API key." };
  if (key.length > BYOK_KEY_MAX_LENGTH) return { ok: false, error: "That key is too long to be an API key." };
  if (/\s/.test(key)) return { ok: false, error: "An API key has no spaces or line breaks." };
  // Visible ASCII only: a header value cannot carry anything else.
  if (!/^[\x21-\x7e]+$/.test(key)) return { ok: false, error: "That key has characters an API key never contains." };
  return { ok: true, key };
}

/** The last four characters, all a client is ever shown. */
export function keyHint(key: string): string {
  return key.slice(-4);
}

/** GCM additional data: a sealed key only opens for this user and this lab. */
export function byokSealContext(userId: string, provider: ByokProvider): string {
  return `alevr.byok.v1:${userId}:${provider}`;
}

/** The lab's public API root a user's key is sent to (never an env override). */
export function byokBaseUrl(provider: ByokProvider): string {
  if (provider === "anthropic") return "https://api.anthropic.com";
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  const base = PROVIDERS[provider].defaultBaseUrl;
  if (!base) throw new Error(`no public base URL for ${provider}`);
  return base.replace(/\/+$/, "");
}

/** Auth headers for a request on the user's key. */
export function byokAuthHeaders(provider: ByokProvider, key: string): Record<string, string> {
  if (provider === "anthropic") return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  // OpenRouter's app attribution headers: the requests show as Alevr's in the user's OpenRouter activity.
  if (provider === "openrouter") return { authorization: `Bearer ${key}`, "http-referer": "https://alevr.com", "x-title": "Alevr" };
  return { authorization: `Bearer ${key}` };
}

/**
 * The cheapest call that proves a key works: list models. It costs nothing on
 * every lab here, reads no conversation, and answers 401/403 for a bad key.
 * OpenRouter lists models without a key, so its key is tested against `/key`
 * (the key's own limits), which refuses a bad one.
 */
export function keyTestRequest(provider: ByokProvider, key: string): { url: string; init: RequestInit } {
  const base = byokBaseUrl(provider);
  const url = provider === "anthropic" ? `${base}/v1/models?limit=1` : provider === "openrouter" ? `${base}/key` : `${base}/models`;
  return { url, init: { method: "GET", headers: byokAuthHeaders(provider, key) } };
}

export type KeyTestOutcome =
  | { status: "valid" }
  | { status: "invalid"; detail: string }
  | { status: "unreachable"; detail: string };

/** Reads a lab's refusal without ever echoing anything key-shaped back. */
function refusalDetail(status: number, body: string): string {
  let message = "";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const e = parsed.error;
    message = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : typeof parsed.message === "string" ? parsed.message : "";
  } catch {
    message = "";
  }
  // Labs sometimes quote the key back ("Incorrect API key provided: sk-…").
  message = message.replace(/[A-Za-z0-9_\-]{16,}/g, "…").replace(/\s+/g, " ").trim().slice(0, 160);
  return message ? `${status}: ${message}` : `The provider answered ${status}.`;
}

/**
 * Run the validation call. `fetchImpl` is injectable for tests. A 401/403 is a
 * bad key; anything else that is not a 2xx (rate limit, outage, timeout) says
 * nothing about the key and is reported as unreachable, never as invalid.
 */
export async function testProviderKey(
  provider: ByokProvider,
  key: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<KeyTestOutcome> {
  const { url, init } = keyTestRequest(provider, key);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: abort.signal, cache: "no-store" });
    if (res.ok) return { status: "valid" };
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) return { status: "invalid", detail: refusalDetail(res.status, body) };
    return { status: "unreachable", detail: refusalDetail(res.status, body) };
  } catch {
    return { status: "unreachable", detail: abort.signal.aborted ? "The provider did not answer in time." : "The provider could not be reached." };
  } finally {
    clearTimeout(timer);
  }
}

/** A stored key as any client may see it. Never carries the key. */
export interface ProviderKeyView {
  provider: ByokProvider;
  label: string;
  keyHint: string;
  status: "active" | "invalid";
  statusDetail: string | null;
  lastTestedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export function toProviderKeyView(row: {
  provider: string;
  keyHint: string;
  status: string;
  statusDetail: string | null;
  lastTestedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}): ProviderKeyView | null {
  if (!isByokProvider(row.provider)) return null;
  return {
    provider: row.provider,
    label: BYOK_PROVIDER_INFO[row.provider].label,
    keyHint: row.keyHint,
    status: row.status === "invalid" ? "invalid" : "active",
    statusDetail: row.statusDetail,
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** UTC day key for ProviderKeyUsage rows. */
export function usageDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}
