"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { TIMING_TOKENS } from "@/lib/design/tokens.generated";
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
 * Both defaults come from the shared timing table, so a tooltip in a dialog
 * and one in the app shell use the same hover intent and scanning window.
 * A caller can still override either duration for a specific interaction.
 */
function TooltipProvider({
  delayDuration = TIMING_TOKENS.delay.tooltip,
  skipDelayDuration = TIMING_TOKENS.delay.tooltipSkip,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration} {...props} />;
}
TooltipProvider.displayName = "TooltipProvider";

const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

/**
 * A small opaque ink label at `rounded-control`. `.ui-tooltip` provides
 * the light text and theme-aware dark surface, including the tokens that
 * nested muted labels and glyphs read. A rich source preview opts into the
 * popover material with `.cite-card`.
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
        "ui-tooltip z-popper max-w-[calc(100vw-1rem)] origin-popper overflow-hidden break-words rounded-control px-2.5 py-1.5 font-sans text-label font-medium data-[state=delayed-open]:animate-tooltip-in data-[state=closed]:animate-tooltip-out",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
