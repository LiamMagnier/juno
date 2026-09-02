import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { StatusIcons } from "@/lib/app-icons";
import { staggerDelay } from "@/lib/motion";
import type { PlanConfig } from "@/lib/plans";
import { cn } from "@/lib/utils";

/**
 * The plan card, in one place.
 *
 * The landing's pricing section and /upgrade were drawing the same tier with
 * two hand-copied cards that agreed on nothing — one a dotted-rule list item,
 * the other a tinted panel with its own badge, its own check glyph and its own
 * stagger step. This is the card both render now: `surface-raised` at
 * `rounded-card` with p-5, the recommended tier on the larger throw with a
 * coral edge, a display-size tabular price with a mono caption, a one-line
 * tagline, the feature checklist, and an action slot pinned to the bottom so
 * three cards in a row end on one baseline.
 *
 * Server-safe and presentational: no hooks, no data fetching. Callers pass
 * ready-made action nodes (or a `renderAction` that returns one) so the
 * landing can hand in plain links while /upgrade hands in its checkout
 * buttons — and a client-only control (the Max ×5/×20 switch) can ride in
 * through `header` without this file becoming a client component.
 */

export interface PlanCardItem {
  plan: PlanConfig;
  /** Overrides `plan.name` — /upgrade shows one "Max" card that switches tier. */
  name?: string;
  /** Formatted price. Defaults to `${plan.price} €`. */
  price?: string;
  /** The caption after the price — "/ mo", "HT / yr". */
  priceSuffix?: string;
  tagline?: string;
  features?: readonly string[];
  /** The tier the page is steering toward: bigger throw, coral edge, a badge. */
  recommended?: boolean;
  /** The reader's plan today. Wins over `recommended` for the badge. */
  current?: boolean;
  /** Rendered at the end of the title row (a tier switch, a count). */
  header?: ReactNode;
  /** The card's action. Wins over `renderAction`. */
  action?: ReactNode;
}

/**
 * Column count per card count. Tailwind scans for literal class strings, so
 * these cannot be interpolated; one-off counts fall back to the widest grid.
 */
const GRID_COLS: Record<number, string> = {
  1: "sm:max-w-sm",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
};

export function PlanCards({
  items,
  renderAction,
  className,
}: {
  items: PlanCardItem[];
  /** Fallback action for items that do not carry their own. */
  renderAction?: (plan: PlanConfig) => ReactNode;
  className?: string;
}) {
  return (
    <ul className={cn("grid items-stretch gap-4", GRID_COLS[items.length] ?? GRID_COLS[4], className)}>
      {items.map((item, i) => (
        <PlanCard key={item.plan.id} index={i} item={item} action={item.action ?? renderAction?.(item.plan)} />
      ))}
    </ul>
  );
}

function PlanCard({ item, index, action }: { item: PlanCardItem; index: number; action: ReactNode }) {
  const { plan, recommended, current, header } = item;
  const name = item.name ?? plan.name;
  const price = item.price ?? `${plan.price} €`;
  const suffix = item.priceSuffix ?? "/ mo";
  const tagline = item.tagline ?? plan.tagline;
  const features = item.features ?? plan.features;

  return (
    <li
      style={staggerDelay(index, "loose")}
      className={cn(
        "relative flex flex-col rounded-card p-5 motion-safe:animate-rise-in [animation-fill-mode:backwards]",
        // The recommended tier stands a step higher than its neighbours and
        // wears the accent on its edge: the larger throw, a coral hairline and a
        // 2px halo at low alpha. `shadow-raised-lg` is restated as a utility so
        // the ring composes with it — a ring is a box-shadow too, and on its own
        // it would replace the surface's throw rather than add to it.
        recommended
          ? "surface-raised-lg border-primary/60 shadow-raised-lg ring-2 ring-primary/15"
          : "surface-raised"
      )}
    >
      <div className="flex min-h-8 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="text-heading">{name}</h3>
          {current ? (
            <Badge variant="outline">Current plan</Badge>
          ) : recommended ? (
            <Badge variant="soft">Recommended</Badge>
          ) : null}
        </div>
        {header}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{tagline}</p>

      <p className="mt-4 flex items-baseline gap-1.5">
        <span className="text-display tabular-nums">{price}</span>
        <span className="font-mono text-caption text-muted-foreground">{suffix}</span>
      </p>

      <ul className="mt-5 space-y-2.5">
        {features.map((feature) => (
          <li key={feature} className="flex items-start gap-2.5 text-sm">
            <StatusIcons.success className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      {action && <div className="mt-auto pt-6">{action}</div>}
    </li>
  );
}
