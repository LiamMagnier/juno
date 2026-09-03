"use client";

import { composerChipClass } from "@/components/ui/composer-shell";

/**
 * The shape every context chip on a Work composer wears — project, permission,
 * apps. It is the product-wide composer chip (`composerChipClass`) in the muted
 * ink, because these name the standing context of the run rather than a value
 * spent on this message; hover and open bring them up to full ink like every
 * other chip on the row.
 *
 * A constant rather than a component. The things that wear it are a
 * `<button>`, a `DropdownMenuTrigger`'s child and — one day — a link, and
 * wrapping them in a shared component would mean forwarding refs, `asChild` and
 * every native attribute through a layer that exists only to hold a string.
 */
export const COMPOSER_CHIP_CLASS = `${composerChipClass} max-w-[14rem] px-2 text-muted-foreground`;
