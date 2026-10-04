import type { ReactNode } from "react";
import type { Plan } from "@prisma/client";

import { StatusIcons } from "@/lib/app-icons";
import type { PlanConfig } from "@/lib/plans";
import { cn } from "@/lib/utils";

/**
 * The three heavy tiers (Max ×5, Max ×10, Ultra) as rows, not cards.
 *
 * Seven tiers side by side is a spreadsheet, and the three at the top differ
 * from Pro in one way only: how much usage the month holds. So the page draws
 * the four tiers people choose between as cards and these three as one quiet
 * list underneath, each row saying the single thing that sets it apart (its
 * multiple of Pro), its price and its action. Same well as the FAQ below it
 * (`surface-inset` at rounded-card, p-1, rounded-control rows), so the page
 * keeps one elevated object: the recommended card.
 *
 * Server-safe and presentational, like PlanCards: callers hand in prices that
 * already went through planPriceParts() and ready-made actions.
 */

/** Usage as a multiple of Pro's monthly budget (BUDGET_EUR in spend.ts). */
export const USAGE_MULTIPLE: Partial<Record<Plan, number>> = { PLUS: 2.5, MAX: 5, MAX20: 10, ULTRA: 25 };

export interface HeavyUsePlanItem {
  plan: PlanConfig;
  price: string;
  priceSuffix: string;
  priceNote?: string | null;
  current?: boolean;
  action?: ReactNode;
}

export function HeavyUsePlans({
  items,
  heading = "For heavy use",
  description = "Everything in Pro, with more of the month to spend and the highest priority.",
  className,
}: {
  items: HeavyUsePlanItem[];
  heading?: string;
  description?: string;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <section className={cn("mt-10", className)} aria-labelledby="heavy-use-plans">
      <h2 id="heavy-use-plans" className="text-heading">
        {heading}
      </h2>
      <p className="mt-1 text-body text-muted-foreground">{description}</p>
      <ul className="surface-inset mt-4 rounded-card p-1">
        {items.map((item) => (
          <HeavyUseRow key={item.plan.id} item={item} />
        ))}
      </ul>
    </section>
  );
}

function HeavyUseRow({ item }: { item: HeavyUsePlanItem }) {
  const { plan, current } = item;
  const multiple = USAGE_MULTIPLE[plan.id];
  return (
    <li className="grid grid-cols-1 items-center gap-x-6 gap-y-3 rounded-control px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto_9rem]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-ui font-medium">{plan.name}</h3>
          {multiple != null && (
            <span className="text-ui tabular-nums text-muted-foreground">{`${multiple}× Pro usage`}</span>
          )}
          {current && (
            <span className="inline-flex items-center gap-1 text-ui text-muted-foreground">
              <StatusIcons.success className="size-3.5 shrink-0" aria-hidden="true" />
              Your plan
            </span>
          )}
        </div>
        <p className="mt-0.5 text-caption text-muted-foreground">{plan.tagline}</p>
      </div>
      <div className="sm:text-right">
        <p className="flex items-baseline gap-1.5 sm:justify-end">
          <span className="text-heading tabular-nums">{item.price}</span>
          <span className="font-mono text-caption text-muted-foreground">{item.priceSuffix}</span>
        </p>
        {item.priceNote && <p className="text-caption tabular-nums text-muted-foreground">{item.priceNote}</p>}
      </div>
      {item.action && <div className="w-full">{item.action}</div>}
    </li>
  );
}
