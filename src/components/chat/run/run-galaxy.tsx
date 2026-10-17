"use client";

import * as React from "react";

import { GalaxyMark, type ThinkingPhase } from "@/components/brand/galaxy-mark";
import { useLoopClaim, useLoopOwner } from "@/lib/run/store";
import type { LoopPriority, RunPhase } from "@/lib/run/types";

/*
 * The run's working mark: the galaxy (docs/design/GALAXY_SPEC.md), placed by
 * the run UI's one-loop arbiter (SPEC §7.9.1).
 *
 * It took over from the 3 × 3 RunGlyph so a run shows one working mark
 * everywhere it appears: the transcript's run line, the activity panel and
 * the research plan row now draw the same galaxy as the live line, the task
 * card and the tool receipts.
 *
 * The arbiter still decides which mark moves. Only the id that owns the
 * page's loop turns; every other working mark holds the galaxy's still frame
 * at full ink, so a page with three live rows has one thing turning, never
 * three. A settled run steps back to 60%; a failure stops at full ink and
 * leaves the words to say what happened.
 */

export interface RunGalaxyProps {
  phase: RunPhase | "paused";
  /** Registers with the one-loop arbiter. */
  loopId: string;
  /**
   * Claim the loop for `loopId` at this priority while the phase is working.
   * Omit when an owner claims it for the mark (the run line, the panel).
   */
  claim?: LoopPriority;
  /** "md" 18 px beside a reading-size line; "sm" 14 px for a compact row. */
  size?: "md" | "sm";
  className?: string;
}

const THINKING: ReadonlySet<RunGalaxyProps["phase"]> = new Set(["queued", "thinking"]);
const WORKING: ReadonlySet<RunGalaxyProps["phase"]> = new Set(["searching", "reading", "tool", "writing"]);

/** Whether the phase is work in progress (the galaxy may turn). */
export function isTurningPhase(phase: RunGalaxyProps["phase"]): boolean {
  return THINKING.has(phase) || WORKING.has(phase);
}

/**
 * The galaxy phase for a run phase. A working phase turns only while this
 * mark owns the loop; otherwise it is the still frame ("waiting" stops the
 * clock without dimming).
 */
export function galaxyPhaseFor(phase: RunGalaxyProps["phase"], owns: boolean): ThinkingPhase {
  if (THINKING.has(phase)) return owns ? "thinking" : "waiting";
  if (WORKING.has(phase)) return owns ? "working" : "waiting";
  if (phase === "failed") return "error";
  if (phase === "answering" || phase === "done" || phase === "stopped") return "finished";
  return "waiting";
}

export function RunGalaxy({ phase, loopId, claim, size = "md", className }: RunGalaxyProps) {
  const turning = isTurningPhase(phase);
  useLoopClaim(loopId, claim ?? 4, claim !== undefined && turning);
  const owns = useLoopOwner(loopId);
  return <GalaxyMark phase={galaxyPhaseFor(phase, owns)} size={size === "sm" ? 14 : 18} className={className} />;
}
