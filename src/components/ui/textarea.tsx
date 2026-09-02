import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * `.surface-inset` with the --input hairline; focus is the border darkening
 * and nothing else. See input.tsx for the reasoning — the three text-entry
 * controls share one recipe.
 */
const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "surface-inset flex min-h-[60px] w-full rounded-field border border-input px-3.5 py-2.5 text-sm transition-[color,border-color,box-shadow] duration-base ease-out-soft placeholder:text-muted-foreground coarse:min-h-[72px] hover:border-foreground/60 focus-visible:border-foreground/70 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";

export { Textarea };
