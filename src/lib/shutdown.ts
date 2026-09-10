/**
 * Drain state for a graceful stop, and the wait that goes with it.
 *
 * Pure — no Next, no Prisma, no signals — so the rules can be tested. The
 * signal handler that drives it is `graceful-shutdown.ts`; the chat route
 * reads `isDraining()` to refuse new generations while it runs.
 *
 * Why this exists: every deploy and every `max_memory_restart` sent SIGTERM to
 * a process with no handler of its own. Next's default handler calls
 * `process.exit(0)` at once, so every in-flight SSE stream on the box died
 * mid-answer — with the message already charged, the spend hold left for the
 * one-hour reaper, and the native client's receipt stranded in `running`
 * until its lease expired. Nothing refunded anything, because nothing ran.
 *
 * The state lives on `globalThis`, as `generation-cancel.ts` does, because the
 * instrumentation bundle and the route bundles are separate module graphs in
 * a Next build: a module-level `let` would be two flags that never meet.
 */

interface DrainState {
  draining: boolean;
}

const globalState = globalThis as typeof globalThis & { __junoDrain?: DrainState };

function state(): DrainState {
  if (!globalState.__junoDrain) globalState.__junoDrain = { draining: false };
  return globalState.__junoDrain;
}

/** True once a stop signal has arrived; new generations are refused. */
export function isDraining(): boolean {
  return state().draining;
}

/** Enter the drain. Returns false when it was already under way. */
export function beginDrain(): boolean {
  const s = state();
  if (s.draining) return false;
  s.draining = true;
  return true;
}

export function resetDrainForTests(): void {
  state().draining = false;
}

/**
 * How long an in-flight generation is given to finish on its own before it
 * is aborted. Most chat answers complete inside this; a deep-research or
 * long-thinking turn will not, and is refunded instead.
 *
 * Bounded by the deploy, not by taste: `deploy.sh` waits ~60s for the new
 * process to report online, and PM2 forces SIGKILL at `kill_timeout`. Grace
 * plus teardown must fit inside both with room to spare.
 */
export const SHUTDOWN_GRACE_MS = 20_000;

/**
 * After the abort, how long the route's own teardown (mark the receipt
 * failed, refund the message, release the hold) is given before the process
 * exits regardless. The startup sweep covers anything that did not make it.
 */
export const SHUTDOWN_TEARDOWN_MS = 30_000;

/** What `POST /api/chat` answers while draining, and the header that goes with it. */
export const DRAIN_RETRY_AFTER_SECONDS = 5;
export const DRAINING_RESPONSE = {
  error: "Juno is restarting. Please try again in a moment.",
  code: "SERVER_DRAINING",
  retryable: true,
} as const;

/**
 * What a user whose generation was cut by the restart sees. Deliberately says
 * the message was NOT counted — that is the promise this whole mechanism
 * exists to keep.
 */
export const SHUTDOWN_USER_MESSAGE =
  "Juno restarted while answering, so this reply was cut short and the message was not counted. Please send it again.";

export interface WaitForInFlightOptions {
  /** Give up after this long, whatever `count()` says. */
  deadlineMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wait until `count()` reaches zero or the deadline passes. Resolves with
 * whether the drain completed and how many were still running if it did not.
 * The clock and the sleep are injectable so the loop can be tested without
 * real time.
 */
export async function waitForInFlight(
  count: () => number,
  options: WaitForInFlightOptions
): Promise<{ drained: boolean; remaining: number }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = Math.max(1, options.pollMs ?? 250);
  const deadline = now() + options.deadlineMs;
  for (;;) {
    const remaining = count();
    if (remaining <= 0) return { drained: true, remaining: 0 };
    if (now() >= deadline) return { drained: false, remaining };
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}
