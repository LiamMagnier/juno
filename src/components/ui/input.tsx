import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The text field is `.surface-inset` (docs/design/SOFT_UI.md §2.2): the page
 * fill with the recess shadow, plus the --input hairline as its boundary.
 *
 * Focus is the border darkening to foreground/70 and NOTHING else — no ring,
 * no accent. Browsers grant `:focus-visible` to text inputs on pointer focus,
 * so a ring here blooms on every click; the global outline is suppressed for
 * the three text-entry controls only (input, textarea, select trigger), and
 * `/70` measures 5.9:1 light / 8.1:1 dark, above the 3:1 an indicator needs.
 *
 * Hover steps the border toward focus (foreground/60) rather than away from
 * it: rest, reachable, focused read as one ramp. The placeholder is the full
 * --muted-foreground, which is tuned to 5:1. `coarse:` matches Button and
 * SelectTrigger so a field and the button beside it stay aligned on a phone.
 */
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "surface-inset flex h-9 w-full rounded-field border border-input px-3.5 py-1 text-sm transition-[color,border-color,box-shadow] duration-base ease-out-soft file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground coarse:h-11 hover:border-foreground/60 focus-visible:border-foreground/70 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
