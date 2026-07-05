import { NextResponse, type NextRequest } from "next/server";

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

const EXEMPT_PREFIXES = ["/api/auth/", "/api/stripe/webhook"];

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

export function middleware(req: NextRequest) {
  if (!MUTATING_METHODS.has(req.method)) return NextResponse.next();

  const { pathname } = req.nextUrl;
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
  matcher: "/api/:path*",
};
