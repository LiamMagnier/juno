import * as React from "react";
import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          // Placeholder at full --muted-foreground: the token is tuned to 5.3:1 and
          // the /70 modifier threw that away at 2.91:1, on text that frequently
          // carries the only hint of the expected format.
          // coarse: matches Button, Input and SelectTrigger — without it a Select
          // grew to 44px on touch while the field beside it stayed at its fine-
          // pointer height and the row de-aligned.
          // `focus-visible:outline-none` removed for the reason spelled out in
          // input.tsx: it suppressed the global accent ring and made the field
          // controls the only ones in the product without it.
          // `hover:border-foreground/60` likewise: `border-input/80` composited
          // AWAY from the surface in both themes, so hovering a field dimmed its
          // own outline. See the ramp note in input.tsx.
          "flex min-h-[60px] w-full rounded-field border border-input px-3.5 py-2.5 text-sm field-well transition-[color,border-color,box-shadow] duration-base ease-out-soft placeholder:text-muted-foreground coarse:min-h-[72px] hover:border-foreground/60 focus-visible:border-foreground/70 disabled:cursor-not-allowed disabled:opacity-50",
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
