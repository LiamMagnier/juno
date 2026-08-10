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
          "flex h-9 w-full rounded-field border border-input bg-background px-3.5 py-1 text-sm field-well transition-[color,border-color,box-shadow] duration-base ease-out-soft file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground coarse:h-11 hover:border-input/80 focus-visible:outline-none focus-visible:border-foreground/70 disabled:cursor-not-allowed disabled:opacity-50",
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
