/**
 * An idle watchdog for provider streams.
 *
 * Nothing bounded a generation that stopped producing. The SDKs do carry a
 * 10-minute default timeout, but it is armed around the inner fetch and cleared
 * the moment response headers arrive, so it never covers the streamed body. And
 * nginx's `proxy_read_timeout 3600s` never fires either, because Juno sends its
 * own SSE heartbeat every 15s regardless of provider activity — the heartbeat
 * that keeps the client's connection alive also keeps a dead one alive.
 *
 * What is left is undici's transport-level body timeout, ~300s, and only for a
 * COMPLETELY silent socket. A provider that trickles a byte now and then resets
 * it, so the stream is effectively unbounded: it holds an SSE connection, a
 * generation registration and a database connection until the client gives up.
 *
 * This watchdog measures time since the last event Juno actually received, and
 * aborts when that exceeds `idleMs`.
 */

/**
 * Two minutes. Long enough for an extended-thinking model that emits nothing
 * between reasoning blocks, short enough that a wedged stream is not a
 * connection held for an hour.
 */
export const PROVIDER_IDLE_TIMEOUT_MS = 120_000;

/**
 * What the user sees when a provider goes silent. Deliberately not the abort
 * error's own text: aborting makes the SDKs throw their user-abort error, which
 * would otherwise read as though the user had pressed Stop.
 */
export const STALL_USER_MESSAGE =
  "The model stopped responding. Nothing more arrived, so the answer was cut short — try again, or pick another model.";

export interface StallWatchdog {
  /** Restart the idle clock. Call on every event received from the provider. */
  touch(): void;
  /** True once the watchdog has fired. */
  readonly stalled: boolean;
  /** Cancel the timer. Always call from a `finally`. */
  stop(): void;
}

/**
 * @param onStall invoked once, when the stream has been idle for `idleMs`.
 *                Typically aborts the generation's AbortController.
 *
 * The caller MUST distinguish a stall from a user-initiated stop when it
 * reports the outcome. Aborting the controller makes the provider SDKs throw
 * their abort error, which the route's `isAbortLike` matches — so without a
 * separate flag a wedged provider would be recorded and shown to the user as
 * though they had pressed Stop. `stalled` is that flag, mirroring how
 * `budgetHalted` already separates a budget abort from a real failure.
 */
export function createStallWatchdog(
  onStall: () => void,
  idleMs: number = PROVIDER_IDLE_TIMEOUT_MS
): StallWatchdog {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stalled = false;
  let stopped = false;

  const arm = () => {
    if (stopped || stalled) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      timer = null;
      onStall();
    }, idleMs);
    // Never hold the process open on this timer alone.
    timer.unref?.();
  };

  arm();

  return {
    touch: arm,
    get stalled() {
      return stalled;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
