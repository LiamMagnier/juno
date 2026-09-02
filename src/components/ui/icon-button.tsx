import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * A glyph you can press, as a raised key: `.control-neu` at `rounded-control`
 * (10) — raised at rest, pressed into the page while held or while
 * `aria-pressed`. Every size grows to a 44px target on a coarse pointer.
 *
 * Distinct from `<Pressable kind="icon">`, which is the FLAT circular
 * affordance for close/copy/expand glyphs that sit on another surface. This
 * is a real control — a toolbar action, the composer's attach button, the
 * sidebar collapse — and it stands on the page by itself.
 *
 * `label` is required and becomes the accessible name (and the tooltip, via
 * `title`, unless one is passed): an icon-only button with no name is the
 * single most common accessibility failure in a toolbar.
 */
const iconButtonVariants = cva(
  "ui-button pressable inline-flex shrink-0 items-center justify-center rounded-control border disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "control-neu border-border/60 text-foreground",
        // Flat at rest for dense toolbars; raises on hover, presses when on.
        ghost:
          "border-transparent bg-transparent text-muted-foreground hover:border-border/60 hover:bg-card hover:text-foreground hover:shadow-raised active:bg-secondary active:shadow-pressed aria-pressed:border-border/60 aria-pressed:bg-secondary aria-pressed:text-foreground aria-pressed:shadow-pressed",
        primary: "control-primary border-primary/90",
      },
      size: {
        sm: "size-8 coarse:size-11",
        md: "size-9 coarse:size-11",
        lg: "size-11",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  }
);

export interface IconButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label">,
    VariantProps<typeof iconButtonVariants> {
  /** The accessible name. Required — an icon is not a label. */
  label: string;
  asChild?: boolean;
}

const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant, size, label, title, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : (type ?? "button")}
        aria-label={label}
        title={title ?? label}
        className={cn(iconButtonVariants({ variant, size }), className)}
        {...props}
      />
    );
  }
);
IconButton.displayName = "IconButton";

export { IconButton, iconButtonVariants };
