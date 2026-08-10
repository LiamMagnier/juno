import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * The four interactive roles that are NOT the action button.
 *
 * `<Button>` models one thing well: a discrete action control — fixed height,
 * horizontal padding, a glossy fill, a sheen that sweeps on hover. That is
 * correct for "Save" and wrong for almost everything else, which is why 255
 * raw `<button>` elements had accumulated beside it. They were not people
 * ignoring the design system. They were people with nowhere to land:
 *
 *   kind="row"   ~61 sites  a full-width, left-aligned selectable row — a
 *                           conversation in the sidebar, a file, a menu entry.
 *                           Content is arbitrary; the affordance is the fill.
 *   kind="tile"  ~28 sites  a bordered card that is one of a set, usually
 *                           `role="radio"` — accent swatches, model cards,
 *                           plan pickers. Needs a real selected state.
 *   kind="chip"  ~18 sites  a pill-shaped filter or token.
 *   kind="icon"  ~23 sites  a bare glyph affordance — close, copy, expand.
 *
 * Each of those had been re-implemented by hand dozens of times, so each site
 * made its own call on radius, hover fill, press feedback, selected styling and
 * disabled handling. Hence "not every button is the same": they were not the
 * same because nothing said what the same would be.
 *
 * Shared behaviour comes from `.pressable` (globals.css), which already existed
 * and which 61 of those call sites had reached for — the right instinct with no
 * component to attach it to. Focus is deliberately NOT styled here: the global
 * `:focus-visible` rule in globals.css is authoritative, and a ring-offset
 * declared per-component is how four hand-forked offset colours accumulated on
 * `<Button>` before it was cleaned up.
 */
const pressableVariants = cva(
  // `.pressable` carries the transition and the active:scale(0.97).
  // `select-none` because these are controls whose labels get double-clicked by
  // users trying to press them twice.
  "pressable relative select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      /**
       * Named `kind`, not `role`, precisely because these elements almost
       * always need the HTML `role` attribute too — a tile is `role="radio"`,
       * a row is often `role="option"`. A variant prop that shadowed it would
       * make the accessible markup unexpressible, which is a strange way to
       * improve a design system.
       */
      kind: {
        row: "flex w-full min-w-0 items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-sm text-foreground/90 hover:bg-accent hover:text-accent-foreground",
        tile: "flex flex-col items-start gap-1 rounded-card border border-border/60 bg-card/40 p-3 text-left text-sm hover:border-border hover:bg-card",
        chip: "inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-1 text-xs font-medium text-muted-foreground hover:border-border hover:text-foreground",
        icon: "inline-flex items-center justify-center rounded-control text-muted-foreground hover:bg-accent hover:text-foreground",
      },
      /**
       * `selected` is a variant rather than a caller-supplied className because
       * a selected state that each site invents is the single most visible way
       * a set of controls stops looking like a set. Drives the visuals only —
       * pass the matching `aria-selected`/`aria-checked` yourself, since which
       * one is correct depends on the surrounding role.
       */
      selected: { true: "", false: "" },
      size: {
        sm: "",
        md: "",
        lg: "",
      },
    },
    compoundVariants: [
      // Selected, per role. A row fills; a tile takes the accent border and a
      // tinted ground; a chip inverts; an icon holds the hover fill.
      // NOT `bg-accent`: that is the row's own hover fill, so a selected row and
      // a merely-hovered one would be indistinguishable — and in a radio list
      // the pointer is usually resting on a row while you read the others. The
      // primary tint plus an inset ring is the treatment code-target-picker had
      // already arrived at independently, which is a good sign it is the right
      // one; the ring is inset so it does not enlarge the row's footprint.
      {
        kind: "row",
        selected: true,
        class: "bg-primary/10 text-foreground ring-1 ring-inset ring-primary/30 hover:bg-primary/10",
      },
      {
        kind: "tile",
        selected: true,
        class: "border-primary/70 bg-primary/[0.06] text-foreground shadow-pop",
      },
      {
        kind: "chip",
        selected: true,
        class: "border-primary/70 bg-primary/10 text-primary-ink",
      },
      { kind: "icon", selected: true, class: "bg-accent text-foreground" },

      // Sizes. Only `icon` and `chip` are size-sensitive; a row and a tile size
      // to their content. Touch targets grow to ~44px on coarse pointers, the
      // same rule <Button> follows.
      { kind: "icon", size: "sm", class: "size-7 coarse:size-9" },
      { kind: "icon", size: "md", class: "size-8 coarse:size-10" },
      { kind: "icon", size: "lg", class: "size-9 coarse:size-11" },
      { kind: "chip", size: "sm", class: "h-6 px-2 text-[11px]" },
      { kind: "chip", size: "lg", class: "h-8 px-3 text-sm" },
      { kind: "row", size: "sm", class: "gap-2 px-2 py-1.5 text-[13px]" },
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
        // is a picker, never a submit, and the default has bitten this codebase
        // before (see the composer's send handling).
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
