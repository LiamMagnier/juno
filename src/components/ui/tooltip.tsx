"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, collisionPadding = 8, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        // instant-open (hopping between adjacent triggers) intentionally skips the entrance.
        // The one deliberately INVERTED tier: a transient micro-label has to stay
        // legible over arbitrary content, so it keeps the solid inked fill and does
        // NOT take .overlay-glass. It is still out-of-flow though, so it belongs on
        // the float ramp — shadow-soft was the in-flow card shadow on a floating layer.
        //
        // The inversion is inverted BACK on dark. `bg-foreground` there is
        // `45 14% 94%` — a near-white slab, and on an OLED-black page it was the
        // single brightest object in the product, flaring on every hover. Dark
        // gets the popover rung it floats beside plus the hairline it was the
        // only overlay to go without; light keeps the inked chip, where an
        // inverted label against warm paper is exactly right. The edge is an
        // inset RING rather than a border so the dark tooltip does not come out
        // 2px larger than the light one for the same string.
        //
        // `rounded-control` (9), not the off-ladder `rounded-md` and not the
        // `rounded-menu` (12) the rest of the popper tier takes: this box is
        // ~25px tall, and 12px on 25px is a capsule. 9 is the nearest rung that
        // still reads as the same family as the dropdown it appears beside.
        "z-popper max-w-[calc(100vw-1rem)] origin-popper overflow-hidden rounded-control bg-foreground px-2.5 py-1 text-xs text-background shadow-float data-[state=delayed-open]:animate-pop-in data-[state=closed]:animate-pop-out dark:bg-popover dark:text-popover-foreground dark:ring-1 dark:ring-inset dark:ring-border",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
