import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const cardVariants = cva(
  // Scoped transition (not transition-all) so panel resizes/layout changes don't animate.
  "rounded-card border border-border/70 bg-card text-card-foreground transition-[border-color,background-color,box-shadow] duration-fast ease-out-soft",
  {
    variants: {
      variant: {
        default: "shadow-none",
        // `shadow-lift`, not a shadow drawn from --foreground. The literal here
        // was `0 8px 24px -20px hsl(var(--foreground)/0.28)`, and --foreground is
        // 94% lightness on dark — so every elevated card wore a soft WHITE halo
        // on the OLED-black ground. --shadow-lift carries the right ink per theme
        // (warm on paper, pure black on dark) and is the rung this wanted anyway.
        elevated: "shadow-lift",
        flat: "shadow-none",
        // Hover lifts one rung to --shadow-lift, not --shadow-float: float is the
        // OUT-OF-FLOW token, so a hovered tile was outranking every dropdown in
        // the product. The ladder is soft < lift < glass < float, monotonic.
        // The ambient --glow-primary halo goes with it — it was retired
        // product-wide for reading as a smudge; this call site never got the memo.
        //
        // The hover FILL is a full rung, not `bg-accent/20`. At /20 over a 6.5%
        // card the composite was ~7.8% — a 1.3-point step, which is nothing on
        // black. The product's primary clickable-card affordance had no visible
        // hover. `bg-accent` (13%) is the same 6.5-point step the ground→card
        // move already uses, so the card climbs one rung the eye can see.
        // `active:` is here because hover is not an affordance on touch, and the
        // card is the one primitive whose whole body is the hit target.
        interactive:
          "shadow-none hover:border-foreground/20 hover:bg-accent hover:shadow-lift active:bg-accent/80 focus-within:border-foreground/25 motion-reduce:transition-none",
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
  ({ className, ...props }, ref) => <div ref={ref} className={cn("flex flex-col space-y-1.5 p-5", className)} {...props} />
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("font-semibold leading-none tracking-tight", className)} {...props} />
  )
);
CardTitle.displayName = "CardTitle";

/**
 * Mono eyebrow for card sections — the Juno label voice.
 *
 * It was `text-xs font-semibold text-foreground`: sans, 12px, weight 600, full
 * contrast — a third competing eyebrow beside Label (label.tsx) and PageHeader,
 * in the primitive that appears most often. `text-label` is 0.75rem/500/0.10em,
 * which is the token the old triple was approximating by hand; muted-foreground
 * is what makes it an eyebrow rather than a second title.
 */
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
  ({ className, ...props }, ref) => <div ref={ref} className={cn("p-5 pt-0", className)} {...props} />
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("flex items-center p-5 pt-0", className)} {...props} />
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardFooter, CardTitle, CardEyebrow, CardDescription, CardContent, cardVariants };
