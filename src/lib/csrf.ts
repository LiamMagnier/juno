/**
 * Juno CSRF & Origin Validation Protection
 *
 * Separates authentication semantics:
 * - Cookie-authenticated browser mutations MUST supply a valid, matching Origin.
 *   Missing or cross-origin headers on cookie-bearing requests are strictly rejected.
 * - Bearer-authenticated API / Native requests validate via cryptographic bearer tokens.
 */

export interface CsrfRequestMetadata {
  method: string;
  pathname: string;
  host: string | null;
  origin: string | null;
  secFetchSite?: string | null;
  hasSessionCookie: boolean;
  hasBearerToken: boolean;
  appUrl?: string;
  isDev?: boolean;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const EXEMPT_PREFIXES = [
  "/api/auth/",
  "/api/stripe/webhook",
  "/api/csp-report",
];

const EXEMPT_EXCEPTIONS = ["/api/auth/register"];

export function allowedHosts(host: string | null, appUrl?: string, isDev?: boolean): Set<string> {
  const hosts = new Set<string>();
  if (host) hosts.add(host.toLowerCase());
  if (appUrl) {
    try {
      hosts.add(new URL(appUrl).host.toLowerCase());
    } catch {}
  }
  if (isDev) {
    hosts.add("localhost:3000");
    hosts.add("127.0.0.1:3000");
  }
  return hosts;
}

export function evaluateCsrf(req: CsrfRequestMetadata): { allowed: boolean; status: number; reason?: string } {
  // Non-mutating methods (GET, HEAD, OPTIONS) are safe
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) {
    return { allowed: true, status: 200 };
  }

  // Check exempt paths
  if (
    EXEMPT_PREFIXES.some((p) => req.pathname.startsWith(p)) &&
    !EXEMPT_EXCEPTIONS.some((p) => req.pathname.startsWith(p))
  ) {
    return { allowed: true, status: 200 };
  }

  // Bearer-authenticated requests (native apps, CLI, API keys) follow the bearer contract
  if (req.hasBearerToken && !req.hasSessionCookie) {
    return { allowed: true, status: 200 };
  }

  const validHosts = allowedHosts(req.host, req.appUrl, req.isDev);

  // If Origin header is present, validate origin host
  if (req.origin) {
    let originHost = "";
    try {
      originHost = new URL(req.origin).host.toLowerCase();
    } catch {
      originHost = "";
    }

    if (!originHost || !validHosts.has(originHost)) {
      return { allowed: false, status: 403, reason: "Cross-origin request rejected." };
    }
    return { allowed: true, status: 200 };
  }

  // If Origin is MISSING but request carries session cookies -> fail-closed CSRF protection
  if (req.hasSessionCookie) {
    // Check Sec-Fetch-Site as fallback if browser supplied it
    if (req.secFetchSite === "same-origin") {
      return { allowed: true, status: 200 };
    }
    return { allowed: false, status: 403, reason: "Missing Origin header on cookie-authenticated mutation." };
  }

  // Unauthenticated non-cookie request without origin (e.g. public curl/api)
  return { allowed: true, status: 200 };
}
