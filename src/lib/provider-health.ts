import "server-only";
import { alertOperator } from "@/lib/alerts";
import { classifyProviderError } from "@/lib/provider-error";
import {
  defaultModelProviders,
  healthTransition,
  isHealthStale,
  liveFaultTunables,
  liveFaultVerdict,
  nextHealthState,
  seedSuspects,
  seededState,
  type LiveFault,
  type OutcomeRow,
  type ProbeOutcome,
  type ProviderHealthState,
} from "@/lib/provider-health-policy";
import { DEFAULT_MODEL, FREE_DEFAULT_MODEL, MODELS, type ModelInfo } from "@/lib/models";
import { probeRequestFor } from "@/lib/model-capability-probe";
import {
  PROVIDERS,
  PROVIDER_LIST,
  configuredProviders,
  providerApiKey,
  type Provider,
} from "@/lib/providers";

/**
 * Is each provider's API key actually *usable*?
 *
 * `isProviderConfigured` only asks whether an env var is non-empty, and that is
 * what the model catalog was gated on. So a revoked or unfunded key kept every
 * one of its models in the picker, and users picked models that could not
 * answer. Worse, `fetchProviderModels` (the since-removed model discovery) made an
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
 *  - **Only account faults count, from a probe.** 429s and 5xx are normal
 *    provider weather; treating them as unhealthy would make the model picker
 *    flap during an ordinary overload. Only auth/billing — the classes an
 *    operator must fix — mark a provider down on a probe.
 *  - **Real turns are evidence too** (`noteLiveProviderFault`). A chat, private
 *    chat, Work or background turn that fails on the lab's account marks it
 *    down at once, and server errors that repeat on real traffic hold it down
 *    until the next probe. The probe still owns recovery.
 *
 * State is per-process and in memory. A restart seeds it from recent failed
 * turns in RoutingOutcome (`seedProviderHealthFromOutcomes`, called at boot),
 * so a deploy does not forget a lab that is down. Known limit: a fault seen
 * by the Work runner or a sweeper lives in that process only; the web process
 * learns of it from its own next turn or probe.
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
function probeModel(provider: Provider): ModelInfo | null {
  const candidates = Object.values(MODELS).filter(
    (m) => m.provider === provider && m.modality === "chat" && !m.comingSoon
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.cost - b.cost);
  return candidates[0];
}

/** Issue the smallest possible completion. Resolves on success, throws on failure. */
async function probeOnce(provider: Provider, parentSignal?: AbortSignal): Promise<void> {
  const apiKey = providerApiKey(provider);
  if (!apiKey) throw Object.assign(new Error("No API key configured"), { status: 401 });

  const model = probeModel(provider);
  if (!model) throw new Error("No probe model for provider");

  // The SAME request builder the capability probe uses, so "is this lab
  // answering?" is asked on the transport that will actually serve traffic.
  // Google was asked on the OpenAI-compat shim while every Gemini chat goes to
  // the native GenerateContent surface, so a shim-only fault could mark a
  // perfectly healthy lab down — and a shim-only recovery could mark a broken
  // one up.
  const request = probeRequestFor(model, apiKey);
  if (!request) throw new Error("No probe endpoint for provider");
  const deadline = boundedSignal(parentSignal, PROVIDER_PROBE_TIMEOUT_MS);

  try {
    const res = await fetch(request.url, {
      method: "POST",
      signal: deadline.signal,
      headers: request.headers,
      body: JSON.stringify(request.body),
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

/** Recent server errors per lab from real turns, for the repeated-capacity rule. */
const capacityFaults = new Map<Provider, number[]>();

/**
 * The labs whose fault is an incident: every account that never chose a model
 * starts on DEFAULT_MODEL (paid) or FREE_DEFAULT_MODEL (Free), so when one of
 * these labs is down, untouched accounts are failing.
 */
const DEFAULT_LABS = defaultModelProviders([DEFAULT_MODEL, FREE_DEFAULT_MODEL]);

function record(provider: Provider, next: ProviderHealth): void {
  const previous = health.get(provider);
  health.set(provider, next);

  const transition = healthTransition(previous, next);
  if (transition === null) return;

  if (transition === "down") {
    // Mailed only when the lab serves a default model.
    //
    // Any other lab out of credit is logged, not mailed: nobody can act on it
    // except by topping the account up, it persists for as long as the account
    // stays dry, and the old per-process dedupe mailed the same fact after
    // every deploy. A default lab is different. On 2026-10-26 the paid
    // default's lab ran out of credit and nothing told anyone: every account
    // that never chose a model was failing, and only the deploy smoke noticed.
    // The mail is still deduplicated (alerts.ts: one per kind:key per hour per
    // process), and a restart does not repeat it — the boot seed never alerts.
    const isFunding = next.failure === "billing";
    const servesDefault = DEFAULT_LABS.has(provider);
    const label = PROVIDERS[provider].label;
    alertOperator({
      kind: "provider_unhealthy",
      key: provider,
      severity: isFunding && !servesDefault ? "warn" : "critical",
      mail: servesDefault,
      title: servesDefault
        ? `${label} is down and serves the default model: accounts that never chose a model are failing`
        : isFunding
          ? `${label} has no credit left`
          : `${label} cannot serve requests`,
      detail: {
        provider,
        failure: next.failure,
        detail: next.detail,
        source: next.source ?? "probe",
        defaultModels: servesDefault ? [DEFAULT_MODEL, FREE_DEFAULT_MODEL].filter((id) => id.startsWith(`${provider}:`)) : [],
        docs: PROVIDERS[provider].docsUrl,
        effect:
          "Its models stay listed but are marked unavailable. Chat's Auto and the background utility jobs (titles, memory, follow-ups) avoid it, a new web chat whose default it serves starts on Auto, and a turn that explicitly chose it fails with a neutral message (the web and Mac error cards offer one other model as a one-click choice). The probe marks it healthy again.",
      },
    });
  } else {
    alertOperator({
      kind: "provider_recovered",
      key: provider,
      severity: "warn",
      mail: false,
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
  record(provider, nextHealthState(provider, health.get(provider), outcome, Date.now(), liveFaultTunables().recheckMs));
}

/** Where a live fault was seen, for the log and the alert. */
export type LiveFaultSource = "chat" | "private_chat" | "work" | "background";

function isKnownProvider(value: string): value is Provider {
  return (PROVIDER_LIST as string[]).includes(value);
}

/**
 * A real turn failed at the provider: fold it into health now.
 *
 * Takes the error itself (classified here, with the chat classifier) or an
 * already-classified fault (the Work runtime classifies on its own, see
 * `classForWorkFailure`). Never throws and never does I/O beyond the alert it
 * may raise: it runs inside a turn's error path.
 *
 * The rules are `liveFaultVerdict`'s: an account fault with an HTTP status
 * marks the lab down at once; server errors count only when they repeat;
 * nothing here marks a lab healthy. The next turn — and Auto — then sees the
 * lab as down within the same process, instead of after the next catalog
 * load's probe.
 */
export function noteLiveProviderFault(provider: string, fault: unknown, source: LiveFaultSource): void {
  try {
    if (!isKnownProvider(provider)) return;
    const classified: LiveFault =
      fault && typeof fault === "object" && "class" in fault && typeof (fault as LiveFault).class === "string" && "raw" in fault
        ? (fault as LiveFault)
        : classifyProviderError(fault);
    const now = Date.now();
    const verdict = liveFaultVerdict({
      provider,
      previous: health.get(provider),
      fault: classified,
      recentCapacity: capacityFaults.get(provider) ?? [],
      now,
      tunables: liveFaultTunables(),
    });
    if (verdict.recentCapacity.length > 0) capacityFaults.set(provider, verdict.recentCapacity);
    else capacityFaults.delete(provider);
    if (!verdict.next) return;
    console.warn(
      `[provider-health] live ${source} fault marks ${provider} down: ${verdict.next.failure ?? "unknown"} ${verdict.next.detail ?? ""}`.slice(0, 500),
    );
    record(provider, verdict.next);
  } catch (err) {
    // Health bookkeeping must never be the reason a turn's error path fails.
    console.error("[provider-health] live fault not recorded", {
      provider,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * At boot: hold down the labs that were failing just before this process
 * started, and probe them now.
 *
 * Reads RoutingOutcome (content-free; written for failed saved-chat turns
 * too) for the last `PROVIDER_HEALTH_SEED_WINDOW_MINUTES`. A suspect is held
 * down only until its probe answers, and a seed never alerts, so a deploy
 * during an outage neither forgets the lab nor mails about it a second time.
 * Never throws; returns the providers it seeded.
 */
export async function seedProviderHealthFromOutcomes(now: number = Date.now()): Promise<Provider[]> {
  try {
    const tunables = liveFaultTunables();
    const { prisma } = await import("@/lib/prisma");
    const rows: OutcomeRow[] = await prisma.routingOutcome.findMany({
      where: { createdAt: { gte: new Date(now - tunables.seedWindowMs) } },
      select: { provider: true, completionState: true, finishReason: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 2_000,
    });
    const configured = new Set(configuredProviders());
    const seeded: Provider[] = [];
    for (const suspect of seedSuspects(rows, now, tunables)) {
      const provider = suspect.provider;
      if (!isKnownProvider(provider) || !configured.has(provider)) continue;
      // A verdict this process already holds (a probe that beat the seed) wins.
      if (health.has(provider)) continue;
      record(provider, seededState(provider, suspect, now));
      seeded.push(provider);
      void startRefresh(provider);
    }
    if (seeded.length > 0) {
      console.warn(`[provider-health] seeded from recent failed turns, probing now: ${seeded.join(", ")}`);
    }
    return seeded;
  } catch (err) {
    console.error("[provider-health] boot seed skipped", {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
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
  capacityFaults.clear();
  for (const e of entries) health.set(e.provider, e);
}
