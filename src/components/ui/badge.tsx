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
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border bg-transparent text-foreground",
        success: "border-transparent bg-success text-success-foreground",
        muted: "border-transparent bg-muted text-muted-foreground",
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
