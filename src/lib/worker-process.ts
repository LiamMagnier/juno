/*
 * Process-level error handling for the tsx workers (scripts/work-runner.ts as
 * juno-work, scripts/sweepers.ts as juno-sweepers, and each loop run on its
 * own).
 *
 * The web process has these already: Next installs log-and-continue handlers
 * in its server. The workers had none, so Node's default applied: an unhandled
 * rejection threw, the process died mid-tick, and PM2 restarted it, taking up
 * to three Work runs in flight with it.
 *
 *   - An unhandled rejection is logged and the worker keeps running. A promise
 *     nobody awaited failing says nothing about the rest of the process, and
 *     every loop here already treats a failed tick as the next tick's problem.
 *   - An uncaught exception is logged, the worker drains (every loop that
 *     registered a drain stops at a safe point, bounded by `drainTimeoutMs`),
 *     and the process exits non-zero, so PM2 restarts it on a clean slate.
 *     Node's own advice: after an uncaught exception the process state is not
 *     to be trusted, so it is not kept running, only wound down.
 *
 * Free of `server-only` and of the database, so it is tested as it is.
 */

export type WorkerDrain = () => Promise<void>;

export interface WorkerProcessGuardOptions {
  /** The worker's name in its log lines. */
  name: string;
  /** The longest an uncaught exception's drain may take before the exit. */
  drainTimeoutMs?: number;
  /** Writes one line to the error log. */
  log?: (line: string) => void;
  /** Ends the process. */
  exit?: (code: number) => void;
  /** The drains to run, read when the drain starts. */
  drains?: () => Iterable<[string, WorkerDrain]>;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => unknown };
  /** Records the exit code before the drain (`process.exitCode`). */
  setExitCode?: (code: number) => void;
}

export interface WorkerProcessGuard {
  onUnhandledRejection(reason: unknown): void;
  onUncaughtException(error: unknown, origin?: string): void;
  /** Whether an uncaught exception has started the drain. */
  readonly draining: boolean;
  /** Resolves when the drain that an uncaught exception started has exited. */
  readonly drained: Promise<void> | null;
}

export const DEFAULT_WORKER_DRAIN_TIMEOUT_MS = 15_000;
/** At most this many lines for repeated unhandled rejections per minute, so a loop failing every tick cannot flood the log. */
const REJECTION_LOG_BUDGET_PER_MINUTE = 20;
const MAX_LOGGED_CHARS = 4_000;

/** An error, as one bounded line: its name and message, and its stack when it has one. */
export function describeFailure(error: unknown): string {
  let text: string;
  if (error instanceof Error) {
    text = error.stack && error.stack.includes(error.message) ? error.stack : `${error.name}: ${error.message}`;
  } else {
    try {
      text = typeof error === "string" ? error : JSON.stringify(error) ?? String(error);
    } catch {
      text = String(error);
    }
  }
  return text.length > MAX_LOGGED_CHARS ? `${text.slice(0, MAX_LOGGED_CHARS)}…` : text;
}

const registeredDrains = new Map<string, WorkerDrain>();

/**
 * Registers what a loop does to stop at a safe point when the process has to
 * go: set its stop flag and resolve once its tick in hand has finished.
 * Returns the function that removes it.
 */
export function registerWorkerDrain(name: string, drain: WorkerDrain): () => void {
  registeredDrains.set(name, drain);
  return () => {
    if (registeredDrains.get(name) === drain) registeredDrains.delete(name);
  };
}

/** The handlers, built on injected effects so they are testable without a process. */
export function createWorkerProcessGuard(options: WorkerProcessGuardOptions): WorkerProcessGuard {
  const log = options.log ?? ((line: string) => console.error(line));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const drains = options.drains ?? (() => registeredDrains.entries());
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const setExitCode =
    options.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  const timeoutMs = options.drainTimeoutMs ?? DEFAULT_WORKER_DRAIN_TIMEOUT_MS;
  const prefix = `[${options.name}]`;

  let draining = false;
  let drained: Promise<void> | null = null;
  let rejectionWindowStart = 0;
  let rejectionsInWindow = 0;
  let suppressed = 0;

  return {
    get draining() {
      return draining;
    },
    get drained() {
      return drained;
    },
    onUnhandledRejection(reason: unknown) {
      const nowMs = Date.now();
      if (nowMs - rejectionWindowStart >= 60_000) {
        if (suppressed > 0) log(`${prefix} ${suppressed} more unhandled rejections were not logged in the last minute`);
        rejectionWindowStart = nowMs;
        rejectionsInWindow = 0;
        suppressed = 0;
      }
      rejectionsInWindow += 1;
      if (rejectionsInWindow > REJECTION_LOG_BUDGET_PER_MINUTE) {
        suppressed += 1;
        return;
      }
      log(`${prefix} unhandled rejection (still running): ${describeFailure(reason)}`);
    },
    onUncaughtException(error: unknown, origin?: string) {
      log(`${prefix} uncaught exception${origin ? ` (${origin})` : ""}: ${describeFailure(error)}`);
      if (draining) return;
      draining = true;
      // The exit code is decided now, whoever exits: a SIGTERM drain that
      // finishes first still reports the failure to PM2.
      setExitCode(1);
      log(`${prefix} draining, then exiting with code 1 so PM2 restarts it`);
      // A backstop in case the drain itself never settles.
      setTimer(() => exit(1), timeoutMs + 2_000).unref?.();
      const work = Promise.allSettled(
        [...drains()].map(async ([name, drain]) => {
          try {
            await drain();
          } catch (drainError) {
            log(`${prefix} ${name} did not drain cleanly: ${describeFailure(drainError)}`);
          }
        })
      ).then(() => undefined);
      const timedOut = new Promise<void>((resolve) => {
        setTimer(() => resolve(), timeoutMs).unref?.();
      });
      drained = Promise.race([work, timedOut]).then(() => exit(1));
    },
  };
}

let installed: WorkerProcessGuard | null = null;

/** The script node was asked to run, by name (`sweepers` inside juno-sweepers). */
function entryScriptName(): string {
  const entry = process.argv[1] ?? "";
  const base = entry.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.(c|m)?[jt]s$/, "") || "worker";
}

/**
 * Installs the handlers on this process, once. Every loop calls it from its
 * own `main`, so a loop run on its own is covered, and inside juno-sweepers the
 * first one to start installs them for the whole process; the others only
 * register their drains. The log name is the entry script's unless given.
 */
export function installWorkerProcessGuard(
  options: Partial<WorkerProcessGuardOptions> = {}
): WorkerProcessGuard {
  if (installed) return installed;
  const guard = createWorkerProcessGuard({ ...options, name: options.name ?? entryScriptName() });
  process.on("unhandledRejection", (reason) => guard.onUnhandledRejection(reason));
  process.on("uncaughtException", (error, origin) => guard.onUncaughtException(error, origin));
  installed = guard;
  return guard;
}
