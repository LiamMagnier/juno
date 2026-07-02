import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // Shared lighting model: every button transitions filter (brightness) + shadow so
  // hover/press read as light changes, not just color swaps.
  "relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform,filter] duration-fast ease-out-soft active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Primary = the signature: glossy accent fill, colored halo, and a diagonal
        // sheen that sweeps across on hover.
        default: "sheen-sweep btn-glossy halo-primary bg-primary text-primary-foreground hover:brightness-[1.06] active:brightness-[0.97]",
        destructive: "btn-glossy bg-destructive text-destructive-foreground shadow-pop hover:brightness-[1.06] active:brightness-[0.97]",
        outline: "border border-border/70 bg-background/50 shadow-pop hover:bg-accent hover:border-border hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-pop [box-shadow:inset_0_1px_0_hsl(var(--sheen)),var(--shadow-pop)] hover:brightness-[0.97]",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // Small/icon sizes grow to ~44px hit areas on touch devices (coarse:).
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-[10px] px-3 text-xs coarse:h-10",
        lg: "h-11 px-6 text-[0.9375rem]",
        icon: "h-9 w-9 coarse:h-11 coarse:w-11",
        "icon-sm": "h-8 w-8 rounded-[10px] coarse:h-10 coarse:w-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
