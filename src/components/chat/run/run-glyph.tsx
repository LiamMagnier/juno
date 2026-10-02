"use client";

import * as React from "react";
import type { RunPhase } from "@/lib/run/types";

/*
 * The run glyph (SPEC §7.4, "Concept A"): an 18 px 3 × 3 dot matrix whose lit
 * layer loops opacity only, one pattern per phase, gathering into the resting
 * dot at done. The same element lives from send to done.
 *
 * WS0 STUB: final props, placeholder body. WS5 builds it on the `.run-glyph`
 * rules already in globals.css.
 */

export interface RunGlyphProps {
  phase: RunPhase | "paused";
  /** ≥ 20 s of continuous work: every period doubles to `--loop-calm`. */
  calm?: boolean;
  /** "sm" = the 14 px grid of 3 px dots, for the artifact card. */
  size?: "md" | "sm";
  /** Registers with the one-loop arbiter (SPEC §7.9.1). */
  loopId: string;
}

export function RunGlyph({ phase, size = "md" }: RunGlyphProps) {
  return <span data-stub="run-glyph" data-phase={phase} data-size={size} aria-hidden="true" />;
}
