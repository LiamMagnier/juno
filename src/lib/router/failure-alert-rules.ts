/**
 * The chat failure-rate alert, as pure rules (no `server-only`, no Prisma):
 * which recent failures make an incident, and when the operator is mailed.
 * The watch that applies them is src/lib/router/failure-alert.ts.
 *
 * THE SOURCE IS DURABLE. Counts come from `RoutingOutcome`
 * (src/lib/router/telemetry-store.ts, `countRecentTurnOutcomes`): one
 * content-free row per saved-chat turn, failed ones included, shared by every
 * process and kept across restarts. Private chats write no row, and an ending
 * the platform caused (a drain, a lost lease, the budget guard) writes none
 * either, so neither can raise this alert.
 *
 * WHAT COUNTS AS A FAILURE. A row that ended `failed` or `partial` with the
 * finish reason `error` or `network_error`: the provider or Juno could not
 * answer. A capped answer (`length`), a safety refusal (`sensitive`) and an
 * oversize prompt are answers shaped by their content, not faults, and do not
 * count.
 *
 * THE GROUPS. One model (`model:<id>`), and one failure class across every
 * model (`class:error`, `class:network_error`). The row holds no provider
 * error class (billing, auth, rate limit), so the alert's detail adds the
 * classes this process saw itself, from its own traces.
 *
 * WHEN. A group is an incident when, within the window, it has at least
 * `threshold` failures and they are at least `minSharePercent` of its turns.
 * An incident mails once: while it lasts (seen again within one window) it
 * is not mailed again, and `alertOperator` keeps its own hourly dedupe per
 * subject on top. Every new incident found in one evaluation goes out in one
 * mail. Numbers in env, owner to confirm (docs/OPEN_DECISIONS.md).
 */

/** The `alertOperator` kind (src/lib/alerts.ts, `CHAT_FAILURE_ALERT_KIND`). */
export const CHAT_FAILURE_RATE_KIND = "chat_failure_rate";

/** Finish reasons that are faults rather than answers. */
export const FAULT_FINISH_REASONS = ["error", "network_error"] as const;
export type FaultFinishReason = (typeof FAULT_FINISH_REASONS)[number];

export interface FailureAlertTunables {
  /** `CHAT_FAILURE_ALERT=off` (or 0, false, no): the watch reads nothing and raises nothing. */
  enabled: boolean;
  /** Failures in the window that make an incident. */
  threshold: number;
  windowMs: number;
  /** The least share of a group's turns that must have failed, in percent. 0 = any. */
  minSharePercent: number;
}

export const DEFAULT_FAILURE_ALERT_TUNABLES: FailureAlertTunables = {
  enabled: true,
  threshold: 5,
  windowMs: 10 * 60_000,
  minSharePercent: 20,
};

function envInt(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * `CHAT_FAILURE_ALERT` (default on; `off`, `0`, `false` or `no` turns the
 * watch off, so it reads nothing), `CHAT_FAILURE_ALERT_THRESHOLD` (default 5, bounded 2 to 1000),
 * `CHAT_FAILURE_ALERT_WINDOW_MINUTES` (default 10, bounded 1 to 120) and
 * `CHAT_FAILURE_ALERT_MIN_SHARE_PERCENT` (default 20, bounded 0 to 100).
 */
export function failureAlertTunables(env: Record<string, string | undefined> = process.env): FailureAlertTunables {
  const d = DEFAULT_FAILURE_ALERT_TUNABLES;
  const switched = (env.CHAT_FAILURE_ALERT ?? "").trim().toLowerCase();
  return {
    enabled: !["off", "0", "false", "no"].includes(switched),
    threshold: envInt(env, "CHAT_FAILURE_ALERT_THRESHOLD", d.threshold, 2, 1000),
    windowMs: envInt(env, "CHAT_FAILURE_ALERT_WINDOW_MINUTES", d.windowMs / 60_000, 1, 120) * 60_000,
    minSharePercent: envInt(env, "CHAT_FAILURE_ALERT_MIN_SHARE_PERCENT", d.minSharePercent, 0, 100),
  };
}

/** One model's turns in the window, as `countRecentTurnOutcomes` reads them. */
export interface TurnOutcomeCount {
  modelId: string;
  provider: string;
  /** Every turn that wrote a row. */
  total: number;
  /** Failed turns by fault class. */
  failed: Record<FaultFinishReason, number>;
}

export interface FailureGroup {
  /** `model:<modelId>` or `class:<finish reason>`. */
  key: string;
  kind: "model" | "class";
  subject: string;
  /** The model's provider (model groups only). */
  provider: string | null;
  failed: number;
  total: number;
}

function failedOf(row: TurnOutcomeCount): number {
  return FAULT_FINISH_REASONS.reduce((sum, reason) => sum + (row.failed[reason] ?? 0), 0);
}

function breaches(failed: number, total: number, t: FailureAlertTunables): boolean {
  if (failed < t.threshold) return false;
  return total <= 0 || failed * 100 >= t.minSharePercent * total;
}

/** The groups in breach, models first (most failures first), then classes. */
export function breachedFailureGroups(rows: readonly TurnOutcomeCount[], t: FailureAlertTunables): FailureGroup[] {
  const models: FailureGroup[] = [];
  const classFailed = new Map<FaultFinishReason, number>();
  let total = 0;
  for (const row of rows) {
    total += row.total;
    const failed = failedOf(row);
    for (const reason of FAULT_FINISH_REASONS) classFailed.set(reason, (classFailed.get(reason) ?? 0) + (row.failed[reason] ?? 0));
    if (breaches(failed, row.total, t)) {
      models.push({ key: `model:${row.modelId}`, kind: "model", subject: row.modelId, provider: row.provider, failed, total: row.total });
    }
  }
  models.sort((a, b) => b.failed - a.failed || (a.subject < b.subject ? -1 : 1));
  const classes: FailureGroup[] = [];
  for (const reason of FAULT_FINISH_REASONS) {
    const failed = classFailed.get(reason) ?? 0;
    if (breaches(failed, total, t)) classes.push({ key: `class:${reason}`, kind: "class", subject: reason, provider: null, failed, total });
  }
  return [...models, ...classes];
}

/** Which incidents are open, and when each was last seen in breach. */
export type FailureAlertState = Map<string, number>;

export function createFailureAlertState(): FailureAlertState {
  return new Map();
}

/**
 * The groups that start a new incident now, and the state after this
 * evaluation. A group still in breach within one window of when it was last
 * seen is the same incident; a group no longer in breach closes.
 */
export function newIncidents(
  state: FailureAlertState,
  breached: readonly FailureGroup[],
  now: number,
  windowMs: number
): FailureGroup[] {
  const fresh: FailureGroup[] = [];
  const still = new Set<string>();
  for (const group of breached) {
    still.add(group.key);
    const lastSeen = state.get(group.key);
    if (lastSeen === undefined || now - lastSeen > windowMs) fresh.push(group);
    state.set(group.key, now);
  }
  for (const key of [...state.keys()]) if (!still.has(key)) state.delete(key);
  return fresh;
}

function describe(group: FailureGroup): string {
  return group.kind === "model" ? group.subject : `${group.subject.replace("_", " ")} on every model`;
}

/**
 * The one alert for the incidents an evaluation found: its subject is the
 * first (the worst model, else the class), and every one is in the detail.
 * Counts and ids only: no user, conversation or message.
 */
export function failureAlertInput(
  incidents: readonly FailureGroup[],
  t: FailureAlertTunables,
  classesSeenHere: Record<string, number> = {}
): {
  kind: string;
  key: string;
  title: string;
  severity: "critical";
  detail: Record<string, unknown>;
} | null {
  const first = incidents[0];
  if (!first) return null;
  const minutes = Math.round(t.windowMs / 60_000);
  const more = incidents.length > 1 ? ` (and ${incidents.length - 1} more)` : "";
  return {
    kind: CHAT_FAILURE_RATE_KIND,
    key: first.key,
    title: `Chat turns failing: ${first.failed} of ${first.total} on ${describe(first)} in ${minutes} min${more}`,
    severity: "critical",
    detail: {
      incidents: incidents.map((group) => ({
        group: group.key,
        ...(group.provider ? { provider: group.provider } : {}),
        failed: group.failed,
        turns: group.total,
      })),
      windowMinutes: minutes,
      threshold: t.threshold,
      minSharePercent: t.minSharePercent,
      ...(Object.keys(classesSeenHere).length ? { errorClassesSeenByThisProcess: classesSeenHere } : {}),
      source: "RoutingOutcome (saved chats only; private chats write nothing)",
    },
  };
}
