"use client";

import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * An inset well that fills with the accent when checked. Unchecked it is a
 * small `.surface-inset` at `rounded-xs` — a slot waiting for a mark; checked
 * it takes the primary fill, and the mark springs in. Indeterminate shows a
 * dash.
 *
 * THE MARK IS ALWAYS MOUNTED and cross-fades on `data-state` (`forceMount`),
 * rather than Radix's default of mounting it only while checked. Mount-time
 * animation had two faults: a box that was already checked when the page
 * loaded sprang its tick in on first paint (a page load is not a change), and
 * unchecking removed the tick in a single frame while the fill behind it was
 * still fading. Now the tick scales up from 0.5 with a small counter-tilt on
 * the spring and leaves on the accelerate, in step with the fill. Both
 * transforms read the motion vars, so the reduced tier keeps the fade only.
 *
 * The mark is the `bold` cut: at 14px inside an 18px accent square the regular
 * line reads as a hairline scratch, and a tick is the one glyph in a form that
 * has to be read at a glance.
 *
 * The rendered box is 18px; a centred pseudo-element grows the hit area to
 * 24px (44px on touch) without changing the drawn size — the same trick
 * Switch uses. Focus is left to the global :focus-visible outline.
 */
const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "surface-inset peer relative flex size-[18px] shrink-0 items-center justify-center rounded-xs border border-input transition-[background-color,border-color,box-shadow] duration-fast ease-out-soft before:absolute before:left-1/2 before:top-1/2 before:size-6 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] coarse:before:size-11 hover:border-foreground/60 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none data-[state=checked]:border-primary/80 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary/80 data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      forceMount
      className={cn(
        "pointer-events-none flex items-center justify-center text-current",
        // In: the spring, on the base rung. Out: the accelerate, on the fast one.
        "transition-[opacity,transform] duration-base ease-spring",
        "data-[state=unchecked]:opacity-0 data-[state=unchecked]:duration-fast data-[state=unchecked]:ease-in",
        "data-[state=unchecked]:[transform:scale(var(--motion-scale-from,0.5))_rotate(calc(-14deg*var(--motion-shift,1)))]"
      )}
    >
      {props.checked === "indeterminate" ? (
        <Minus weight="bold" className="size-3.5" aria-hidden="true" />
      ) : (
        <Check weight="bold" className="size-3.5" aria-hidden="true" />
      )}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
