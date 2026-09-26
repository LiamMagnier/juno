import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * A card is `.surface-raised` (docs/design/FLAT_UI.md §2.2): the card fill,
 * the hairline, and the 1px contact shadow the flat material allows in flow.
 *
 *   default      raised
 *   elevated     the bigger throw — hero cards, pricing, project tiles
 *   flat         fill + hairline, no shadow — for a card that sits INSIDE
 *                another raised surface, where a second shadow would stack
 *   interactive  raised; on hover the hairline darkens and the fill takes a
 *                faint tonal wash, and it goes a shade deeper while held —
 *                the whole body is the hit target
 *
 * The interactive card used to LIFT on hover (to the large shadow throw). In
 * the flat language nothing in flow casts a shadow and nothing rises under the
 * pointer; state is tonal (ICONS_AND_MOTION.md §2.2, rule 1). A card is also a
 * large surface, so it does not scale under the finger either — the fill step
 * on `:active` is its press.
 *
 * The transition is scoped (not transition-all) so panel resizes and layout
 * changes never animate.
 */
const cardVariants = cva(
  "rounded-card text-card-foreground transition-[border-color,background-color,box-shadow,transform] duration-base ease-out-expo motion-reduce:transition-none",
  {
    variants: {
      variant: {
        default: "surface-raised",
        elevated: "surface-raised-lg",
        flat: "border border-border/60 bg-card shadow-none",
        // `hover:` and `active:` utilities outrank the components-layer class
        // (pseudo-class specificity), which is what lets the surface change
        // depth without a second material. `active:` is here because hover is
        // not an affordance on touch.
        //
        // It lifts again (premium pass, brief rule 3): a 2px rise onto the
        // `raised-lg` throw, so a card that opens something reads as an
        // object you can pick up, and one that does not (default) stays on
        // the page. Transform only, under motion-safe, and it settles back to
        // the page while held, which is the press.
        interactive:
          "surface-raised hover:border-foreground/20 hover:bg-accent/40 hover:shadow-raised-lg motion-safe:hover:-translate-y-0.5 active:translate-y-0 active:bg-selected active:shadow-raised focus-within:border-foreground/25",
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
 * Mono eyebrow for card sections — the Juno label voice. `text-label` is
 * 0.75rem/500/0.10em; muted-foreground is what makes it an eyebrow rather
 * than a second title.
 */
const CardEyebrow = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn("font-mono text-label text-muted-foreground", className)} {...props} />
  )
);
CardEyebrow.displayName = "CardEyebrow";

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("text-body text-muted-foreground", className)} {...props} />
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
