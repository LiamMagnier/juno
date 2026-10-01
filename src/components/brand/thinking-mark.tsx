"use client";

import "./thinking-mark.css";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { continuumDrawing } from "./continuum-geometry";
import {
  initThinking,
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
   * Changes whenever a real batch of reasoning or tool activity arrives. Each
   * change may ask for another pass; passes coalesce to one per 1.6 s.
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

/**
 * The Continuum thinking mark (MOTION_AND_THINKING.md): the stationary mark,
 * with presence ink handed along its four blades when real work starts and
 * when new real activity arrives. It never spins, pulses on a loop or measures
 * anything; the words beside it carry the state. Timing lives in
 * thinking-schedule.ts.
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

  const lastEvent = useRef(eventKey);
  useEffect(() => {
    if (lastEvent.current === eventKey) return;
    lastEvent.current = eventKey;
    dispatch({ type: "event", now: clock() });
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

  const drawing = continuumDrawing(size);
  const mode = view.passing ? "pass" : view.settling ? "settle" : "rest";
  return (
    <span
      ref={root}
      className={cn("alevr-thinking-mark", className)}
      data-visible={view.visible ? "true" : "false"}
      data-phase={view.shown}
      data-reduced={view.reduced ? "" : undefined}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <svg viewBox={drawing.viewBox} width={size} height={size} focusable="false" aria-hidden="true">
        <g key={mode === "pass" ? `pass-${view.passId}` : mode === "settle" ? `settle-${view.settleId}` : "rest"} data-mode={mode}>
          {drawing.paths.map((p, i) => (
            <path key={p.id} data-blade={p.id} d={p.d} style={{ "--blade": i } as CSSProperties} />
          ))}
        </g>
      </svg>
    </span>
  );
}
