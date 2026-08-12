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
  //
  // The two `motion-reduce:` escapes are here because `.pressable`'s dip has no
  // other way out. Tier B of the reduced-motion policy (globals.css) works by
  // having KEYFRAMES read --motion-shift/--motion-scale-from; a plain
  // `.pressable:active { transform: scale(.97) }` rule reads neither, so the
  // preference reached it through nothing at all. `<Button>` states exactly this
  // pair for exactly this reason, and these ~130 call sites — the majority of
  // the pressable surfaces in the product — were the ones still moving.
  // (The utilities are emitted after the components layer and match on `:active`
  // at equal specificity, so they win over the class rule they are cancelling.)
  "pressable relative select-none disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100 [&_svg]:pointer-events-none [&_svg]:shrink-0",
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
        // Full-strength surface tokens. `bg-card/40 border-border/60` was tuned
        // against the old 9%-lightness ground; over #000 it composited to ~2.6%
        // with a ~9.6% border, so the variant whose whole job is to be "a
        // bordered card that is one of a set" (accent swatches, model cards,
        // plan pickers) was invisible until the pointer was already on it — and
        // its hover only reached the card rung it should have started at. The
        // hover is a real step up now: card 6.5% → accent 13%.
        tile: "flex flex-col items-start gap-1 rounded-card border border-border/70 bg-card p-3 text-left text-sm hover:border-border hover:bg-accent",
        chip: "inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-1 text-xs font-medium text-muted-foreground hover:border-border hover:bg-accent/60 hover:text-foreground",
        // `rounded-full`, and that is measured rather than chosen. Of the 34
        // bare square icon buttons in the product, 20 were already circular and
        // the other 14 were spread across seven radii — lg, xs, md, sm, xl,
        // composer-action, and one with none at all. The house idiom for "a
        // glyph you can press" is a circle; those 14 were drift, not dissent.
        icon: "inline-flex items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground",
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
      //
      // Two things were true of `row` and of none of its three siblings, and
      // both are corrected below.
      //
      // EVERY SELECTED STATE PINS ITS OWN HOVER. `row` ends in
      // `hover:bg-primary/10` for a reason the other three needed just as badly:
      // the base kind still carries `hover:bg-accent` (or `/60`), which is a
      // different merge group from the flat `bg-*` the compound sets, so both
      // survive — and the moment the pointer lands on a selected tile, chip or
      // icon its accent tint was replaced by the same neutral grey an unselected
      // sibling shows. The one control the user has chosen was the one control
      // that stopped looking chosen while they were pointing at it.
      //
      // AND THE TINTS ARE RECOMPUTED AGAINST BLACK. These alphas were set when
      // the dark ground was 12.5% charcoal, where 6-10% of the accent still
      // composited to something above the surface around it. Over #000 they
      // resolve to 2.8% (tile) and 4.6% (row/icon) — so a selected tile came out
      // DARKER than the `bg-card` (6.5%) of the unselected tiles beside it, and
      // a selected row sat below the 13% `bg-accent` of a merely hovered one.
      // The selection was inverted relative to both of the states it has to beat.
      // Light is untouched (its ramp runs the other way and reads correctly at
      // these values); dark gets the alpha that reproduces the same lift, which
      // is the same per-theme split TabsTrigger and the segmented thumb make.
      {
        kind: "row",
        selected: true,
        class:
          "bg-primary/10 hover:bg-primary/10 dark:bg-primary/25 dark:hover:bg-primary/25 text-foreground ring-1 ring-inset ring-primary/30",
      },
      {
        kind: "tile",
        selected: true,
        class:
          "border-primary/70 hover:border-primary/70 bg-primary/[0.06] hover:bg-primary/[0.06] dark:bg-primary/20 dark:hover:bg-primary/20 text-foreground shadow-pop",
      },
      {
        kind: "chip",
        selected: true,
        class:
          "border-primary/70 hover:border-primary/70 bg-primary/10 hover:bg-primary/10 text-primary-ink hover:text-primary-ink",
      },
      // `bg-accent` was the icon's ENTIRE selected state — and `bg-accent` is
      // also its hover fill, so an icon toggle that is ON and an icon toggle the
      // pointer happens to be resting on were pixel-identical. That is precisely
      // the failure the note above records for `row`, left in place on the kind
      // with the fewest other cues: no border, no label, no ring. It joins the
      // other three on the accent tint plus the ink ramp.
      {
        kind: "icon",
        selected: true,
        class:
          "bg-primary/15 hover:bg-primary/15 dark:bg-primary/25 dark:hover:bg-primary/25 text-primary-ink hover:text-primary-ink",
      },

      // Sizes. Only `icon` and `chip` are size-sensitive; a row and a tile size
      // to their content. Touch targets grow to ~44px on coarse pointers, the
      // same rule <Button> follows.
      { kind: "icon", size: "sm", class: "size-7 coarse:size-9" },
      { kind: "icon", size: "md", class: "size-8 coarse:size-10" },
      { kind: "icon", size: "lg", class: "size-9 coarse:size-11" },
      // text-caption IS 11px (0.6875rem) — the arbitrary value was the token
      // spelled out longhand, minus the 0.02em tracking that keeps a chip label
      // legible at that size.
      { kind: "chip", size: "sm", class: "h-6 px-2 text-caption" },
      { kind: "chip", size: "lg", class: "h-8 px-3 text-sm" },
      // `text-xs` (12), not the off-ladder `text-[13px]`. 13 is not a rung —
      // the sans steps either side of it are 12 and 14 — so a compact row was
      // the one control in the product setting its own type size, and it is the
      // same 13px SegmentedControl's icon rail was moved off for the same
      // reason. 12 is the rung the compact `chip` already uses, which is the
      // register a dense row belongs in.
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
