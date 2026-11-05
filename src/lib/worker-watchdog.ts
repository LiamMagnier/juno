import "server-only";
import { WORKER_ALERT_KINDS, alertOperator, type AlertInput } from "@/lib/alerts";
import { prismaUnguarded } from "@/lib/db";
import { readExecutorPresence } from "@/lib/work/executor-heartbeat";
import {
  executorKnownAbsent,
  executorStaleWithWaitingWork,
  type ExecutorPresenceReading,
} from "@/lib/work/executor-presence";
import { RESTART_PAUSE_REASON } from "@/lib/work/restart-resume-rules";
import {
  AlertGate,
  SWEEPERS_HEARTBEAT_KEY,
  SWEEPERS_HEARTBEAT_TTL_MS,
  SWEEPERS_HEARTBEAT_WRITE_MS,
  WATCHDOG_INTERVAL_MS,
  minutesOf,
  sweepersHeartbeatStale,
  workerLoops,
  type LoopMonitor,
} from "@/lib/worker-watchdog-rules";

/*
 * The watchdogs' reads, writes and alerts. Who watches whom, and why, is at
 * the top of worker-watchdog-rules.ts.
 */

type Alert = (input: AlertInput) => unknown;

// ---------------------------------------------------------------------------
// juno-sweepers' heartbeat row
// ---------------------------------------------------------------------------

let lastSweepersBeatWrittenMs = 0;

/** Keeps juno-sweepers counted as alive. Throttled; never throws. */
export async function recordSweepersHeartbeat(now: Date = new Date()): Promise<void> {
  if (now.getTime() - lastSweepersBeatWrittenMs < SWEEPERS_HEARTBEAT_WRITE_MS) return;
  const expiresAt = new Date(now.getTime() + SWEEPERS_HEARTBEAT_TTL_MS);
  try {
    await prismaUnguarded.rateLimit.upsert({
      where: { key: SWEEPERS_HEARTBEAT_KEY },
      create: { key: SWEEPERS_HEARTBEAT_KEY, count: 0, expiresAt },
      update: { expiresAt },
    });
    lastSweepersBeatWrittenMs = now.getTime();
  } catch (error) {
    console.warn("[watchdog] sweepers heartbeat write failed", error instanceof Error ? error.message : String(error));
  }
}

/** The row's expiry, null with no row, "unknown" when the read failed. */
export async function readSweepersHeartbeat(): Promise<Date | null | "unknown"> {
  try {
    const row = await prismaUnguarded.rateLimit.findUnique({
      where: { key: SWEEPERS_HEARTBEAT_KEY },
      select: { expiresAt: true },
    });
    return row?.expiresAt ?? null;
  } catch {
    return "unknown";
  }
}

/** Cloud runs waiting for an executor: queued for one, or set aside for a restart. */
export async function countWaitingCloudRuns(): Promise<number> {
  return prismaUnguarded.workRun.count({
    where: {
      effectiveTarget: "cloud",
      claimedBy: null,
      OR: [{ status: "queued" }, { status: "paused", pauseReason: RESTART_PAUSE_REASON }],
    },
  });
}

// ---------------------------------------------------------------------------
// In juno-sweepers: its loops, and the executor
// ---------------------------------------------------------------------------

export interface SweepersWatchdogDeps {
  loops?: LoopMonitor;
  alert?: Alert;
  readPresence?: (now: Date) => Promise<ExecutorPresenceReading>;
  countWaiting?: () => Promise<number>;
  writeHeartbeat?: (now: Date) => Promise<void>;
  /** When this process started watching. */
  startedAtMs?: number;
  log?: (line: string) => void;
}

/**
 * One look, every `WATCHDOG_INTERVAL_MS`, from inside juno-sweepers: write the
 * process's own heartbeat, mail about any loop that stopped finishing ticks,
 * and mail when the executor's heartbeat has lapsed while cloud runs wait.
 * Never throws: a watchdog that fails is logged and looks again next time.
 */
export function createSweepersWatchdog(deps: SweepersWatchdogDeps = {}) {
  const loops = deps.loops ?? workerLoops;
  const alert = deps.alert ?? alertOperator;
  const readPresence = deps.readPresence ?? readExecutorPresence;
  const countWaiting = deps.countWaiting ?? countWaitingCloudRuns;
  const writeHeartbeat = deps.writeHeartbeat ?? recordSweepersHeartbeat;
  const startedAtMs = deps.startedAtMs ?? Date.now();
  const log = deps.log ?? ((line: string) => console.error(line));
  const gate = new AlertGate();

  return async function check(now: Date = new Date()): Promise<void> {
    const nowMs = now.getTime();
    await writeHeartbeat(now).catch(() => undefined);

    for (const loop of loops.health(nowMs)) {
      const seen = gate.observe(`loop:${loop.name}`, loop.stale, nowMs);
      if (seen === "alert") {
        alert({
          kind: WORKER_ALERT_KINDS.sweeperStale,
          key: loop.name,
          severity: "critical",
          title: `${loop.name} has not finished a tick for ${minutesOf(loop.silentForMs)} min`,
          detail: {
            loop: loop.name,
            silentForMinutes: minutesOf(loop.silentForMs),
            staleAfterMinutes: minutesOf(loop.staleAfterMs),
            everTicked: loop.everTicked,
            process: "juno-sweepers",
          },
        });
      } else if (seen === "recovered") {
        alert({
          kind: WORKER_ALERT_KINDS.recovered,
          key: loop.name,
          severity: "warn",
          title: `${loop.name} is finishing ticks again`,
          detail: { loop: loop.name, process: "juno-sweepers" },
        });
      }
    }

    try {
      const reading = await readPresence(now);
      // Counted only when the executor is gone: one count a minute while it
      // is down, none while it is up.
      const waitingRuns = executorKnownAbsent(reading, now) ? await countWaiting() : 0;
      const stale = executorStaleWithWaitingWork({ reading, waitingRuns, now, watcherUpForMs: nowMs - startedAtMs });
      const seen = gate.observe("executor", stale, nowMs);
      if (seen === "alert") {
        const lastBeatAt = reading.kind === "read" ? reading.lastBeatAt : null;
        alert({
          kind: WORKER_ALERT_KINDS.executorStale,
          key: "cloud",
          severity: "critical",
          title: lastBeatAt
            ? `The cloud Work executor has not reported for ${minutesOf(nowMs - lastBeatAt.getTime())} min and ${waitingRuns} cloud run${waitingRuns === 1 ? " is" : "s are"} waiting`
            : // No row: never written, or its heartbeat lapsed over a day ago and
              // scripts/prune-sync.ts removed it with the other expired RateLimit rows.
              `The cloud Work executor has no current heartbeat (none in over a day, or never) and ${waitingRuns} cloud run${waitingRuns === 1 ? " is" : "s are"} waiting`,
          detail: {
            lastBeatAt: lastBeatAt?.toISOString() ?? null,
            waitingRuns,
            process: "juno-work",
            check: "pm2 describe juno-work",
          },
        });
      } else if (seen === "recovered") {
        alert({
          kind: WORKER_ALERT_KINDS.recovered,
          key: "cloud",
          severity: "warn",
          title: "The cloud Work executor is reporting again, or nothing is waiting for it",
          detail: { process: "juno-work" },
        });
      }
    } catch (error) {
      log(`[watchdog] executor check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/**
 * Starts juno-sweepers' watchdog: one look now (which writes the heartbeat),
 * then one a minute. The timer does not hold the process open. Returns the
 * function that stops it.
 */
export function startSweepersWatchdog(deps: SweepersWatchdogDeps = {}): () => void {
  const check = createSweepersWatchdog(deps);
  let running = false;
  const look = () => {
    if (running) return;
    running = true;
    void check()
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  };
  look();
  const timer = setInterval(look, WATCHDOG_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// In juno-work: juno-sweepers
// ---------------------------------------------------------------------------

export interface SweepersWatcherDeps {
  alert?: Alert;
  readHeartbeat?: () => Promise<Date | null | "unknown">;
  startedAtMs?: number;
  /** Whether juno-sweepers is expected to run beside this runner (production). */
  expectSweepers?: boolean;
}

/**
 * juno-work's look at juno-sweepers, at most once a `WATCHDOG_INTERVAL_MS`
 * however often it is called (the runner calls it every tick). Never throws.
 */
export function createSweepersWatcher(deps: SweepersWatcherDeps = {}) {
  const alert = deps.alert ?? alertOperator;
  const readHeartbeat = deps.readHeartbeat ?? readSweepersHeartbeat;
  const startedAtMs = deps.startedAtMs ?? Date.now();
  const expectSweepers = deps.expectSweepers ?? process.env.NODE_ENV === "production";
  const gate = new AlertGate();
  let lastLookMs = Number.NEGATIVE_INFINITY;

  return async function check(now: Date = new Date()): Promise<void> {
    const nowMs = now.getTime();
    if (nowMs - lastLookMs < WATCHDOG_INTERVAL_MS) return;
    lastLookMs = nowMs;
    try {
      const expiresAt = await readHeartbeat();
      const stale = sweepersHeartbeatStale({ expiresAt, now, watcherUpForMs: nowMs - startedAtMs, expectSweepers });
      const seen = gate.observe("juno-sweepers", stale, nowMs);
      if (seen === "alert") {
        const lastBeatAt =
          expiresAt instanceof Date ? new Date(expiresAt.getTime() - SWEEPERS_HEARTBEAT_TTL_MS) : null;
        alert({
          kind: WORKER_ALERT_KINDS.sweeperStale,
          key: "juno-sweepers",
          severity: "critical",
          title: lastBeatAt
            ? `juno-sweepers has not reported for ${minutesOf(nowMs - lastBeatAt.getTime())} min`
            : // No row: never written, or its heartbeat lapsed over a day ago and
              // scripts/prune-sync.ts removed it with the other expired RateLimit rows.
              "juno-sweepers has no current heartbeat (none in over a day, or never)",
          detail: {
            lastBeatAt: lastBeatAt?.toISOString() ?? null,
            process: "juno-sweepers",
            check: "pm2 describe juno-sweepers",
          },
        });
      } else if (seen === "recovered") {
        alert({
          kind: WORKER_ALERT_KINDS.recovered,
          key: "juno-sweepers",
          severity: "warn",
          title: "juno-sweepers is reporting again",
          detail: { process: "juno-sweepers" },
        });
      }
    } catch (error) {
      console.error(`[watchdog] sweepers check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
