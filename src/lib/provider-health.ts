import "server-only";
import { alertOperator } from "@/lib/alerts";
import { classifyProviderError } from "@/lib/provider-error";
import {
  healthTransition,
  isHealthStale,
  nextHealthState,
  type ProbeOutcome,
  type ProviderHealthState,
} from "@/lib/provider-health-policy";
import { MODELS } from "@/lib/models";
import {
  PROVIDERS,
  configuredProviders,
  providerApiKey,
  providerBaseUrl,
  type Provider,
} from "@/lib/providers";

/**
 * Is each provider's API key actually *usable*?
 *
 * `isProviderConfigured` only asks whether an env var is non-empty, and that is
 * what the model catalog was gated on. So a revoked or unfunded key kept every
 * one of its models in the picker, and users picked models that could not
 * answer. Worse, `fetchProviderModels` (model-discovery.ts) already made an
 * authenticated call every 10 minutes and *discarded* the 401 — falling back to
 * the curated list, so a dead provider produced a MORE complete catalog than a
 * working one, with the only log suppressed in production.
 *
 * A models-list GET is not enough to close this: a valid-but-unfunded key still
 * lists models happily. Only actually asking for a token proves the account can
 * serve traffic, so the probe is a 1-token completion.
 *
 * Design constraints this has to respect:
 *  - **Never block a request.** `loadAvailableModels` is awaited by
 *    /api/v1/bootstrap among others; a cold-start probe of 14 providers would
 *    stall app load. Reads are served from cache and refreshes happen in the
 *    background (stale-while-revalidate).
 *  - **Fail open.** A provider that has never been probed counts as healthy.
 *    Being wrong in that direction shows a model that errors; being wrong the
 *    other way hides a working catalog.
 *  - **Only account faults count.** 429s and 5xx are normal provider weather;
 *    treating them as unhealthy would make the model picker flap during an
 *    ordinary overload. Only auth/billing — the classes an operator must fix —
 *    mark a provider down.
 *
 * State is per-process and in memory, like the model-discovery cache beside it.
 *
 * Known limitation: the probe is a chat completion, so a provider with no
 * curated chat model — an image/video-only one such as seedance — cannot be
 * probed and stays assumed-healthy. That is the fail-open default rather than a
 * special case, and it is the honest state: nothing has been proven about it.
 */

/** Re-exported so callers need only this module. */
export type ProviderHealth = ProviderHealthState;

export const PROVIDER_PROBE_TIMEOUT_MS = 8_000;
export const PROVIDER_DIAGNOSTIC_TIMEOUT_MS = PROVIDER_PROBE_TIMEOUT_MS + 2_000;

const health = new Map<Provider, ProviderHealth>();
const inFlight = new Map<Provider, Promise<void>>();

interface BoundedSignal {
  signal: AbortSignal;
  cleanup: () => void;
}

/**
 * Create a cancellable, cleaned-up deadline for provider I/O.
 *
 * AbortSignal.timeout() is convenient, but a composed signal is needed here:
 * the explicit readiness request has its own batch deadline while every
 * provider fetch also needs a shorter per-provider deadline. The listener and
 * timer are always removed so a diagnostic request cannot leave work attached
 * to the process after it has completed.
 */
function boundedSignal(parent: AbortSignal | undefined, timeoutMs: number): BoundedSignal {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  const forwardAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) forwardAbort();
  else parent?.addEventListener("abort", forwardAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", forwardAbort);
    },
  };
}

/** Cheapest curated chat model for a provider — the probe should cost nothing. */
function probeModel(provider: Provider): string | null {
  const candidates = Object.values(MODELS).filter(
    (m) => m.provider === provider && m.modality === "chat" && !m.comingSoon && m.api !== "responses"
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.cost - b.cost);
  return candidates[0].providerModel;
}

/** Issue the smallest possible completion. Resolves on success, throws on failure. */
async function probeOnce(provider: Provider, parentSignal?: AbortSignal): Promise<void> {
  const apiKey = providerApiKey(provider);
  if (!apiKey) throw Object.assign(new Error("No API key configured"), { status: 401 });

  const model = probeModel(provider);
  if (!model) throw new Error("No probe model for provider");

  const def = PROVIDERS[provider];
  const isAnthropic = def.kind === "anthropic";
  const base = (providerBaseUrl(provider) ?? "https://api.anthropic.com").replace(/\/$/, "");
  const url = isAnthropic ? `${base}/v1/messages` : `${base}/chat/completions`;
  const deadline = boundedSignal(parentSignal, PROVIDER_PROBE_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      signal: deadline.signal,
      headers: isAnthropic
        ? { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
        : { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    if (res.ok) return;

    const text = await res.text().catch(() => "");
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* a non-JSON body is fine; the raw text still classifies */
    }
    const body = parsed as { error?: { message?: string; type?: string; code?: string } } | undefined;
    throw {
      status: res.status,
      error: body?.error ?? { message: text.slice(0, 300) },
      message: `${res.status} ${text.slice(0, 300)}`,
    };
  } finally {
    deadline.cleanup();
  }
}

function record(provider: Provider, next: ProviderHealth): void {
  const previous = health.get(provider);
  health.set(provider, next);

  const transition = healthTransition(previous, next);
  if (transition === null) return;

  if (transition === "down") {
    // An account with no credit left is not mailed about, only logged.
    //
    // It is a real condition and the catalog does hide the provider, but it is
    // not an incident: nobody can act on it except by topping the account up,
    // which the person receiving the mail already knows. It also persists — a
    // dry account fails every probe for as long as it stays dry — and the mail
    // dedupe is per-process and in memory, so every deploy resets the window and
    // sends the same message again. The result was a mailbox full of "this API
    // has no credit" for a fact the owner learned the first time.
    const isFunding = next.failure === "billing";
    alertOperator({
      kind: "provider_unhealthy",
      key: provider,
      severity: isFunding ? "warn" : "critical",
      mail: !isFunding,
      title: isFunding
        ? `${PROVIDERS[provider].label} has no credit left`
        : `${PROVIDERS[provider].label} cannot serve requests`,
      detail: {
        provider,
        failure: next.failure,
        detail: next.detail,
        docs: PROVIDERS[provider].docsUrl,
        effect: "Its models are hidden from the catalog until it recovers.",
      },
    });
  } else {
    // Recovery is only news if the outage was. Pairing a "recovered" mail with a
    // "down" that was deliberately silent would reintroduce the noise from the
    // other side — and topping an account up is not something to be congratulated
    // on by email.
    const wasFunding = previous?.failure === "billing";
    alertOperator({
      kind: "provider_recovered",
      key: provider,
      severity: "warn",
      mail: !wasFunding,
      title: `${PROVIDERS[provider].label} is serving requests again`,
      detail: { provider },
    });
  }
}

async function refresh(provider: Provider, signal?: AbortSignal): Promise<void> {
  let outcome: ProbeOutcome;
  try {
    await probeOnce(provider, signal);
    outcome = { ok: true };
  } catch (err) {
    const { class: klass, status, raw } = classifyProviderError(err);
    outcome = { ok: false, class: klass, status, raw };
  }
  record(provider, nextHealthState(provider, health.get(provider), outcome, Date.now()));
}

function startRefresh(provider: Provider, signal?: AbortSignal): Promise<void> {
  const existing = inFlight.get(provider);
  if (existing) return existing;

  const run = refresh(provider, signal)
    .catch((err) => {
      console.error("[provider-health] probe failed", {
        provider,
        message: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => inFlight.delete(provider));
  inFlight.set(provider, run);
  return run;
}

/**
 * Kick off background probes for any provider whose verdict has gone stale.
 * Returns immediately — callers must never await provider I/O.
 */
export function ensureProviderHealthFresh(): void {
  const now = Date.now();
  for (const provider of configuredProviders()) {
    if (!isHealthStale(health.get(provider), now)) continue;
    startRefresh(provider);
  }
}

/**
 * Can this provider serve traffic? Cached; never performs I/O.
 *
 * Unknown counts as healthy, so the catalog is never emptied by a probe that
 * has not run yet.
 */
export function providerHealthy(provider: Provider): boolean {
  return health.get(provider)?.healthy ?? true;
}

/** Every configured provider's current verdict, for the owner diagnostic path. */
export function providerHealthSnapshot(): ProviderHealth[] {
  return configuredProviders().map(
    (provider) =>
      health.get(provider) ?? {
        provider,
        healthy: true,
        checkedAt: null,
        failure: null,
        detail: null,
      }
  );
}

/**
 * Probe everything now and wait. This is intentionally an explicit operation
 * for the owner-gated diagnostic/readiness path, not part of ordinary
 * liveness. Every provider fetch is aborted after its per-provider deadline;
 * the batch deadline also bounds a diagnostic request if a provider client
 * misbehaves.
 */
export async function probeAllProviders(options: {
  signal?: AbortSignal;
  timeoutMs?: number;
} = {}): Promise<ProviderHealth[]> {
  const deadline = boundedSignal(
    options.signal,
    options.timeoutMs ?? PROVIDER_DIAGNOSTIC_TIMEOUT_MS,
  );
  try {
    await Promise.all(configuredProviders().map((provider) => startRefresh(provider, deadline.signal)));
    return providerHealthSnapshot();
  } finally {
    deadline.cleanup();
  }
}

/** Test seam. */
export function __setProviderHealthForTests(entries: ProviderHealth[]): void {
  health.clear();
  for (const e of entries) health.set(e.provider, e);
}
