"use client";

import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

/** A compact track with a larger pointer target around it. */
const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, ...props }, ref) => {
  const thumbs = Array.isArray(props.value)
    ? props.value.length
    : Array.isArray(props.defaultValue)
      ? props.defaultValue.length
      : 1;
  /*
   * THE NAME HAS TO REACH THE THUMB, and it was not reaching it.
   *
   * Radix puts Root's props on the wrapper div; the element that carries
   * `role="slider"` — and therefore the element a screen reader announces — is
   * the Thumb. So `<Slider aria-label="Text size">` looked correct at the call
   * site, rendered a labelled div nobody queries, and left the control itself
   * anonymous: axe flags it `aria-input-field-name`, serious, and a reader
   * hears "slider, 16" with no idea what 16 is. Settings › General was doing
   * exactly that.
   *
   * Pulled off Root and put on every Thumb. On a RANGE the one name would be
   * ambiguous — two sliders called "Price" — so the ends say which end they
   * are; that is the WAI-APG pattern for a two-thumb slider, not an
   * invention. Beyond two thumbs there is no natural wording and each gets an
   * ordinal.
   */
  const thumbName = (i: number) => {
    if (!ariaLabel) return undefined;
    if (thumbs === 1) return ariaLabel;
    if (thumbs === 2) return `${ariaLabel}, ${i === 0 ? "minimum" : "maximum"}`;
    return `${ariaLabel}, ${i + 1} of ${thumbs}`;
  };
  return (
    <SliderPrimitive.Root
      ref={ref}
      className={cn("relative flex h-9 w-full touch-none select-none items-center coarse:h-11", className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-muted-foreground/20">
        <SliderPrimitive.Range className="absolute h-full rounded-full bg-primary" />
      </SliderPrimitive.Track>
      {Array.from({ length: thumbs }).map((_, i) => (
        <SliderPrimitive.Thumb
          key={i}
          aria-label={thumbName(i)}
          aria-labelledby={ariaLabel ? undefined : ariaLabelledBy}
          className="block size-3.5 cursor-grab rounded-full border border-border bg-background transition-colors duration-fast ease-out-soft hover:border-foreground/50 active:cursor-grabbing active:border-primary aria-disabled:pointer-events-none aria-disabled:opacity-50 coarse:size-4"
        />
      ))}
    </SliderPrimitive.Root>
  );
});
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
