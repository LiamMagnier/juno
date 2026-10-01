/**
 * The Continuum thinking mark's timing, as a pure state machine.
 *
 * docs/rework/brand/MOTION_AND_THINKING.md: the silhouette never moves; a
 * tonal handoff passes presence ink along the four blades in order. One pass
 * when work starts; a new real event may ask for another, but passes coalesce
 * to at most one per 1.6 s, so streaming deltas cannot keep it running. With
 * no new events the mark holds still. Finished settles once; waiting and error
 * are static. Pending states keep the inherited loader contract
 * (INTERACTION_SPEC TIMING): nothing for the first 200 ms, then at least
 * 400 ms on screen before a status replaces it. Off-screen or in a hidden tab
 * nothing starts, and nothing missed is replayed.
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
  /** V3 `base`: one blade's tone transition toward presence ink (and back). */
  tone: 220,
  /** V3 `press`: offset between adjacent blades in a pass. */
  stagger: 70,
  /** Passes coalesce: at most one starts per this window. */
  cooldown: 1600,
  /** V3 `emphasis`: the single settle on finished. */
  settle: 560,
} as const;

export const THINKING_BLADES = 4;

/** One pass: each blade rises and falls (2 x tone), the last starting 3 staggers after the first. */
export const THINKING_PASS_MS = 2 * THINKING_TIMING.tone + THINKING_TIMING.stagger * (THINKING_BLADES - 1);

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
  /** Start of the running or most recent pass; the cooldown counts from here. */
  readonly passAt: number | null;
  /** Increments per pass, so a renderer can restart its animation. */
  readonly passId: number;
  /** A pass was asked for inside the cooldown; it starts when the cooldown ends. At most one waits. */
  readonly queuedPass: boolean;
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
    queuedPass: false,
    settleAt: null,
    settleId: 0,
    paused: opts.paused ?? false,
    reducedMotion: opts.reducedMotion ?? false,
  };
}

function startPass(s: ThinkingState, now: number): ThinkingState {
  // Work that has already ended (a result waiting out the pending minimum) starts nothing new.
  const ending = s.requested !== s.shown && !isPendingPhase(s.requested);
  if (s.reducedMotion || s.paused || !s.visible || !isPendingPhase(s.shown) || ending) return { ...s, queuedPass: false };
  if (s.passAt === null || now - s.passAt >= THINKING_TIMING.cooldown) {
    return { ...s, passAt: now, passId: s.passId + 1, queuedPass: false };
  }
  return { ...s, queuedPass: true };
}

/** Put a non-pending phase on screen. */
function apply(s: ThinkingState, phase: ThinkingPhase, now: number): ThinkingState {
  const settle = phase === "finished" && s.visible && !s.reducedMotion && !s.paused;
  return {
    ...s,
    shown: phase,
    pendingSince: null,
    shownAt: null,
    queuedPass: false,
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
          // On screen already (waiting -> thinking, thinking -> working): the change is itself a real event.
          const next: ThinkingState = {
            ...s,
            requested: p,
            shown: p,
            settleAt: null,
            pendingSince: wasPending ? s.pendingSince : now,
            shownAt: wasPending ? s.shownAt : now,
          };
          return startPass(next, now);
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
      return startPass(s, now);
    }
    case "tick": {
      let next = s;
      if (isPendingPhase(next.shown) && !next.visible && !next.suppressed && next.pendingSince !== null && now - next.pendingSince >= THINKING_TIMING.showDelay) {
        next = startPass({ ...next, visible: true, shownAt: now }, now); // one pass on start
      }
      if (next.requested !== next.shown && !isPendingPhase(next.requested) && next.shownAt !== null && now - next.shownAt >= THINKING_TIMING.minVisible) {
        next = apply(next, next.requested, now);
      }
      if (next.queuedPass && next.passAt !== null && now - next.passAt >= THINKING_TIMING.cooldown) {
        next = startPass({ ...next, queuedPass: false, passAt: next.passAt }, now);
      }
      if (next.settleAt !== null && now - next.settleAt >= THINKING_TIMING.settle) next = { ...next, settleAt: null };
      return next;
    }
    case "visibility": {
      const paused = !input.visible;
      if (paused === s.paused) return s;
      return paused ? { ...s, paused, queuedPass: false, settleAt: null } : { ...s, paused };
    }
    case "motion": {
      if (input.reduced === s.reducedMotion) return s;
      return input.reduced ? { ...s, reducedMotion: true, queuedPass: false, settleAt: null } : { ...s, reducedMotion: false };
    }
  }
}

/** A pass is drawing right now. */
export function passActive(s: ThinkingState, now: number): boolean {
  return s.visible && !s.paused && !s.reducedMotion && isPendingPhase(s.shown) && s.passAt !== null && now - s.passAt < THINKING_PASS_MS;
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
  if (s.queuedPass && s.passAt !== null) at.push(s.passAt + THINKING_TIMING.cooldown);
  if (s.settleAt !== null) at.push(s.settleAt + THINKING_TIMING.settle);
  if (passActive(s, now) && s.passAt !== null) at.push(s.passAt + THINKING_PASS_MS);
  const future = at.filter((t) => Number.isFinite(t));
  return future.length ? Math.max(now, Math.min(...future)) : null;
}
