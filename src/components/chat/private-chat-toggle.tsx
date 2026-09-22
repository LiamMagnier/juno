"use client";

import * as React from "react";
import { EyeOff } from "@/components/ui/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The private-chat switch in the chat root's header cluster.
 *
 * A GLYPH FROM THE SET, not a mascot. This used to hand-draw a 48-unit ghost
 * whose eyes tracked the pointer and whose body floated on hover — a charming
 * object, and the one interface icon in the header drawn on a different grid,
 * at a different line weight, from the two buttons it sits between (Share and
 * the model parameters). An eye with a slash through it says the same thing
 * — nothing here is kept — in the house line.
 *
 * ON IS THE FILLED CUT. `weight="fill"` is the set's word for "on"
 * (ICONS_AND_MOTION.md §1.2), so the two states are two drawings of one mark,
 * and they cross-fade rather than swap in a frame: both glyphs share one grid
 * cell and trade opacity and a small scale on `--dur-fast`. Reduced motion
 * keeps the fade and drops the scale.
 */
export function PrivateChatToggle({
  active,
  disabled,
  onToggle,
}: {
  active: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  // The swap rides a wrapper, not the svg: `svg.icon[data-motion]` owns the
  // glyph's own transition list (its hover articulation), and it outranks any
  // utility written on the svg itself.
  const face =
    "col-start-1 row-start-1 grid place-items-center transition-[opacity,transform] duration-fast ease-out-soft motion-reduce:transition-opacity";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={active ? "Leave private chat" : "Start private chat"}
          aria-pressed={active}
          disabled={disabled}
          onClick={onToggle}
          className={cn(
            // Hover is the accent FILL, like both neighbours in the cluster;
            // the press is `.pressable`'s dip on --dur-press. No transition-*
            // utility beside it: one would replace the class's shorthand and
            // un-time the press.
            "pressable grid size-9 place-items-center rounded-full text-foreground/75",
            "hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
            "motion-reduce:transition-none motion-reduce:active:scale-100 coarse:size-11",
            active && "text-primary hover:text-primary"
          )}
        >
          <span aria-hidden="true" className={cn(face, active ? "scale-75 opacity-0" : "opacity-100")}>
            <EyeOff motion="pop" className="size-5" />
          </span>
          <span aria-hidden="true" className={cn(face, active ? "opacity-100" : "scale-75 opacity-0")}>
            <EyeOff motion="pop" weight="fill" className="size-5" />
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{active ? "Private chat is on. Nothing is saved." : "Start private chat"}</TooltipContent>
    </Tooltip>
  );
}
