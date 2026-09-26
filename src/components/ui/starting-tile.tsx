"use client";

import type { IconComponent } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * THE STARTING-POINT CHIP, shared by Chat's empty state and Code's, so the two
 * landings hand the reader the same object.
 *
 * A pill with one word and a duotone glyph in the brand ink. It replaced a
 * four-up grid of tiles (a grey icon well, a verb and a hint line each) that
 * read as a template: four equal cards under the composer competed with it,
 * and the hairline icons in grey squares were the flattest thing on the page.
 * The chip is quieter at rest and warmer up close: Phosphor's duotone cut is
 * its own drawing (a tinted fill under the line), not a recoloured outline.
 *
 * The hint stays in the accessible name (and the caller's tooltip, if any), so
 * nothing the tile used to say is lost to a screen reader.
 */
export const startingTileClass = cn(
  "pressable group inline-flex h-9 items-center gap-2 rounded-full border border-border/70 bg-card/70 pl-3 pr-3.5",
  "text-ui font-medium text-foreground/80 shadow-[0_1px_1px_hsl(var(--foreground)/0.03)]",
  "hover:border-foreground/15 hover:bg-card hover:text-foreground",
  "aria-expanded:border-foreground/20 aria-expanded:bg-card aria-expanded:text-foreground",
  "[animation-fill-mode:backwards] motion-safe:animate-fade-in"
);

/** One centred row that wraps on a phone. The caller sets the max width. */
export const startingGridClass = "mx-auto flex w-full flex-wrap items-center justify-center gap-2";

export function StartingTileBody({ icon: Icon, label, hint }: { icon: IconComponent; label: string; hint: string }) {
  return (
    <>
      <Icon
        aria-hidden="true"
        weight="duotone"
        className="size-[18px] shrink-0 text-primary transition-transform duration-fast ease-out-soft group-hover:-rotate-6 motion-reduce:transition-none motion-reduce:group-hover:rotate-0"
      />
      <span>{label}</span>
      <span className="sr-only">: {hint}</span>
    </>
  );
}
