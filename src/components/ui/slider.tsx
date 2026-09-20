"use client";

import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

/**
 * An inset groove with a coral range and a raised round thumb — the same
 * three depths as Switch and Progress, so the three read as one family.
 * Focus is the global outline.
 *
 * THE THUMB WAKES WHEN YOU GRAB IT; IT USED TO SHRINK.
 *
 * `active:scale-[0.97]` was inherited from `.pressable`, where it is right:
 * a button dips under the finger because the finger is pushing it, and the
 * finger then leaves. A slider thumb is not pushed, it is CARRIED — the
 * pointer stays on it for the whole gesture — so the press dip applies for
 * as long as the drag lasts and it is doing the opposite of what it should.
 * On touch it was worse than neutral: the thumb is 20px and a fingertip
 * covers ~45px of it, so the one moment the reader most needs the thumb
 * visible was the moment it got smaller.
 *
 * Grabbed, it grows 10% and lifts a soft accent halo out of nothing. The
 * halo is what makes the state legible past the finger — it is wider than
 * the contact patch, so something of the control is always showing — and it
 * is `--primary` at low alpha rather than a shadow, because a shadow reads
 * as height and this is not the thumb moving toward the reader.
 *
 * `--dur-fast` rather than `--dur-press`: the press rung (70ms) is for a
 * transform that snaps under a click. This is the control changing mode for
 * the length of a gesture, and a mode change that lands in 70ms reads as a
 * flicker on the way into the drag.
 */
const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => {
  const thumbs = Array.isArray(props.value)
    ? props.value.length
    : Array.isArray(props.defaultValue)
      ? props.defaultValue.length
      : 1;
  return (
    <SliderPrimitive.Root
      ref={ref}
      className={cn("relative flex w-full touch-none select-none items-center py-2", className)}
      {...props}
    >
      <SliderPrimitive.Track className="surface-inset relative h-2 w-full grow overflow-hidden rounded-full">
        <SliderPrimitive.Range className="absolute h-full rounded-full bg-primary" />
      </SliderPrimitive.Track>
      {Array.from({ length: thumbs }).map((_, i) => (
        <SliderPrimitive.Thumb
          key={i}
          className="block size-4 cursor-grab rounded-full border border-border bg-card shadow-raised-lg ring-0 ring-primary/20 transition-[box-shadow,transform,border-color] duration-fast ease-out-soft hover:border-foreground/40 active:cursor-grabbing active:scale-110 active:border-primary/60 active:ring-4 disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100 dark:bg-foreground coarse:size-5"
        />
      ))}
    </SliderPrimitive.Root>
  );
});
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
