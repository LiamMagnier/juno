"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { toast } from "sonner";
import type { Plan } from "@prisma/client";

import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { useApp } from "@/components/app/app-provider";
import { PlanCards, type PlanCardItem } from "@/components/billing/plan-cards";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusIcons } from "@/lib/app-icons";
import { PLANS, planRank } from "@/lib/plans";

type MaxTier = "MAX" | "MAX20";
type BillingInterval = "month" | "year";

/*
 * Annual is twelve months, priced as twelve months.
 *
 * Most of the market discounts 17-23% for paying up front. Juno does not, and
 * the page says so rather than staying quiet and letting people hunt for a
 * saving that is not there. What annual buys is one invoice a year instead of
 * twelve — which is worth something to some people and nothing to others, and
 * that is the honest pitch.
 *
 * The entitlement is identical, and so is the budget: it stays MONTHLY on both
 * intervals, because a year of budget released at once would be a different
 * product.
 */
const MONTHS_PER_YEAR = 12;

const MAX_TIERS: { id: MaxTier; label: string; multiplier: string }[] = [
  { id: "MAX", label: "Max ×5", multiplier: "×5" },
  { id: "MAX20", label: "Max ×20", multiplier: "×20" },
];

function planLabel(plan: Plan): string {
  return PLANS[plan].name;
}

/**
 * The questions people ask before they pay, answered in the product's own
 * words — every line here restates something the code already enforces
 * (plans.ts, spend.ts, the CGU) so the page cannot promise what the service
 * does not do.
 */
const FAQ: { q: string; a: string; annualOnly?: boolean }[] = [
  {
    q: "What does a plan actually buy?",
    a: "A monthly budget of real model usage, metered at the providers' own list prices. Every reply shows its cost on the receipt. Light models stretch the budget; frontier models spend it faster — your call, visibly.",
  },
  {
    q: "Which models come with each plan?",
    a: "Free gets the everyday models — Claude Sonnet, GPT Mini, Gemini Flash and friends. Every paid plan unlocks the whole lineup, flagships included; Max tiers add more monthly headroom and the highest priority.",
  },
  {
    q: "Is yearly billing cheaper?",
    a: "No. Yearly is twelve months at the monthly rate — the same price, one invoice instead of twelve. The usage budget stays monthly on both intervals.",
    annualOnly: true,
  },
  {
    q: "Can I change or cancel later?",
    a: "Any time. Upgrades apply instantly. If you cancel, paid features stay on until the end of the billing period you have already paid for, and your data stays yours to export.",
  },
  {
    q: "What does fair use mean?",
    a: "Fair use keeps Juno fast for everyone. If your usage ever looks like it needs a conversation, we reach out first — nothing changes on your account without notice.",
  },
];

export default function UpgradePage() {
  const { quota, features } = useApp();
  const currentPlan = quota.plan;
  const [loading, setLoading] = React.useState<Plan | null>(null);
  const [interval, setInterval] = React.useState<BillingInterval>("month");
  const annualAvailable = features.purchasableAnnualPlans.length > 0;

  // Only offer a tier whose Stripe price id is configured — checkout returns
  // 503 "Plan price is not configured." otherwise, so rendering the button at
  // all is a broken promise. A subscriber already on an unconfigured tier still
  // sees it, because it is their current plan and hiding it would be a lie.
  const offerable = React.useCallback(
    (plan: Plan) => {
      const sellable =
        interval === "year" ? features.purchasableAnnualPlans : features.purchasablePlans;
      return sellable.includes(plan) || plan === currentPlan;
    },
    [features.purchasablePlans, features.purchasableAnnualPlans, interval, currentPlan]
  );

  const maxTiers = MAX_TIERS.filter((t) => offerable(t.id));
  const [maxTier, setMaxTier] = React.useState<MaxTier>(currentPlan === "MAX20" ? "MAX20" : "MAX");
  // The stored tier can fall out of the offerable set (env change, or the
  // initial "MAX" default on a deployment that only sells ×20).
  const activeMaxTier: MaxTier | null =
    maxTiers.find((t) => t.id === maxTier)?.id ?? maxTiers[0]?.id ?? null;

  const checkout = async (plan: Plan) => {
    setLoading(plan);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, interval }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) window.location.href = data.url;
      else throw new Error(data.error ?? "Could not start checkout.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Checkout failed.");
      setLoading(null);
    }
  };

  const manage = async () => {
    const res = await fetch("/api/stripe/portal", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.url) window.location.href = data.url;
    else toast.error(data.error ?? "Could not open billing portal.");
  };

  const cta = (plan: Plan, variant: "default" | "secondary") => {
    const rankDiff = planRank(plan) - planRank(currentPlan);
    if (plan === currentPlan) {
      return (
        <Button variant="secondary" className="w-full" disabled>
          Current plan
        </Button>
      );
    }
    if (plan === "FREE") {
      return (
        <Button variant="secondary" className="w-full" onClick={manage} disabled={!features.billing}>
          Downgrade
        </Button>
      );
    }
    if (rankDiff > 0) {
      return (
        <Button
          variant={variant}
          className="w-full"
          onClick={() => checkout(plan)}
          disabled={!features.billing || loading !== null}
        >
          {loading === plan ? "Redirecting…" : `Upgrade to ${planLabel(plan)}`}
        </Button>
      );
    }
    return (
      <Button variant="secondary" className="w-full" onClick={manage} disabled={!features.billing}>
        Manage
      </Button>
    );
  };

  /** Twelve months at the monthly rate — no discount, by design. */
  const priceFor = (monthly: number) =>
    interval === "year" ? `${monthly * MONTHS_PER_YEAR} €` : `${monthly} €`;
  const suffix = interval === "year" ? "HT / yr" : "HT / mo";

  const maxPlan = activeMaxTier ? PLANS[activeMaxTier] : null;
  const showPro = offerable("PRO");

  const cards: PlanCardItem[] = [
    {
      plan: PLANS.FREE,
      price: "0 €",
      priceSuffix: "/ mo",
      current: currentPlan === "FREE",
      action: cta("FREE", "secondary"),
    },
  ];
  if (showPro) {
    cards.push({
      plan: PLANS.PRO,
      price: priceFor(PLANS.PRO.price),
      priceSuffix: suffix,
      recommended: true,
      current: currentPlan === "PRO",
      action: cta("PRO", "default"),
    });
  }
  if (maxPlan && activeMaxTier) {
    cards.push({
      plan: maxPlan,
      name: "Max",
      price: priceFor(maxPlan.price),
      priceSuffix: suffix,
      current: currentPlan === activeMaxTier,
      header:
        maxTiers.length > 1 ? (
          // The ×5/×20 switch is the same primitive as the interval switch
          // above; the multipliers are sans like any other control label.
          <SegmentedControl<MaxTier>
            value={activeMaxTier}
            onChange={setMaxTier}
            options={maxTiers.map((t) => ({ value: t.id, label: t.multiplier }))}
            ariaLabel="Max tier"
            className="shrink-0"
            optionClassName="coarse:py-2"
          />
        ) : undefined,
      action: cta(activeMaxTier, "secondary"),
    });
  }

  const faq = FAQ.filter((entry) => !entry.annualOnly || annualAvailable);

  return (
    <AppPage measure="wide">
      <AppPageHeader
        eyebrow="Plan"
        heading="Upgrade"
        lede={
          <>
            You’re on the{" "}
            <span className="font-medium text-foreground">
              {currentPlan === "OWNER" ? "Owner" : planLabel(currentPlan)}
            </span>{" "}
            plan. Every paid plan unlocks all models with a monthly limit based on tokens — upgrade any time, changes apply instantly.
          </>
        }
      />

      {!features.billing && (
        // The same callout the two other warning callouts in the product use
        // (settings' spend-ceiling notice, the permissions lockdown banner):
        // rounded-field, /40 border, /10 fill.
        <div
          role="status"
          className="mb-6 flex items-start gap-2 rounded-field border border-warning/40 bg-warning/10 p-4 text-sm"
        >
          <StatusIcons.warning className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          Billing isn’t configured on this deployment. Set the Stripe environment variables to enable upgrades.
        </div>
      )}

      {annualAvailable && (
        <div className="mb-6 flex flex-wrap items-center gap-3">
          {/* A one-of-N choice is a radiogroup with a gliding thumb and arrow
              keys, and the product has exactly one of those. `coarse:py-2`
              because this picks a price, and every other picker grows on touch. */}
          <SegmentedControl<BillingInterval>
            value={interval}
            onChange={setInterval}
            options={[
              { value: "month", label: "Monthly" },
              { value: "year", label: "Yearly" },
            ]}
            ariaLabel="Billing interval"
            className="shrink-0"
            optionClassName="coarse:py-2"
          />
          {/* Said plainly rather than left for someone to work out. Every
              competitor discounts annual by 17-23%; implying a saving that is
              not there would be the one dishonest line on a page whose whole
              argument is honest metering. */}
          <span className="font-mono text-caption text-muted-foreground">
            {interval === "year" ? "Twelve months up front — same price, one invoice." : "Billed monthly."}
          </span>
        </div>
      )}

      <PlanCards items={cards} />

      <p className="mt-6 flex items-center gap-1.5 text-caption text-muted-foreground">
        <StatusIcons.info className="size-3.5 shrink-0" aria-hidden />
        Fair-use applies to keep Juno fast for everyone; we’ll always reach out before anything changes.
      </p>

      <section className="mt-8" aria-labelledby="upgrade-faq">
        <h2 id="upgrade-faq" className="text-heading">
          Questions
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">The short version of the terms, before you agree to them.</p>
        {/* Disclosure rows in a well: `surface-inset` at rounded-card with p-1.5
            holds `rounded-control` rows (16 = 10 + 6, concentric). Each row is
            the house hover-raised row; the chevron is the only thing that moves. */}
        <div className="surface-inset mt-4 rounded-card p-1.5">
          {faq.map((entry) => (
            <details key={entry.q} className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-control px-3 py-2.5 text-sm font-medium transition-[background-color,box-shadow] duration-fast ease-out-soft hover:bg-card hover:shadow-raised motion-reduce:transition-none [&::-webkit-details-marker]:hidden">
                {entry.q}
                <ChevronDown
                  className="size-4 shrink-0 text-muted-foreground transition-transform duration-base ease-in-out group-open:rotate-180 motion-reduce:transition-none"
                  aria-hidden="true"
                />
              </summary>
              <p className="px-3 pb-3 pt-1 text-sm text-muted-foreground motion-safe:animate-fade-in">{entry.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* The terms were reachable from the landing footer and the sign-in page,
          but not from the one screen where money changes hands. A consumer
          agreeing to a subscription should be one click from what they are
          agreeing to, at the moment they agree to it. */}
      <p className="mt-6 text-caption text-muted-foreground">
        By subscribing you accept the{" "}
        <a
          href="/legal/cgu"
          className="rounded-xs underline underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary focus-visible:text-primary"
        >
          terms of service
        </a>{" "}
        and the{" "}
        <a
          href="/legal/confidentialite"
          className="rounded-xs underline underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary focus-visible:text-primary"
        >
          privacy policy
        </a>
        .
      </p>
    </AppPage>
  );
}
