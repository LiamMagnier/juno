"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

/**
 * The provider, with the product's timing as its defaults.
 *
 * `skipDelayDuration` is the part that makes a toolbar feel quick: once one
 * tooltip has opened, moving to the next trigger within this window opens its
 * tooltip INSTANTLY (Radix marks it `instant-open`, which skips the entrance
 * below) — the reader is scanning a row of icons, and making them wait out the
 * delay on every one is what makes a tooltip row feel sticky. 400ms is long
 * enough to cross a 32px gap between icon buttons at a relaxed hand speed.
 *
 * `delayDuration` stays a short hover-intent pause; the app shell passes its
 * own value, which wins, so this default only governs mounts that do not.
 */
function TooltipProvider({
  delayDuration = 300,
  skipDelayDuration = 400,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration} {...props} />;
}
TooltipProvider.displayName = "TooltipProvider";

const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

/**
 * A small `.surface-float` at `rounded-control` (8) — the same material as
 * the menu it appears beside, opaque so a transient micro-label stays legible
 * over arbitrary content. Not inverted: an inked slab was the single
 * brightest object on the dark theme, flaring on every hover.
 *
 * ~25px tall, so 10px is the rung that still reads as the popper family
 * without becoming a capsule.
 *
 * MOTION. The quietest member of the floating family (tailwind.config.ts,
 * `tooltip-in` / `tooltip-out`): a 2px drift toward the trigger and a 0.97
 * start on the fast rung, no spring, leaving on the accelerate. `instant-open`
 * (hopping between adjacent triggers inside the provider's skip window)
 * deliberately has NO entrance — the label simply changes, which is what
 * makes scanning a toolbar feel immediate. 6px from the trigger rather than
 * 4, so the label clears a focus outline instead of touching it.
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
        "surface-float z-popper max-w-[calc(100vw-1rem)] origin-popper overflow-hidden rounded-control px-2.5 py-1 text-caption text-foreground data-[state=delayed-open]:animate-tooltip-in data-[state=closed]:animate-tooltip-out",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
