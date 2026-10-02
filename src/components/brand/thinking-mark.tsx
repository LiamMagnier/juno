"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { continuumDrawingSet } from "./continuum-geometry";
import { ContinuumDrawings, outerViewBox } from "./continuum-mark";
import {
  THINKING_TIMING,
  initThinking,
  isPendingPhase,
  nextWake,
  passActive,
  settleActive,
  stepThinking,
  type ThinkingInput,
  type ThinkingPhase,
  type ThinkingState,
} from "./thinking-schedule";

export type { ThinkingPhase } from "./thinking-schedule";

export type ThinkingMarkProps = {
  /** The truthful runtime phase of the row this mark sits in. */
  phase: ThinkingPhase;
  /**
   * Changes once per real STEP of work: a tool call starting, a new section
   * of a supplied progress summary, a batch of search results. Never per
   * token or delta. A change may ask for another pass; inside the window it is
   * absorbed, and while steps keep coming the window backs off (1.6, 3.2,
   * 6.4 s). In development, more than two changes a second logs a warning.
   */
  eventKey?: string | number;
  /** CSS px; 16 to 20 beside a work row's text. */
  size?: number;
  /**
   * Accessible name. Omit (the default) when adjacent text states the phase,
   * which it always should: the mark is then hidden from assistive technology.
   */
  label?: string;
  /** Force reduced motion (demo and tests); otherwise the OS setting is followed. */
  reducedMotion?: boolean;
  className?: string;
};

type View = {
  visible: boolean;
  shown: ThinkingPhase;
  passing: boolean;
  passId: number;
  settling: boolean;
  settleId: number;
  reduced: boolean;
};

const viewOf = (s: ThinkingState, now: number): View => ({
  visible: s.visible,
  shown: s.shown,
  passing: passActive(s, now),
  passId: s.passId,
  settling: settleActive(s, now),
  settleId: s.settleId,
  reduced: s.reducedMotion,
});

const clock = (): number => (typeof performance === "undefined" ? 0 : performance.now());

/* ———————————————— The tone layer (Web Animations) ————————————————
 *
 * Each blade is drawn twice: in ink, and above it in presence ink at opacity
 * 0. A pass animates the upper copies' opacity. Every change of plan starts
 * from the tone a blade is at RIGHT NOW (read from its computed style), so
 * nothing ever cuts to rest in one frame: an interrupted pass fades back over
 * `release`, the finished settle begins where the pass left each blade, and a
 * pass that is running when the tab hides simply finishes on its own clock.
 */

const OUT_SOFT = "cubic-bezier(0.33, 1, 0.68, 1)";
const IN_OUT = "cubic-bezier(0.65, 0, 0.35, 1)";

function tonePaths(root: HTMLElement): SVGPathElement[][] {
  const byBlade: SVGPathElement[][] = [[], [], [], []];
  root.querySelectorAll<SVGPathElement>("[data-tone-blade]").forEach((p) => byBlade[Number(p.dataset.toneBlade)]?.push(p));
  return byBlade;
}

/** Cancel whatever a path is doing and return the opacity it was showing. */
function takeTone(p: SVGPathElement): number {
  const v = Number.parseFloat(getComputedStyle(p).opacity);
  for (const a of p.getAnimations()) a.cancel();
  return Number.isFinite(v) ? v : 0;
}

function tokens(root: HTMLElement) {
  const cs = getComputedStyle(root);
  const read = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const peak = Number.parseFloat(read("--tm-peak", "0.5"));
  return {
    outSoft: read("--ease-out-soft", OUT_SOFT),
    inOut: read("--ease-in-out", IN_OUT),
    peak: Number.isFinite(peak) ? peak : 0.5,
  };
}

function runPass(root: HTMLElement) {
  const T = THINKING_TIMING;
  const { outSoft, peak } = tokens(root);
  const crest = T.rise / (T.rise + T.fall);
  tonePaths(root).forEach((paths, i) => {
    for (const p of paths) {
      const from = takeTone(p);
      p.animate(
        [
          { opacity: from, easing: outSoft },
          { opacity: peak, offset: crest, easing: outSoft },
          { opacity: 0 },
        ],
        { duration: T.rise + T.fall, delay: i * T.stagger, fill: "backwards" },
      );
    }
  });
}

function runRelease(root: HTMLElement) {
  const { outSoft } = tokens(root);
  for (const paths of tonePaths(root)) {
    for (const p of paths) {
      if (!p.getAnimations().length) continue;
      const from = takeTone(p);
      if (from > 0.004) p.animate([{ opacity: from }, { opacity: 0 }], { duration: THINKING_TIMING.release, easing: outSoft });
    }
  }
}

function runSettle(root: HTMLElement) {
  const { outSoft, inOut, peak } = tokens(root);
  for (const paths of tonePaths(root)) {
    for (const p of paths) {
      const from = takeTone(p);
      p.animate(
        [
          { opacity: from, easing: outSoft },
          { opacity: Math.max(from, peak * 0.5), offset: 0.21, easing: inOut },
          { opacity: 0 },
        ],
        { duration: THINKING_TIMING.settle },
      );
    }
  }
}

/**
 * The continuous hand-off while work is real (owner, 2026-10-02: "the logo
 * doesn't do anything, it's just here"): presence ink travels blade to blade,
 * clockwise, at a calmer tempo than an event pass and to a fuller peak, for as
 * long as the phase is thinking or working. It is the one loop the mark has,
 * and it is honest: it runs only while a reply is actually in progress, stops
 * when the tab is hidden, and is absent under reduced motion.
 */
const LOOP = { rise: 260, fall: 600, stagger: 200, gap: 340, peak: 1 } as const;
const LOOP_MS = LOOP.stagger * 3 + LOOP.rise + LOOP.fall + LOOP.gap;

function runLoopPass(root: HTMLElement) {
  const { outSoft } = tokens(root);
  const crest = LOOP.rise / (LOOP.rise + LOOP.fall);
  tonePaths(root).forEach((paths, i) => {
    for (const p of paths) {
      const from = takeTone(p);
      p.animate(
        [
          { opacity: from, easing: outSoft },
          { opacity: LOOP.peak, offset: crest, easing: outSoft },
          { opacity: 0 },
        ],
        { duration: LOOP.rise + LOOP.fall, delay: i * LOOP.stagger, fill: "backwards" },
      );
    }
  });
}

/**
 * The Continuum thinking mark (MOTION_AND_THINKING.md): the stationary mark,
 * with presence ink handed from blade to blade, clockwise, when real work
 * starts and when a new real step arrives. It never spins, pulses on a loop
 * or measures anything; the words beside it carry the state. At rest it takes
 * the colour of the row it sits in (currentColor), so it is never darker than
 * its own label. Timing lives in thinking-schedule.ts.
 */
export function ThinkingMark({ phase, eventKey, size = 16, label, reducedMotion, className }: ThinkingMarkProps) {
  const machine = useRef<ThinkingState>(initThinking(phase, 0, { reducedMotion: reducedMotion ?? false }));
  const [view, setView] = useState<View>(() => viewOf(machine.current, 0));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const root = useRef<HTMLSpanElement>(null);

  const dispatch = useCallback((input: ThinkingInput) => {
    const s = stepThinking(machine.current, input);
    machine.current = s;
    setView(viewOf(s, input.now));
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const wake = nextWake(s, input.now);
    if (wake !== null) timer.current = setTimeout(() => dispatch({ type: "tick", now: clock() }), Math.max(0, Math.ceil(wake - input.now)));
  }, []);

  // Rebase the machine's clock on mount: the server render used t = 0.
  useEffect(() => {
    const now = clock();
    machine.current = initThinking(machine.current.requested, now, { reducedMotion: machine.current.reducedMotion });
    dispatch({ type: "tick", now });
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [dispatch]);

  useEffect(() => {
    dispatch({ type: "phase", phase, now: clock() });
  }, [phase, dispatch]);

  const looping = view.visible && isPendingPhase(view.shown) && !view.reduced;
  useEffect(() => {
    const el = root.current;
    if (!looping || !el) return;
    const pass = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      runLoopPass(el);
    };
    pass();
    const id = setInterval(pass, LOOP_MS);
    return () => clearInterval(id);
  }, [looping]);

  const lastEvent = useRef(eventKey);
  const recent = useRef<number[]>([]);
  const warned = useRef(false);
  useEffect(() => {
    if (lastEvent.current === eventKey) return;
    lastEvent.current = eventKey;
    const now = clock();
    if (process.env.NODE_ENV !== "production" && !warned.current) {
      recent.current = [...recent.current.filter((t) => now - t < 1000), now];
      if (recent.current.length > 2) {
        warned.current = true;
        console.warn(
          "ThinkingMark: eventKey changed more than twice in a second. Change it once per real step of work (a tool call, a new summary section), never per token or delta.",
        );
      }
    }
    dispatch({ type: "event", now });
  }, [eventKey, dispatch]);

  // Reduced motion: the explicit prop wins, otherwise the OS preference, live.
  useEffect(() => {
    if (reducedMotion !== undefined) {
      dispatch({ type: "motion", reduced: reducedMotion, now: clock() });
      return;
    }
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => dispatch({ type: "motion", reduced: mq.matches, now: clock() });
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [reducedMotion, dispatch]);

  // Pause off-screen and in a hidden tab: nothing starts, nothing replays.
  useEffect(() => {
    const el = root.current;
    let inView = true;
    const apply = () => dispatch({ type: "visibility", visible: inView && document.visibilityState === "visible", now: clock() });
    let io: IntersectionObserver | null = null;
    if (el && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver((entries) => {
        inView = entries.some((e) => e.isIntersecting);
        apply();
      });
      io.observe(el);
    }
    document.addEventListener("visibilitychange", apply);
    apply();
    return () => {
      io?.disconnect();
      document.removeEventListener("visibilitychange", apply);
    };
  }, [dispatch]);

  // Drive the tone layer from the machine's view. Each branch starts from the current tone, and
  // only a change of plan touches it: a settle runs to its end; a pass is released (faded) only
  // when work stops being drawn mid-pass (a status replaced it, reduced motion turned on).
  const drawn = useRef<{ passId: number; settleId: number; mode: "rest" | "pass" | "settle" }>({ passId: 0, settleId: 0, mode: "rest" });
  useEffect(() => {
    const el = root.current;
    if (!el || typeof el.animate !== "function") return;
    const d = drawn.current;
    if (view.settling && view.settleId !== d.settleId) {
      d.settleId = view.settleId;
      d.mode = "settle";
      runSettle(el);
      return;
    }
    if (view.passing && view.passId !== d.passId) {
      d.passId = view.passId;
      d.mode = "pass";
      runPass(el);
      return;
    }
    const stopped = !isPendingPhase(view.shown) || !view.visible;
    if ((d.mode === "pass" && (stopped || view.reduced)) || (d.mode === "settle" && view.reduced)) {
      d.mode = "rest";
      runRelease(el);
    }
  }, [view.passing, view.passId, view.settling, view.settleId, view.shown, view.reduced, view.visible]);

  const set = continuumDrawingSet(size);
  return (
    <span
      ref={root}
      className={cn("alevr-thinking-mark", className)}
      data-visible={view.visible ? "true" : "false"}
      data-phase={view.shown}
      data-pass={view.passId}
      data-looping={looping ? "" : undefined}
      data-reduced={view.reduced ? "" : undefined}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <svg viewBox={outerViewBox(set, size, size)} width={size} height={size} focusable="false" aria-hidden="true">
        <ContinuumDrawings
          set={set}
          render={(d) => (
            <>
              <g className="tm-ink">
                {d.paths.map((p) => (
                  <path key={p.id} data-blade={p.id} d={p.d} />
                ))}
              </g>
              <g className="tm-tone">
                {d.paths.map((p, i) => (
                  <path key={p.id} data-tone-blade={i} d={p.d} />
                ))}
              </g>
            </>
          )}
        />
      </svg>
    </span>
  );
}
