"use client";

/**
 * The shape every chip on the Work composer's second row wears.
 *
 * Pulled out of `work-composer.tsx` when the row it belongs to stopped being
 * the only place it was used. The Project chip, the permission chip and
 * anything a later strip grows are the same 32px box with the same
 * nothing-at-rest treatment, and the reason that matters is unchanged from
 * where it was written: the strip must not resize as its fetches land under it,
 * because a control that changes width the moment a request resolves is a
 * control that moves out from under the pointer heading for it.
 *
 * A constant rather than a component. The three things that wear it are a
 * `<button>`, a `DropdownMenuTrigger`'s child and — one day — a link, and
 * wrapping them in a shared component would mean forwarding refs, `asChild` and
 * every native attribute through a layer that exists only to hold a string.
 */
export const COMPOSER_CHIP_CLASS =
  "group inline-flex h-7 min-w-0 max-w-[14rem] items-center gap-1.5 rounded-lg px-2 text-xs font-normal text-muted-foreground transition-[background-color,color,transform] duration-fast ease-out-soft hover:bg-accent/80 hover:text-foreground active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-accent data-[state=open]:text-foreground coarse:h-9";
