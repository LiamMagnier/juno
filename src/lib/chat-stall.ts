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
 * Two minutes between events, once events are actually arriving. Long enough for
 * an extended-thinking model that emits nothing between reasoning blocks, short
 * enough that a wedged stream is not a connection held for an hour.
 */
export const PROVIDER_IDLE_TIMEOUT_MS = 120_000;

/**
 * Five minutes for the FIRST event, which is a different measurement entirely.
 *
 * Nothing can be touched before the generator yields, so everything ahead of the
 * first token counts as idle time: connecting to each linked MCP server,
 * downloading every image attachment to build the request, and then the
 * provider's own time to first token. On top of that, several providers stream
 * literally nothing while reasoning — Google is in neither the reasoning-effort
 * nor the thinking-object branch of openai-compat.ts, so no thinking config is
 * sent and its compat endpoint returns no reasoning_content at all. Juno cannot
 * see that work happening, so from here it is indistinguishable from a dead
 * socket.
 *
 * With one shared 120s budget, a hard prompt on Gemini or a turn with several
 * large attachments was killed mid-flight and told the user the model had
 * stopped responding, for a generation that was working. The startup grace is
 * still bounded, so a provider that never answers is still cut off — just not at
 * the same threshold as one that answered and then went quiet.
 */
export const PROVIDER_STARTUP_TIMEOUT_MS = 300_000;

/**
 * What the user sees when a provider goes silent. Deliberately not the abort
 * error's own text: aborting makes the SDKs throw their user-abort error, which
 * would otherwise read as though the user had pressed Stop.
 */
export const STALL_USER_MESSAGE =
  "The model stopped responding. Nothing more arrived, so the answer was cut short — try again, or pick another model.";

/**
 * The startup-window equivalent. "Nothing MORE arrived" is wrong when nothing
 * arrived at all, and the difference matters to the user: one is a truncated
 * answer worth re-reading, the other is a turn that never began.
 */
export const STALL_STARTUP_USER_MESSAGE =
  "The model never started responding. Nothing arrived at all — try again, or pick another model.";

/** The right message for whichever window fired. */
export function stallMessageFor(watchdog: Pick<StallWatchdog, "startedStreaming">): string {
  return watchdog.startedStreaming ? STALL_USER_MESSAGE : STALL_STARTUP_USER_MESSAGE;
}

/**
 * The operator-facing line in the activity log. Reports the window that actually
 * elapsed — quoting the idle timeout after a startup stall would send whoever
 * reads it looking for a 120s gap that never existed.
 */
export function stallDetail(
  providerLabel: string,
  watchdog: Pick<StallWatchdog, "startedStreaming">
): string {
  return watchdog.startedStreaming
    ? `Nothing received from ${providerLabel} for ${Math.round(PROVIDER_IDLE_TIMEOUT_MS / 1000)}s.`
    : `${providerLabel} sent nothing at all within ${Math.round(PROVIDER_STARTUP_TIMEOUT_MS / 1000)}s.`;
}

export interface StallWatchdog {
  /** Restart the idle clock. Call on every event received from the provider. */
  touch(): void;
  /** True once the watchdog has fired. */
  readonly stalled: boolean;
  /** True once the provider has produced at least one event. */
  readonly startedStreaming: boolean;
  /**
   * Cancel the timer. Call the moment the provider stream ENDS — not only from
   * the outer `finally`. Everything between the last event and the end of the
   * request (persisting the turn, artifacts, memories, spend) is Juno's own
   * work, and leaving the watchdog armed across it means a database slowdown
   * fires a provider-stalled warning into a generation that already succeeded.
   */
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
  idleMs: number = PROVIDER_IDLE_TIMEOUT_MS,
  startupMs: number = PROVIDER_STARTUP_TIMEOUT_MS
): StallWatchdog {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stalled = false;
  let stopped = false;
  let started = false;

  const arm = (delay: number) => {
    if (stopped || stalled) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      timer = null;
      onStall();
    }, delay);
    // Never hold the process open on this timer alone.
    timer.unref?.();
  };

  // The first window covers request setup and time to first token; every
  // window after it measures silence between events.
  arm(startupMs);

  return {
    touch: () => {
      started = true;
      arm(idleMs);
    },
    get startedStreaming() {
      return started;
    },
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
