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
  /**
   * What wrote this verdict. Absent reads as "probe", which is every state
   * written before real turns fed health.
   *
   *  - `probe`: the 1-token completion in provider-health.ts.
   *  - `live`: a real turn (chat, private chat, Work, a background job) failed
   *    on the lab's account, or kept meeting its server errors.
   *  - `seed`: a restarted process read recent failed turns from
   *    RoutingOutcome and is holding the lab down until a probe confirms or
   *    clears it. A suspicion, never a verdict: it never alerts.
   */
  source?: "probe" | "live" | "seed";
  /**
   * Epoch ms after which the probe looks again, sooner than the TTL would.
   * Set on verdicts a probe has not confirmed (a live fault) and on a lab held
   * down for server errors, which usually clear in minutes. Absent or null:
   * the TTLs alone decide.
   */
  recheckAt?: number | null;
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
  if (typeof entry.recheckAt === "number" && now >= entry.recheckAt) return true;
  return now - entry.checkedAt > (entry.healthy ? HEALTHY_TTL_MS : UNHEALTHY_TTL_MS);
}

/**
 * The owner-tunable numbers behind live faults and the boot seed. Every one is
 * read from the environment with a conservative default and a clamp, so a typo
 * cannot make one 5xx take a lab out of the catalog. Listed in
 * docs/OPEN_DECISIONS.md ("Provider health from live turns") as owner to
 * confirm.
 */
export interface LiveFaultTunables {
  /** Server errors (class `capacity`) from real turns that mark a lab down. Never fewer than 2. */
  capacityFaults: number;
  /** …within this many ms. */
  capacityWindowMs: number;
  /** How soon the probe looks again at a lab a live turn marked down. */
  recheckMs: number;
  /** How far back a restarted process reads RoutingOutcome for a lab that was failing. */
  seedWindowMs: number;
  /** Consecutive failed turns, with no answer since, that make a lab a suspect at boot. */
  seedMinFailures: number;
}

export const DEFAULT_LIVE_FAULT_TUNABLES: LiveFaultTunables = {
  capacityFaults: 3,
  capacityWindowMs: 120_000,
  recheckMs: 120_000,
  seedWindowMs: 15 * 60_000,
  seedMinFailures: 3,
};

function envInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function liveFaultTunables(env: Record<string, string | undefined> = process.env): LiveFaultTunables {
  const d = DEFAULT_LIVE_FAULT_TUNABLES;
  return {
    capacityFaults: envInt(env, "PROVIDER_CAPACITY_FAULTS_TO_MARK_DOWN", d.capacityFaults, 2, 50),
    capacityWindowMs: envInt(env, "PROVIDER_CAPACITY_FAULT_WINDOW_SECONDS", d.capacityWindowMs / 1000, 10, 3600) * 1000,
    recheckMs: envInt(env, "PROVIDER_LIVE_FAULT_RECHECK_SECONDS", d.recheckMs / 1000, 30, 1800) * 1000,
    seedWindowMs: envInt(env, "PROVIDER_HEALTH_SEED_WINDOW_MINUTES", d.seedWindowMs / 60_000, 1, 120) * 60_000,
    seedMinFailures: envInt(env, "PROVIDER_HEALTH_SEED_MIN_FAILURES", d.seedMinFailures, 1, 50),
  };
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
 * every single request. Two exceptions, both about verdicts no probe made:
 *
 *  - a boot seed is a suspicion, so a probe that finds no account fault clears
 *    it (fail open, as for any lab nothing has been proven about);
 *  - a lab held down for server errors stays down while the probe still meets
 *    trouble, and is looked at again after `recheckMs` rather than 30 minutes,
 *    because that weather usually clears in minutes.
 */
export function nextHealthState(
  provider: Provider,
  previous: ProviderHealthState | undefined,
  outcome: ProbeOutcome,
  now: number,
  recheckMs: number = DEFAULT_LIVE_FAULT_TUNABLES.recheckMs
): ProviderHealthState {
  if (outcome.ok) {
    return { provider, healthy: true, checkedAt: now, failure: null, detail: null, source: "probe", recheckAt: null };
  }

  if (!isAccountFault(outcome.class)) {
    if (previous?.source === "seed") {
      return { provider, healthy: true, checkedAt: now, failure: null, detail: null, source: "probe", recheckAt: null };
    }
    if (previous && !previous.healthy && previous.failure === "capacity") {
      return { ...previous, checkedAt: now, source: "probe", recheckAt: now + recheckMs };
    }
    // A live fault the probe could not confirm either way (it timed out, or
    // met a rate limit) stays unconfirmed and keeps its short recheck;
    // anything else waits out the TTL.
    const unconfirmedLive = previous?.source === "live" && previous.healthy === false;
    return {
      provider,
      // Unknown stays healthy: the catalog may only shrink on positive evidence.
      healthy: previous?.healthy ?? true,
      checkedAt: now,
      failure: previous?.failure ?? null,
      detail: previous?.detail ?? null,
      source: unconfirmedLive ? "live" : "probe",
      recheckAt: unconfirmedLive ? now + recheckMs : null,
    };
  }

  return {
    provider,
    healthy: false,
    checkedAt: now,
    failure: outcome.class,
    detail: `${outcome.status !== null ? `${outcome.status} ` : ""}${outcome.raw}`.slice(0, 300),
    source: "probe",
    recheckAt: null,
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
  // A boot seed that a probe cleared never was down, as far as anyone knows,
  // and one that is written is not news either (the process before this one
  // alerted when the lab went down; a deploy must not repeat it).
  if (previous?.source === "seed" || next.source === "seed") return null;
  return next.healthy ? "recovered" : "down";
}

// ---------------------------------------------------------------------------
// Live faults: real turns feed health
// ---------------------------------------------------------------------------

/** A provider failure from a real turn, already classified. */
export interface LiveFault {
  class: ProviderErrorClass;
  status: number | null;
  raw: string;
}

export interface LiveFaultVerdict {
  /** The state to record, or null to leave the verdict alone. */
  next: ProviderHealthState | null;
  /** The lab's recent server-error timestamps, to keep for the next fault. */
  recentCapacity: number[];
}

/**
 * Fold a real turn's provider failure into health.
 *
 * Before this, health changed only through a probe that ran when someone
 * loaded the model catalog, and a healthy verdict was trusted for 10 minutes:
 * on 2026-10-26 every paid account's default lab ran out of credit and the
 * next turn, and the one after, and Auto, all went to it again. A live turn is
 * better evidence than a probe, and it arrives first.
 *
 *  - An account fault (auth, billing) marks the lab down at once, with a short
 *    recheck so a probe confirms or clears it. Only with an HTTP status: an
 *    error with none (a tool failure, an internal error that reached the same
 *    catch) proves nothing about the lab's account.
 *  - Server errors (`capacity`) count only when they repeat: `capacityFaults`
 *    within `capacityWindowMs`. One 503 is weather; three in two minutes on
 *    real traffic is an outage, and it is held only until the next probe.
 *  - Everything else (rate limits, which provider-pressure already weighs per
 *    lab, and request-level failures) leaves health alone.
 *
 * The probe still owns recovery: nothing here ever marks a lab healthy.
 */
export function liveFaultVerdict(input: {
  provider: Provider;
  previous: ProviderHealthState | undefined;
  fault: LiveFault;
  recentCapacity: readonly number[];
  now: number;
  tunables?: LiveFaultTunables;
}): LiveFaultVerdict {
  const t = input.tunables ?? DEFAULT_LIVE_FAULT_TUNABLES;
  const { provider, previous, fault, now } = input;
  const recent = input.recentCapacity.filter((at) => now - at < t.capacityWindowMs);

  if (fault.status === null) return { next: null, recentCapacity: recent };

  if (isAccountFault(fault.class)) {
    // Already known down for the same reason: nothing new to record, and
    // re-recording would push a confirmed verdict back to unconfirmed.
    if (previous && !previous.healthy && previous.failure === fault.class && previous.source !== "seed") {
      return { next: null, recentCapacity: recent };
    }
    const probeShaped = nextHealthState(provider, previous, { ok: false, ...fault }, now, t.recheckMs);
    return {
      next: { ...probeShaped, source: "live", recheckAt: now + t.recheckMs },
      recentCapacity: recent,
    };
  }

  if (fault.class === "capacity") {
    const window = [...recent, now];
    if (previous && !previous.healthy && previous.source !== "seed") {
      // Already down (for this or a worse reason): keep counting, change nothing.
      return { next: null, recentCapacity: window };
    }
    if (window.length < t.capacityFaults) return { next: null, recentCapacity: window };
    return {
      next: {
        provider,
        healthy: false,
        checkedAt: now,
        failure: "capacity",
        detail: `${window.length} server errors from live turns within ${Math.round(t.capacityWindowMs / 1000)}s; last: ${
          fault.status
        } ${fault.raw}`.slice(0, 300),
        source: "live",
        recheckAt: now + t.recheckMs,
      },
      recentCapacity: [],
    };
  }

  return { next: null, recentCapacity: recent };
}

/**
 * The Work runtime's failure kinds (runner/agent-core/src/providers/errors.ts,
 * `ProviderFailureKind`) in this module's classes, for the live-fault feed.
 *
 * Deliberately narrower than the chat classifier: `forbidden` (403) can be one
 * model this key may not use rather than the account, and `plan_limit` is
 * Juno's own wall, so neither says anything about the lab. Null: do not feed.
 */
export function classForWorkFailure(kind: string, status: number | null): ProviderErrorClass | null {
  switch (kind) {
    case "auth":
      return "auth";
    case "insufficient_balance":
      return "billing";
    case "overloaded":
      return "capacity";
    case "transient":
      return status !== null && status >= 500 ? "capacity" : null;
    case "rate_limit":
      return "rate_limit";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The boot seed: a restart must not forget a lab that is down
// ---------------------------------------------------------------------------

/** The RoutingOutcome columns the seed reads. Content-free by the table's own policy. */
export interface OutcomeRow {
  provider: string;
  completionState: string;
  finishReason: string | null;
  createdAt: Date | number;
}

/**
 * Labs a restarted process should hold down until a probe has looked.
 *
 * Health is in memory and per process, and unknown counts as healthy, so every
 * deploy used to forget a lab that was down until the next catalog load probed
 * it. RoutingOutcome is the one durable, cross-process record of how real turns
 * ended, written for failed turns too. It does not record the provider error's
 * class, so the seed cannot tell an unfunded account from a burst of errors:
 * that is why a seed is a suspicion (`source: "seed"`, never alerted) that the
 * first probe confirms or clears.
 *
 * A lab is a suspect when its newest turns in the window are at least
 * `seedMinFailures` failures (`completionState` failed, finish reason `error`)
 * with no answered turn after them. A Stop says nothing about the lab and is
 * skipped over; any completed or partial answer ends the count.
 */
export function seedSuspects(
  rows: readonly OutcomeRow[],
  now: number,
  tunables: LiveFaultTunables = DEFAULT_LIVE_FAULT_TUNABLES,
): Array<{ provider: string; failures: number; since: number }> {
  const byProvider = new Map<string, OutcomeRow[]>();
  for (const row of rows) {
    const at = typeof row.createdAt === "number" ? row.createdAt : row.createdAt.getTime();
    if (now - at > tunables.seedWindowMs || at > now) continue;
    const list = byProvider.get(row.provider) ?? [];
    list.push(row);
    byProvider.set(row.provider, list);
  }
  const suspects: Array<{ provider: string; failures: number; since: number }> = [];
  for (const [provider, list] of byProvider) {
    const newestFirst = [...list].sort((a, b) => time(b) - time(a));
    let failures = 0;
    let since = now;
    for (const row of newestFirst) {
      if (row.completionState === "stopped") continue;
      if (row.completionState === "failed" && row.finishReason === "error") {
        failures += 1;
        since = time(row);
        continue;
      }
      break;
    }
    if (failures >= tunables.seedMinFailures) suspects.push({ provider, failures, since });
  }
  return suspects.sort((a, b) => a.provider.localeCompare(b.provider));
}

function time(row: OutcomeRow): number {
  return typeof row.createdAt === "number" ? row.createdAt : row.createdAt.getTime();
}

/** The state a suspect is held in until its first probe. */
export function seededState(
  provider: Provider,
  suspect: { failures: number; since: number },
  now: number,
): ProviderHealthState {
  const minutes = Math.max(1, Math.round((now - suspect.since) / 60_000));
  return {
    provider,
    healthy: false,
    // Never probed by this process, so stale at once: the first
    // ensureProviderHealthFresh() probes it.
    checkedAt: null,
    failure: null,
    detail: `${suspect.failures} turns failed in the ${minutes} minute(s) before this process started, with no answer since; held until a probe confirms.`,
    source: "seed",
    recheckAt: null,
  };
}

/**
 * The labs whose fault means every untouched account is failing: the ones
 * serving DEFAULT_MODEL (paid) and FREE_DEFAULT_MODEL (Free). Taking the ids
 * rather than importing them keeps this module free of the model registry.
 */
export function defaultModelProviders(modelIds: readonly string[]): Set<string> {
  const providers = new Set<string>();
  for (const id of modelIds) {
    const separator = id.indexOf(":");
    if (separator > 0) providers.add(id.slice(0, separator));
  }
  return providers;
}
