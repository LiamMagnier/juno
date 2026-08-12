import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // Placeholder at full --muted-foreground: the token is tuned to 5.3:1 and
          // the /70 modifier threw that away at 2.91:1, on text that frequently
          // carries the only hint of the expected format ("you@example.com").
          // coarse: matches Button and SelectTrigger — without it a Select grew to
          // 44px on touch while the Input above it stayed 36px and the row de-aligned.
          //
          // No `focus-visible:outline-none`. It suppressed the authoritative
          // global :focus-visible ring (globals.css) and left a 1px border swap
          // as the entire focus signal — so the three text-entry controls, where
          // focus matters most, were the only ones in the product not speaking
          // the product's focus language. Button, Pressable and Switch all defer
          // to the ring. The border swap is kept; it now accompanies the ring
          // instead of replacing it.
          //
          // The HOVER border ran backwards in both themes. `border-input/80`
          // discounts the rest colour toward whatever is behind it, and --input
          // sits on the far side of the surface from --foreground in each theme
          // — 53% lightness over 97% paper, 32% over the dark well — so the
          // discount composited to ~62% on light and ~28% on dark: in both
          // directions, approaching a field made its outline FAINTER than
          // leaving it alone. `foreground/60` lands at ~46% and ~60%, one step
          // toward the `foreground/70` focus border below it, so the three
          // states finally read as a ramp: rest, reachable, focused.
          "flex h-9 w-full rounded-field border border-input px-3.5 py-1 text-sm field-well transition-[color,border-color,box-shadow] duration-base ease-out-soft file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground coarse:h-11 hover:border-foreground/60 focus-visible:border-foreground/70 disabled:cursor-not-allowed disabled:opacity-50",
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
