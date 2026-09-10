import "server-only";
import {
  abortGenerationsForShutdown,
  activeGenerationCount,
} from "@/lib/generation-cancel";
import {
  beginDrain,
  SHUTDOWN_GRACE_MS,
  SHUTDOWN_TEARDOWN_MS,
  waitForInFlight,
} from "@/lib/shutdown";

/**
 * The stop sequence for the backend process. Installed once from
 * `instrumentation.ts`; the rules it applies live in `shutdown.ts`.
 *
 *  1. Enter the drain: `POST /api/chat` answers 503 + Retry-After from here on.
 *  2. Give in-flight generations SHUTDOWN_GRACE_MS to finish on their own —
 *     most chat answers do.
 *  3. Abort the rest with the `shutdown` mark, so the route's terminal state
 *     records each as a failure, refunds the message and releases the hold.
 *  4. Wait SHUTDOWN_TEARDOWN_MS for those teardowns, then exit. Whatever did
 *     not make it is picked up by the receipt sweep on the next boot.
 *
 * Next.js normally installs its own SIGINT/SIGTERM handler that calls
 * `process.exit(0)` immediately; the PM2 ecosystem sets NEXT_MANUAL_SIG_HANDLE
 * so this one runs instead. Both signals are handled because PM2 stops a
 * process with SIGINT first and only escalates to SIGKILL at `kill_timeout`.
 */

const globalState = globalThis as typeof globalThis & { __junoShutdownInstalled?: boolean };

export function installGracefulShutdown(): void {
  // `register()` is once-per-process by contract, but in development the
  // instrumentation module can be evaluated again on reload; a second pair of
  // listeners would run the drain twice.
  if (globalState.__junoShutdownInstalled) return;
  globalState.__junoShutdownInstalled = true;

  const onSignal = (signal: NodeJS.Signals) => {
    void drainAndExit(signal);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}

async function drainAndExit(signal: NodeJS.Signals): Promise<void> {
  if (!beginDrain()) {
    // A second signal while draining: the operator (or PM2) wants out now.
    console.warn("[shutdown] second signal received, exiting without waiting", { signal });
    process.exit(0);
  }
  const inFlight = activeGenerationCount();
  console.info("[shutdown] draining", { signal, inFlight });

  const graced = await waitForInFlight(activeGenerationCount, { deadlineMs: SHUTDOWN_GRACE_MS });
  if (!graced.drained) {
    const aborted = abortGenerationsForShutdown();
    console.warn("[shutdown] grace elapsed, aborting in-flight generations", {
      remaining: graced.remaining,
      aborted,
    });
    const tornDown = await waitForInFlight(activeGenerationCount, { deadlineMs: SHUTDOWN_TEARDOWN_MS });
    if (!tornDown.drained) {
      console.error("[shutdown] teardown did not finish; the startup sweep will refund the rest", {
        remaining: tornDown.remaining,
      });
    }
  }
  console.info("[shutdown] exiting", { signal });
  process.exit(0);
}
