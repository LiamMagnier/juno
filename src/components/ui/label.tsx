"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    // A form label, in the UI face. It used to wear the mono eyebrow voice —
    // "E M A I L" in tracked JetBrains Mono over the sign-in field — which is
    // the register of a dev tool, not of a product people sign into. Eyebrows
    // on cards and page headers keep their own mono class; this is the label
    // that sits over an input, and it reads like the input's own text.
    className={cn(
      "text-ui font-medium text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
      className
    )}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
