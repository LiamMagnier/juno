import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { isTerminalTaskStatus, taskTokenAuth } from "@/lib/code-remote";
import { PROVIDERS, providerApiKey, providerBaseUrl, type Provider } from "@/lib/providers";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/usage";
import { checkBudget, checkUsageWindows, budgetExceededMessage, recordSpend } from "@/lib/spend";
import { windowLimitMessage } from "@/lib/spend-ceiling";
import {
  createUpstreamAbort,
  inspectAgentRequest,
  isUpstreamTimeout,
  providerWire,
  readLimitedRequestBody,
  relayedResponseHeaders,
  relayUpstreamBody,
  upstreamTimeoutKind,
  upstreamTimeoutsFor,
  usageMeterFor,
} from "@/lib/agent-proxy";

// Streaming needs the Node runtime. There is deliberately no `maxDuration`:
// it is a Vercel-only directive that `next start` ignores (the chat route says
// the same), and the value it used to carry — 300 — read as a limit this
// process never had. How long an upstream call may run is decided by the three
// deadlines in agent-proxy.ts; the only ceiling outside this process is nginx's
// `proxy_read_timeout` (3600s between reads, deploy/nginx.conf.template).
export const runtime = "nodejs";

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
 *
 * BILLING. Every call is charged here, from the usage the provider itself
 * reports in the response (or, when it reports none before the exchange ends,
 * at the character floor of the request and what streamed), as one ApiSpend
 * row of kind "code". This is the one place that can: every request on Juno's
 * provider keys from a Code engine passes through it, and nothing else sees
 * what the provider said it cost. The callers, and why none of them is charged
 * a second time:
 *
 *  - The Mac app (`BackendCodeModelClient`, native bearer): Code sessions, their
 *    sub-agents, device-queued tasks and Work runs hosted on the Mac. It never
 *    reported usage anywhere, and a Mac-hosted Work run finishes with no usage
 *    attached, so `recordWorkRunSpend` bills it nothing. Those Work calls land
 *    here as "code": nothing in a request says which product made it.
 *  - The Cloud Code runner (`scripts/cloud-code-runner.mjs`, `cct_` bearer): it
 *    passes no usage reporter, and cloud tasks keep no cost of their own.
 *  - agent-core's `BackendUsageReporter` hosts (the Electron agent host and the
 *    agent-core socket server, session cookie; neither is configured by a live
 *    client in this repository today): they settle each turn through
 *    `/api/agent/usage`, which therefore no longer writes a ledger row — see
 *    that route. Skipping the charge here on a caller-chosen signal (a header,
 *    or cookie auth) instead would let any signed-in account use this proxy as
 *    unmetered provider access, since the budget gates above read only the
 *    ledger.
 *
 * Voice never comes through here: the relay speaks to its providers directly
 * and reports through `/api/voice/spend`.
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

  // This proxy carries real provider spend (Juno Code agent loops, and Work
  // runs hosted on a Mac), so it obeys the same plan budget as /api/chat — otherwise
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
    // And the rolling windows, which are the real limit now that the per-run
    // ceiling is gone (src/lib/work/budget.ts). Every Juno Code agent turn
    // comes through this proxy, so without it a Code run was the one surface
    // with nothing but the MONTH above it: chat stops at the five-hour window,
    // a Work run stops at it and is re-checked mid-flight, and a Code loop went
    // on spending. That is not a stricter or looser policy than the others —
    // it is the same account's limit not being applied to one of its surfaces.
    //
    // Same 402 and same `QUOTA_EXCEEDED` as the budget wall above, deliberately:
    // every client already treats that pair as "stop the turn and say why"
    // rather than as something to retry, and a new code would be a refusal they
    // do not recognise. `window` rides along for a client that wants to say
    // which one.
    const windows = await checkUsageWindows(user.id, plan);
    if (!windows.allowed && windows.bound !== null) {
      return NextResponse.json(
        {
          error: windowLimitMessage(windows.bound, windows.resetsAtMs),
          code: "QUOTA_EXCEEDED",
          window: windows.bound,
          resetsAtMs: windows.resetsAtMs,
        },
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

  // Forward the app's provider-native body, swapping in the real key.
  // Read it with a limit: req.text() otherwise buffers an unbounded request in
  // the Node worker before the provider ever sees it.
  const bodyResult = await readLimitedRequestBody(req);
  if (!bodyResult.ok) {
    return NextResponse.json(
      {
        error:
          bodyResult.reason === "too_large"
            ? "Agent request body is too large."
            : "Agent request body could not be read.",
      },
      { status: bodyResult.reason === "too_large" ? 413 : 400 },
    );
  }
  // What billing needs from the body, read once here — and, for a streamed
  // Chat Completions call that did not ask for it, the one change the proxy
  // makes: switching on the final usage chunk. Everything else is forwarded as
  // the client sent it. A body the proxy cannot read exactly as the provider
  // will, or a Responses call whose cost could never reach the ledger
  // (`background`), is refused before it costs anything; see inspectAgentRequest.
  const wire = providerWire(def.kind, forwardPath);
  if (!wire) return NextResponse.json({ error: "Endpoint not allowed." }, { status: 403 });
  const checked = inspectAgentRequest(wire, bodyResult.body);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  const request = checked.request;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (def.kind === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = req.headers.get("anthropic-version") ?? "2023-06-01";
    const beta = req.headers.get("anthropic-beta");
    if (beta) headers["anthropic-beta"] = beta;
  } else {
    headers["authorization"] = `Bearer ${key}`;
  }

  const upstreamAbort = createUpstreamAbort(req.signal, upstreamTimeoutsFor(request.streamed));
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers,
      body: request.body,
      signal: upstreamAbort.signal,
    });
  } catch {
    upstreamAbort.cancel();
    if (isUpstreamTimeout(upstreamAbort.signal)) {
      return NextResponse.json({ error: "Upstream provider request timed out." }, { status: 504 });
    }
    if (req.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    return NextResponse.json({ error: "Upstream provider request failed." }, { status: 502 });
  }
  upstreamAbort.headersReceived();

  // Stream the provider response back to the app untouched, with its media
  // type and any `retry-after` it asked for.
  const respHeaders = relayedResponseHeaders(upstream.headers);

  // A bodyless upstream response has no stream to clear the deadlines from, so
  // disarm them here — otherwise the timers and the `req.signal` listener stay
  // alive for the full ceiling after the request has already been answered.
  if (!upstream.body) {
    upstreamAbort.cancel();
    return new Response(null, { status: upstream.status, headers: respHeaders });
  }

  const meter = usageMeterFor(wire, upstream, request);
  // The Juno catalog id, `<provider>:<provider model>`, so `resolveModel`
  // finds the model's real rates; a bare provider id would be priced at the
  // unknown-model fallback.
  const spendModel = `${provider}:${request.model}`;
  const userId = user.id;
  // The runner is Juno's own server-side execution, the bucket a cloud Work
  // run's spend lands in too; every other caller of this proxy is an app.
  const source = authorization?.startsWith("Bearer cct_") ? "web" : "app";
  const bodyStream = relayUpstreamBody({
    body: upstream.body,
    abort: upstreamAbort,
    observe: meter ? (chunk) => meter.observe(chunk) : undefined,
    answerComplete: meter ? () => meter.answerComplete : undefined,
    onEnd: (outcome) => {
      const timeout = upstreamTimeoutKind(upstreamAbort.signal);
      if (timeout) {
        console.warn("[agent-proxy] upstream stream stopped by its deadline", { provider, timeout });
      }
      // Billed on every ending, a client that left halfway included: the
      // provider charged for what it produced whether or not anyone read it.
      // What it reported, when it reported anything; otherwise the character
      // floor (the request's text and what streamed), because OpenAI-style
      // usage arrives last and a client that hangs up just before it must not
      // make the call free.
      const metered = meter?.finish();
      if (!metered) return;
      if (metered.estimated) {
        // A call that finished without usage is a host ignoring include_usage,
        // worth noticing; one cut short is an ordinary Stop.
        const log = outcome === "completed" ? console.warn : console.info;
        log("[agent-proxy] no usage reported; billing the character floor", { provider, outcome });
      } else if (outcome !== "completed") {
        console.info("[agent-proxy] billing a stream that did not complete", { provider, outcome });
      }
      // Not awaited: the ledger write happens after the client has its last
      // byte, never in front of it. `recordSpend` catches its own failures.
      void recordSpend({ userId, model: spendModel, kind: "code", source, ...metered.usage }).catch(
        () => undefined,
      );
    },
  });
  return new Response(bodyStream, { status: upstream.status, headers: respHeaders });
}
