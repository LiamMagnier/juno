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
    <SwitchPrimitives.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-background shadow-pop ring-0 transition-transform duration-base ease-spring data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
