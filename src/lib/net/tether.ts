/**
 * Tether: the one reconnect policy every Alevr client follows when a live
 * stream (a chat answer, a Code run) drops while a turn is still in flight.
 *
 * Design: docs/rea/designs/reliability-and-native.md §3.1. The Swift twin is
 * `native/Packages/JunoNativeKit/Sources/JunoCore/Tether.swift`; both are held
 * to `tests/fixtures/tether-vectors.json`, so a constant or a transition that
 * changes on one side and not the other fails a test on both.
 *
 * The rules, in the order they matter:
 *
 *  1. **Backoff with full jitter.** The n-th retry waits a uniformly random
 *     time between `floorMs` and `min(capMs, baseMs * 2^n)`. Spreading every
 *     client across the whole window, rather than around a point, is what
 *     keeps a fleet that lost the server at the same moment from coming back
 *     at the same moment too.
 *  2. **Triggers skip the wait.** The network coming back, the app returning
 *     to the foreground and the machine waking each start an attempt at once
 *     and reset the backoff. Waiting out a 30 s timer after the person has
 *     just opened their laptop is the thing this module exists to stop.
 *  3. **Never give up while a turn is in flight.** Past the active window the
 *     turn is *parked*: no more visible retrying, a calm "Waiting for
 *     connection" line, the seq cursor kept, a slow background probe, and an
 *     immediate attempt on the next trigger. The client stops only when the
 *     person stops it, moves on, or the server says the log is gone.
 *  4. **Truthful states.** `reconnecting` (an attempt is due or under way),
 *     `waiting` (the device reports no network, so there is nothing to retry
 *     against), `parked` (the active window is over) and `connected`.
 *
 * The reducer is pure — time and randomness come in as arguments — so the
 * fixture can pin every transition. `TetherLink` below is the small stateful
 * driver the hooks use; it takes an injectable clock for the fake-clock tests.
 */

/** Shared constants. The fixture repeats them, and both sides assert they match. */
export const TETHER = {
  /** Ceiling of the first retry's window. */
  baseMs: 1_000,
  /** No retry window grows past this. */
  capMs: 30_000,
  /** No retry is scheduled sooner than this, so a broken server is not hammered. */
  floorMs: 250,
  /** How long a dropped turn retries visibly before it parks. */
  activeWindowMs: 3 * 60_000,
  /** While waiting or parked: a quiet probe on this interval, in case no trigger ever fires. */
  probeMs: 60_000,
  /** The resume route's heartbeat (src/lib/chat/stream-replay.ts REPLAY_HEARTBEAT_MS). */
  heartbeatMs: 15_000,
  /** A resumed stream silent for this long is failed rather than trusted. */
  staleAfterMs: 2 * 15_000,
} as const;

export type TetherPhase = "connected" | "reconnecting" | "waiting" | "parked";

/** What made an attempt start early. `manual` is a person pressing something. */
export type TetherTrigger = "network" | "foreground" | "wake" | "manual";

export interface TetherState {
  readonly phase: TetherPhase;
  /** Retries since the outage (or the last trigger) began; picks the backoff window. */
  readonly attempt: number;
  /** Whether the device reports a network. Only an `offline` event clears it. */
  readonly online: boolean;
  /** When the current active window started (the drop, or the last trigger). */
  readonly since: number | null;
  /**
   * When the next attempt is due, in the caller's clock. `null` while
   * connected, and while an attempt is under way — a trigger arriving then
   * does not start a second one.
   */
  readonly retryAt: number | null;
}

export type TetherEvent =
  /** The live stream ended or failed without the turn's terminal frame. */
  | { readonly type: "drop" }
  /** The timer (or a trigger) said go: an attempt is now under way. */
  | { readonly type: "attempt" }
  /** An attempt failed before any frame arrived. */
  | { readonly type: "failed" }
  /** Frames are flowing again. */
  | { readonly type: "connected" }
  /** The device reports no network (`offline`, an unsatisfied NWPath). */
  | { readonly type: "offline" }
  | { readonly type: "trigger"; readonly reason: TetherTrigger };

export const TETHER_CONNECTED: TetherState = {
  phase: "connected",
  attempt: 0,
  online: true,
  since: null,
  retryAt: null,
};

/**
 * The wait before retry number `attempt` (0-based), for a uniform `unit` in
 * [0, 1). Floored to whole milliseconds so both platforms agree to the digit.
 */
export function tetherDelayMs(attempt: number, unit: number): number {
  const n = Math.max(0, Math.floor(attempt));
  // 2^n overflows nothing here: past ~5 doublings the cap has already won.
  const ceiling = Math.min(TETHER.capMs, TETHER.baseMs * 2 ** Math.min(n, 30));
  const u = Math.min(Math.max(unit, 0), 1);
  return Math.floor(TETHER.floorMs + u * (ceiling - TETHER.floorMs));
}

/** After a failure (or a drop): the next state, from whether we are online and how long this has gone on. */
function backOff(state: TetherState, now: number, unit: number, attempt: number, since: number): TetherState {
  if (!state.online) {
    return { phase: "waiting", attempt, online: false, since, retryAt: now + TETHER.probeMs };
  }
  if (now - since >= TETHER.activeWindowMs) {
    return { phase: "parked", attempt, online: true, since, retryAt: now + TETHER.probeMs };
  }
  return { phase: "reconnecting", attempt, online: true, since, retryAt: now + tetherDelayMs(attempt, unit) };
}

/**
 * The policy. `unit` is a uniform random number in [0, 1); only the events
 * that schedule a backoff read it.
 */
export function tetherStep(state: TetherState, event: TetherEvent, now: number, unit = 0): TetherState {
  switch (event.type) {
    case "connected":
      return { ...TETHER_CONNECTED };
    case "drop":
      // A drop from a live stream opens a fresh window. A "drop" while not
      // connected is an attempt that ended without frames: a failure.
      if (state.phase === "connected") return backOff(state, now, unit, 0, now);
      return tetherStep(state, { type: "failed" }, now, unit);
    case "failed": {
      if (state.phase === "connected") return state;
      return backOff(state, now, unit, state.attempt + 1, state.since ?? now);
    }
    case "attempt":
      if (state.phase === "connected") return state;
      return { ...state, retryAt: null };
    case "offline":
      if (state.phase === "connected") return { ...state, online: false };
      // An attempt under way is left to fail on its own; a scheduled one is
      // pointless until the network is back.
      if (state.retryAt === null) return { ...state, online: false };
      return { ...state, phase: "waiting", online: false, retryAt: now + TETHER.probeMs };
    case "trigger": {
      const online = event.reason === "network" ? true : state.online;
      if (state.phase === "connected") return { ...state, online };
      return {
        phase: "reconnecting",
        attempt: 0,
        online,
        since: now,
        // Under way already: let it finish rather than start a second one.
        retryAt: state.retryAt === null ? null : now,
      };
    }
  }
}

/** Whole seconds until the next attempt, for "Reconnecting in 5s"; null when none is counting down. */
export function tetherRetryInSeconds(state: Pick<TetherState, "phase" | "retryAt">, now: number): number | null {
  if (state.phase !== "reconnecting" || state.retryAt === null) return null;
  const ms = state.retryAt - now;
  return ms > 0 ? Math.ceil(ms / 1000) : null;
}

/**
 * What a transcript shows for a turn's connection. `undefined` means
 * connected — say nothing. Carried on the message so the bubble that is
 * waiting is the one that says so.
 */
export type TetherView = { readonly phase: Exclude<TetherPhase, "connected">; readonly retryAt: number | null };

export function tetherView(state: TetherState): TetherView | undefined {
  if (state.phase === "connected") return undefined;
  return { phase: state.phase, retryAt: state.phase === "reconnecting" ? state.retryAt : null };
}

// ── Driver ─────────────────────────────────────────────────────────────────

/** Time and randomness, injectable for the fake-clock tests. */
export interface TetherClock {
  now(): number;
  random(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const systemTetherClock: TetherClock = {
  now: () => Date.now(),
  random: () => Math.random(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Where triggers come from. `browserTetherSignals` is the web's; tests pass their own. */
export interface TetherSignals {
  /** Whether the device currently reports a network. */
  online(): boolean;
  /** Calls back on every trigger and on going offline; returns the unsubscribe. */
  subscribe(listener: (signal: TetherTrigger | "offline") => void): () => void;
}

export const noTetherSignals: TetherSignals = { online: () => true, subscribe: () => () => {} };

/**
 * One dropped turn's reconnect loop state.
 *
 *   const link = new TetherLink({ onChange });
 *   link.drop();
 *   while (await link.nextAttempt(signal)) {
 *     … try; on the first frame call link.connected(); on a drop link.drop() …
 *   }
 *
 * `nextAttempt` resolves `true` when it is time to try (the backoff ran out,
 * or a trigger fired) and `false` when `signal` aborted. It never resolves
 * `false` on its own: there is no give-up.
 */
export class TetherLink {
  private current: TetherState;
  private readonly clock: TetherClock;
  private readonly onChange?: (state: TetherState) => void;
  private timer: unknown = null;
  private waiter: ((go: boolean) => void) | null = null;
  private readonly unsubscribe: () => void;

  constructor(options: { clock?: TetherClock; signals?: TetherSignals; onChange?: (state: TetherState) => void } = {}) {
    this.clock = options.clock ?? systemTetherClock;
    this.onChange = options.onChange;
    const signals = options.signals ?? noTetherSignals;
    this.current = { ...TETHER_CONNECTED, online: signals.online() };
    this.unsubscribe = signals.subscribe((signal) => {
      if (signal === "offline") this.dispatch({ type: "offline" });
      else this.trigger(signal);
    });
  }

  get state(): TetherState {
    return this.current;
  }

  drop(): void {
    this.dispatch({ type: "drop" });
  }

  failed(): void {
    this.dispatch({ type: "failed" });
  }

  connected(): void {
    if (this.current.phase !== "connected") this.dispatch({ type: "connected" });
  }

  trigger(reason: TetherTrigger): void {
    this.dispatch({ type: "trigger", reason });
  }

  dispatch(event: TetherEvent): void {
    const next = tetherStep(this.current, event, this.clock.now(), this.clock.random());
    if (next === this.current) return;
    this.current = next;
    this.onChange?.(next);
    this.arm();
  }

  /** Resolves when the next attempt should start; see the class comment. */
  nextAttempt(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    this.waiter?.(false);
    return new Promise<boolean>((resolve) => {
      const onAbort = () => finish(false);
      const finish = (go: boolean) => {
        if (this.waiter !== finish) return;
        this.waiter = null;
        signal?.removeEventListener("abort", onAbort);
        if (go) this.dispatch({ type: "attempt" });
        resolve(go);
      };
      this.waiter = finish;
      signal?.addEventListener("abort", onAbort, { once: true });
      this.arm();
    });
  }

  dispose(): void {
    this.unsubscribe();
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    this.timer = null;
    this.waiter?.(false);
  }

  /** (Re)schedule the waiter's wake-up for the current `retryAt`. */
  private arm(): void {
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    this.timer = null;
    const waiter = this.waiter;
    const due = this.current.retryAt;
    if (!waiter || this.current.phase === "connected") return;
    if (due === null) {
      // Nothing scheduled and nothing under way: only reachable before the
      // first drop. Go now rather than wait forever.
      waiter(true);
      return;
    }
    const ms = due - this.clock.now();
    if (ms <= 0) {
      waiter(true);
      return;
    }
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      this.waiter?.(true);
    }, ms);
  }
}

// ── The web's triggers ─────────────────────────────────────────────────────

/** A timer that fires this much later than asked means the machine slept. */
const WAKE_TICK_MS = 5_000;
const WAKE_GAP_MS = 20_000;

/**
 * `online` / `offline`, the page becoming visible, and a wake detected from
 * timer drift (the web has no wake event; a 5 s tick that lands 20 s late is a
 * machine that was asleep). SSR-safe: off the browser it is `noTetherSignals`.
 */
export function browserTetherSignals(): TetherSignals {
  if (typeof window === "undefined" || typeof document === "undefined") return noTetherSignals;
  return {
    online: () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
    subscribe(listener) {
      const onOnline = () => listener("network");
      const onOffline = () => listener("offline");
      const onVisible = () => {
        if (document.visibilityState === "visible") listener("foreground");
      };
      let last = Date.now();
      const tick = window.setInterval(() => {
        const now = Date.now();
        if (now - last > WAKE_TICK_MS + WAKE_GAP_MS) listener("wake");
        last = now;
      }, WAKE_TICK_MS);
      window.addEventListener("online", onOnline);
      window.addEventListener("offline", onOffline);
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        window.clearInterval(tick);
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
        document.removeEventListener("visibilitychange", onVisible);
      };
    },
  };
}

/**
 * Read a resumed stream, failing it when it goes silent.
 *
 * The resume routes heartbeat every `heartbeatMs`, so twice that with no frame
 * at all is a socket that is not coming back (a laptop that slept through a
 * NAT timeout keeps a dead fetch open indefinitely). Aborting it hands the
 * loop back to the policy instead of trusting it forever.
 */
export function staleGuard(parent: AbortSignal | undefined, clock: TetherClock = systemTetherClock) {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  let timer: unknown = null;
  let stale = false;
  const arm = () => {
    if (timer !== null) clock.clearTimer(timer);
    timer = clock.setTimer(() => {
      stale = true;
      controller.abort();
    }, TETHER.staleAfterMs);
  };
  arm();
  return {
    signal: controller.signal,
    /** Call on every frame, heartbeats included. */
    beat: arm,
    /** Whether the guard (rather than the caller) ended the read. */
    get stale() {
      return stale;
    },
    dispose() {
      if (timer !== null) clock.clearTimer(timer);
      timer = null;
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}
