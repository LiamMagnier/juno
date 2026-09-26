"use client";

import type { IconComponent } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * THE STARTING-POINT TILE, shared by Chat's empty state and Code's, so the
 * two landings hand the reader the same object (premium brief rule 2).
 *
 * Quiet at rest (ground-toned card, hairline), one rung up under the pointer
 * (lift 1px, deeper edge), selected while open. `.pressable` owns the
 * transition list, so no transition utility sits beside it. Dealt in once on
 * the page's first reveal with a backwards fill, so a tile is not painted for
 * one frame before its delay.
 */
export const startingTileClass = cn(
  "pressable group flex min-w-0 items-center gap-2.5 rounded-card border border-border/80 bg-card/60 p-2.5 text-left",
  "hover:-translate-y-px hover:border-foreground/15 hover:bg-card",
  "aria-expanded:border-foreground/20 aria-expanded:bg-card",
  "motion-reduce:hover:translate-y-0",
  "[animation-fill-mode:backwards] motion-safe:animate-rise-in"
);

/** Four across from `sm`, two on a phone. The caller sets the max width. */
export const startingGridClass = "mx-auto grid w-full grid-cols-2 gap-2 sm:grid-cols-4";

/** The inside of a tile: the mark in its own small well, the verb, one line
 *  on what it is for (dropped on a phone, where the tile becomes a row). */
export function StartingTileBody({ icon: Icon, label, hint }: { icon: IconComponent; label: string; hint: string }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-control bg-accent text-muted-foreground",
          "transition-colors duration-fast ease-out-soft group-hover:text-foreground group-aria-expanded:bg-primary/10 group-aria-expanded:text-primary motion-reduce:transition-none"
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-ui font-medium text-foreground">{label}</span>
        <span className="hidden truncate text-caption text-muted-foreground sm:block">{hint}</span>
      </span>
    </>
  );
}
