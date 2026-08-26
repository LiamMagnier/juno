import { isDisallowedHost } from "./url-safety";
import { fetchPinnedPublicUrl } from "./pinned-fetch";

export const MAX_SAFE_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type SafeFetchResult =
  | { kind: "response"; response: Response; url: string }
  | { kind: "blocked" }
  | { kind: "redirect_limit" };

/**
 * Fetch a public URL without delegating redirect policy to undici.
 *
 * `redirect: "follow"` checks only the URL supplied by the caller. A public
 * page can redirect to loopback, RFC1918, metadata, or another non-http scheme,
 * so every Location is resolved and passed through the same SSRF guard before
 * the next request is made.
 */
export async function fetchSafePublicUrl(
  initialUrl: string,
  init: RequestInit,
  signal?: AbortSignal,
  transport: (url: string, init: RequestInit, signal?: AbortSignal) => Promise<Response> = fetchPinnedPublicUrl,
): Promise<SafeFetchResult> {
  let currentUrl = initialUrl;
  let redirects = 0;
  for (;;) {
    if (isDisallowedHost(currentUrl)) return { kind: "blocked" };
    const response = await transport(currentUrl, init, signal);
    if (!REDIRECT_STATUSES.has(response.status)) return { kind: "response", response, url: currentUrl };

    const location = response.headers.get("location");
    if (!location) return { kind: "response", response, url: currentUrl };
    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "blocked" };
    }
    await response.body?.cancel().catch(() => undefined);
    if (isDisallowedHost(nextUrl)) return { kind: "blocked" };
    redirects += 1;
    if (redirects > MAX_SAFE_REDIRECTS) return { kind: "redirect_limit" };
    currentUrl = nextUrl;
  }
}
