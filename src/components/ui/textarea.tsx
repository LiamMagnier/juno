import * as React from "react";
import { cn } from "@/lib/utils";
import { fieldFrameClass } from "@/components/ui/field-recipe";

/**
 * Multiline text on the shared field recipe. Only height and padding differ
 * from Input; adjacent fields keep the same boundary, ink and focus response.
 */
const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          fieldFrameClass,
          "flex min-h-[60px] px-3.5 py-2.5",
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
