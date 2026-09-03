"use client";

import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * An inset well that fills coral when checked. Unchecked it is a small
 * `.surface-inset` at `rounded-xs` — a slot waiting for a mark; checked it
 * takes the primary fill with the pressed recipe and the glow, and the check
 * springs in on `.check-morph`. Indeterminate shows a dash.
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
      "surface-inset peer relative flex size-[18px] shrink-0 items-center justify-center rounded-xs border border-input transition-[background-color,border-color,box-shadow] duration-fast ease-out-soft before:absolute before:left-1/2 before:top-1/2 before:size-6 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] coarse:before:size-11 hover:border-foreground/60 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none data-[state=checked]:border-primary/80 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:shadow-pressed data-[state=indeterminate]:border-primary/80 data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground data-[state=indeterminate]:shadow-pressed",
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
      {props.checked === "indeterminate" ? (
        <Minus className="check-morph size-3.5 [stroke-width:3]" aria-hidden="true" />
      ) : (
        <Check className="check-morph size-3.5 [stroke-width:3]" aria-hidden="true" />
      )}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
