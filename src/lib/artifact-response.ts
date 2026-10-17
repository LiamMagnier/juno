/*
 * Reading an API answer without ever showing a parser error to a person.
 *
 * The artifact menu used to call `response.json()` before looking at
 * `response.ok`, so a proxy's HTML error page, an empty 502 or a timeout
 * surfaced as "Unexpected token '<', "<!DOCTYPE "… is not valid JSON" in the
 * alert. Here the body is read as text first and parsed only if it parses;
 * a failure is always a sentence: the server's own when it wrote one, else
 * one chosen by status. Client-safe and pure apart from `fetch`.
 */

export const RESPONSE_COPY = {
  failed: "The action couldn’t finish. Try again.",
  offline: "Couldn’t reach the server. Check your connection and try again.",
  notFound: "This isn’t available any more. It may have been moved to Recently deleted.",
  rateLimited: "Too many changes at once. Try again shortly.",
  unauthorized: "Your session has ended. Sign in again to continue.",
  server: "Something went wrong on our side. Try again in a moment.",
} as const;

export type JsonResult =
  | { ok: true; status: number; data: Record<string, unknown> }
  | { ok: false; status: number; error: string; code: string | null; data: Record<string, unknown> | null };

/** Terse machine answers some routes give, mapped to a sentence a person can act on. */
const TERSE: Record<string, string> = {
  "not found": RESPONSE_COPY.notFound,
  unauthorized: RESPONSE_COPY.unauthorized,
  "invalid input": RESPONSE_COPY.failed,
  stale: RESPONSE_COPY.failed,
};

export function fallbackErrorFor(status: number): string {
  if (status === 0) return RESPONSE_COPY.offline;
  if (status === 401) return RESPONSE_COPY.unauthorized;
  if (status === 404 || status === 410) return RESPONSE_COPY.notFound;
  if (status === 429) return RESPONSE_COPY.rateLimited;
  if (status >= 500) return RESPONSE_COPY.server;
  return RESPONSE_COPY.failed;
}

/** The sentence to show for a failed answer: the server's when it wrote a real one. */
export function errorMessageFor(status: number, data: Record<string, unknown> | null): string {
  const raw = typeof data?.error === "string" ? data.error.trim() : "";
  if (!raw) return fallbackErrorFor(status);
  const terse = TERSE[raw.toLowerCase()];
  if (terse) return terse;
  // A one-word code ("stale", "rate_limited") is not a sentence either.
  if (!/\s/.test(raw)) return fallbackErrorFor(status);
  return raw;
}

function parseObject(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Reads `res` as JSON when it is JSON, after checking its status. Never throws. */
export async function readJsonResponse(res: Response): Promise<JsonResult> {
  const text = await res.text().catch(() => "");
  const data = parseObject(text);
  if (res.ok) return { ok: true, status: res.status, data: data ?? {} };
  return {
    ok: false,
    status: res.status,
    error: errorMessageFor(res.status, data),
    code: typeof data?.code === "string" ? data.code : null,
    data,
  };
}

/** `fetch` + `readJsonResponse`; a network failure is status 0 with the offline sentence. */
export async function requestJson(url: string, init?: RequestInit): Promise<JsonResult> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch {
    return { ok: false, status: 0, error: RESPONSE_COPY.offline, code: null, data: null };
  }
  return readJsonResponse(res);
}
