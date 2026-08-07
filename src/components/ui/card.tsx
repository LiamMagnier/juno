import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const cardVariants = cva(
  // Scoped transition (not transition-all) so panel resizes/layout changes don't animate.
  "rounded-lg border border-border/70 bg-card text-card-foreground transition-[transform,border-color,background-color,box-shadow] duration-base ease-out-soft",
  {
    variants: {
      variant: {
        // surface-raised adds the top sheen + inner highlight + soft ambient shadow.
        default: "surface-raised",
        elevated: "surface-raised shadow-float",
        flat: "shadow-none",
        // Hover lifts one rung to --shadow-lift, not --shadow-float: float is the
        // OUT-OF-FLOW token, so a hovered tile was outranking every dropdown in
        // the product. The ladder is soft < lift < glass < float, monotonic.
        // The ambient --glow-primary halo goes with it — it was retired
        // product-wide for reading as a smudge; this call site never got the memo.
        interactive:
          "surface-raised hover:-translate-y-0.5 hover:border-primary/45 hover:[box-shadow:inset_0_1px_0_hsl(var(--sheen)),var(--shadow-lift)] focus-within:border-primary/45 active:translate-y-0",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

const Card = React.forwardRef<HTMLDivElement, CardProps>(({ className, variant, ...props }, ref) => (
  <div ref={ref} className={cn(cardVariants({ variant }), className)} {...props} />
));
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("font-semibold leading-none tracking-tight", className)} {...props} />
  )
);
CardTitle.displayName = "CardTitle";

/** Mono eyebrow for card sections — the Juno label voice. */
const CardEyebrow = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn("font-mono text-label text-muted-foreground", className)} {...props} />
  )
);
CardEyebrow.displayName = "CardEyebrow";

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("flex items-center p-6 pt-0", className)} {...props} />
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardFooter, CardTitle, CardEyebrow, CardDescription, CardContent, cardVariants };
