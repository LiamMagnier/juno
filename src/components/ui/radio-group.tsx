"use client";

import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { cn } from "@/lib/utils";

/**
 * Radios are the round sibling of Checkbox: an inset well that, when
 * selected, takes the primary border and an accent dot that springs in.
 * The ring stays neutral so a list of options reads as a set of slots with
 * one key in them, not as a row of accent circles.
 *
 * The dot is always mounted and cross-faded on `data-state` (see checkbox.tsx
 * for why mount-time animation was wrong): choosing a new option grows the new
 * dot from a point on the spring while the old one shrinks away on the
 * accelerate, so the selection visibly MOVES from one slot to the other rather
 * than blinking. Reduced motion keeps the fade and drops the scale.
 */
const RadioGroup = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Root className={cn("grid gap-2", className)} {...props} ref={ref} />
));
RadioGroup.displayName = RadioGroupPrimitive.Root.displayName;

const RadioGroupItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Item
    ref={ref}
    className={cn(
      "surface-inset peer relative flex size-[18px] shrink-0 items-center justify-center rounded-full border border-input transition-[border-color,box-shadow] duration-fast ease-out-soft before:absolute before:left-1/2 before:top-1/2 before:size-6 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] coarse:before:size-11 hover:border-foreground/60 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none data-[state=checked]:border-primary/80",
      className
    )}
    {...props}
  >
    <RadioGroupPrimitive.Indicator
      forceMount
      className={cn(
        "pointer-events-none flex items-center justify-center",
        "transition-[opacity,transform] duration-base ease-spring",
        "data-[state=unchecked]:opacity-0 data-[state=unchecked]:duration-fast data-[state=unchecked]:ease-in",
        "data-[state=unchecked]:[transform:scale(var(--motion-scale-from,0.25))]"
      )}
    >
      <span className="block size-2 rounded-full bg-primary" aria-hidden="true" />
    </RadioGroupPrimitive.Indicator>
  </RadioGroupPrimitive.Item>
));
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName;

export { RadioGroup, RadioGroupItem };
