import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The multi-line text field, on exactly Input's recipe: the page fill and the
 * `--input` hairline at rest, the hairline a step toward ink on hover, and the
 * accent edge plus a 3px accent halo on focus. input.tsx has the reasoning; the
 * short version is that the old focus state (the border darkening to
 * `foreground/70` from a hover of `foreground/60`) could not be told apart
 * from hover, and a textarea sitting under an Input in the same form must not
 * answer focus differently from it.
 *
 * Plain utilities rather than `.surface-inset` for the same cascade reason
 * input.tsx gives: every state here is a border change, and a material class
 * with its own `border` fights a `border-*` utility on the same element.
 */
const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[60px] w-full rounded-field border border-input bg-background px-3.5 py-2.5 text-ui text-foreground shadow-none",
          "transition-[border-color,box-shadow] duration-fast ease-out-soft motion-reduce:transition-none",
          "placeholder:text-muted-foreground",
          "hover:border-foreground/30",
          "focus-visible:border-primary focus-visible:shadow-[0_0_0_3px_hsl(var(--primary)/0.16)] focus-visible:outline-none",
          "aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:shadow-[0_0_0_3px_hsl(var(--destructive)/0.16)]",
          "disabled:cursor-not-allowed disabled:opacity-50 coarse:min-h-[72px]",
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
