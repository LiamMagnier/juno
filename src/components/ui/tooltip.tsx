"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { TIMING } from "@/lib/interaction";
import { cn } from "@/lib/utils";

/**
 * The provider, with the product's timing as its defaults (spec C7):
 * `--delay-tooltip` (500ms) of hover intent before the first tooltip, and
 * `--delay-tooltip-skip` (300ms) inside which a peer opens INSTANTLY (Radix
 * marks it `instant-open`, which skips the entrance below). The reader is
 * scanning a row of icons, and making them wait out the delay on every one is
 * what makes a tooltip row feel sticky.
 */
function TooltipProvider({
  delayDuration = TIMING.tooltip,
  skipDelayDuration = TIMING.tooltipSkip,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration} {...props} />;
}
TooltipProvider.displayName = "TooltipProvider";

const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

/**
 * A small `.surface-float` at `rounded-control` (8) — the same material as
 * the menu it appears beside, opaque so a transient label stays legible over
 * arbitrary content. Set in `ui` 13 (spec §3.5: tooltips are control text,
 * never caption).
 *
 * MOTION. A frequent overlay (sheet.css, `.ui-overlay-frequent`): in over 120
 * on out-soft from 0.97 at the trigger's transform-origin, out over 70 on the
 * accelerate; opacity only when opened from the keyboard or under reduced
 * motion. `instant-open` (hopping between adjacent triggers inside the skip
 * window) has NO entrance — the label simply changes. 6px from the trigger,
 * so the label clears a focus outline instead of touching it.
 */
const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, collisionPadding = 8, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        "ui-overlay-frequent surface-float z-popper max-w-[calc(100vw-1rem)] origin-popper overflow-hidden rounded-control px-2.5 py-1 text-ui text-foreground",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
