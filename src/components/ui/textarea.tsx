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
          "flex min-h-[60px] w-full rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm field-well transition-[color,border-color,box-shadow] duration-base ease-out-soft placeholder:text-muted-foreground coarse:min-h-[72px] hover:border-input/80 focus-visible:outline-none focus-visible:border-foreground/70 disabled:cursor-not-allowed disabled:opacity-50",
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
