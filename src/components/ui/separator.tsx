import * as React from "react";
import { cn } from "@/lib/utils";

const Separator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { orientation?: "horizontal" | "vertical" }
>(({ className, orientation = "horizontal", ...props }, ref) => (
  <div
    ref={ref}
    role="separator"
    aria-orientation={orientation}
    className={cn(
      "shrink-0 border-0",
      // Hairline dividers fade at the ends — a softer, more crafted rule than a flat bar.
      orientation === "horizontal"
        ? "h-px w-full bg-gradient-to-r from-transparent via-border to-transparent"
        : "h-full w-px bg-gradient-to-b from-transparent via-border to-transparent",
      className
    )}
    {...props}
  />
));
Separator.displayName = "Separator";

export { Separator };
