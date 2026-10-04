/**
 * Recent rate-limit pressure per provider, for the router's retry estimate.
 *
 * `provider-health.ts` answers "is this provider answering at all" (auth,
 * billing, outage) and the router EXCLUDES an unhealthy provider. A 429 is a
 * different fact: the provider works, but a request sent now is likely to be
 * retried. That is a cost, not a veto, so it lands in `expectedRetries`.
 *
 * Per-process and in memory, like provider-health (see docs/OPEN_DECISIONS.md
 * "known scaling limit"). Decays: a rate limit seen ten minutes ago says little
 * about now.
 */

const DECAY_MS = 10 * 60 * 1000;
const hits = new Map<string, number[]>();

export function recordProviderRateLimit(provider: string, now = Date.now()): void {
  const list = (hits.get(provider) ?? []).filter((t) => now - t < DECAY_MS);
  list.push(now);
  hits.set(provider, list.slice(-50));
}

/**
 * Expected extra attempts for one request to this provider right now, 0–1.
 * One recent 429 → 0.15; five or more in the window → 0.6.
 */
export function providerRetryPressure(provider: string, now = Date.now()): number {
  const list = (hits.get(provider) ?? []).filter((t) => now - t < DECAY_MS);
  if (list.length === 0) return 0;
  return Math.min(0.6, 0.15 + (list.length - 1) * 0.1125);
}

/** Test seam. */
export function __resetProviderPressureForTests(): void {
  hits.clear();
}
