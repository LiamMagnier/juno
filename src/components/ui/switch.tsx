"use client";

import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

/**
 * Inset track, raised thumb; coral when on (docs/design/SOFT_UI.md §2.2).
 *
 * The track is `.surface-inset` — a slot cut into the page — and the thumb is
 * a raised key sliding along it. Checked, the track takes the primary fill
 * with the pressed recipe (the well is now coral) and the accent glow.
 *
 * The rendered control is 20×36, under the 24×24 pointer-target minimum
 * (SC 2.5.8) in the dense settings rows it lives in. A centred pseudo-element
 * grows the HIT AREA to 24×44 (44×44 on touch) while the control itself stays
 * pixel-identical. Focus is left to the global :focus-visible outline.
 */
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "surface-inset peer relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border/70 transition-[background-color,border-color,box-shadow] duration-base ease-out-soft before:absolute before:left-1/2 before:top-1/2 before:h-6 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] coarse:before:size-11 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none data-[state=checked]:border-primary/80 data-[state=checked]:bg-primary data-[state=checked]:[box-shadow:var(--shadow-pressed),var(--glow-primary)]",
      className
    )}
    {...props}
    ref={ref}
  >
    {/* The thumb has to be the LIGHTEST thing in the control, in both themes:
        the card fill on paper, the near-white foreground on charcoal. Its
        raised shadow is what makes it read as a key rather than a disc. The
        1px track border leaves 18px inside for a 16px thumb, hence the 1px
        rest offset and the 17px travel. */}
    <SwitchPrimitives.Thumb className="pointer-events-none block size-4 translate-x-px rounded-full bg-card shadow-raised ring-0 transition-transform duration-base ease-out-strong motion-reduce:transition-none data-[state=checked]:translate-x-[17px] dark:bg-foreground" />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
