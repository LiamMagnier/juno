import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Mono metadata voice. `text-caption` carries the same 11px/0.02em the
 * arbitrary values were approximating. Badges are ~20px tall, so they take
 * the small `shadow-pop` rather than the full raised throw — a 3px/4px shadow
 * on a chip that size reads as a smudge. Solid fills carry the sheen; `muted`
 * is pressed into its ground; `outline` is a small raised tile.
 */
const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-caption font-medium transition-[color,background-color,border-color] duration-fast ease-out-soft",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground shadow-pop [background-image:linear-gradient(180deg,hsl(0_0%_100%/.14),hsl(0_0%_100%/0)_55%)]",
        secondary: "border-border/50 bg-secondary text-secondary-foreground shadow-pop",
        outline: "border-border/70 bg-card text-foreground shadow-pop",
        success: "border-transparent bg-success text-success-foreground shadow-pop [background-image:linear-gradient(180deg,hsl(0_0%_100%/.14),hsl(0_0%_100%/0)_55%)]",
        muted: "border-transparent bg-muted text-muted-foreground shadow-pressed",
        // Tinted "soft" chip — premium, low-noise; the accent hue at low alpha.
        soft: "border-primary/25 bg-primary/12 text-primary",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
