"use client";

import * as React from "react";
import { TIMING } from "@/lib/interaction";
import { cn } from "@/lib/utils";

/**
 * A placeholder is a well the content will fill (spec C21): `.skeleton`
 * (globals.css) is the muted fill pressed into its ground, breathing from 1 to
 * 0.62 over `--loop-breathe` (1.8s). Under the reduced tier the loop stops and
 * it holds at 0.8 (Tier C, sheet.css). `rounded-control`, because rows, chips
 * and small buttons — what a skeleton most often stands in for — are drawn at
 * that rung. Skeletons must mirror the final layout exactly.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("skeleton rounded-control", className)} aria-hidden="true" {...props} />;
}

/*
 * WHEN A SKELETON SHOWS (C21): not before `--delay-show` (200ms), so fast
 * work never flashes one; once shown, for at least `--hold-skeleton` (400ms),
 * so it never blinks. `createSkeletonGate` is the clock-driven rule, DOM-free
 * and tested with an injected clock; `useSkeletonGate` wires it to React.
 */

export interface GateClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: GateClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type SkeletonPhase = "idle" | "waiting" | "skeleton" | "content";

export interface SkeletonGate {
  setLoading(loading: boolean): void;
  phase(): SkeletonPhase;
  dispose(): void;
}

export function createSkeletonGate(onPhase: (phase: SkeletonPhase) => void, clock: GateClock = realClock): SkeletonGate {
  let phase: SkeletonPhase = "idle";
  let loading = false;
  let shownAt = 0;
  let timer: unknown = null;
  const set = (next: SkeletonPhase) => {
    if (next === phase) return;
    phase = next;
    onPhase(next);
  };
  const clear = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };
  return {
    setLoading(next) {
      if (next === loading) return;
      loading = next;
      clear();
      if (loading) {
        if (phase === "skeleton") return;
        set("waiting");
        timer = clock.setTimeout(() => {
          timer = null;
          shownAt = clock.now();
          set("skeleton");
        }, TIMING.show);
        return;
      }
      if (phase !== "skeleton") {
        set("content");
        return;
      }
      const left = TIMING.skeleton - (clock.now() - shownAt);
      if (left <= 0) set("content");
      else
        timer = clock.setTimeout(() => {
          timer = null;
          set("content");
        }, left);
    },
    phase: () => phase,
    dispose: clear,
  };
}

/** Whether to draw the skeleton for a load that is `loading`, under the C21 delay and minimum. */
export function useSkeletonGate(loading: boolean, clock?: GateClock): boolean {
  const [phase, setPhase] = React.useState<SkeletonPhase>("idle");
  const gate = React.useMemo(() => createSkeletonGate(setPhase, clock), [clock]);
  React.useEffect(() => {
    gate.setLoading(loading);
  }, [gate, loading]);
  React.useEffect(() => () => gate.dispose(), [gate]);
  return phase === "skeleton";
}

/**
 * A region that loads: while `loading`, it is aria-busy and says "Loading" to
 * assistive technology; the `skeleton` draws only after the 200ms delay and
 * stays at least 400ms; the content then cross-fades in over 160 with no
 * shift. Before the delay passes nothing is drawn (the region keeps its
 * height through `className`).
 */
export function SkeletonRegion({
  loading,
  skeleton,
  children,
  className,
  label = "Loading",
}: {
  loading: boolean;
  skeleton: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  label?: string;
}) {
  const showSkeleton = useSkeletonGate(loading);
  const busy = loading || showSkeleton;
  return (
    <div className={cn("ui-skeleton-region", className)} aria-busy={busy || undefined} data-loading={busy ? "" : undefined}>
      {busy ? <span className="sr-only">{label}</span> : null}
      {showSkeleton ? skeleton : busy ? null : <div className="ui-skeleton-content">{children}</div>}
    </div>
  );
}

export { Skeleton };
