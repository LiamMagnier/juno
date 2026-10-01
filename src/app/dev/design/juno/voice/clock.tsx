"use client";

import * as React from "react";
import { smoothed, type Talker } from "./signal";

/*
 * One clock for a voice scene. Everything that moves with sound (the string,
 * the listening caret, the mic's bars, the crew character's talking) reads
 * the same time, so a state is one coherent moment, and a frozen clock makes
 * a still exactly reproducible (?freeze=<ms>).
 *
 * Full motion: one requestAnimationFrame loop for the whole scene, each
 * subscriber draws straight to the DOM (no React render per frame).
 * Reduced motion (§1.7): the clock steps four times a second and nothing
 * eases between steps; a level is then a reading, not a motion.
 */

export interface Clock {
  /** Milliseconds of scene time. */
  now: () => number;
  frozen: boolean;
  reduced: boolean;
  subscribe: (fn: (t: number) => void) => () => void;
}

const STEP_REDUCED = 250;

const ClockCtx = React.createContext<Clock | null>(null);

export function ClockProvider({ freezeAt, start = 0, reduced = false, children }: { freezeAt?: number; start?: number; reduced?: boolean; children: React.ReactNode }) {
  const subs = React.useRef(new Set<(t: number) => void>());
  const origin = React.useRef<number | null>(null);
  const last = React.useRef(freezeAt ?? start);
  const frozen = freezeAt !== undefined;

  const clock = React.useMemo<Clock>(
    () => ({
      now: () => last.current,
      frozen,
      reduced,
      subscribe: (fn) => {
        subs.current.add(fn);
        fn(last.current);
        return () => {
          subs.current.delete(fn);
        };
      },
    }),
    [frozen, reduced],
  );

  React.useEffect(() => {
    if (frozen) {
      last.current = freezeAt!;
      subs.current.forEach((f) => f(last.current));
      return;
    }
    let raf = 0;
    let lastStep = -Infinity;
    const tick = (ts: number) => {
      if (origin.current === null) origin.current = ts;
      const t = start + (ts - origin.current);
      if (!reduced || t - lastStep >= STEP_REDUCED) {
        lastStep = reduced ? Math.floor(t / STEP_REDUCED) * STEP_REDUCED : t;
        last.current = reduced ? lastStep : t;
        subs.current.forEach((f) => f(last.current));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [frozen, freezeAt, start, reduced]);

  return <ClockCtx.Provider value={clock}>{children}</ClockCtx.Provider>;
}

export function useClock(): Clock {
  const c = React.useContext(ClockCtx);
  if (!c) throw new Error("voice: useClock outside a ClockProvider");
  return c;
}

/** Run `draw` on every clock tick (once, when frozen). `draw` must write to the DOM itself. */
export function useTick(draw: (t: number) => void, deps: React.DependencyList = []) {
  const clock = useClock();
  const ref = React.useRef(draw);
  React.useLayoutEffect(() => {
    ref.current = draw;
  });
  React.useLayoutEffect(() => clock.subscribe((t) => ref.current(t)), [clock, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** A React value sampled from the clock at most every `everyMs` (for the few things that must re-render: icon bars, a character's level). */
export function useSampled<T>(read: (t: number) => T, everyMs = 33, deps: React.DependencyList = []): T {
  const clock = useClock();
  const [v, setV] = React.useState<T>(() => read(clock.now()));
  const lastAt = React.useRef(-Infinity);
  const readRef = React.useRef(read);
  React.useLayoutEffect(() => {
    readRef.current = read;
  });
  React.useEffect(
    () =>
      clock.subscribe((t) => {
        if (clock.frozen || clock.reduced || t - lastAt.current >= everyMs || t < lastAt.current) {
          lastAt.current = t;
          setV(readRef.current(t));
        }
      }),
    [clock, everyMs, ...deps], // eslint-disable-line react-hooks/exhaustive-deps
  );
  return v;
}

/* —————————————————————————— The level source —————————————————————————— */

export type LevelFn = (t: number, who: Talker) => number;

const LevelCtx = React.createContext<LevelFn>(smoothed);

/**
 * Who is making sound, and how loud, at a scene time. Everything that listens
 * (the string, the listening caret, the mic's bars, a member's talking) reads
 * this one function; a scripted scene gates the synthetic voices to its own
 * timeline, the product passes the analysers.
 */
export function LevelProvider({ level, children }: { level: LevelFn; children: React.ReactNode }) {
  return <LevelCtx.Provider value={level}>{children}</LevelCtx.Provider>;
}

export function useLevel(): LevelFn {
  return React.useContext(LevelCtx);
}
