/**
 * Keeping a voice call alive: a heartbeat on the relay socket, and the
 * screen awake while the call runs.
 *
 * HEARTBEAT. The protocol has always had `ping`/`pong`, and the client never
 * sent a ping. A half-open socket (Wi-Fi handing over to cellular, a laptop
 * waking from sleep) raised no event at all, so the call read "Listening" on
 * a dead line until TCP gave up, minutes later. Now the client pings while
 * the line is quiet and treats a ping nobody answers as a drop, which the
 * hook's reconnect already knows how to handle. Any frame from the relay
 * (audio included) counts as an answer.
 *
 * WAKE LOCK. A phone's screen slept at the OS timeout mid-call, the page was
 * suspended, and the call dropped. The lock is held while a call runs and
 * taken again when the page becomes visible (the browser drops it whenever
 * the page is hidden). Where the API is missing or refuses, the call goes on
 * without it.
 *
 * Both take their clocks and globals as arguments, so
 * tests/voice-keepalive.test.ts drives them without a browser.
 */

export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_TIMEOUT_MS = 5_000;

export interface HeartbeatTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const browserTimers: HeartbeatTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface VoiceHeartbeat {
  /** A frame arrived from the relay: the line is alive. */
  heard(): void;
  stop(): void;
}

/**
 * Ping every `intervalMs`; if nothing at all is heard within `timeoutMs` of a
 * ping, call `onSilent` once and stop. A ping is only sent when none is
 * outstanding, so a slow answer never stacks pings.
 */
export function createVoiceHeartbeat({
  ping,
  onSilent,
  intervalMs = HEARTBEAT_INTERVAL_MS,
  timeoutMs = HEARTBEAT_TIMEOUT_MS,
  timers = browserTimers,
}: {
  ping: () => void;
  onSilent: () => void;
  intervalMs?: number;
  timeoutMs?: number;
  timers?: HeartbeatTimers;
}): VoiceHeartbeat {
  let stopped = false;
  let deadline: unknown = null;
  const interval = timers.setInterval(() => {
    if (stopped || deadline !== null) return;
    ping();
    deadline = timers.setTimeout(() => {
      deadline = null;
      if (stopped) return;
      stop();
      onSilent();
    }, timeoutMs);
  }, intervalMs);

  function stop() {
    stopped = true;
    timers.clearInterval(interval);
    if (deadline !== null) timers.clearTimeout(deadline);
    deadline = null;
  }

  return {
    heard() {
      if (deadline === null) return;
      timers.clearTimeout(deadline);
      deadline = null;
    },
    stop,
  };
}

interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}

export interface WakeLockHost {
  wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
}

export interface VisibilityHost {
  visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface CallWakeLock {
  /** Keep the screen on from now (asks again whenever the page comes back). */
  hold(): void;
  /** Let the screen sleep again. */
  release(): void;
  dispose(): void;
}

/** The screen wake lock for a call's lifetime, re-taken on `visibilitychange`. */
export function createCallWakeLock(
  nav: WakeLockHost | undefined = typeof navigator === "undefined" ? undefined : (navigator as unknown as WakeLockHost),
  doc: VisibilityHost | undefined = typeof document === "undefined" ? undefined : document,
): CallWakeLock {
  let wanted = false;
  let sentinel: WakeLockSentinelLike | null = null;
  let requesting = false;

  const acquire = async () => {
    if (!wanted || sentinel || requesting || !nav?.wakeLock || doc?.visibilityState !== "visible") return;
    requesting = true;
    try {
      const next = await nav.wakeLock.request("screen");
      if (!wanted) {
        // Released while the request was in flight.
        void next.release().catch(() => {});
        return;
      }
      sentinel = next;
      next.addEventListener("release", () => {
        if (sentinel === next) sentinel = null;
      });
    } catch {
      // Refused (battery saver, a permissions policy): the call goes on, the screen may sleep.
    } finally {
      requesting = false;
    }
  };

  const onVisibility = () => {
    if (doc?.visibilityState === "visible") void acquire();
  };
  doc?.addEventListener("visibilitychange", onVisibility);

  const release = () => {
    wanted = false;
    const held = sentinel;
    sentinel = null;
    if (held) void held.release().catch(() => {});
  };

  return {
    hold() {
      wanted = true;
      void acquire();
    },
    release,
    dispose() {
      release();
      doc?.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
