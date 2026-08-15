"use client";

import * as React from "react";
import { toast } from "sonner";
import { StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useApp } from "@/components/app/app-provider";
import { PLANS, planRank } from "@/lib/plans";
import { cn } from "@/lib/utils";
import type { Plan } from "@prisma/client";
import { AppPageHeader } from "@/components/app/app-page-header";

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

  const cta = (plan: Plan, variant: "default" | "outline") => {
    const rankDiff = planRank(plan) - planRank(currentPlan);
    if (plan === currentPlan) {
      return (
        <Button variant="outline" className="w-full" disabled>
          Current plan
        </Button>
      );
    }
    if (plan === "FREE") {
      return (
        <Button variant="outline" className="w-full" onClick={manage} disabled={!features.billing}>
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
      <Button variant="outline" className="w-full" onClick={manage} disabled={!features.billing}>
        Manage
      </Button>
    );
  };

  /** Twelve months at the monthly rate — no discount, by design. */
  const priceFor = (monthly: number) =>
    interval === "year" ? `${monthly * MONTHS_PER_YEAR} €` : `${monthly} €`;
  const suffixFor = () => (interval === "year" ? "HT/yr" : "HT/mo");

  const maxPlan = activeMaxTier ? PLANS[activeMaxTier] : null;
  const showPro = offerable("PRO");
  const cardCount = 1 + (showPro ? 1 : 0) + (maxPlan ? 1 : 0);

  return (
    <div className="app-page-scroll">
      <div className="app-page-content max-w-5xl">
        {/*
          The standing line goes in the header's own `lede`. This page was the
          only one in the product that cancelled AppPageHeader's bottom spacing
          with `mb-0` and then hand-drew a sibling paragraph in its place, which
          put the lede outside the heading stack, outside the rule the header
          draws, and on a margin nobody else uses. The prop already renders this
          shape and already owns the gap below it.
        */}
        <AppPageHeader
          eyebrow="Plans"
          heading={<>Pick the plan that <span className="italic text-primary">fits you</span>.</>}
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
          // (settings/page.tsx's spend-ceiling notice, permissions-section's
          // lockdown banner): rounded-field, /40 border, /10 fill. This one was
          // the odd rung out at rounded-lg + /5, and a 5% warning tint over pure
          // black has no ground left.
          <div
            role="status"
            className="mt-6 flex items-start gap-2 rounded-field border border-warning/40 bg-warning/10 p-4 text-sm"
          >
            <StatusIcons.warning className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            Billing isn’t configured on this deployment. Set the Stripe environment variables to enable upgrades.
          </div>
        )}

        {annualAvailable && (
          <div className="mt-6 flex items-center gap-3">
            {/*
              The house segmented control, not a hand-rolled one. This was a
              role="tablist" div wrapping raw buttons, set in 11px MONO on the
              one control that decides what the user pays, over a pill track
              that disagreed with the real primitive on radius, fill and inset.
              A one-of-N choice is a radiogroup with a gliding thumb and arrow
              keys, and the product already has exactly one of those. The only
              thing kept from the old buttons is `coarse:py-2`: this picks a
              price, and every other picker in the product grows on touch.
            */}
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
            {/*
              Said plainly rather than left for someone to work out. Every
              competitor discounts annual by 17-23%; implying a saving that is
              not there would be the one dishonest line on a page whose whole
              argument is honest metering.
            */}
            <span className="text-caption text-muted-foreground">
              {interval === "year"
                ? "Twelve months up front — same price, one invoice."
                : "Billed monthly."}
            </span>
          </div>
        )}

        <div
          className={cn(
            "mt-8 grid items-stretch gap-4",
            cardCount === 3 ? "md:grid-cols-3" : cardCount === 2 ? "md:grid-cols-2" : "md:max-w-sm"
          )}
        >
          {/* Free */}
          <PlanCard
            name={PLANS.FREE.name}
            tagline={PLANS.FREE.tagline}
            price="0 €"
            priceSuffix="/mo"
            features={PLANS.FREE.features}
            delay={0}
          >
            {cta("FREE", "outline")}
          </PlanCard>

          {/* Pro — most popular */}
          {showPro && (
            <PlanCard
              name={PLANS.PRO.name}
              tagline={PLANS.PRO.tagline}
              price={priceFor(PLANS.PRO.price)}
              priceSuffix={suffixFor()}
              features={PLANS.PRO.features}
              popular
              // 60/120, the `loose` rung in lib/motion — the step reserved for
              // "large, few, and consequential", which is this row exactly. The
              // 70/140 it was is one of the eight private stagger steps that
              // scale exists to end; nobody can name 70 against 60, but a
              // product where no two lists share a tempo is felt.
              delay={60}
            >
              {cta("PRO", "default")}
            </PlanCard>
          )}

          {/* Max — one card, switch between ×5 and ×20 */}
          {maxPlan && activeMaxTier && (
            <PlanCard
              name="Max"
              tagline={maxPlan.tagline}
              price={priceFor(maxPlan.price)}
              priceSuffix={suffixFor()}
              features={maxPlan.features}
              accent
              delay={120}
              header={
                maxTiers.length > 1 ? (
                  // The ×5/×20 switch was a verbatim second copy of the billing
                  // tablist — same hand-rolled track, same mono caption labels —
                  // so the page shipped two of a control the product has one of.
                  // It is the same primitive as the interval switch above now,
                  // and the multipliers are sans like any other control label.
                  <SegmentedControl<MaxTier>
                    value={activeMaxTier}
                    onChange={setMaxTier}
                    options={maxTiers.map((t) => ({ value: t.id, label: t.multiplier }))}
                    ariaLabel="Max tier"
                    className="shrink-0"
                    optionClassName="coarse:py-2"
                  />
                ) : undefined
              }
            >
              {cta(activeMaxTier, "outline")}
            </PlanCard>
          )}
        </div>

        <p className="mt-6 flex items-center gap-1.5 text-caption text-muted-foreground">
          <StatusIcons.info className="size-3.5" />
          Fair-use applies to keep Juno fast for everyone; we’ll always reach out before anything changes.
        </p>
        {/*
          The terms were reachable from the landing footer and the sign-in page,
          but not from the one screen where money changes hands. A consumer
          agreeing to a subscription should be one click from what they are
          agreeing to, at the moment they agree to it.
        */}
        <p className="mt-2 text-caption text-muted-foreground">
          By subscribing you accept the{" "}
          <a
            href="/legal/cgu"
            className="underline underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary"
          >
            terms of service
          </a>{" "}
          and the{" "}
          <a
            href="/legal/confidentialite"
            className="underline underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary"
          >
            privacy policy
          </a>
          .
        </p>
      </div>
    </div>
  );
}

function PlanCard({
  name,
  tagline,
  price,
  priceSuffix,
  features,
  children,
  header,
  popular,
  accent,
  delay,
}: {
  name: string;
  tagline: string;
  price: string;
  priceSuffix: string;
  features: readonly string[];
  children: React.ReactNode;
  header?: React.ReactNode;
  popular?: boolean;
  accent?: boolean;
  delay: number;
}) {
  return (
    <div
      style={{ animationDelay: `${delay}ms` }}
      className={cn(
        "relative flex flex-col rounded-card border bg-card p-6 transition-[border-color,background-color] duration-base ease-out-soft motion-safe:animate-rise-in [animation-fill-mode:backwards]",
        // Every card answers the pointer. The popular card had NO hover state at
        // all — the one card the page is steering people toward was the only
        // inert object on it — and its 3.5% primary tint resolves to under 0.3%
        // lightness over pure black, so its "chosen" ground disappeared with the
        // retheme. 8% keeps a real ground on the black ladder.
        // The fills are rungs, not tints. `hover:bg-accent/20` composited to
        // ~7.8% over the 6.5% card — a 1.3-point step, i.e. nothing on black —
        // so the plain cards' hover was carried entirely by their border while
        // the popular card, which had no fill change at all, answered with a
        // border too. Three cards, one gesture, no visible difference between
        // the card you are pointing at and the two you are not.
        popular
          ? "border-primary/45 bg-primary/[0.08] hover:border-primary/70 hover:bg-primary/[0.14]"
          : "border-border/70 hover:border-foreground/25 hover:bg-accent"
      )}
    >
      {popular && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-3 py-1 text-label font-semibold text-primary-foreground">
          Most popular
        </div>
      )}
      <div className="flex min-h-8 items-start justify-between gap-3">
        <h2 className="text-heading font-semibold tracking-[-0.02em]">{name}</h2>
        {header}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{tagline}</p>
      <div className="mt-4 flex items-baseline gap-1.5">
        <span className="text-display font-semibold tracking-[-0.04em] tabular-nums">{price}</span>
        <span className="font-mono text-caption text-muted-foreground">{priceSuffix}</span>
      </div>

      <ul className="mt-5 flex-1 space-y-2.5">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-sm">
            <span
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full",
                popular || accent ? "bg-primary text-primary-foreground" : "bg-primary/15 text-primary"
              )}
            >
              <StatusIcons.success className="size-3" />
            </span>
            <span>{f}</span>
          </li>
        ))}
      </ul>

      <div className="mt-6">{children}</div>
    </div>
  );
}
