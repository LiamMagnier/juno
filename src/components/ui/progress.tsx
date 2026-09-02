"use client";

import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "@/lib/utils";

/**
 * A determinate bar: an inset track (a groove cut into the page) with a
 * raised coral fill sliding along it. The fill moves on translate, not width,
 * so the bar animates on the compositor; `--dur-slow` because progress is a
 * change the user did not cause and should be seen moving, not snapping.
 *
 * `tone` swaps the fill for a state colour — a quota bar turns amber near its
 * limit and red past it — without the caller reaching for a raw class.
 */
const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & {
    tone?: "primary" | "success" | "warning" | "destructive" | "neutral";
  }
>(({ className, value, tone = "primary", ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn("surface-inset relative h-2 w-full overflow-hidden rounded-full", className)}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className={cn(
        "h-full w-full flex-1 rounded-full shadow-raised transition-transform duration-slow ease-out-soft motion-reduce:transition-none",
        tone === "primary" && "bg-primary",
        tone === "success" && "bg-success",
        tone === "warning" && "bg-warning",
        tone === "destructive" && "bg-destructive",
        tone === "neutral" && "bg-foreground/60"
      )}
      style={{ transform: `translateX(-${100 - Math.max(0, Math.min(100, value ?? 0))}%)` }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
