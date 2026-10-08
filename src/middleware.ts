import { NextResponse, type NextRequest } from "next/server";
import { buildCsp } from "@/lib/csp";
import { documentPolicyFor, sandboxOrigin } from "@/lib/sandbox-policy";
import { evaluateCsrf } from "@/lib/csrf";
import { REQUEST_ID_HEADER, RESPONSE_REQUEST_ID_HEADER } from "@/lib/request-id";
import { REFERRAL_COOKIE, REFERRAL_COOKIE_MAX_AGE_SEC, normalizeReferralCode } from "@/lib/credits";

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
 * **Enforcing Content-Security-Policy.** Juno renders
 * model-authored markdown and model-authored code, so CSP is the layer that
 * turns a renderer bug into a blocked console message rather than script
 * execution on the user's session. There is no known bypass today
 * (react-markdown without rehype-raw, two audited dangerouslySetInnerHTML
 * sites), which is exactly when to add it — before there is one.
 *
 * The policy lives in @/lib/csp so it can be unit tested. It is NOT applied to
 * the artifact preview shell (/sandbox/*): a document an iframe gets from
 * `srcdoc`, `blob:` or `data:` inherits the embedding page's policy, so while
 * previews were srcdoc frames this nonce policy blocked every script in them
 * (audit X-01). Previews now load the shell by URL and the shell's response
 * carries its own policy — see src/lib/sandbox-policy.ts.
 */
function withRequestContext(req: NextRequest, applyCsp: boolean): NextResponse {
  const requestId = requestIdFor(req);
  const headers = new Headers(req.headers);
  headers.set(REQUEST_ID_HEADER, requestId);

  let csp: string | null = null;
  if (applyCsp) {
    const nonce = crypto.randomUUID();
    csp = buildCsp({
      nonce,
      relayUrl: process.env.NEXT_PUBLIC_VOICE_RELAY_URL || process.env.VOICE_RELAY_URL,
      sandboxOrigin: sandboxOrigin(),
    });
    // Next reads the nonce off the REQUEST header to stamp its own script tags.
    // It looks for `Content-Security-Policy`, so request and response use the
    // same enforcing policy and nonce.
    headers.set("x-nonce", nonce);
    headers.set("Content-Security-Policy", csp);
  }

  const res = NextResponse.next({ request: { headers } });
  res.headers.set(RESPONSE_REQUEST_ID_HEADER, requestId);
  if (csp) res.headers.set("Content-Security-Policy", csp);
  if (req.nextUrl.pathname === "/computer-view") {
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    res.headers.set("X-Robots-Tag", "noindex");
  }
  return res;
}

/** The public poster route, which sets its own Content-Security-Policy. */
const SHARE_POSTER_PATH = /^\/share\/[^/]+\/poster$/;

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // The preview shell brings its own policy, and a separate preview origin
  // serves the shell and nothing else.
  const policy = documentPolicyFor({ pathname, host: req.headers.get("host"), sandboxOrigin: sandboxOrigin() });
  if (policy === "not-found") return new NextResponse("Not found", { status: 404 });
  if (policy === "sandbox") return withRequestContext(req, false);

  // CSP applies to documents, not to the JSON/SSE API. The request id applies
  // to both.
  //
  // One non-API path is not a document: a shared design's poster
  // (`/share/{token}/poster`), which answers with an SVG image under its own,
  // stricter policy (`POSTER_CSP` in src/lib/design/poster.ts). Next adds a
  // route handler's header only when the middleware has not already set it,
  // so stamping the page policy here would silently replace the poster's.
  if (!pathname.startsWith("/api/")) {
    const res = withRequestContext(req, !SHARE_POSTER_PATH.test(pathname));
    // `?ref=<code>` on any page (a shared link to the homepage, /sign-up, the
    // pricing page) remembers the referral exactly as /r/<code> does; the
    // account it belongs to is linked once it exists.
    const ref = normalizeReferralCode(req.nextUrl.searchParams.get("ref"));
    if (ref && !req.cookies.has(REFERRAL_COOKIE)) {
      res.cookies.set(REFERRAL_COOKIE, ref, {
        httpOnly: true,
        sameSite: "lax",
        secure: req.nextUrl.protocol === "https:",
        path: "/",
        maxAge: REFERRAL_COOKIE_MAX_AGE_SEC,
      });
    }
    return res;
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
  //
  // sw.js especially: a worker script runs under the CSP of its own response,
  // and the document policy (a per-request nonce, 'strict-dynamic') is written
  // for pages. The worker is push-only and self-contained (public/sw.js).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon1.ico|icon.svg|apple-icon.png|brand/|manifest.webmanifest|robots.txt|sitemap.xml|sw.js).*)",
  ],
};
