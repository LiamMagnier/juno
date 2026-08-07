import Link from "next/link";
import { PLAN_LIST } from "@/lib/plans";
import { isPlanPurchasable } from "@/lib/stripe";
import { Section } from "@/components/landing/section";

/**
 * Pricing digest — names and prices come from src/lib/plans.ts (the same
 * config the billing flow uses), one honest line each. The full comparison
 * lives on /upgrade once signed in.
 */

const ONE_LINERS: Record<string, string> = {
  FREE: "Create an account, look around, keep your history. Chatting unlocks with Pro.",
  PRO: "Every model, voice, memory and artifacts — a real month of everyday use.",
  MAX: "Five times Pro's monthly budget, for people who live in Juno.",
  MAX20: "Twenty times Pro — the most headroom we sell.",
};

export function Pricing() {
  // Never advertise a price this deployment cannot charge: without its
  // STRIPE_PRICE_* env var, checkout answers 503 and the tier is a dead end.
  const plans = PLAN_LIST.filter((plan) => plan.id === "FREE" || isPlanPurchasable(plan.id));

  return (
    <Section
      id="pricing"
      eyebrow="Plans"
      heading="Simple plans, metered honestly."
      lede="Every paid plan unlocks every model. The difference is budget — measured in real usage, not message counts."
    >
      <ul
        className={
          plans.length === 4
            ? "mt-10 grid gap-x-10 sm:grid-cols-2 lg:grid-cols-4"
            : "mt-10 grid gap-x-10 sm:grid-cols-2 lg:grid-cols-3"
        }
      >
        {/* Dotted rules — the product's rule motif (DottedDivider), which the
            landing already uses for the flagship divider and the receipt leader. */}
        {plans.map((plan) => (
          <li key={plan.id} className="border-t border-dotted border-border pb-6 pt-5">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-serif text-heading font-medium">{plan.name}</h3>
              {plan.id === "PRO" && (
                <span className="font-mono text-caption text-primary">Most popular</span>
              )}
            </div>
            <p className="mt-3 flex items-baseline gap-1.5">
              {/* The same step the in-app PlanCard sets this exact figure at
                  (/upgrade) — it is the most-read number on the page and used to
                  be the only one off Juno's scale. */}
              <span className="font-serif text-display font-medium tabular-nums">{plan.price} €</span>
              {plan.price > 0 && <span className="font-mono text-caption text-muted-foreground">HT / mo</span>}
            </p>
            <p className="mt-2 text-body text-muted-foreground">{ONE_LINERS[plan.id] ?? plan.tagline}</p>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-body text-muted-foreground">
        Upgrade, downgrade or cancel any time — changes apply instantly.{" "}
        {/* /upgrade is behind requireUser(), so a signed-out visitor following this
            was bounced to a login form with no explanation. The copy is unchanged;
            only the destination moves to the page that can actually answer it. */}
        <Link href="/sign-up" className="underline underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary">
          Full plan details
        </Link>
      </p>
    </Section>
  );
}
