"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

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
        // ONE radius for the floating layer. The comment here used to assert
        // "18px, unchanged — `rounded-popover` IS 18px"; it is 14px
        // (tailwind.config.ts), and the overlay family was shipping five corners
        // for one material — dialog 18, popover 14, dropdown/select 12, tooltip
        // 8, sheet none. `rounded-menu` (12) is the majority and is now the whole
        // popper tier; `rounded-panel` (18) stays with the modal, which is
        // genuinely a bigger box.
        //
        // The material is the shared .overlay-glass — the identical eight-class
        // string this and five siblings each open-coded.
        "z-popper w-72 max-w-[calc(100vw-1rem)] origin-popper rounded-menu overlay-glass p-4 outline-none data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out",
        className
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
