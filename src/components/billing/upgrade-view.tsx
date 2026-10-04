"use client";

import * as React from "react";
import { ChevronDown, Loader2 } from "@/components/ui/icons";
import { toast } from "sonner";
import type { Plan } from "@prisma/client";

import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { PlanCards, type PlanCardItem } from "@/components/billing/plan-cards";
import { HeavyUsePlans, type HeavyUsePlanItem } from "@/components/billing/heavy-use-plans";
import { usePriceLocale } from "@/components/billing/use-price-locale";
import { Button } from "@/components/ui/button";
import { MetalCta } from "@/components/effects/metal-cta";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { planPriceParts, vatNote, type BillingInterval as PriceInterval } from "@/lib/price-display";
import type { AppBootstrap } from "@/types/app";
import { StatusIcons } from "@/lib/app-icons";
import { PLANS, planRank } from "@/lib/plans";
import { PRODUCT_NAME } from "@/lib/brand/names";

type BillingInterval = PriceInterval;

/*
 * Annual is ten months' price for twelve: two months free
 * (ANNUAL_MONTHS_BILLED in price-display.ts, the same figure the Stripe yearly
 * prices are created at). The entitlement is identical, and so is the budget:
 * it stays MONTHLY on both intervals, because a year of budget released at
 * once would be a different product.
 *
 * Seven tiers are laid out as two groups. The four people actually choose
 * between (Free, Lite, Pro, Plus) are cards; the three that only add usage on
 * top of Pro (Max ×5, Max ×10, Ultra) are rows underneath (HeavyUsePlans).
 * Every figure on the page is tax-included via planPriceParts().
 */
const PRIMARY: Plan[] = ["FREE", "LITE", "PRO", "PLUS"];
const HEAVY: Plan[] = ["MAX", "MAX20", "ULTRA"];

function planLabel(plan: Plan): string {
  return PLANS[plan].name;
}

/**
 * The questions people ask before they pay, answered in the product's own
 * words. Every line here restates something the code already enforces
 * (plans.ts, spend.ts, the CGU) so the page cannot promise what the service
 * does not do.
 */
const FAQ: { q: string; a: string; annualOnly?: boolean }[] = [
  {
    q: "What does a plan actually buy?",
    a: "A monthly budget of real model usage, metered at the providers' own list prices. Every reply shows its cost on its receipt. Light models stretch the budget and frontier models spend it faster, and you choose which.",
  },
  {
    q: "What does Free include?",
    a: "A small monthly allowance on the fast models (Claude Haiku, GPT-6 Luna, Gemini Flash-Lite, GLM Flash), with no card needed. When it is used up, chat waits for next month or for an upgrade.",
  },
  {
    q: "Which models and features come with each plan?",
    a: "Lite adds the everyday models, such as Claude Sonnet and Gemini Flash, and web search. Pro and every plan above it unlock every model, Code, agents, deep research and voice. Plus, Max and Ultra add more usage each month and a higher priority.",
  },
  {
    q: "Is yearly billing cheaper?",
    a: "Yes. Yearly is ten months' price for twelve months, so two months are free. The usage budget stays monthly on both intervals.",
    annualOnly: true,
  },
  {
    q: "Are prices shown with VAT?",
    a: "Yes. Prices include 20% French VAT. Checkout shows the exact amount for your country before you pay, and EU businesses with a VAT number pay the price excluding VAT.",
  },
  {
    q: "Can I change or cancel later?",
    a: "Any time. Upgrades apply instantly. If you cancel, paid features stay on until the end of the billing period you have already paid for, and your data stays yours to export.",
  },
  {
    q: "What does fair use mean?",
    a: `Fair use keeps ${PRODUCT_NAME} fast for everyone. If your usage ever looks like it needs a conversation, we reach out first, and nothing changes on your account without notice.`,
  },
];

/**
 * The FAQ rows stay native `<details>`: the disclosure semantics are the
 * platform's, and find-in-page still opens a shut answer when it matches.
 *
 * Continuous disclosure is layered on as progressive enhancement. Where the
 * browser has `::details-content` (and `interpolate-size` for the `auto`
 * end), the answer's box eases open and shut on the caret's own rung and
 * curve, and `content-visibility` flips discretely at the end of the close so
 * the text stays painted while it collapses. Elsewhere the rule is dropped
 * and the row opens as it always has, with the answer's fade-in.
 */
const FAQ_DISCLOSURE =
  "group [interpolate-size:allow-keywords] " +
  "[&::details-content]:[block-size:0] [&::details-content]:overflow-clip " +
  "[&::details-content]:transition-[block-size,content-visibility] [&::details-content]:[transition-behavior:allow-discrete] " +
  "[&::details-content]:duration-base [&::details-content]:ease-in-out " +
  "[&[open]::details-content]:[block-size:auto] motion-reduce:[&::details-content]:transition-none";

/**
 * The page itself, fed by props so /dev/pricing can render it for every plan
 * without a signed-in account.
 */
export function UpgradeView({
  currentPlan,
  features,
}: {
  currentPlan: Plan;
  features: Pick<AppBootstrap["features"], "billing" | "purchasablePlans" | "purchasableAnnualPlans">;
}) {
  const locale = usePriceLocale();
  const [loading, setLoading] = React.useState<Plan | null>(null);
  const [interval, setInterval] = React.useState<BillingInterval>("month");
  const annualAvailable = features.purchasableAnnualPlans.length > 0;

  // Only offer a tier whose Stripe price id is configured: checkout returns
  // 503 "Plan price is not configured." otherwise, so rendering the button at
  // all is a broken promise. A subscriber already on an unconfigured tier still
  // sees it, because it is their current plan and hiding it would be a lie.
  // Free is always shown: it is the floor every account stands on.
  const offerable = React.useCallback(
    (plan: Plan) => {
      if (plan === "FREE") return true;
      const sellable = interval === "year" ? features.purchasableAnnualPlans : features.purchasablePlans;
      return sellable.includes(plan) || plan === currentPlan;
    },
    [features.purchasablePlans, features.purchasableAnnualPlans, interval, currentPlan]
  );

  // Pro is the tier the page steers toward, until the reader already holds it
  // or something above it: then nothing is singled out.
  const recommend = planRank(currentPlan) < planRank("PRO");

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
      else throw new Error(data.error ?? "Couldn’t start checkout.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Checkout failed.");
      setLoading(null);
    }
  };

  const manage = async () => {
    const res = await fetch("/api/stripe/portal", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.url) window.location.href = data.url;
    else toast.error(data.error ?? "Couldn’t open billing portal.");
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
      const button = (
        <Button
          variant={variant}
          className="w-full"
          onClick={() => checkout(plan)}
          disabled={!features.billing || loading !== null}
          aria-busy={loading === plan}
        >
          {loading === plan && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />}
          {loading === plan ? "Redirecting…" : `Get ${planLabel(plan)}`}
        </Button>
      );
      // The page's one metal object: the recommended plan's upgrade (the
      // `default` variant is only ever that card). Every other CTA stays a
      // plain button, so two metal buttons never sit side by side.
      return variant === "default" && features.billing ? <MetalCta>{button}</MetalCta> : button;
    }
    return (
      <Button variant="secondary" className="w-full" onClick={manage} disabled={!features.billing}>
        Manage
      </Button>
    );
  };

  const price = (plan: Plan) => planPriceParts(PLANS[plan].price, interval, locale);

  const cards: PlanCardItem[] = PRIMARY.filter(offerable).map((id) => {
    const p = price(id);
    const recommended = recommend && id === "PRO";
    return {
      plan: PLANS[id],
      price: p.amount,
      priceSuffix: p.suffix,
      priceNote: p.note,
      recommended,
      current: currentPlan === id,
      action: cta(id, recommended ? "default" : "secondary"),
    };
  });

  const heavy: HeavyUsePlanItem[] = HEAVY.filter(offerable).map((id) => {
    const p = price(id);
    return {
      plan: PLANS[id],
      price: p.amount,
      priceSuffix: p.suffix,
      priceNote: p.note,
      current: currentPlan === id,
      action: cta(id, "secondary"),
    };
  });

  const faq = FAQ.filter((entry) => !entry.annualOnly || annualAvailable);

  return (
    <AppPage measure="wide">
      <AppPageHeader
        eyebrow="Plan"
        heading="Upgrade"
        lede={
          <>
            You’re on the{" "}
            <span className="font-medium text-foreground">{planLabel(currentPlan)}</span> plan. Every plan is
            metered by tokens, not messages, and a change applies the moment you make it.
          </>
        }
      />

      {!features.billing && (
        // The same callout the two other warning callouts in the product use
        // (settings' spend-ceiling notice, the permissions lockdown banner):
        // rounded-field, /40 border, /10 fill.
        <div
          role="status"
          className="mb-6 flex items-start gap-2 rounded-field border border-warning/40 bg-warning/10 p-4 text-body"
        >
          <StatusIcons.warning className="mt-1 size-4 shrink-0 text-warning" aria-hidden />
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
          {/* Ten months for twelve (ANNUAL_MONTHS_BILLED). Plain words in the
              muted ink, never a badge: the toggle is the control, this is
              the reason to touch it. */}
          <span className="text-caption text-muted-foreground">
            {interval === "year" ? "2 months free: ten months’ price for twelve." : "Pay yearly and get 2 months free."}
          </span>
        </div>
      )}

      <PlanCards items={cards} />

      <HeavyUsePlans items={heavy} />

      <div className="mt-6 space-y-1.5 text-caption text-muted-foreground">
        <p className="flex items-start gap-1.5">
          <StatusIcons.info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{vatNote(locale)}</span>
        </p>
        <p className="pl-5">
          {`Fair use applies to keep ${PRODUCT_NAME} fast for everyone; we’ll always reach out before anything changes.`}
        </p>
      </div>

      <section className="mt-10" aria-labelledby="upgrade-faq">
        <h2 id="upgrade-faq" className="text-heading">
          Questions
        </h2>
        <p className="mt-1 text-body text-muted-foreground">The short version of the terms, before you agree to them.</p>
        {/* Disclosure rows in a well: `surface-inset` at rounded-card with p-1
            holds `rounded-control` rows (12 = 8 + 4, concentric). Each row is
            the house tonal-hover row; the caret turns and the answer opens on
            the same rung (see FAQ_DISCLOSURE). */}
        <div className="surface-inset mt-4 rounded-card p-1">
          {faq.map((entry) => (
            <details key={entry.q} className={FAQ_DISCLOSURE}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-control px-3 py-2.5 text-ui font-medium transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none [&::-webkit-details-marker]:hidden">
                {entry.q}
                <ChevronDown
                  className="size-4 shrink-0 text-muted-foreground transition-[transform,color] duration-base ease-in-out group-hover:text-foreground group-open:rotate-180 group-open:text-foreground motion-reduce:transition-none"
                  aria-hidden="true"
                />
              </summary>
              <p className="px-3 pb-3 pt-1 text-body text-muted-foreground motion-safe:animate-fade-in">{entry.a}</p>
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
