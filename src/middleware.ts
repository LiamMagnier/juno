import { NextResponse, type NextRequest } from "next/server";
import { buildCsp } from "@/lib/csp";
import { evaluateCsrf } from "@/lib/csrf";
import { REQUEST_ID_HEADER, RESPONSE_REQUEST_ID_HEADER } from "@/lib/request-id";

/**
 * Cross-origin write protection for the API.
 *
 * Browsers attach an `Origin` header to cross-origin (and same-origin POST)
 * requests; a session cookie rides along automatically, which is what CSRF
 * exploits. So: for mutating methods under /api/, an Origin whose host doesn't
 * match the request Host (or the configured app URL / localhost in dev) is
 * rejected. Requests WITHOUT an Origin header pass — native JunoApp clients,
 * server-to-server callers (Anthropic MCP fetches, Stripe), and curl don't
 * send one and don't carry ambient browser credentials the same way.
 *
 * Exempt: /api/auth/* (next-auth has its own CSRF double-submit protection)
 * and /api/stripe/webhook (authenticated by Stripe signature verification).
 */



/**
 * One id per request, readable by every log line and echoed to the client.
 *
 * `X-Juno-Request-Id` existed before this, but only on /api/v1 responses and
 * minted per response — so it correlated nothing. Stamped here it ties together
 * every line a request produces, and a user reporting a failure can quote the
 * header from their network tab.
 *
 * An inbound value is honoured so a native client or a proxy can carry its own
 * trace id through, but it is bounded and stripped of anything that would let
 * it forge extra fields in a log line.
 */
function requestIdFor(req: NextRequest): string {
  const inbound = req.headers.get(REQUEST_ID_HEADER);
  if (inbound) {
    const safe = inbound.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    if (safe.length >= 8) return safe;
  }
  return `req_${crypto.randomUUID()}`;
}

/**
 * Attaches the per-request id to both the request (for logging) and the
 * response (for the client), and — on document requests — the CSP.
 *
 * **Content-Security-Policy, in Report-Only to start with.** Juno renders
 * model-authored markdown and model-authored code, so CSP is the layer that
 * turns a renderer bug into a blocked console message rather than script
 * execution on the user's session. There is no known bypass today
 * (react-markdown without rehype-raw, two audited dangerouslySetInnerHTML
 * sites), which is exactly when to add it — before there is one.
 *
 * Report-Only means it cannot break the app. Watch /api/csp-report, fix what it
 * surfaces, and only then rename the response header to enforce. The policy
 * itself lives in @/lib/csp so it can be unit tested; the artifact iframe is
 * `srcdoc` + `sandbox` WITHOUT allow-same-origin, so it is an opaque origin and
 * unaffected by any of this.
 */
function withRequestContext(req: NextRequest, applyCsp: boolean): NextResponse {
  const requestId = requestIdFor(req);
  const headers = new Headers(req.headers);
  headers.set(REQUEST_ID_HEADER, requestId);

  let csp: string | null = null;
  if (applyCsp) {
    const nonce = crypto.randomUUID();
    csp = buildCsp({ nonce, relayUrl: process.env.NEXT_PUBLIC_VOICE_RELAY_URL });
    // Next reads the nonce off the REQUEST header to stamp its own script tags.
    // It looks for `Content-Security-Policy`, not the report-only name, so the
    // request carries the enforcing name even while the response only reports.
    headers.set("x-nonce", nonce);
    headers.set("Content-Security-Policy", csp);
  }

  const res = NextResponse.next({ request: { headers } });
  res.headers.set(RESPONSE_REQUEST_ID_HEADER, requestId);
  if (csp) res.headers.set("Content-Security-Policy-Report-Only", csp);
  return res;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // CSP applies to documents, not to the JSON/SSE API. The request id applies
  // to both.
  if (!pathname.startsWith("/api/")) {
    return withRequestContext(req, true);
  }

  const authHeader = req.headers.get("authorization");
  const hasSessionCookie =
    req.cookies.has("authjs.session-token") ||
    req.cookies.has("__Secure-authjs.session-token") ||
    req.cookies.has("next-auth.session-token") ||
    req.cookies.has("__Secure-next-auth.session-token");

  const csrfResult = evaluateCsrf({
    method: req.method,
    pathname,
    host: req.headers.get("host"),
    origin: req.headers.get("origin"),
    secFetchSite: req.headers.get("sec-fetch-site"),
    hasSessionCookie,
    hasBearerToken: Boolean(authHeader?.startsWith("Bearer ")),
    appUrl: process.env.NEXT_PUBLIC_APP_URL,
    isDev: process.env.NODE_ENV !== "production",
  });

  if (!csrfResult.allowed) {
    return NextResponse.json({ error: csrfResult.reason || "Cross-origin request rejected." }, { status: csrfResult.status });
  }

  return withRequestContext(req, false);
}

export const config = {
  // Everything except Next's own static output and the files served straight
  // from /public — those need neither the origin check nor a CSP, and running
  // middleware on them is pure overhead on every asset.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|manifest.webmanifest|robots.txt|sitemap.xml).*)",
  ],
};
