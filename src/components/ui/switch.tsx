"use client";

import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { motion } from "framer-motion";
import { useGestureNonce, useTravelSquash } from "@/components/ui/micro";
import { cn } from "@/lib/utils";

/**
 * A tonal track and a light thumb; the accent when on (docs/design/FLAT_UI.md
 * §4 — "the switch track is `--input` when off").
 *
 * Off, the track is the `--input` rung; on, it takes the primary fill — flat,
 * no glow — and the thumb, the lightest thing in the control, slides along it
 * on --dur-base with the front-loaded curve the ladder keeps for things the
 * user moves. The fill cross-fades on the same rung, so colour and travel
 * arrive together.
 *
 * The rendered control is 20×36, under the 24×24 pointer-target minimum
 * (SC 2.5.8) in the dense settings rows it lives in. A centred pseudo-element
 * grows the HIT AREA to 24×44 (44×44 on touch) while the control itself stays
 * pixel-identical. Focus is left to the global :focus-visible outline.
 *
 * THE THUMB SQUASHES ALONG ITS TRAVEL (lib/micro.ts, `STRETCH`). A disc that
 * translates rigidly between two ends of a track is a sprite being moved; the
 * same disc stretched 10% along the axis it is moving on and eased back is a
 * thing with mass, and mass is the only cue a 17px journey has room for. It is
 * the one piece of this control that says the switch went somewhere rather
 * than simply became something else.
 *
 * TWO ELEMENTS, and the split is forced: Radix drives the travel with a CSS
 * `transform` on the Thumb, and a framer `scaleX` on the same node would
 * replace that transform rather than compose with it. The Thumb stays the
 * carriage and an inner span is the body — which also puts the squash on the
 * painted disc and leaves the hit geometry alone.
 *
 * The nonce is bumped from `onCheckedChange`, which Radix fires only for real
 * user interaction. A controlled parent flipping the value — a settings page
 * hydrating, a sync landing — moves the thumb without the squash, because
 * nobody touched it.
 */
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, onCheckedChange, ...props }, ref) => {
  const [nonce, bump] = useGestureNonce();
  const squash = useTravelSquash(nonce);

  return (
    <SwitchPrimitives.Root
      className={cn(
        "peer relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input transition-[background-color,border-color,box-shadow] duration-base ease-out-soft before:absolute before:left-1/2 before:top-1/2 before:h-6 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] coarse:before:size-11 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none data-[state=checked]:border-transparent data-[state=checked]:bg-primary",
        className
      )}
      onCheckedChange={(next) => {
        bump();
        onCheckedChange?.(next);
      }}
      {...props}
      ref={ref}
    >
      {/* The thumb has to be the LIGHTEST thing in the control, in both themes:
          the card fill on paper, the near-white foreground on charcoal. Except
          ON in dark mode: the primary track is itself near-white there (the
          default accent), and a white thumb vanished into it, so the thumb
          takes the primary's own foreground, which is dark for every accent. Its
          raised shadow is what makes it read as a key rather than a disc. The
          1px track border leaves 18px inside for a 16px thumb, hence the 1px
          rest offset and the 17px travel. */}
      <SwitchPrimitives.Thumb className="group/thumb pointer-events-none block size-4 translate-x-px transition-transform duration-base ease-out-strong motion-reduce:transition-none data-[state=checked]:translate-x-[17px]">
        <motion.span
          aria-hidden="true"
          style={squash}
          className="block size-4 rounded-full bg-card shadow-raised-lg ring-0 transition-colors duration-base ease-out-soft motion-reduce:transition-none dark:bg-foreground dark:group-data-[state=checked]/thumb:bg-primary-foreground"
        />
      </SwitchPrimitives.Thumb>
    </SwitchPrimitives.Root>
  );
});
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
