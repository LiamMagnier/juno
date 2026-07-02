import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { PROVIDERS, providerApiKey, providerBaseUrl, type Provider } from "@/lib/providers";

// Streaming needs the Node runtime and a generous ceiling.
export const runtime = "nodejs";
export const maxDuration = 300;

const ANTHROPIC_BASE = "https://api.anthropic.com";

// Only the chat/messages endpoints may be proxied — never arbitrary provider paths.
const ALLOWED: Record<"anthropic" | "openai", string> = {
  anthropic: "v1/messages",
  openai: "chat/completions",
};

/**
 * Transparent, authenticated provider proxy for the native app's Code agent.
 *
 * The app builds a provider-native request (Anthropic Messages / OpenAI chat
 * completions) and posts it here at /api/agent/<provider>/<path>. We validate the
 * signed-in session, inject the server-side provider key, forward to the real
 * provider, and stream the response straight back — so the app reuses its
 * existing request-building and SSE parsing, and the user never pastes a key.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { path } = await ctx.params;
  const [providerRaw, ...rest] = path ?? [];
  const provider = providerRaw as Provider;
  if (!provider || !(provider in PROVIDERS)) {
    return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
  }

  const def = PROVIDERS[provider];
  const forwardPath = rest.join("/");
  if (forwardPath !== ALLOWED[def.kind]) {
    return NextResponse.json({ error: "Endpoint not allowed." }, { status: 403 });
  }

  const key = providerApiKey(provider);
  if (!key) {
    return NextResponse.json(
      { error: `${def.label} isn't configured on the server.` },
      { status: 502 },
    );
  }

  const base = def.kind === "anthropic" ? ANTHROPIC_BASE : providerBaseUrl(provider);
  if (!base) return NextResponse.json({ error: "No base URL for provider." }, { status: 502 });
  const target = `${base.replace(/\/+$/, "")}/${forwardPath}`;

  // Forward the app's provider-native body verbatim, swapping in the real key.
  const body = await req.text();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (def.kind === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = req.headers.get("anthropic-version") ?? "2023-06-01";
    const beta = req.headers.get("anthropic-beta");
    if (beta) headers["anthropic-beta"] = beta;
  } else {
    headers["authorization"] = `Bearer ${key}`;
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, { method: "POST", headers, body });
  } catch {
    return NextResponse.json({ error: "Upstream provider request failed." }, { status: 502 });
  }

  // Stream the provider response back to the app untouched.
  const respHeaders = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) respHeaders.set("content-type", ct);
  respHeaders.set("cache-control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}
