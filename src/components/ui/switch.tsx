"use client";

import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      // The rendered switch is 20×36, well under the 24×24 pointer-target minimum
      // (SC 2.5.8) in the dense settings rows it lives in. A centred pseudo-element
      // grows the HIT AREA to 24×44 (44×44 on touch) while the control itself stays
      // pixel-identical — the same trick as empty-state.tsx.
      // Focus is left to the global :focus-visible outline; see button.tsx.
      "peer relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-base ease-out-soft before:absolute before:left-1/2 before:top-1/2 before:h-6 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] coarse:before:h-11 coarse:before:w-11 disabled:cursor-not-allowed disabled:opacity-50 data-[state=unchecked]:bg-input data-[state=unchecked]:[box-shadow:var(--well-inset)] data-[state=checked]:btn-glossy data-[state=checked]:bg-primary data-[state=checked]:[box-shadow:inset_0_1px_2px_hsl(0_0%_0%/0.16),0_1px_2px_hsl(var(--primary)/0.4)]",
      className
    )}
    {...props}
    ref={ref}
  >
    {/*
     * The thumb has to be the LIGHTEST thing in the control, in both themes.
     *
     * It was `bg-background`, which is pure #000 on dark — so an unchecked
     * switch was a 32%-lightness track with a black hole punched through it,
     * and the one element that should read as a raised key read as a gap. Light
     * is unchanged (`--background` is paper there and correct); dark takes
     * --foreground, the only near-white in the ramp.
     *
     * A bare --shadow-pop is pure black ink on dark, which vanishes against the
     * black track and does nothing against the coral checked fill either. The
     * inset bottom edge is what keeps the thumb's lower rim defined once it has
     * slid onto the accent — drawn in --shadow-ink so it stays dark ink in both
     * themes rather than inverting into a halo.
     */}
    <SwitchPrimitives.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-background ring-0 transition-transform duration-base ease-out-strong [box-shadow:inset_0_-1px_0_hsl(var(--shadow-ink)/0.18),var(--shadow-pop)] motion-reduce:transition-none data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 dark:bg-foreground" />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
