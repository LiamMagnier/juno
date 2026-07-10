import Link from "next/link";
import { PLAN_LIST } from "@/lib/plans";
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
  return (
    <Section
      id="pricing"
      eyebrow="Plans"
      heading="Simple plans, metered honestly."
      lede="Every paid plan unlocks every model. The difference is budget — measured in real usage, not message counts."
    >
      <ul className="mt-10 grid gap-x-10 sm:grid-cols-2 lg:grid-cols-4">
        {PLAN_LIST.map((plan) => (
          <li key={plan.id} className="border-t border-border/60 pb-6 pt-5">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-serif text-heading font-medium">{plan.name}</h3>
              {plan.id === "PRO" && (
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-primary">Most popular</span>
              )}
            </div>
            <p className="mt-3 flex items-baseline gap-1.5">
              <span className="font-serif text-3xl font-medium tabular-nums tracking-tight">{plan.price} €</span>
              {plan.price > 0 && <span className="font-mono text-caption text-muted-foreground">HT / mo</span>}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">{ONE_LINERS[plan.id] ?? plan.tagline}</p>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-sm text-muted-foreground">
        Upgrade, downgrade or cancel any time — changes apply instantly.{" "}
        <Link href="/upgrade" className="underline underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary">
          Full plan details
        </Link>
      </p>
    </Section>
  );
}
