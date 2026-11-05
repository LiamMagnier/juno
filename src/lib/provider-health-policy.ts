import { isBareForbidden, type ProviderErrorClass } from "@/lib/provider-error";
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
  /**
   * Probes in a row that could neither confirm nor clear a verdict (a
   * timeout, a rate limit, a server error on an account fault). A live
   * verdict rests on real turns alone, so it is held through one such probe
   * and released at the next; a confirmed hold for server errors is held
   * through one probe that times out and released at the second. Unknown
   * stays healthy (`MAX_INCONCLUSIVE_LIVE_PROBES`). Absent reads as 0.
   */
  inconclusiveProbes?: number;
}

/**
 * How many inconclusive probes in a row a verdict no probe can currently
 * back survives: an unconfirmed live verdict, and a confirmed hold for server
 * errors whose probe now times out. One: the lab is held for at most two
 * recheck periods (four minutes by default) on that evidence, then fails
 * open; a real fault marks it down again on the next turns that meet it.
 * Without the cap a lab whose cheap probe model is slow, or whose probe path
 * differs from chat's, stayed out of Auto and the pickers for as long as its
 * probe kept timing out.
 */
export const MAX_INCONCLUSIVE_LIVE_PROBES = 1;

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
  /**
   * Distinct sources (`liveFaultOrigin`: person or Work run, and model) whose
   * real turns met server errors (class `capacity`) that mark a lab down.
   * Never fewer than 2.
   */
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
 * every single request. The exceptions are all about verdicts no probe made,
 * or a hold for server errors:
 *
 *  - a boot seed is a suspicion, so a probe that finds no account fault clears
 *    it (fail open, as for any lab nothing has been proven about);
 *  - a live hold for server errors is confirmed only by a probe that meets a
 *    server error itself (`capacity`). A timeout or a rate limit proves
 *    nothing about the lab's servers, so it is inconclusive;
 *  - an unconfirmed live verdict whose probe is inconclusive is held through
 *    one such probe, with the short recheck, and released at the next
 *    (`MAX_INCONCLUSIVE_LIVE_PROBES`): it rests on real turns alone, and
 *    unknown stays healthy;
 *  - a confirmed hold for server errors stays down while the probe still
 *    meets a server error, and is looked at again after `recheckMs` rather
 *    than 30 minutes, because that weather usually clears in minutes. A probe
 *    that gets no answer holds it once and releases it at the second in a row
 *    (`MAX_INCONCLUSIVE_LIVE_PROBES`); a probe the lab answers, even with a
 *    rate limit, clears it.
 */
export function nextHealthState(
  provider: Provider,
  previous: ProviderHealthState | undefined,
  outcome: ProbeOutcome,
  now: number,
  recheckMs: number = DEFAULT_LIVE_FAULT_TUNABLES.recheckMs
): ProviderHealthState {
  const cleared: ProviderHealthState = {
    provider,
    healthy: true,
    checkedAt: now,
    failure: null,
    detail: null,
    source: "probe",
    recheckAt: null,
  };
  if (outcome.ok) return cleared;

  if (!isAccountFault(outcome.class)) {
    if (previous?.source === "seed") return cleared;

    if (previous?.source === "live" && !previous.healthy) {
      if (previous.failure === "capacity" && outcome.class === "capacity") {
        // The probe met a server error too: the hold is confirmed.
        return { ...previous, checkedAt: now, source: "probe", recheckAt: now + recheckMs, inconclusiveProbes: 0 };
      }
      const inconclusive = (previous.inconclusiveProbes ?? 0) + 1;
      if (inconclusive > MAX_INCONCLUSIVE_LIVE_PROBES) return cleared;
      return { ...previous, checkedAt: now, source: "live", recheckAt: now + recheckMs, inconclusiveProbes: inconclusive };
    }

    if (previous && !previous.healthy && previous.failure === "capacity") {
      if (outcome.class === "capacity") {
        return { ...previous, checkedAt: now, source: "probe", recheckAt: now + recheckMs, inconclusiveProbes: 0 };
      }
      if (outcome.class === "network") {
        // No answer at all: the hold stands once, and is released at the
        // second timeout in a row (`MAX_INCONCLUSIVE_LIVE_PROBES`).
        const inconclusive = (previous.inconclusiveProbes ?? 0) + 1;
        if (inconclusive > MAX_INCONCLUSIVE_LIVE_PROBES) return cleared;
        return { ...previous, checkedAt: now, source: "probe", recheckAt: now + recheckMs, inconclusiveProbes: inconclusive };
      }
      return cleared;
    }

    return {
      provider,
      // Unknown stays healthy: the catalog may only shrink on positive evidence.
      healthy: previous?.healthy ?? true,
      checkedAt: now,
      failure: previous?.failure ?? null,
      detail: previous?.detail ?? null,
      source: "probe",
      recheckAt: null,
    };
  }

  return {
    provider,
    healthy: false,
    checkedAt: now,
    failure: outcome.class,
    detail: scrubHealthDetail(`${outcome.status !== null ? `${outcome.status} ` : ""}${outcome.raw}`),
    source: "probe",
    recheckAt: null,
  };
}

/**
 * A provider's error text, fit for a health verdict that is logged, alerted
 * and served by the owner diagnostic: bounded to 300 characters, and with
 * anything shaped like a credential replaced. A 401 body can echo the key it
 * refused (OpenAI's "Incorrect API key provided: sk-proj-****abcd" names its
 * tail), and a verdict now comes from live turns as well as the probe.
 */
export function scrubHealthDetail(text: string): string {
  return text
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_*.-]{4,}/g, "[redacted key]")
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, "[redacted key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .slice(0, 300);
}

/**
 * Did this transition cross a boundary worth alerting an operator about?
 *
 * A live verdict (`source: "live"`) changes routing at once but is not news
 * on its own: it rests on real turns' errors, which can concern one model or
 * one request rather than the lab. The probe confirms it (provider-health.ts
 * starts one at once for an account fault, and at the recheck for server
 * errors): a probe that agrees is the moment the lab is news, and one that
 * clears it means it never was.
 *
 * This decides the alert LINE. Whether a default lab's alert is also MAILED
 * is `outageMailDue`'s, which compares with what the operator was last told
 * rather than with the previous verdict.
 */
export function healthTransition(
  previous: ProviderHealthState | undefined,
  next: ProviderHealthState
): "down" | "recovered" | null {
  if (next.source === "live") return null;
  if (previous?.source === "live" && !previous.healthy) return next.healthy ? null : "down";
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
// Operator mail for a lab that serves a default model
// ---------------------------------------------------------------------------

/**
 * What the mailing process last told the operator about a default lab: that
 * it is down, or that it is serving again. Absent: nothing told yet, or the
 * last all-clear was muted.
 */
export type OutageMailTold = "down" | "recovered";

/** What became of an alert's mail (src/lib/alerts.ts, `alertOperator`). */
export type OutageMailOutcome = "queued" | "deduped" | "muted" | "log_only";

export type OutageMailDecision =
  | { mail: null; adopt?: "down" }
  | { mail: "down"; bypassDedupe: boolean }
  | { mail: "recovered" };

/**
 * Should a default lab's state be mailed now? Compared with what the
 * operator was last TOLD, not with the previous verdict, so the last mail
 * they read stays true:
 *
 *  - a probe-made or probe-confirmed outage is mailed unless the last mail
 *    already said down. Live and seeded verdicts are never mailed; a probe
 *    that confirms a boot seed counts the operator as told (the process
 *    before this one mailed it; a deploy must not repeat it);
 *  - a lab serving again is mailed only when the last mail said down. That
 *    includes a probe that clears a live verdict laid over a mailed outage,
 *    which `healthTransition` cannot see;
 *  - a down mail after a mailed all-clear bypasses the hourly dedupe in
 *    alerts.ts, which would otherwise drop it and leave "recovered" as the
 *    last word while the lab is down again. That cannot loop: the all-clear
 *    itself keeps the dedupe, so a flapping lab mails at most one all-clear,
 *    and so at most two outages, an hour.
 */
export function outageMailDue(
  told: OutageMailTold | undefined,
  previous: ProviderHealthState | undefined,
  next: ProviderHealthState,
): OutageMailDecision {
  if (next.source === "live" || next.source === "seed") return { mail: null };
  if (!next.healthy) {
    if (told === "down") return { mail: null };
    if (previous?.source === "seed") return { mail: null, adopt: "down" };
    return { mail: "down", bypassDedupe: told === "recovered" };
  }
  return told === "down" ? { mail: "recovered" } : { mail: null };
}

/**
 * What the operator has been told once a mail was attempted:
 *
 *  - a down mail: down. Queued, it says so; deduplicated, a down mail went
 *    out within the hour with no all-clear since (an all-clear makes the next
 *    down bypass the dedupe); muted, it is the operator's own choice;
 *  - an all-clear: recovered when queued. Deduplicated, the operator's last
 *    mail still says down, so it stays owed and the next probe that finds the
 *    lab serving asks again. Muted, nothing is owed and the next outage mail
 *    keeps the hourly dedupe, so muting all-clears cannot turn a flapping lab
 *    into a mail per flap.
 *
 * A recorder that returns nothing (a test stub) reads as queued.
 */
export function toldAfterMail(
  mail: "down" | "recovered",
  outcome: OutageMailOutcome | undefined | void,
  told: OutageMailTold | undefined,
): OutageMailTold | undefined {
  if (mail === "down") return "down";
  if (outcome === "deduped") return told;
  if (outcome === "muted") return undefined;
  return "recovered";
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

/**
 * One server error from a real turn, for the repeated-capacity rule: when,
 * and from which source (`liveFaultOrigin`: who met it, on which model). Kept
 * in memory for the window only, and never logged.
 */
export interface CapacityFault {
  at: number;
  origin: string;
}

/** Most server errors a lab's window keeps: enough to count distinct sources, bounded under a flood. */
const MAX_CAPACITY_WINDOW = 200;

/**
 * The source a real turn's fault is counted under: the person (or Work run)
 * and the model. Repeats from one source count once toward the
 * repeated-capacity rule, so one person pressing Try again on one model whose
 * 500 is specific to their input cannot hold every model of the lab down.
 */
export function liveFaultOrigin(requester: string | null | undefined, modelId: string): string {
  return `${requester || "unattributed"}|${modelId}`;
}

export interface LiveFaultVerdict {
  /** The state to record, or null to leave the verdict alone. */
  next: ProviderHealthState | null;
  /** The lab's recent server errors, to keep for the next fault. */
  recentCapacity: CapacityFault[];
  /**
   * Ask the probe, without changing the verdict: the fault might be the
   * lab's account but does not say so (a bare 403, `isBareForbidden`). The
   * probe asks the lab's cheapest model with the same key, and a refusal
   * there is the account's; routing changes only if it agrees.
   */
  probe?: boolean;
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
 *    catch) proves nothing about the lab's account. And not on a bare 403
 *    (`isBareForbidden`), which can be one model this key may not use: that
 *    one asks the probe (`probe: true`) and leaves routing alone unless the
 *    probe agrees, as the Work feed leaves out its `forbidden`.
 *  - Server errors (`capacity`) count only when they repeat across sources:
 *    `capacityFaults` distinct sources (`liveFaultOrigin`: person or Work run,
 *    and model) within `capacityWindowMs`. One 503 is weather, and so is one
 *    person's Try again on one model meeting the same 500 three times; three
 *    sources meeting server errors within two minutes is an outage, held
 *    only until the next probe.
 *  - Everything else (rate limits, which provider-pressure already weighs per
 *    lab, and request-level failures) leaves health alone.
 *
 * The probe still owns recovery: nothing here ever marks a lab healthy.
 */
export function liveFaultVerdict(input: {
  provider: Provider;
  previous: ProviderHealthState | undefined;
  fault: LiveFault;
  /** `liveFaultOrigin(requester, modelId)`. Absent: one shared "unattributed" source. */
  origin?: string;
  recentCapacity: readonly CapacityFault[];
  now: number;
  tunables?: LiveFaultTunables;
}): LiveFaultVerdict {
  const t = input.tunables ?? DEFAULT_LIVE_FAULT_TUNABLES;
  const { provider, previous, fault, now } = input;
  const recent = input.recentCapacity.filter((entry) => now - entry.at < t.capacityWindowMs);

  if (fault.status === null) return { next: null, recentCapacity: recent };

  if (isAccountFault(fault.class)) {
    if (isBareForbidden(fault)) {
      return { next: null, recentCapacity: recent, probe: previous?.healthy !== false };
    }
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
    const window = [...recent, { at: now, origin: input.origin ?? liveFaultOrigin(null, "") }].slice(-MAX_CAPACITY_WINDOW);
    if (previous && !previous.healthy && previous.source !== "seed") {
      // Already down (for this or a worse reason): keep counting, change nothing.
      return { next: null, recentCapacity: window };
    }
    const sources = new Set(window.map((entry) => entry.origin)).size;
    if (sources < t.capacityFaults) return { next: null, recentCapacity: window };
    return {
      next: {
        provider,
        healthy: false,
        checkedAt: now,
        failure: "capacity",
        detail: scrubHealthDetail(
          `${window.length} server errors from ${sources} live sources within ${Math.round(t.capacityWindowMs / 1000)}s; last: ${fault.status} ${fault.raw}`,
        ),
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
