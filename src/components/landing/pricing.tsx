import Link from "next/link";
import { PlanCards, type PlanCardItem } from "@/components/billing/plan-cards";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
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
 */
const ONE_LINERS: Partial<Record<string, string>> = {
  PRO: "Every model, voice, memory and artifacts — a real month of everyday use.",
  MAX: "Five times Pro's monthly budget, for people who live in Juno.",
  // Deliberately no multiple. This said "Twenty times Pro", and the enforced
  // budgets are Pro 11 € against Max x20's 110 € — ten times, not twenty. The
  // figure lives in one place, BUDGET_EUR in src/lib/spend.ts, and is shown
  // on the settings Usage tile where it is read from that same constant.
  MAX20: "The most headroom we sell.",
};

export function Pricing() {
  // Never advertise a price this deployment cannot charge: without its
  // STRIPE_PRICE_* env var, checkout answers 503 and the tier is a dead end.
  const plans = PLAN_LIST.filter((plan) => plan.id === "FREE" || isPlanPurchasable(plan.id));
  // isPlanPurchasable is an env lookup, so a deployment with no STRIPE_PRICE_*
  // vars leaves only Free — and a pricing section with no prices needs to say
  // so, not shrug.
  const hasPaidTier = plans.length > 1;

  const items: PlanCardItem[] = plans.map((plan) => {
    const recommended = plan.id === "PRO";
    return {
      plan,
      tagline: ONE_LINERS[plan.id] ?? plan.tagline,
      price: `${plan.price} €`,
      priceSuffix: plan.price > 0 ? "HT / mo" : "/ mo",
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
      lede={
        hasPaidTier
          ? "Every paid plan unlocks every model. The difference is budget — measured in real usage, not message counts."
          : "Paid plans are not open on this deployment yet. A free account still gets you in, and keeps everything you bring with you."
      }
    >
      {hasPaidTier ? (
        <>
          <PlanCards items={items} className="mt-10" />
          <p className="mt-6 max-w-prose text-body text-muted-foreground">
            Prices are per month, before VAT. Upgrade, downgrade or cancel any time — changes apply instantly, and the
            full comparison is on your plan page once you have an account.
          </p>
        </>
      ) : (
        // size="page", not "panel": this state owns the whole section column.
        <EmptyState
          className="mt-10"
          tone="empty"
          size="page"
          title="Plans are being set up"
          description="Checkout is not configured on this deployment yet. A free account works today — bring your history over and look around."
          action={
            <Button asChild variant="secondary" size="sm">
              <Link href="/sign-up">Create account</Link>
            </Button>
          }
        />
      )}
    </Section>
  );
}
