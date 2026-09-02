"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

/**
 * The floating tier: `.surface-float` + `.overlay-glass` (glass tint, 12px
 * blur, the float shadow) at `rounded-popover` (16). ONE radius and one
 * material for popover, dropdown and select — they open beside each other and
 * must read as the same object. Pops in on the spring, out on the accelerate;
 * `.origin-popper` anchors the scale to the trigger side.
 *
 * Call sites pass width, padding and alignment only. A `border-*`, `bg-*`,
 * `shadow-*` or `backdrop-blur-*` utility here is a fork of the material and
 * will silently beat it.
 */
const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, collisionPadding = 8, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        "surface-float overlay-glass z-popper w-72 max-w-[calc(100vw-1rem)] origin-popper rounded-popover p-4 outline-none data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out",
        className
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
