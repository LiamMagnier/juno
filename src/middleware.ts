import { NextResponse, type NextRequest } from "next/server";
import { buildCsp } from "@/lib/csp";

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

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const EXEMPT_PREFIXES = [
  "/api/auth/",
  "/api/stripe/webhook",
  // The browser posts CSP violation reports itself, with `Origin: null` (not a
  // missing Origin), which the check below would reject as cross-origin. The
  // route carries no authority and reads no session, so there is nothing to
  // forge.
  "/api/csp-report",
];

// Custom routes under /api/auth/ that are NOT next-auth handlers (no built-in
// CSRF protection of their own) — the origin check still applies to these.
const EXEMPT_EXCEPTIONS = ["/api/auth/register"];

function allowedHosts(req: NextRequest): Set<string> {
  const hosts = new Set<string>();
  const requestHost = req.headers.get("host");
  if (requestHost) hosts.add(requestHost.toLowerCase());
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl) {
    try {
      hosts.add(new URL(appUrl).host.toLowerCase());
    } catch {
      // Malformed env value — fall through to the other allowed hosts.
    }
  }
  if (process.env.NODE_ENV !== "production") {
    hosts.add("localhost:3000");
    hosts.add("127.0.0.1:3000");
  }
  return hosts;
}

/**
 * Content-Security-Policy, in **Report-Only** to start with.
 *
 * Juno renders model-authored markdown and model-authored code. CSP is the
 * layer that turns a renderer bug into a blocked console message instead of
 * script execution on the user's session. There is no known bypass today
 * (react-markdown without rehype-raw, two audited dangerouslySetInnerHTML
 * sites), which is exactly when to add it — before there is one.
 *
 * Report-Only means this cannot break the app. Watch /api/csp-report, fix what
 * it surfaces, and only then rename the header to enforce.
 *
 * The policy itself lives in @/lib/csp so it can be unit tested; the artifact
 * iframe is `srcdoc` + `sandbox` WITHOUT allow-same-origin, so it is an opaque
 * origin and unaffected by any of this.
 */
function withCsp(req: NextRequest): NextResponse {
  const nonce = crypto.randomUUID();
  const csp = buildCsp({ nonce, relayUrl: process.env.NEXT_PUBLIC_VOICE_RELAY_URL });

  // Next reads the nonce off the REQUEST header to stamp its own script tags.
  // It looks for `Content-Security-Policy`, not the report-only name, so the
  // request carries the enforcing name even while the response only reports.
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);

  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy-Report-Only", csp);
  return res;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // CSP applies to documents, not to the JSON/SSE API.
  if (!pathname.startsWith("/api/")) {
    return withCsp(req);
  }

  if (!MUTATING_METHODS.has(req.method)) return NextResponse.next();

  if (
    EXEMPT_PREFIXES.some((p) => pathname.startsWith(p)) &&
    !EXEMPT_EXCEPTIONS.some((p) => pathname.startsWith(p))
  ) {
    return NextResponse.next();
  }

  const origin = req.headers.get("origin");
  if (!origin) return NextResponse.next();

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    // "null" (sandboxed iframe) or malformed — treat as cross-origin.
    originHost = "";
  }

  if (!originHost || !allowedHosts(req).has(originHost)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next's own static output and the files served straight
  // from /public — those need neither the origin check nor a CSP, and running
  // middleware on them is pure overhead on every asset.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|manifest.webmanifest|robots.txt|sitemap.xml).*)",
  ],
};
