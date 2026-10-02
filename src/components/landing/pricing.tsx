import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PLAN_LIST } from "@/lib/plans";
import { isPlanPurchasable } from "@/lib/stripe";
import { Reveal } from "./reveal";
import { Section } from "./section";

/** Public comparison uses the checkout's data without borrowing billing badges. */
export function Pricing() {
  const checkoutOpen = PLAN_LIST.some(plan => isPlanPurchasable(plan.id));
  return (
    <Section id="pricing" heading="Choose your room to work." lede="Every paid plan unlocks every model. Choose a monthly usage budget that fits your work.">
      <Reveal amount={0.1}>
        <div className="alevr-pricing-grid">
          {PLAN_LIST.map(plan => (
            <div key={plan.id} className="alevr-pricing-plan" data-plan={plan.id}>
              <h3 className="font-serif text-title">{plan.name}</h3>
              <p className="mt-5 font-serif text-display tabular-nums">{plan.price} €</p>
              <p className="mt-1 text-caption text-muted-foreground">{plan.price > 0 ? "excl. VAT / month" : "/ month"}</p>
              <p className="mt-5 min-h-10 text-ui leading-relaxed text-muted-foreground">{plan.tagline}</p>
              <details><summary>All features</summary><ul>{plan.features.map(feature => <li key={feature}>{feature}</li>)}</ul></details>
              <Button asChild variant={plan.id === "PRO" ? "default" : "secondary"}><Link href="/sign-up">Create account</Link></Button>
            </div>
          ))}
        </div>
        <p className="mt-6 max-w-prose text-ui leading-relaxed text-muted-foreground">{checkoutOpen ? "Prices are per month, before VAT. Upgrade, downgrade or cancel any time; changes apply instantly." : "Prices are per month, before VAT. Checkout opens soon. A free account works today, and everything carries over when you upgrade."}</p>
      </Reveal>
    </Section>
  );
}
