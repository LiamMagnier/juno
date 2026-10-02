/**
 * The Continuum thinking mark's timing, as a pure state machine.
 *
 * docs/rework/brand/MOTION_AND_THINKING.md: the silhouette never moves; a
 * tonal handoff passes presence ink along the four blades in order, one blade
 * at a time. One pass when work starts. A new real step (a tool call, a new
 * summary section: never a token) may ask for another, but a request inside
 * the coalescing window is absorbed, not deferred, and while steps keep
 * arriving the window backs off (1.6 s, then 3.2 s, then 6.4 s; it resets after
 * a quiet gap), so a stream can never turn the mark into a beat. With no new
 * steps the mark holds still. Finished settles once; waiting and error are
 * static. Pending states keep the inherited loader contract (INTERACTION_SPEC
 * TIMING): nothing for the first 200 ms, then at least 400 ms on screen before
 * a status replaces it. Off-screen or in a hidden tab nothing starts, and
 * nothing missed is replayed.
 *
 * No React, no DOM, no clock: every input carries `now` (ms), and
 * `nextWake` says when the caller should feed the next `tick`. The component
 * (thinking-mark.tsx) is a thin shell around this; tests drive it directly.
 */

export type ThinkingPhase = "thinking" | "working" | "waiting" | "finished" | "error" | "idle";

export const THINKING_TIMING = {
  /** INTERACTION_SPEC TIMING.showDelay: a pending indicator waits this long before it appears. */
  showDelay: 200,
  /** TIMING.minVisible: once shown, a pending indicator stays at least this long. */
  minVisible: 400,
  /** V3 `fast`: one blade rising toward presence ink. */
  rise: 120,
  /**
   * V3 `base`: the same blade falling back to rest, on out-soft too: the
   * presence leaves at once and only an afterglow lingers, so as the next
   * blade rises this one is already well down.
   */
  fall: 220,
  /**
   * V3 `fast`: offset between adjacent blades. Equal to the rise, so the next
   * blade starts as this one peaks: only one blade is ever at its peak, and
   * attention is handed on rather than swept.
   */
  stagger: 120,
  /** The coalescing window after a pass, while steps arrive at a calm rate. */
  window: 1600,
  /** The longest the window grows to while steps keep streaming (1.6 -> 3.2 -> 6.4 s). */
  windowMax: 6400,
  /** A gap this long with no step ends the stream: the window returns to 1.6 s. */
  quietGap: 1600,
  /** V3 `fast`: an interrupted pass fades back to rest over this, from wherever it is. */
  release: 120,
  /** V3 `emphasis`: the single settle on finished. */
  settle: 560,
} as const;

export const THINKING_BLADES = 4;

/** One pass: the last blade starts three staggers after the first, then rises and falls. */
export const THINKING_PASS_MS = THINKING_TIMING.stagger * (THINKING_BLADES - 1) + THINKING_TIMING.rise + THINKING_TIMING.fall;

export const isPendingPhase = (p: ThinkingPhase): boolean => p === "thinking" || p === "working";

export type ThinkingState = {
  /** The latest phase the caller asked for. */
  readonly requested: ThinkingPhase;
  /** The phase on screen (lags `requested` while a pending phase serves its minimum). */
  readonly shown: ThinkingPhase;
  /** Whether the mark is drawn at all. */
  readonly visible: boolean;
  /** A pending phase ended inside its show delay: nothing appeared, so nothing appears for the result. */
  readonly suppressed: boolean;
  readonly pendingSince: number | null;
  /** When the current pending phase became visible. */
  readonly shownAt: number | null;
  /** Start of the running or most recent pass; the window counts from here. */
  readonly passAt: number | null;
  /** Increments per pass, so a renderer can start its animation. */
  readonly passId: number;
  /** The current coalescing window (ms): doubles while steps stream, up to windowMax. */
  readonly window: number;
  /** A step arrived inside the window and was absorbed since the last pass. */
  readonly absorbed: boolean;
  /** The last step that reached the machine while it could draw (for the quiet gap). */
  readonly lastEventAt: number | null;
  readonly settleAt: number | null;
  readonly settleId: number;
  /** Off-screen, or the document is hidden. */
  readonly paused: boolean;
  readonly reducedMotion: boolean;
};

export type ThinkingInput =
  | { readonly type: "phase"; readonly phase: ThinkingPhase; readonly now: number }
  | { readonly type: "event"; readonly now: number }
  | { readonly type: "tick"; readonly now: number }
  | { readonly type: "visibility"; readonly visible: boolean; readonly now: number }
  | { readonly type: "motion"; readonly reduced: boolean; readonly now: number };

export function initThinking(phase: ThinkingPhase, now: number, opts: { reducedMotion?: boolean; paused?: boolean } = {}): ThinkingState {
  const pending = isPendingPhase(phase);
  return {
    requested: phase,
    shown: phase,
    visible: !pending,
    suppressed: false,
    pendingSince: pending ? now : null,
    shownAt: null,
    passAt: null,
    passId: 0,
    window: THINKING_TIMING.window,
    absorbed: false,
    lastEventAt: null,
    settleAt: null,
    settleId: 0,
    paused: opts.paused ?? false,
    reducedMotion: opts.reducedMotion ?? false,
  };
}

/** Whether a pass could draw right now. */
function canPass(s: ThinkingState): boolean {
  // Work that has already ended (a result waiting out the pending minimum) starts nothing new.
  const ending = s.requested !== s.shown && !isPendingPhase(s.requested);
  return !s.reducedMotion && !s.paused && s.visible && isPendingPhase(s.shown) && !ending;
}

/** A real step (or the start of work) asks for a pass at `now`. */
function requestPass(s: ThinkingState, now: number): ThinkingState {
  if (!canPass(s)) return s;
  const T = THINKING_TIMING;
  let { window, absorbed } = s;
  // The stream went quiet: the next step is news again.
  if (s.lastEventAt !== null && now - s.lastEventAt >= T.quietGap) {
    window = T.window;
    absorbed = false;
  }
  if (s.passAt === null || now - s.passAt >= window) {
    // Steps kept arriving through the last window: give the next one longer.
    const next = absorbed ? Math.min(window * 2, T.windowMax) : window;
    return { ...s, passAt: now, passId: s.passId + 1, window: next, absorbed: false, lastEventAt: now };
  }
  // Inside the window: absorbed. Nothing is queued; the mark holds still.
  return { ...s, window, absorbed: true, lastEventAt: now };
}

/** Put a non-pending phase on screen. */
function apply(s: ThinkingState, phase: ThinkingPhase, now: number): ThinkingState {
  const settle = phase === "finished" && s.visible && !s.reducedMotion && !s.paused;
  return {
    ...s,
    shown: phase,
    pendingSince: null,
    shownAt: null,
    absorbed: false,
    window: THINKING_TIMING.window,
    lastEventAt: null,
    settleAt: settle ? now : null,
    settleId: settle ? s.settleId + 1 : s.settleId,
  };
}

export function stepThinking(s: ThinkingState, input: ThinkingInput): ThinkingState {
  const { now } = input;
  switch (input.type) {
    case "phase": {
      const p = input.phase;
      if (p === s.requested) return s;
      if (isPendingPhase(p)) {
        const wasPending = isPendingPhase(s.shown);
        if (s.visible && !s.suppressed) {
          // On screen already (waiting -> thinking, thinking -> working): the change is itself a real step.
          const next: ThinkingState = {
            ...s,
            requested: p,
            shown: p,
            settleAt: null,
            pendingSince: wasPending ? s.pendingSince : now,
            shownAt: wasPending ? s.shownAt : now,
          };
          return requestPass(next, now);
        }
        // Not on screen: (re)start the show delay, unless one is already counting.
        return {
          ...s,
          requested: p,
          shown: p,
          visible: false,
          suppressed: false,
          settleAt: null,
          pendingSince: wasPending && s.pendingSince !== null ? s.pendingSince : now,
          shownAt: null,
        };
      }
      // Leaving (or never in) a pending phase.
      if (isPendingPhase(s.shown) && !s.visible) {
        // Ended inside the show delay: nothing flashes. Statuses that need the person still show.
        if (p === "waiting" || p === "error") return apply({ ...s, requested: p, visible: true, suppressed: false }, p, now);
        return apply({ ...s, requested: p, suppressed: true }, p, now);
      }
      if (isPendingPhase(s.shown) && s.shownAt !== null && now - s.shownAt < THINKING_TIMING.minVisible) {
        return { ...s, requested: p }; // served on the tick at shownAt + minVisible
      }
      const needsPerson = p === "waiting" || p === "error";
      return apply({ ...s, requested: p, visible: s.visible || needsPerson, suppressed: s.suppressed && !needsPerson }, p, now);
    }
    case "event": {
      if (!isPendingPhase(s.shown) || !s.visible) return s;
      return requestPass(s, now);
    }
    case "tick": {
      let next = s;
      if (isPendingPhase(next.shown) && !next.visible && !next.suppressed && next.pendingSince !== null && now - next.pendingSince >= THINKING_TIMING.showDelay) {
        next = requestPass({ ...next, visible: true, shownAt: now }, now); // one pass on start
      }
      if (next.requested !== next.shown && !isPendingPhase(next.requested) && next.shownAt !== null && now - next.shownAt >= THINKING_TIMING.minVisible) {
        next = apply(next, next.requested, now);
      }
      if (next.settleAt !== null && now - next.settleAt >= THINKING_TIMING.settle) next = { ...next, settleAt: null };
      return next;
    }
    case "visibility": {
      const paused = !input.visible;
      if (paused === s.paused) return s;
      // A pass already drawing finishes on its own clock (nothing cuts to rest); nothing new starts while paused.
      return paused ? { ...s, paused, settleAt: null } : { ...s, paused };
    }
    case "motion": {
      if (input.reduced === s.reducedMotion) return s;
      return input.reduced ? { ...s, reducedMotion: true, settleAt: null } : { ...s, reducedMotion: false };
    }
  }
}

/** A pass is drawing right now (its blades are handing presence along). */
export function passActive(s: ThinkingState, now: number): boolean {
  return s.visible && !s.reducedMotion && isPendingPhase(s.shown) && s.passAt !== null && now - s.passAt < THINKING_PASS_MS;
}

/** The finished settle is drawing right now. */
export function settleActive(s: ThinkingState, now: number): boolean {
  return s.settleAt !== null && !s.reducedMotion && !s.paused && now - s.settleAt < THINKING_TIMING.settle;
}

/** The next time the caller must feed a `tick`, or null when nothing is scheduled. */
export function nextWake(s: ThinkingState, now: number): number | null {
  const at: number[] = [];
  if (isPendingPhase(s.shown) && !s.visible && !s.suppressed && s.pendingSince !== null) at.push(s.pendingSince + THINKING_TIMING.showDelay);
  if (s.requested !== s.shown && !isPendingPhase(s.requested) && s.shownAt !== null) at.push(s.shownAt + THINKING_TIMING.minVisible);
  if (s.settleAt !== null) at.push(s.settleAt + THINKING_TIMING.settle);
  const future = at.filter((t) => Number.isFinite(t));
  return future.length ? Math.max(now, Math.min(...future)) : null;
}

/**
 * The tone (0 rest, 1 peak) of blade `i` at `t` ms into a pass: a rise over
 * `rise` and a fall over `fall`, both on out-soft, blade i starting
 * i * stagger after the first. A pure model of what the renderer draws, for
 * tests and filmstrips; the renderer itself uses the same numbers.
 */
export function passTone(i: number, t: number): number {
  const T = THINKING_TIMING;
  const local = t - i * T.stagger;
  if (local <= 0 || local >= T.rise + T.fall) return 0;
  const outSoft = (x: number) => cubicBezierY(0.33, 1, 0.68, 1, x);
  return local < T.rise ? outSoft(local / T.rise) : 1 - outSoft((local - T.rise) / T.fall);
}

/** y of a CSS cubic-bezier(x1, y1, x2, y2) at progress x (Newton on x(t), then y(t)). */
function cubicBezierY(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const by = (t: number) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < x) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}
