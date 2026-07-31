import type { ProviderErrorClass } from "@/lib/provider-error";
import type { Provider } from "@/lib/providers";

/**
 * The decision rules behind the provider health probe, kept separate from the
 * probe itself so they are unit testable — src/lib/provider-health.ts is
 * `server-only` and cannot be loaded under `tsx --test`.
 */

export interface ProviderHealthState {
  provider: Provider;
  healthy: boolean;
  /** Epoch ms of the last completed probe; null when never probed. */
  checkedAt: number | null;
  failure: ProviderErrorClass | null;
  detail: string | null;
}

export const HEALTHY_TTL_MS = 10 * 60 * 1000;
/**
 * Back off harder on a provider already known to be down. Several providers
 * meter their free tiers by request count rather than tokens, and re-probing
 * 14 providers every 10 minutes is ~2k requests/day per instance.
 */
export const UNHEALTHY_TTL_MS = 30 * 60 * 1000;

export function isHealthStale(entry: ProviderHealthState | undefined, now: number): boolean {
  if (!entry || entry.checkedAt === null) return true;
  return now - entry.checkedAt > (entry.healthy ? HEALTHY_TTL_MS : UNHEALTHY_TTL_MS);
}

/**
 * Only the classes an operator must personally fix count as "down".
 *
 * A 429 or a 503 is ordinary provider weather. Treating those as unhealthy
 * would pull models out of the picker every time a provider had a busy minute,
 * so the catalog would flap under exactly the load where it matters most.
 */
export function isAccountFault(klass: ProviderErrorClass): boolean {
  return klass === "auth" || klass === "billing";
}

export type ProbeOutcome =
  | { ok: true }
  | { ok: false; class: ProviderErrorClass; status: number | null; raw: string };

/**
 * Fold a probe result into the next state.
 *
 * A non-account failure does not change the verdict, but *does* move the clock
 * on — otherwise a provider that reliably times out would be re-probed on
 * every single request.
 */
export function nextHealthState(
  provider: Provider,
  previous: ProviderHealthState | undefined,
  outcome: ProbeOutcome,
  now: number
): ProviderHealthState {
  if (outcome.ok) {
    return { provider, healthy: true, checkedAt: now, failure: null, detail: null };
  }

  if (!isAccountFault(outcome.class)) {
    return {
      provider,
      // Unknown stays healthy: the catalog may only shrink on positive evidence.
      healthy: previous?.healthy ?? true,
      checkedAt: now,
      failure: previous?.failure ?? null,
      detail: previous?.detail ?? null,
    };
  }

  return {
    provider,
    healthy: false,
    checkedAt: now,
    failure: outcome.class,
    detail: `${outcome.status !== null ? `${outcome.status} ` : ""}${outcome.raw}`.slice(0, 300),
  };
}

/** Did this transition cross a boundary worth alerting an operator about? */
export function healthTransition(
  previous: ProviderHealthState | undefined,
  next: ProviderHealthState
): "down" | "recovered" | null {
  if (previous?.healthy === next.healthy) return null;
  // The first sighting of a working provider is not news.
  if (previous === undefined && next.healthy) return null;
  return next.healthy ? "recovered" : "down";
}
