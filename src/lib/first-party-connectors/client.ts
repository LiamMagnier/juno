import type { FirstPartyId } from "./providers";
import { safeMcpFetch } from "@/lib/mcp-safe-fetch";

export class ConnectorApiError extends Error {
  constructor(readonly status: number) { super(`Connected app request failed (${status})`); }
}

const ORIGINS = {
  gmail: "https://gmail.googleapis.com", "google-calendar": "https://www.googleapis.com",
  "google-drive": "https://www.googleapis.com", outlook: "https://graph.microsoft.com",
  "microsoft-365": "https://graph.microsoft.com", slack: "https://slack.com",
} satisfies Record<FirstPartyId, string>;

/** Never follow an API nextLink or redirect while carrying a bearer token. */
export function connectorApiUrl(provider: FirstPartyId, path: string): URL {
  const origin = ORIGINS[provider];
  const url = new URL(path, origin);
  const prefix = provider === "gmail" ? "/gmail/v1/" : provider === "google-calendar" ? "/calendar/v3/" : provider === "google-drive" ? "/drive/v3/" : provider === "slack" ? "/api/" : "/v1.0/";
  if (url.origin !== origin || !url.pathname.startsWith(prefix) || url.username || url.password || url.hash) throw new Error("Invalid connected app cursor");
  return url;
}

export class FirstPartyClient {
  constructor(readonly provider: FirstPartyId, private readonly token: string, private readonly fetcher: typeof fetch = fetch, private readonly signal?: AbortSignal) {}

  async request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", download = false): Promise<Response> {
    const response = await this.fetcher(connectorApiUrl(this.provider, path), {
      method, headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual",
      signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    // Writes are deliberately not retried: a timed-out send may have succeeded.
    if (download && method === "GET" && [301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || new URL(location).protocol !== "https:") throw new Error("Invalid file download location");
      // Graph /content issues a short-lived download URL. No provider headers
      // follow it; the shared SSRF-safe fetch pins public DNS on every hop.
      const file = await safeMcpFetch(location, { signal: this.signal ?? AbortSignal.timeout(30_000) });
      if (!file.ok) throw new ConnectorApiError(file.status);
      return file;
    }
    if (!response.ok) throw new ConnectorApiError(response.status);
    return response;
  }

  async json<T = Record<string, unknown>>(path: string, body?: unknown, method?: string): Promise<T> {
    const res = await this.request(path, body, method);
    if (res.status === 204 || res.headers.get("content-length") === "0") return {} as T;
    const text = await boundedText(res, 2_000_000);
    if (!text) return {} as T;
    const data = JSON.parse(text);
    if (this.provider === "slack" && data.ok !== true) throw new Error("Slack refused the request");
    return data as T;
  }
}

export async function boundedText(response: Response, maxBytes = 500_000): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Connected app response is too large");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
