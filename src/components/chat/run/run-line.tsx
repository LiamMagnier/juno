"use client";

import * as React from "react";
import type { RunView } from "@/lib/run/types";

/*
 * The run's one status line (SPEC §7.1, §7.5): glyph, label, facts, favicon
 * stack and clock while working; the summary and a chevron at rest. A press
 * toggles the inline timeline. It reads its paced phase from the phase store
 * under `renderKey`, so only the line re-renders when the phase changes.
 *
 * WS0 STUB: final props, placeholder body. WS5 builds it.
 */

export interface RunLineProps {
  /** The message's stable client key; the phase store is keyed by it. */
  renderKey: string;
  view: RunView;
  /** The turn is still streaming. */
  streaming: boolean;
  /** The inline timeline is open (aria-expanded). */
  expanded: boolean;
  onToggle(): void;
  /** id of the inline timeline; `aria-controls` is set only while it is mounted. */
  controlsId?: string;
  /** Loop-arbiter id for the glyph and the shimmer. */
  loopId: string;
}

export function RunLine({ expanded, onToggle }: RunLineProps) {
  return <button type="button" data-stub="run-line" aria-expanded={expanded} onClick={onToggle} />;
}
