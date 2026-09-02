"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

/**
 * A small `.surface-float` at `rounded-control` (10) — the same material as
 * the menu it appears beside, opaque so a transient micro-label stays legible
 * over arbitrary content. Not inverted: an inked slab was the single
 * brightest object on the dark theme, flaring on every hover.
 *
 * ~25px tall, so 10px is the rung that still reads as the popper family
 * without becoming a capsule. instant-open (hopping between adjacent
 * triggers) intentionally skips the entrance.
 */
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
        "surface-float z-popper max-w-[calc(100vw-1rem)] origin-popper overflow-hidden rounded-control px-2.5 py-1 text-xs text-foreground data-[state=delayed-open]:animate-pop-in data-[state=closed]:animate-pop-out",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
