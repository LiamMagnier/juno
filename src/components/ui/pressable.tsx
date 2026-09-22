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
 *                hover fill; SELECTED keeps that fill at full strength.
 *   kind="tile"  a bordered card that is one of a set, usually `role="radio"` —
 *                accent swatches, model cards, plan pickers. `.control-neu`:
 *                a hairline at rest, a tonal fill on hover, a deeper one plus
 *                the accent edge when selected.
 *   kind="chip"  a pill-shaped filter or token. `.control-neu`.
 *   kind="icon"  a bare glyph affordance — close, copy, expand. Flat at rest,
 *                a circular tonal fill on hover, the secondary fill when on.
 *
 * Shared behaviour comes from `.pressable` (globals.css): the tonal hover
 * cross-fade on --dur-fast and the 0.97 dip on --dur-press. A ROW does not
 * dip: it is a large surface, and large surfaces never scale
 * (ICONS_AND_MOTION.md §2.2, rule 2) — a full-width row shrinking by 3% moves
 * its edges further than a button's whole dip. It presses TONALLY instead,
 * stepping to the `--secondary` fill while held, the same pressed tone
 * `.control-neu` and the ghost IconButton take. Focus is deliberately NOT
 * styled here: the global `:focus-visible` rule is authoritative. A glyph
 * inside any kind plays its own hover articulation (icons.tsx), because every
 * kind renders a button or a link.
 *
 * `.control-neu` reads `[data-selected]` (set below) for its "on" fill, so a
 * selected tile, chip or icon takes the same deeper tone as one being held,
 * and the compound variants below only add the accent edge and ink. That is
 * the flat answer to "selected must not look like hovered": hover is a wash,
 * selection is a bounded, accent-edged fill.
 */
const pressableVariants = cva(
  // `.pressable` carries the transition and the active:scale(0.97). The
  // `motion-reduce:` escapes are here because a plain `:active` rule reads
  // neither --motion-shift nor --motion-scale-from, so the preference reaches
  // it through nothing else. Under the preference only the TRAVEL goes: the
  // dip is held at scale 1 and transform leaves the transition list, while
  // colour, fill, edge and opacity keep their cross-fade on the fast rung
  // (Tier A of the reduced-motion note in globals.css — removing feedback is
  // not an accessibility win). The timing is restated with the list rather
  // than left to `.pressable`, because a bare `transition-property` would
  // re-pair the remaining properties with the class's duration list by
  // position and hand colour the 70ms press rung. It is written as arbitrary
  // properties, not `duration-fast` / `ease-out-soft`: tailwindcss-animate
  // reads those utilities as ANIMATION timing too, and would retime an
  // entrance on the same element.
  "pressable relative select-none disabled:pointer-events-none disabled:opacity-50 " +
    "motion-reduce:transition-[color,background-color,border-color,opacity,box-shadow,filter] " +
    "motion-reduce:[transition-duration:var(--dur-fast)] motion-reduce:[transition-timing-function:var(--ease-out-soft)] " +
    "motion-reduce:active:scale-100 " +
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
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
        // On the shell's grid: `text-body` at `gap-2.5`, like every other list
        // row in the product. It was `text-ui` on `py-2` with no fixed height,
        // which is what left the settings rail and every other caller of this
        // primitive a rung of type below the sidebar that opens them.
        //
        // `active:scale-100` cancels `.pressable`'s dip (a row never scales)
        // and `active:bg-secondary` is its press: a tonal step, on the same
        // fast cross-fade as the hover fill.
        row: "flex w-full min-w-0 items-center gap-2.5 rounded-control border border-transparent px-2.5 py-1.5 text-left text-body text-foreground/90 hover:bg-accent hover:text-accent-foreground active:scale-100 active:bg-secondary",
        tile: "control-neu flex flex-col items-start gap-1 rounded-card p-3 text-left text-ui",
        chip: "control-neu inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-caption font-medium text-muted-foreground hover:text-foreground",
        // `rounded-full`: the house idiom for "a glyph you can press" is a circle.
        icon: "inline-flex items-center justify-center rounded-full border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
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
      // A selected row keeps the hover fill at rest, and the hover is pinned
      // to it so pointing at the selected row does not change it — the
      // pointer moving across a list must never make the current row flicker.
      {
        kind: "row",
        selected: true,
        class: "bg-accent text-foreground hover:bg-accent hover:text-foreground",
      },
      // Tile, chip, icon: `.control-neu[data-selected]` supplies the
      // secondary fill; these add the accent edge and ink, and pin them
      // through hover.
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
        class: "bg-secondary text-primary-ink hover:text-primary-ink",
      },

      // Sizes. Only `icon` and `chip` are size-sensitive; a row and a tile size
      // to their content. Touch targets grow to ~44px on coarse pointers, the
      // same rule <Button> follows.
      { kind: "icon", size: "sm", class: "size-7 coarse:size-9" },
      { kind: "icon", size: "md", class: "size-8 coarse:size-10" },
      { kind: "icon", size: "lg", class: "size-9 coarse:size-11" },
      { kind: "chip", size: "sm", class: "h-6 px-2 text-caption" },
      { kind: "chip", size: "lg", class: "h-8 px-3 text-ui" },
      { kind: "row", size: "sm", class: "gap-2 px-2 py-1.5 text-caption" },
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
