/*
 * Whether the background workers are still doing their jobs, as rules with no
 * database in them. The reads and the alerts are src/lib/worker-watchdog.ts.
 *
 * Who watches whom. A process cannot report its own death, so the two worker
 * processes watch each other, through rows they both can read:
 *
 *   - juno-sweepers watches the Work executor: its heartbeat
 *     (src/lib/work/executor-heartbeat.ts) gone stale while cloud runs wait
 *     for it mails the operator. It also watches its own loops in memory: a
 *     loop whose tick never comes back (a query that hangs, a promise that
 *     never settles) stops ticking without any error, and only a clock outside
 *     the loop can see that.
 *   - juno-work watches juno-sweepers: the process writes a heartbeat row of
 *     its own, and a row gone stale mails the operator.
 *
 * Both are stale-only-after-a-grace: a deploy stops both workers for minutes
 * (deploy.sh pauses them while it builds), and the one that comes back first
 * must not mail about the one still starting.
 */

// ---------------------------------------------------------------------------
// Loops inside one process
// ---------------------------------------------------------------------------

export interface StaleLoop {
  name: string;
  /** How long since its last finished tick (or since it started, if none). */
  silentForMs: number;
  staleAfterMs: number;
  /** Whether it has finished a tick at all. */
  everTicked: boolean;
}

/**
 * The loops of one process and when each last finished a tick. A loop
 * registers when it starts and beats after every tick, whatever the tick's
 * outcome: a tick that failed still came back, and its failure is logged where
 * it happened. What this catches is a tick that never comes back.
 */
export class LoopMonitor {
  private readonly loops = new Map<string, { startedMs: number; lastBeatMs: number | null; staleAfterMs: number }>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  register(name: string, staleAfterMs: number): void {
    this.loops.set(name, { startedMs: this.clock(), lastBeatMs: null, staleAfterMs });
  }

  unregister(name: string): void {
    this.loops.delete(name);
  }

  beat(name: string): void {
    const loop = this.loops.get(name);
    if (loop) loop.lastBeatMs = this.clock();
  }

  names(): string[] {
    return [...this.loops.keys()];
  }

  /** Every registered loop, stale or not, with how long it has been silent. */
  health(nowMs: number = this.clock()): Array<StaleLoop & { stale: boolean }> {
    return [...this.loops.entries()].map(([name, loop]) => {
      const silentForMs = Math.max(0, nowMs - (loop.lastBeatMs ?? loop.startedMs));
      return {
        name,
        silentForMs,
        staleAfterMs: loop.staleAfterMs,
        everTicked: loop.lastBeatMs !== null,
        stale: silentForMs >= loop.staleAfterMs,
      };
    });
  }
}

/** The loops of this process (juno-sweepers, or a loop run on its own). */
export const workerLoops = new LoopMonitor();

/**
 * How long each watched loop may go without finishing a tick before it counts
 * as stopped. Generous multiples of its cadence: the scheduler and the trigger
 * poller tick every 15 s; the reflector every 10 minutes, and a reflection
 * tick calls a model for a few agents in turn.
 */
export const LOOP_STALE_AFTER_MS = {
  "work-scheduler": 10 * 60_000,
  "work-trigger-poller": 10 * 60_000,
  "agent-reflector": 45 * 60_000,
} as const satisfies Record<string, number>;

// ---------------------------------------------------------------------------
// The juno-sweepers process, seen from juno-work
// ---------------------------------------------------------------------------

/** The `RateLimit` row juno-sweepers keeps fresh, as the executor keeps its own. */
export const SWEEPERS_HEARTBEAT_KEY = "worker-heartbeat:juno-sweepers";
/** How long one write keeps juno-sweepers counted as alive. */
export const SWEEPERS_HEARTBEAT_TTL_MS = 5 * 60_000;
/** juno-sweepers writes at most this often. */
export const SWEEPERS_HEARTBEAT_WRITE_MS = 60_000;
/** How often each watchdog looks. */
export const WATCHDOG_INTERVAL_MS = 60_000;
/** How long a watcher must itself have been up before anything it sees counts. */
export const WATCHER_STARTUP_GRACE_MS = 5 * 60_000;

/**
 * Whether juno-sweepers has gone quiet, from juno-work's side.
 *
 * `expiresAt` is the heartbeat row's expiry: null when there is no row, and
 * "unknown" when it could not be read, which is evidence of nothing. A missing
 * row counts only where juno-sweepers is expected to run at all (production);
 * a developer running the runner alone has none.
 */
export function sweepersHeartbeatStale(input: {
  expiresAt: Date | null | "unknown";
  now: Date;
  watcherUpForMs: number;
  expectSweepers: boolean;
}): boolean {
  if (input.watcherUpForMs < WATCHER_STARTUP_GRACE_MS) return false;
  if (input.expiresAt === "unknown") return false;
  if (input.expiresAt === null) return input.expectSweepers;
  return input.expiresAt.getTime() <= input.now.getTime();
}

// ---------------------------------------------------------------------------
// Saying it once
// ---------------------------------------------------------------------------

/** One alert per hour per subject while it stays stale; the same window `alertOperator` dedupes mail on. */
export const WATCHDOG_REALERT_MS = 60 * 60_000;

/**
 * Turns "is it stale now?", asked every minute, into the moments worth an
 * alert: the first time it is seen stale, again every `realertMs` while it
 * stays so, and once when it recovers after an alert. Everything in between
 * is silence, so the log carries one line an hour, not one a minute.
 */
export class AlertGate {
  private readonly state = new Map<string, { alertedAtMs: number }>();

  constructor(private readonly realertMs: number = WATCHDOG_REALERT_MS) {}

  observe(key: string, stale: boolean, nowMs: number): "alert" | "recovered" | null {
    const seen = this.state.get(key);
    if (stale) {
      if (!seen || nowMs - seen.alertedAtMs >= this.realertMs) {
        this.state.set(key, { alertedAtMs: nowMs });
        return "alert";
      }
      return null;
    }
    if (!seen) return null;
    this.state.delete(key);
    return "recovered";
  }
}

/** Minutes, rounded down, for a title a person reads. */
export function minutesOf(ms: number): number {
  return Math.max(0, Math.floor(ms / 60_000));
}

// ---------------------------------------------------------------------------
// The scheduler and the trigger poller inside juno-sweepers
// ---------------------------------------------------------------------------

/**
 * Whether juno-sweepers starts the routine scheduler and the event-trigger
 * poller. Off unless `SWEEPERS_RUN_WORK_SCHEDULER` is `1` (or `true`, `on`,
 * `yes`). Owner to decide (docs/OPEN_DECISIONS.md §14).
 *
 * Both files only start their loop when they are the script node was asked
 * to run (`pathToFileURL(process.argv[1]) === import.meta.url`), which
 * scripts/sweepers.ts, importing them, never is: inside juno-sweepers neither
 * loop has been running. Starting them is what the deployment was written to
 * do, and it also starts everything their ticks carry — routines firing (one
 * catch-up per routine under the default policy), event triggers polling
 * connected apps, the seven-day checkpoint retention sweep (which deletes
 * stored transcripts of runs that ended more than a week ago), the queued and
 * parked run expiries, and legacy task adoption. That is the owner's call, so
 * this stays off until it is made.
 */
export function workDispatchLoopsEnabled(raw: string | undefined = process.env.SWEEPERS_RUN_WORK_SCHEDULER): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}
