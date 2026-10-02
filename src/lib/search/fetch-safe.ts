import { isDisallowedHost } from "./url-safety";
import { fetchPinnedPublicUrl } from "./pinned-fetch";

export const MAX_SAFE_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type SafeFetchResult =
  /** `hops`: every URL requested, in order — the initial one first, `url` (the final one) last. */
  | { kind: "response"; response: Response; url: string; hops: string[] }
  | { kind: "blocked" }
  | { kind: "redirect_limit" };

export interface SafeFetchOptions {
  /**
   * A caller's own policy, applied to EVERY hop beside the SSRF host guard:
   * false refuses the hop as `blocked`. Chat passes its `urlGuard` (web's two
   * ports only, never Juno's own origins), so a URL the provenance ledger
   * approved cannot redirect somewhere the guard would have refused had it
   * been asked for directly (SPEC §6.1 step 7). Research and Work pass none.
   */
  guard?: (url: string) => boolean;
}

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
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const allowed = (url: string) => !isDisallowedHost(url) && (!options.guard || options.guard(url));
  let currentUrl = initialUrl;
  const hops = [initialUrl];
  let redirects = 0;
  for (;;) {
    if (!allowed(currentUrl)) return { kind: "blocked" };
    const response = await transport(currentUrl, init, signal);
    if (!REDIRECT_STATUSES.has(response.status)) return { kind: "response", response, url: currentUrl, hops };

    const location = response.headers.get("location");
    if (!location) return { kind: "response", response, url: currentUrl, hops };
    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "blocked" };
    }
    await response.body?.cancel().catch(() => undefined);
    if (!allowed(nextUrl)) return { kind: "blocked" };
    redirects += 1;
    if (redirects > MAX_SAFE_REDIRECTS) return { kind: "redirect_limit" };
    currentUrl = nextUrl;
    hops.push(nextUrl);
  }
}
