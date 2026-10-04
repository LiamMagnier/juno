import type { ReactNode } from "react";

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
  /** Overrides `plan.name`. */
  name?: string;
  /**
   * Formatted, tax-included price (planPriceParts() in price-display.ts).
   * Required: the HT figure in `plan.price` must never reach a consumer.
   */
  price: string;
  /** The caption after the price: "/mo incl. VAT". */
  priceSuffix?: string;
  /** One quiet line under the price: the yearly charge on annual billing. */
  priceNote?: string | null;
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
  const price = item.price;
  const suffix = item.priceSuffix ?? "/mo";
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
          {/* Words, not badges (owner directive, 2026-09-26): the
              recommended card already stands forward on the raised rung
              with the accent edge, and "your plan" is a fact. */}
          {current ? (
            <span className="inline-flex items-center gap-1 text-ui text-muted-foreground">
              <StatusIcons.success className="size-3.5 shrink-0" aria-hidden="true" />
              Your plan
            </span>
          ) : recommended ? (
            <span className="text-ui text-muted-foreground">Recommended</span>
          ) : null}
        </div>
        {header}
      </div>
      {/* Two lines reserved, so a one-line tagline does not lift its price
          above its neighbours' and four cards keep one baseline. */}
      <p className="mt-1 min-h-10 text-ui text-muted-foreground">{tagline}</p>

      {/* The figure alone on its line, its unit on the next: "€10.80 /mo
          incl. VAT" does not fit a quarter of the page, and a suffix that
          wraps under some figures and not others breaks the row. The yearly
          charge, when there is one, sits under the unit. */}
      <p className="mt-4 text-display tabular-nums">{price}</p>
      <p className="mt-1 font-mono text-caption tabular-nums text-muted-foreground">
        {suffix}
        {/* Always present (a no-break space when empty) so a Free card on
            yearly billing lines up with the paid ones beside it. */}
        <span className="block font-sans">{item.priceNote ?? "\u00a0"}</span>
      </p>

      <ul className="mt-4 space-y-2.5">
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
