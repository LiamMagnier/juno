import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * The four interactive roles that are NOT the action button.
 *
 * `<Button>` models one thing well: a discrete action control. That is correct
 * for "Save" and wrong for almost everything else, which is why hundreds of
 * raw `<button>` elements had accumulated beside it:
 *
 *   kind="row"   a full-width, left-aligned selectable row — a conversation in
 *                the sidebar, a file, a menu entry. Flat; the affordance is the
 *                hover fill; SELECTED is the one raised object in its list.
 *   kind="tile"  a bordered card that is one of a set, usually `role="radio"` —
 *                accent swatches, model cards, plan pickers. `.control-neu`:
 *                raised at rest, pressed into the page when selected.
 *   kind="chip"  a pill-shaped filter or token. `.control-neu`.
 *   kind="icon"  a bare glyph affordance — close, copy, expand. Flat at rest,
 *                raises on hover, pressed when on.
 *
 * Shared behaviour comes from `.pressable` (globals.css). Focus is deliberately
 * NOT styled here: the global `:focus-visible` rule is authoritative.
 *
 * `.control-neu` reads `[data-selected]` (set below) for its pressed state, so
 * a selected tile, chip or icon goes DOWN — the same gesture as holding it —
 * and the compound variants below only add the accent edge and ink. That is
 * the Soft UI answer to "selected must not look like hovered": hover lifts,
 * selection sinks.
 */
const pressableVariants = cva(
  // `.pressable` carries the transition and the active:scale(0.97). The two
  // `motion-reduce:` escapes are here because a plain `:active` rule reads
  // neither --motion-shift nor --motion-scale-from, so the preference reaches
  // it through nothing else.
  "pressable relative select-none disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      /**
       * Named `kind`, not `role`, precisely because these elements almost
       * always need the HTML `role` attribute too — a tile is `role="radio"`,
       * a row is often `role="option"`.
       */
      kind: {
        // Every kind carries a 1px border (transparent where flat) so a
        // surface arriving on hover or selection never changes the box size.
        row: "flex w-full min-w-0 items-center gap-2.5 rounded-control border border-transparent px-2.5 py-2 text-left text-sm text-foreground/90 hover:bg-accent hover:text-accent-foreground",
        tile: "control-neu flex flex-col items-start gap-1 rounded-card p-3 text-left text-sm",
        chip: "control-neu inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground",
        // `rounded-full`: the house idiom for "a glyph you can press" is a circle.
        icon: "inline-flex items-center justify-center rounded-full border border-transparent text-muted-foreground hover:control-neu hover:border-border/60 hover:text-foreground",
      },
      /**
       * `selected` is a variant rather than a caller-supplied className because
       * a selected state that each site invents is the single most visible way
       * a set of controls stops looking like a set. Drives the visuals only —
       * pass the matching `aria-selected`/`aria-checked` yourself.
       */
      selected: { true: "", false: "" },
      size: {
        sm: "",
        md: "",
        lg: "",
      },
    },
    compoundVariants: [
      // A selected row is the one RAISED object in its list — the sidebar's
      // active conversation standing proud of the inset well around it. The
      // hover is pinned to the card fill so pointing at it does not swap the
      // raised surface for the flat accent wash an unselected sibling shows.
      {
        kind: "row",
        selected: true,
        class: "surface-raised border-border/60 text-foreground hover:bg-card hover:text-foreground",
      },
      // Tile, chip, icon: `.control-neu[data-selected]` supplies the pressed
      // recess and the secondary fill; these add the accent edge and ink, and
      // pin them through hover.
      {
        kind: "tile",
        selected: true,
        class: "border-primary/70 hover:border-primary/70 text-foreground",
      },
      {
        kind: "chip",
        selected: true,
        class: "border-primary/70 hover:border-primary/70 text-primary-ink hover:text-primary-ink",
      },
      {
        kind: "icon",
        selected: true,
        class: "control-neu border-border/60 text-primary-ink hover:text-primary-ink",
      },

      // Sizes. Only `icon` and `chip` are size-sensitive; a row and a tile size
      // to their content. Touch targets grow to ~44px on coarse pointers, the
      // same rule <Button> follows.
      { kind: "icon", size: "sm", class: "size-7 coarse:size-9" },
      { kind: "icon", size: "md", class: "size-8 coarse:size-10" },
      { kind: "icon", size: "lg", class: "size-9 coarse:size-11" },
      { kind: "chip", size: "sm", class: "h-6 px-2 text-caption" },
      { kind: "chip", size: "lg", class: "h-8 px-3 text-sm" },
      { kind: "row", size: "sm", class: "gap-2 px-2 py-1.5 text-xs" },
      { kind: "row", size: "lg", class: "gap-3 px-3 py-2.5" },
      { kind: "tile", size: "sm", class: "gap-0.5 p-2.5" },
      { kind: "tile", size: "lg", class: "gap-1.5 p-4" },
    ],
    defaultVariants: { kind: "row", selected: false, size: "md" },
  }
);

export interface PressableProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof pressableVariants> {
  /** Render as the child element (e.g. a `next/link`) instead of a `<button>`. */
  asChild?: boolean;
}

/**
 * A selectable surface. Use `<Button>` for a discrete action ("Save", "Delete");
 * use this for something the user is picking, opening or toggling.
 */
const Pressable = React.forwardRef<HTMLButtonElement, PressableProps>(
  ({ className, kind, selected, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        // Inside a <form>, a button with no type submits it. Every one of these
        // is a picker, never a submit.
        type={asChild ? undefined : (type ?? "button")}
        data-selected={selected ? "" : undefined}
        className={cn(pressableVariants({ kind, selected, size }), className)}
        {...props}
      />
    );
  }
);
Pressable.displayName = "Pressable";

export { Pressable, pressableVariants };
