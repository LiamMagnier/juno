"use client";

import * as React from "react";

import { RunSweep } from "@/components/chat/run/run-sweep";
import { PhraseWithArgs } from "@/lib/i18n-phrase";
import type { PhraseLine } from "@/lib/run/types";
import { cn } from "@/lib/utils";

/*
 * The run line's phase label (SPEC §7.3, §7.5): the phrase swap with its
 * mount-only entrance, and the compositor-only shimmer while live. Its motion
 * identity is `motionKey` (phase + subject), never the rendered string, so a
 * late translation or a new count never replays the swap.
 *
 * Two stacked items share one grid cell: the new one enters with the
 * `@starting-style` rise, the old one leaves upward on the fast rung and
 * unmounts. The live → settled change is the same swap (the summary is a new
 * key), so the type size never transitions: the reading-size live label
 * cross-fades into the UI-size summary.
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

interface Shown {
  key: string;
  line: PhraseLine;
  live: boolean;
}

/** How long a leaving label stays mounted: the fast rung it leaves on, plus a frame. */
const LEAVE_MS = 140;

export function RunLabel({ line, motionKey, live, calm = false, loopId, className }: RunLabelProps) {
  // The current label renders from props; state only remembers what was on
  // screen under the previous key, so it can leave while the new one enters.
  const [state, setState] = React.useState<{ current: Shown; leaving: Shown | null }>(() => ({
    current: { key: motionKey, line, live },
    leaving: null,
  }));
  if (state.current.key !== motionKey) {
    setState({ current: { key: motionKey, line, live }, leaving: state.current });
  } else if (state.current.line !== line || state.current.live !== live) {
    setState({ current: { key: motionKey, line, live }, leaving: state.leaving });
  }

  const leavingKey = state.leaving?.key;
  React.useEffect(() => {
    if (leavingKey === undefined) return;
    const timer = setTimeout(() => setState((s) => (s.leaving?.key === leavingKey ? { ...s, leaving: null } : s)), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [leavingKey]);

  return (
    <span className={cn("run-label min-w-0 flex-1", className)}>
      {state.leaving ? (
        <span key={`leaving:${state.leaving.key}`} className={itemClass(state.leaving.live)} data-leaving="" aria-hidden="true">
          <PhraseWithArgs spec={state.leaving.line} />
        </span>
      ) : null}
      <span key={`current:${motionKey}`} className={itemClass(live)}>
        {live ? (
          <RunSweep live calm={calm} loopId={loopId}>
            <PhraseWithArgs spec={line} />
          </RunSweep>
        ) : (
          <PhraseWithArgs spec={line} />
        )}
      </span>
    </span>
  );
}

function itemClass(live: boolean): string {
  // `leading-6` last: a font-size rung carries its own line height, and the row's height must
  // not change between the reading-size live label and the UI-size summary.
  return cn("run-label__item", live ? "text-reading text-muted-foreground" : "text-ui font-medium text-foreground/80", "leading-6");
}
