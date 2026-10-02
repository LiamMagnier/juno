"use client";

import * as React from "react";

import { reducedMotionAt, useOffscreen, usePhaseLock } from "@/lib/run/loop-phase";
import { useLoopClaim, useLoopOwner } from "@/lib/run/store";
import type { LoopPriority, RunPhase } from "@/lib/run/types";
import { cn } from "@/lib/utils";

/*
 * The run glyph (SPEC §7.4, "Concept A"): an 18 px 3 × 3 dot matrix whose lit
 * layer loops opacity only, one pattern per phase, gathering into the resting
 * dot at done. The same element lives from send to done, so a phase change is
 * a change of attributes on one node, never a remount.
 *
 * The CSS in globals.css does all the drawing; this component only says which
 * phase, whether it is calm, whether it owns the page's one loop (anything
 * else shows the phase's static signature, §7.9.1), and keeps that loop
 * locked to the page clock.
 */

export interface RunGlyphProps {
  phase: RunPhase | "paused";
  /** ≥ 20 s of continuous work: every period doubles to `--loop-calm`. */
  calm?: boolean;
  /** "sm" = the 14 px grid of 3 px dots, for the artifact card. */
  size?: "md" | "sm";
  /** Registers with the one-loop arbiter (SPEC §7.9.1). */
  loopId: string;
  /**
   * Claim the loop for `loopId` at this priority while the phase loops. Omit
   * when the glyph's owner claims it (the run line claims for its glyph and
   * shimmer together); the artifact card passes 3.
   */
  claim?: LoopPriority;
  className?: string;
}

/** Row, column and the thinking sequence (perimeter clockwise 0–7, centre 8). */
const CELLS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [0, 1, 1], [0, 2, 2],
  [1, 0, 7], [1, 1, 8], [1, 2, 3],
  [2, 0, 6], [2, 1, 5], [2, 2, 4],
];

const LOOPING: ReadonlySet<RunGlyphProps["phase"]> = new Set(["queued", "thinking", "searching", "reading", "tool", "writing"]);

/** The dim-and-return between two looping patterns: 120 ms down, then the new phase. */
const SWAP_MS = 120;

export function isLoopingPhase(phase: RunGlyphProps["phase"]): boolean {
  return LOOPING.has(phase);
}

/** The period the loop runs at, for the phase lock: the beat for `tool`, doubled when calm. */
export function glyphPeriodMs(phase: RunGlyphProps["phase"], calm: boolean): number {
  if (calm) return 4_800;
  return phase === "tool" ? 1_200 : 2_400;
}

export function RunGlyph({ phase, calm = false, size = "md", loopId, claim, className }: RunGlyphProps) {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  const looping = LOOPING.has(phase);
  useLoopClaim(loopId, claim ?? 4, claim !== undefined && looping);
  const owner = useLoopOwner(loopId);
  useOffscreen(ref);

  // Phase swap (§7.4): between two looping patterns the lit channel dims, the
  // new pattern takes over with a fresh phase lock, and the channel returns.
  // Into a static or settled phase the change is immediate: the gather is its
  // own transition.
  const [shown, setShown] = React.useState(phase);
  const [swapping, setSwapping] = React.useState(false);
  React.useEffect(() => {
    if (phase === shown) return;
    if (!LOOPING.has(phase) || !LOOPING.has(shown) || reducedMotionAt(ref.current)) {
      setShown(phase);
      setSwapping(false);
      return;
    }
    setSwapping(true);
    const timer = setTimeout(() => {
      setShown(phase);
      setSwapping(false);
    }, SWAP_MS);
    return () => clearTimeout(timer);
  }, [phase, shown]);

  const loops = LOOPING.has(shown);
  const owns = loops && owner;
  usePhaseLock(ref, glyphPeriodMs(shown, calm));

  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={cn("run-glyph", className)}
      data-phase={shown}
      data-size={size}
      data-calm={calm && loops ? "" : undefined}
      data-swapping={swapping ? "" : undefined}
      data-loop={owns ? undefined : "off"}
      data-run-loop-owner={owns ? "" : undefined}
    >
      {CELLS.map(([r, c, s]) => (
        <i
          key={`${r}${c}`}
          data-r={r}
          data-c={c}
          data-centre={r === 1 && c === 1 ? "" : undefined}
          style={{ "--r": r, "--c": c, "--s": s } as React.CSSProperties}
        />
      ))}
    </span>
  );
}
