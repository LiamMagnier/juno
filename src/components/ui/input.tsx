import * as React from "react";
import { cn } from "@/lib/utils";
import { fieldFrameClass, fieldHeightClass } from "@/components/ui/field-recipe";

/**
 * Text entry shares its material, hover/focus/invalid states and touch height
 * with Textarea and Select through field-recipe.ts. No surface class or dark
 * override can silently replace that edge. A pointer deepens the edge; the
 * keyboard gets one continuous outer line instead of a tinted halo.
 */
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          fieldFrameClass,
          fieldHeightClass,
          "flex px-3.5 py-1 file:border-0 file:bg-transparent file:text-ui file:font-medium",
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
