"use client";

import * as React from "react";
import type { Plan } from "@prisma/client";
import { PLANS } from "@/lib/plans";
import { Check } from "@/components/ui/icons";
import { planCapabilities } from "@/lib/billing/plan-capabilities";
import { cn } from "@/lib/utils";

/**
 * Every plan side by side, drawn in dots: a dot for what a plan has, a faint
 * point for what it does not, a dot meter for the month's usage, and words
 * only where the difference is a word (which models, how much priority).
 * The column being looked at is lit; pressing a column's head picks it.
 */
const ROWS: { id: string; label: string }[] = [
  { id: "models", label: "Models" },
  { id: "usage", label: "Usage each month" },
  { id: "search", label: "Web search" },
  { id: "research", label: "Deep Field research" },
  { id: "code", label: "Alevr Code" },
  { id: "agents", label: "Orbit agents" },
  { id: "voice", label: "Voice mode" },
  { id: "priority", label: "Priority" },
  { id: "uploads", label: "File uploads" },
  { id: "memory", label: "Memory and artifacts" },
];

function Cell({ plan, row }: { plan: Plan; row: string; plans?: readonly Plan[] }) {
  const caps = planCapabilities(plan);
  const has = caps.find((c) => c.id === row);
  if (row === "models") {
    const word = has?.level === 2 ? "Every model" : has?.level === 1 ? "Everyday" : "Fast";
    return <span className="text-caption text-foreground">{word}</span>;
  }
  if (row === "usage") {
    const m = PLANS[plan].usageVsPro;
    return <span className="text-caption tabular-nums text-foreground">{plan === "FREE" ? "Base" : m === 1 ? "Pro" : `${m}× Pro`}</span>;
  }
  if (row === "priority") {
    return has ? (
      <span className="text-caption text-foreground">{has.level === 2 ? "Highest" : "Higher"}</span>
    ) : (
      <span className="text-caption text-muted-foreground">Standard</span>
    );
  }
  if (row === "uploads") return <span className="text-caption tabular-nums text-foreground">{PLANS[plan].maxUploadMb} MB</span>;
  return has ? (
    <Check aria-label="Included" className="mx-auto size-4 text-foreground" />
  ) : (
    <span aria-label="Not included" className="text-caption text-muted-foreground">
      –
    </span>
  );
}

export function PlanCompare({
  plans,
  selected,
  current,
  priceOf,
  onSelect,
}: {
  plans: readonly Plan[];
  selected: Plan;
  current: Plan;
  priceOf: (plan: Plan) => string;
  onSelect: (plan: Plan) => void;
}) {
  const cols = `minmax(9.5rem,1.3fr) repeat(${plans.length}, minmax(5.5rem,1fr))`;
  return (
    <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:thin]">
      <div role="table" aria-label="Plans side by side" className="min-w-[44rem]">
        <div role="row" className="grid items-end" style={{ gridTemplateColumns: cols }}>
          <span role="columnheader">
            <span className="sr-only">Feature</span>
          </span>
          {plans.map((plan) => (
            <span role="columnheader" key={plan} className={cn("plans-col rounded-t-card px-2 pb-3 pt-3 text-center", plan === selected && "")} data-selected={plan === selected || undefined}>
              <button
                type="button"
                onClick={() => onSelect(plan)}
                className="mx-auto grid justify-items-center gap-1 rounded-control px-2 py-1 transition-colors duration-fast ease-out-soft hover:bg-foreground/[0.05]"
              >
                <span className={cn("font-serif text-heading font-normal leading-none", plan === selected ? "text-foreground" : "text-muted-foreground")}>
                  {PLANS[plan].name}
                </span>
                <span className="text-micro tabular-nums text-muted-foreground">{priceOf(plan)}</span>
                {plan === current && <span className="text-micro text-muted-foreground">your plan</span>}
              </button>
            </span>
          ))}
        </div>
        <div className="plans-rule" aria-hidden />
        {ROWS.map((row, r) => (
          <div role="row" key={row.id} className="grid items-center" style={{ gridTemplateColumns: cols }}>
            <span role="rowheader" className="py-3.5 pr-3 text-ui text-muted-foreground">
              {row.label}
            </span>
            {plans.map((plan) => (
              <span
                role="cell"
                key={plan}
                data-selected={plan === selected || undefined}
                className={cn("plans-col flex min-h-12 items-center justify-center px-2 py-3.5", r === ROWS.length - 1 && "rounded-b-card")}
              >
                <Cell plan={plan} row={row.id} plans={plans} />
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
