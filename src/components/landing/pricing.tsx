import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PLAN_LIST } from "@/lib/plans";
import { isPlanPurchasable } from "@/lib/stripe";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
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
  // Deliberately no multiple. This said "Twenty times Pro", and the enforced
  // budgets are Pro 11 € against Max x20's 110 € — ten times, not twenty. The
  // plan's NAME is a tier label, not a promise about budget, but this sentence
  // was a promise, and it was the wrong number. Max's "five times" is left
  // alone because 55 against 11 really is five.
  //
  // The figure lives in one place, BUDGET_EUR in src/lib/spend.ts, and is shown
  // to the user on the settings Usage tile where it is read from that same
  // constant. Copy that restates it is copy that will drift from it again.
  MAX20: "The most headroom we sell.",
};

/**
 * Column count per tier count. Tailwind scans for literal class strings, so
 * these cannot be interpolated. The previous 4-vs-else ternary sent the
 * two-tier case into a three-column grid, leaving a hole in the row.
 */
const GRID_COLS: Record<number, string> = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
};

export function Pricing() {
  // Never advertise a price this deployment cannot charge: without its
  // STRIPE_PRICE_* env var, checkout answers 503 and the tier is a dead end.
  const plans = PLAN_LIST.filter((plan) => plan.id === "FREE" || isPlanPurchasable(plan.id));
  // isPlanPurchasable is an env lookup, so a deployment with no STRIPE_PRICE_*
  // vars leaves only Free — and the section then rendered a single stranded
  // card under a lede promising "every paid plan unlocks every model". A
  // pricing section with no prices needs to say so, not shrug.
  const hasPaidTier = plans.length > 1;

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
          <ul className={cn("mt-10 grid gap-x-10", GRID_COLS[plans.length] ?? GRID_COLS[4])}>
            {/* Dotted rules — the product's rule motif (DottedDivider), which the
                landing already uses for the flagship divider and the receipt leader.
                The "loose" rung because these are the page's few consequential
                items — the same entrance /upgrade's PlanCards already have, which
                the landing's identical four tiers were missing entirely. */}
            {plans.map((plan, i) => (
              <li
                key={plan.id}
                style={staggerDelay(i, "loose")}
                className="border-t border-dotted border-border pb-6 pt-5 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-serif text-heading font-medium">{plan.name}</h3>
                  {plan.id === "PRO" && (
                    // The same badge /upgrade puts on the same tier — it was a bare
                    // run of coral text here, quiet enough to miss, which is the one
                    // thing a "most popular" marker must not be.
                    <span className="whitespace-nowrap rounded-full bg-primary px-2 py-0.5 font-mono text-label text-primary-foreground">
                      ◆ Most popular
                    </span>
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
          {/* max-w-2xl, matching model-lineup's closing line and PageHeader's own
              lede measure: unconstrained this ran the full 1152px column, ~150
              characters a line, so the section opened on one measure and closed
              on another. */}
          <p className="mt-6 max-w-2xl text-body text-muted-foreground">
            Upgrade, downgrade or cancel any time — changes apply instantly. The feature-by-feature comparison is on
            your plan page once you have an account.
          </p>
          {/* Pricing is the last section and had nothing pressable in it: a visitor
              who read five sections and picked a tier had to scroll all the way back
              to the hero (the header is not sticky) to act. Outline, not the default
              fill, so the hero's "Create account" stays the page's only coral action.
              This also retires a link labelled "Full plan details" that pointed at
              /sign-up — a form that lists no plan details at all. */}
          <div className="mt-6">
            <Button asChild variant="outline" size="lg">
              <Link href="/sign-up">
                Create account
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          </div>
        </>
      ) : (
        <EmptyState
          className="mt-10"
          tone="empty"
          size="panel"
          title="Plans are being set up"
          description="Checkout is not configured on this deployment yet. A free account works today — bring your history over and look around."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/sign-up">Create account</Link>
            </Button>
          }
        />
      )}
    </Section>
  );
}
