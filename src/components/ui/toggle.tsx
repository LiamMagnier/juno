"use client";

import * as React from "react";
import * as TogglePrimitive from "@radix-ui/react-toggle";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * A two-state control on `.control-neu`: raised while off, pressed into the
 * page while on. Radix sets `data-state="on"`, which is one of the selectors
 * the recipe reads, so no compound class is needed for the pressed look —
 * only the ink changes. `ghost` is the flat variant for toolbars, where a row
 * of raised keys would be too loud: flat at rest, raised on hover, pressed
 * when on.
 */
const toggleVariants = cva(
  "pressable inline-flex items-center justify-center gap-2 rounded-control border text-sm font-medium disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100 data-[state=on]:text-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "control-neu border-border/60 text-muted-foreground",
        ghost:
          "border-transparent bg-transparent text-muted-foreground hover:border-border/60 hover:bg-card hover:text-foreground hover:shadow-raised data-[state=on]:border-border/60 data-[state=on]:bg-secondary data-[state=on]:shadow-pressed",
      },
      size: {
        default: "h-9 min-w-9 px-3 coarse:h-11 coarse:min-w-11",
        sm: "h-8 min-w-8 px-2 text-xs coarse:h-10 coarse:min-w-10",
        lg: "h-11 min-w-11 rounded-field px-4",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

const Toggle = React.forwardRef<
  React.ElementRef<typeof TogglePrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>
>(({ className, variant, size, ...props }, ref) => (
  <TogglePrimitive.Root ref={ref} className={cn(toggleVariants({ variant, size }), className)} {...props} />
));
Toggle.displayName = TogglePrimitive.Root.displayName;

export { Toggle, toggleVariants };
