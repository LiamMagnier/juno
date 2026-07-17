import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { isTerminalTaskStatus, taskTokenAuth } from "@/lib/code-remote";
import { PROVIDERS, providerApiKey, providerBaseUrl, type Provider } from "@/lib/providers";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/usage";
import { checkBudget, budgetExceededMessage } from "@/lib/spend";

// Streaming needs the Node runtime and a generous ceiling.
export const runtime = "nodejs";
export const maxDuration = 300;

const ANTHROPIC_BASE = "https://api.anthropic.com";

// Only the chat/messages endpoints may be proxied — never arbitrary provider paths.
// "responses" is OpenAI-proper only: the pro/Codex Responses-only models live
// there, and no other openai-kind lab serves that endpoint.
function isAllowedPath(kind: "anthropic" | "openai", provider: Provider, forwardPath: string): boolean {
  if (kind === "anthropic") return forwardPath === "v1/messages";
  if (forwardPath === "chat/completions") return true;
  return provider === "openai" && forwardPath === "responses";
}

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
  // The Cloud Code runner authenticates with its per-task bearer ("cct_…") — it
  // has no session cookie. Resolve that to the task's owner so plan budget still
  // applies (no free provider calls); everyone else uses the normal session /
  // native-bearer path, unchanged.
  const authorization = req.headers.get("authorization");
  let user;
  if (authorization?.startsWith("Bearer cct_")) {
    const task = await taskTokenAuth(req);
    if (!task) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // A finished task must not keep driving paid provider calls: once the run is
    // done/failed/cancelled the runner has no business here, so a replayed token
    // is refused even though it hasn't expired yet.
    if (isTerminalTaskStatus(task.status)) {
      return NextResponse.json({ error: "Task is no longer active." }, { status: 409 });
    }
    user = task.user;
  } else {
    user = await getCurrentUser();
  }
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // This proxy carries real provider spend (Juno Code agent loops, voice and
  // utility calls), so it obeys the same plan budget as /api/chat — otherwise
  // app usage would be unlimited and invisible to plan limits. The generous
  // burst limit accommodates multi-iteration agent turns.
  const plan = await getUserPlan(user.id);
  if (plan !== "OWNER") {
    const rl = await rateLimit({ key: `agent:${user.id}`, limit: 120, windowSec: 60 });
    if (!rl.success) {
      return NextResponse.json({ error: "Rate limit exceeded. Try again shortly." }, { status: 429 });
    }
    const budget = await checkBudget(user.id, plan);
    if (!budget.allowed) {
      return NextResponse.json(
        { error: budgetExceededMessage(plan, budget.resetsAtMs), code: "QUOTA_EXCEEDED" },
        { status: 402 },
      );
    }
  }

  const { path } = await ctx.params;
  const [providerRaw, ...rest] = path ?? [];
  const provider = providerRaw as Provider;
  if (!provider || !(provider in PROVIDERS)) {
    return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
  }

  const def = PROVIDERS[provider];
  const forwardPath = rest.join("/");
  if (!isAllowedPath(def.kind, provider, forwardPath)) {
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
