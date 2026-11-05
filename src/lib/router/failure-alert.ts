import "server-only";

import { alertOperator, type AlertInput, type AlertMail } from "@/lib/alerts";
import {
  breachedFailureGroups,
  createFailureAlertState,
  failureAlertInput,
  failureAlertTunables,
  newIncidents,
  type FailureGroup,
  type TurnOutcomeCount,
} from "@/lib/router/failure-alert-rules";

/*
 * THE CHAT FAILURE-RATE WATCH (rules: failure-alert-rules.ts).
 *
 * Woken by a failed saved-chat turn (trace-sink.ts), it waits a moment for
 * the turn's `RoutingOutcome` row to land, counts the window from the
 * database, and mails the operator once per new incident. It never polls:
 * a quiet process costs nothing, and during an outage it evaluates at most
 * once every `minIntervalMs` however many turns fail. Runs in the web
 * process, the only one that writes chat outcomes; its incident memory is
 * per process, so a restart during an outage can mail it once more (and
 * `alertOperator`'s hourly dedupe is per process too).
 */

export interface FailureRateWatchDeps {
  readCounts(since: Date): Promise<TurnOutcomeCount[]>;
  alert(input: AlertInput): AlertMail | void;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => { unref?: () => void } | unknown;
  env?: Record<string, string | undefined>;
  /** How long after a failure the count is read (its row is written just after the trace). */
  settleMs?: number;
  /** The least time between two evaluations. */
  minIntervalMs?: number;
}

/** What a failed turn tells the watch, for the alert's detail. Counts only. */
export interface FailedTurnNote {
  modelId: string;
  /** The normalised provider error class (`provider-error.ts`), when the trace had one. */
  errorClass: string | null;
}

export interface FailureRateWatch {
  /** A saved-chat turn failed: evaluate soon. */
  noteFailedTurn(note?: FailedTurnNote): void;
  /** Count now and alert on new incidents (exposed for tests). */
  evaluate(): Promise<FailureGroup[]>;
}

const RECENT_NOTES_MAX = 500;

export function createFailureRateWatch(deps: FailureRateWatchDeps): FailureRateWatch {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const settleMs = deps.settleMs ?? 3_000;
  const minIntervalMs = deps.minIntervalMs ?? 30_000;
  const state = createFailureAlertState();
  const notes: Array<FailedTurnNote & { at: number }> = [];
  let scheduled = false;
  let running = false;
  let again = false;
  let lastRunAt = Number.NEGATIVE_INFINITY;

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    const wait = Math.max(settleMs, lastRunAt + minIntervalMs - now());
    const timer = setTimer(() => {
      scheduled = false;
      void evaluate();
    }, wait) as { unref?: () => void } | undefined;
    timer?.unref?.();
  };

  /** The provider error classes this process saw for the incidents' models. */
  const classesSeen = (incidents: readonly FailureGroup[], since: number): Record<string, number> => {
    const models = new Set(incidents.filter((group) => group.kind === "model").map((group) => group.subject));
    const anyModel = incidents.some((group) => group.kind === "class");
    const out: Record<string, number> = {};
    for (const note of notes) {
      if (note.at < since || !note.errorClass) continue;
      if (!anyModel && !models.has(note.modelId)) continue;
      out[note.errorClass] = (out[note.errorClass] ?? 0) + 1;
    }
    return out;
  };

  async function evaluate(): Promise<FailureGroup[]> {
    if (running) {
      again = true;
      return [];
    }
    running = true;
    lastRunAt = now();
    try {
      const tunables = failureAlertTunables(deps.env ?? process.env);
      if (!tunables.enabled) return [];
      const at = now();
      const since = at - tunables.windowMs;
      while (notes.length && notes[0].at < since) notes.shift();
      const rows = await deps.readCounts(new Date(since));
      const incidents = newIncidents(state, breachedFailureGroups(rows, tunables), at, tunables.windowMs);
      const input = failureAlertInput(incidents, tunables, classesSeen(incidents, since));
      if (input) deps.alert(input);
      return incidents;
    } catch (error) {
      // An alert that cannot count says so in the log and tries again on the
      // next failure; it never throws into a turn.
      console.warn("[alert] chat failure-rate check skipped", error instanceof Error ? error.message : String(error));
      return [];
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule();
      }
    }
  }

  return {
    noteFailedTurn(note) {
      if (note) {
        notes.push({ ...note, at: now() });
        if (notes.length > RECENT_NOTES_MAX) notes.splice(0, notes.length - RECENT_NOTES_MAX);
      }
      schedule();
    },
    evaluate,
  };
}

let shared: FailureRateWatch | null = null;

/** The web process's watch, reading `RoutingOutcome` and mailing through `alertOperator`. */
export function chatFailureRateWatch(): FailureRateWatch {
  shared ??= createFailureRateWatch({
    readCounts: async (since) => (await import("@/lib/router/telemetry-store")).countRecentTurnOutcomes(since),
    alert: alertOperator,
  });
  return shared;
}
