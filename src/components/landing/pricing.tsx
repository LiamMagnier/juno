import Link from "next/link";
import type { Plan } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { USAGE_MULTIPLE } from "@/components/billing/heavy-use-plans";
import { PLANS } from "@/lib/plans";
import { planPriceParts, vatNote } from "@/lib/price-display";
import { getRequestLocale } from "@/lib/i18n-server";
import { isPlanPurchasable } from "@/lib/stripe";
import { Reveal } from "./reveal";
import { Section } from "./section";

/*
 * The public lineup, in two groups. The four tiers people choose between
 * (Free, Lite, Pro, Plus) are columns; the three that only add usage on top
 * of Pro (Max ×5, Max ×10, Ultra) are one ruled list under them, each row
 * naming its multiple of Pro. Seven equal columns would be a spreadsheet.
 *
 * Every figure is tax-included (planPriceParts → displayPrice), labelled as
 * such in the reader's language, with the VAT note under the list: French and
 * EU consumer law want the price a consumer pays, not the HT figure the
 * Stripe prices are created at.
 */
const PRIMARY: Plan[] = ["FREE", "LITE", "PRO", "PLUS"];
const HEAVY: Plan[] = ["MAX", "MAX20", "ULTRA"];

const CTA_LABEL: Partial<Record<Plan, string>> = {
  FREE: "Start free",
  LITE: "Get Lite",
  PRO: "Get Pro",
  PLUS: "Get Plus",
};

export async function Pricing({ locale: localeOverride }: { locale?: string } = {}) {
  const locale = localeOverride ?? (await getRequestLocale());
  const checkoutOpen = [...PRIMARY, ...HEAVY].some((plan) => plan !== "FREE" && isPlanPurchasable(plan));
  return (
    <Section
      id="pricing"
      heading="Choose your room to work."
      lede="Start free on the fast models. Every plan is metered by tokens, not messages, so you pay for the room you use."
    >
      <Reveal amount={0.1}>
        <div className="alevr-pricing-grid">
          {PRIMARY.map((id) => {
            const plan = PLANS[id];
            const price = planPriceParts(plan.price, "month", locale);
            return (
              <div key={id} className="alevr-pricing-plan" data-plan={id}>
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-serif text-title">{plan.name}</h3>
                  {/* Plain words, never a pill (owner rule). */}
                  {id === "PRO" && <span className="text-caption text-muted-foreground">Most popular</span>}
                </div>
                <p className="mt-5 font-serif text-display tabular-nums">{price.amount}</p>
                <p className="mt-1 text-caption text-muted-foreground">{price.suffix}</p>
                <p className="mt-5 min-h-10 text-ui leading-relaxed text-muted-foreground">{plan.tagline}</p>
                <ul>
                  {plan.features.slice(0, 3).map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
                <Button asChild variant={id === "PRO" ? "default" : "secondary"}>
                  <Link href="/sign-up">{CTA_LABEL[id]}</Link>
                </Button>
              </div>
            );
          })}
        </div>

        <div className="alevr-pricing-heavy">
          <div className="alevr-pricing-heavy-head">
            <h3 className="text-ui font-medium">For heavy use</h3>
            <p className="text-ui text-muted-foreground">
              Everything in Pro, with more of the month to spend and the highest priority.
            </p>
          </div>
          <ul>
            {HEAVY.map((id) => {
              const plan = PLANS[id];
              const price = planPriceParts(plan.price, "month", locale);
              return (
                <li key={id} data-plan={id}>
                  <span className="text-ui font-medium">{plan.name}</span>
                  <span className="text-ui tabular-nums text-muted-foreground">{`${USAGE_MULTIPLE[id]}× Pro usage`}</span>
                  <span className="alevr-pricing-heavy-price">
                    <span className="text-ui tabular-nums">{price.amount}</span>{" "}
                    <span className="text-caption text-muted-foreground">{price.suffix}</span>
                  </span>
                  <Link href="/sign-up" className="alevr-pricing-heavy-link text-ui">
                    {`Get ${plan.name}`}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="mt-6 max-w-prose space-y-2 text-ui leading-relaxed text-muted-foreground">
          <p>
            {checkoutOpen
              ? "Pay yearly and get 2 months free. Upgrade, downgrade or cancel any time; changes apply instantly."
              : "Checkout opens soon. You can start free today, and everything carries over when you upgrade."}
          </p>
          <p className="text-caption">{vatNote(locale)}</p>
        </div>
      </Reveal>
    </Section>
  );
}
