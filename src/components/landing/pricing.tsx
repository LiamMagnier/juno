import Link from "next/link";
import { PlanCards, type PlanCardItem } from "@/components/billing/plan-cards";
import { Button } from "@/components/ui/button";
import { PLAN_LIST } from "@/lib/plans";
import { isPlanPurchasable } from "@/lib/stripe";
import { Section } from "@/components/landing/section";

/**
 * Pricing — the same plan cards /upgrade renders, fed by the same config
 * (src/lib/plans.ts) the billing flow uses. Names, prices and feature lists
 * cannot drift from what checkout sells.
 */

/**
 * One line per paid tier, in the landing's voice. Free falls through to its
 * own tagline in plans.ts: the line this used to carry ("Chatting unlocks
 * with Pro") predates the 15-message trial and would sit directly above a
 * feature list that says the opposite.
 *
 * The multiples are the ratio of enforced budgets — BUDGET_EUR in
 * src/lib/spend.ts, Pro 11 € / Max 55 € / Max ×10 110 € — which is also why
 * the top tier is named ×10 (see plans.ts). One place, one number.
 */
const ONE_LINERS: Partial<Record<string, string>> = {
  PRO: "Every model, voice, memory and artifacts — a real month of everyday use.",
  MAX: "Five times Pro's monthly budget, for people who live in Juno.",
  MAX20: "Ten times Pro's monthly budget — the most headroom we sell.",
};

export function Pricing() {
  // Without its STRIPE_PRICE_* env var a tier's checkout answers 503, so the
  // card cannot carry a buy button — but the plan itself is real and the
  // prices are what will be charged, so the cards still render. What changes
  // is the action: an account today, checkout when it opens. A "not
  // configured" box in the middle of a marketing page told a visitor about
  // the deployment's env vars, which is nothing a visitor can act on.
  const purchasable = new Set(PLAN_LIST.filter((plan) => isPlanPurchasable(plan.id)).map((plan) => plan.id));
  const checkoutOpen = purchasable.size > 0;

  const items: PlanCardItem[] = PLAN_LIST.map((plan) => {
    const recommended = plan.id === "PRO";
    return {
      plan,
      tagline: ONE_LINERS[plan.id] ?? plan.tagline,
      price: `${plan.price} €`,
      // "excl. VAT", not the French "HT": this page is English.
      priceSuffix: plan.price > 0 ? "excl. VAT / mo" : "/ mo",
      recommended,
      action: (
        <Button asChild variant={recommended ? "default" : "secondary"} className="w-full">
          <Link href="/sign-up">Create account</Link>
        </Button>
      ),
    };
  });

  return (
    <Section
      id="pricing"
      eyebrow="Plans"
      heading="Simple plans, metered honestly."
      lede="Every paid plan unlocks every model. The difference is budget — measured in real usage, not message counts."
    >
      <PlanCards items={items} className="mt-10" />
      <p className="mt-6 max-w-prose text-body text-muted-foreground">
        {checkoutOpen
          ? "Prices are per month, before VAT. Upgrade, downgrade or cancel any time — changes apply instantly, and the full comparison is on your plan page once you have an account."
          : "Prices are per month, before VAT. Checkout opens soon — a free account works today, and everything you bring with you carries over when you upgrade."}
      </p>
    </Section>
  );
}
