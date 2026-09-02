"use client";

import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { cn } from "@/lib/utils";

/**
 * Radios are the round sibling of Checkbox: an inset well that, when
 * selected, takes the primary border and a raised coral dot that springs in.
 * The ring stays neutral so a list of options reads as a set of slots with
 * one key in them, not as a row of coral circles.
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
    <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
      <span className="check-morph block size-2 rounded-full bg-primary shadow-raised" aria-hidden="true" />
    </RadioGroupPrimitive.Indicator>
  </RadioGroupPrimitive.Item>
));
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName;

export { RadioGroup, RadioGroupItem };
