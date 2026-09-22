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
 * ONE ACCENT PER ROW OF CARDS. The coral is spent on two things only: the
 * recommended tier's edge and the one primary CTA the caller hands in. The
 * checklist ticks are the success mark in muted ink — "included" is neither a
 * state nor an action, and fifteen coral ticks across three cards drowned out
 * the one coral button that mattered. The reader's own plan is marked by a
 * check in its badge, which is a state, and is the one tick that may be loud.
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
  // `mx-auto`, not just the width cap. A lone card was capped at 24rem and
  // left where the grid put it — hard against the left gutter with two thirds
  // of the page empty beside it, which reads as two cards that failed to
  // load. One card is the whole row, so it belongs in the middle of it. This
  // is reachable in production whenever a tier is withheld (billing not
  // configured on a deployment, a plan hidden for an account), and it is what
  // /upgrade renders today when Stripe is absent.
  1: "sm:mx-auto sm:max-w-sm",
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
        // wears the accent on its edge: the larger throw and a coral hairline.
        // The 2px coral halo it also wore is gone — a tinted glow around the
        // thing we want bought is the pricing-page version of the send-button
        // halo FLAT_UI.md retired, and the edge already says it.
        recommended ? "surface-raised-lg border-primary/60" : "surface-raised"
      )}
    >
      <div className="flex min-h-8 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="text-heading">{name}</h3>
          {current ? (
            <Badge variant="outline" className="gap-1">
              <StatusIcons.success className="size-3 shrink-0 text-primary" aria-hidden="true" />
              Current plan
            </Badge>
          ) : recommended ? (
            <Badge variant="soft">Recommended</Badge>
          ) : null}
        </div>
        {header}
      </div>
      <p className="mt-1 text-ui text-muted-foreground">{tagline}</p>

      <p className="mt-4 flex items-baseline gap-1.5">
        <span className="text-display tabular-nums">{price}</span>
        <span className="font-mono text-caption text-muted-foreground">{suffix}</span>
      </p>

      <ul className="mt-5 space-y-2.5">
        {features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-ui">
            <StatusIcons.success className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      {action && <div className="mt-auto pt-6">{action}</div>}
    </li>
  );
}
