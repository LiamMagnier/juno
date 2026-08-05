import "server-only";
import { alertOperator } from "@/lib/alerts";
import { classifyProviderError, type ProviderErrorClass } from "@/lib/provider-error";
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
 */

export interface ProviderHealth {
  provider: Provider;
  healthy: boolean;
  /** Epoch ms of the last completed probe; null when never probed. */
  checkedAt: number | null;
  /** Why it is down, when it is down. */
  failure: ProviderErrorClass | null;
  detail: string | null;
}

const HEALTHY_TTL = 10 * 60 * 1000;
/**
 * Back off harder on a provider already known to be down. Several providers
 * meter free tiers by request count rather than tokens, and re-probing 14
 * providers every 10 minutes is ~2k requests/day per instance.
 */
const UNHEALTHY_TTL = 30 * 60 * 1000;
const PROBE_TIMEOUT_MS = 8_000;

const health = new Map<Provider, ProviderHealth>();
const inFlight = new Map<Provider, Promise<void>>();

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
async function probeOnce(provider: Provider): Promise<void> {
  const apiKey = providerApiKey(provider);
  if (!apiKey) throw Object.assign(new Error("No API key configured"), { status: 401 });

  const model = probeModel(provider);
  if (!model) throw new Error("No probe model for provider");

  const def = PROVIDERS[provider];
  const isAnthropic = def.kind === "anthropic";
  const base = (providerBaseUrl(provider) ?? "https://api.anthropic.com").replace(/\/$/, "");
  const url = isAnthropic ? `${base}/v1/messages` : `${base}/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
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
}

function record(provider: Provider, next: ProviderHealth): void {
  const previous = health.get(provider);
  health.set(provider, next);

  if (previous?.healthy === next.healthy) return;
  // First observation of a healthy provider is not news.
  if (previous === undefined && next.healthy) return;

  if (!next.healthy) {
    alertOperator({
      kind: "provider_unhealthy",
      key: provider,
      severity: "critical",
      title: `${PROVIDERS[provider].label} cannot serve requests`,
      detail: {
        provider,
        failure: next.failure,
        detail: next.detail,
        docs: PROVIDERS[provider].docsUrl,
        effect: "Its models are hidden from the catalog until it recovers.",
      },
    });
  } else {
    alertOperator({
      kind: "provider_recovered",
      key: provider,
      severity: "warn",
      title: `${PROVIDERS[provider].label} is serving requests again`,
      detail: { provider },
    });
  }
}

async function refresh(provider: Provider): Promise<void> {
  try {
    await probeOnce(provider);
    record(provider, { provider, healthy: true, checkedAt: Date.now(), failure: null, detail: null });
  } catch (err) {
    const { class: klass, status, raw } = classifyProviderError(err);
    const accountFault = klass === "auth" || klass === "billing";
    const previous = health.get(provider);

    if (!accountFault) {
      // Busy, overloaded, timed out, or a model-specific problem. Not evidence
      // about the key — keep the previous verdict but move the clock on so a
      // flapping provider is not re-probed on every single request.
      record(provider, {
        provider,
        healthy: previous?.healthy ?? true,
        checkedAt: Date.now(),
        failure: previous?.failure ?? null,
        detail: previous?.detail ?? null,
      });
      return;
    }

    record(provider, {
      provider,
      healthy: false,
      checkedAt: Date.now(),
      failure: klass,
      detail: `${status !== null ? `${status} ` : ""}${raw}`.slice(0, 300),
    });
  }
}

function isStale(entry: ProviderHealth | undefined, now: number): boolean {
  if (!entry || entry.checkedAt === null) return true;
  return now - entry.checkedAt > (entry.healthy ? HEALTHY_TTL : UNHEALTHY_TTL);
}

/**
 * Kick off background probes for any provider whose verdict has gone stale.
 * Returns immediately — callers must never await provider I/O.
 */
export function ensureProviderHealthFresh(): void {
  const now = Date.now();
  for (const provider of configuredProviders()) {
    if (!isStale(health.get(provider), now)) continue;
    if (inFlight.has(provider)) continue;
    const run = refresh(provider)
      .catch((err) => {
        console.error("[provider-health] probe failed", {
          provider,
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => inFlight.delete(provider));
    inFlight.set(provider, run);
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

/** Every configured provider's current verdict, for /api/health. */
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

/** Probe everything now and wait. For /api/health?probe=1 and for tests. */
export async function probeAllProviders(): Promise<ProviderHealth[]> {
  await Promise.all(configuredProviders().map((p) => refresh(p)));
  return providerHealthSnapshot();
}

/** Test seam. */
export function __setProviderHealthForTests(entries: ProviderHealth[]): void {
  health.clear();
  for (const e of entries) health.set(e.provider, e);
}
