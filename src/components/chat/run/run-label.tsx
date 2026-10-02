"use client";

import * as React from "react";
import type { PhraseLine } from "@/lib/run/types";

/*
 * The run line's phase label (SPEC §7.3, §7.5): the phrase swap with its
 * mount-only entrance, and the compositor-only shimmer while live. Its motion
 * identity is `motionKey` (phase + subject), never the rendered string, so a
 * late translation or a new count never replays the swap.
 *
 * WS0 STUB: final props, placeholder body. WS5 builds it.
 */

export interface RunLabelProps {
  /** What the label says: complete phrases plus argument nodes. */
  line: PhraseLine;
  /** Animation identity: a new key swaps the label; a new line under the same key only updates it. */
  motionKey: string;
  /** Live (shimmering, reading size) or settled (the summary, UI size). */
  live: boolean;
  /** No shimmer: ≥ 20 s of work, a stall, or a long Research run. */
  calm?: boolean;
  /** The loop id of the glyph beside it; the shimmer runs only while that id owns the loop. */
  loopId: string;
  className?: string;
}

export function RunLabel({ className }: RunLabelProps) {
  return <span data-stub="run-label" className={className} />;
}
