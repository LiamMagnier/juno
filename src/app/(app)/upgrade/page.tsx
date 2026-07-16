"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Check, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApp } from "@/components/app/app-provider";
import { PLANS, planRank } from "@/lib/plans";
import { cn } from "@/lib/utils";
import type { Plan } from "@prisma/client";

type MaxTier = "MAX" | "MAX20";

const MAX_TIERS: { id: MaxTier; label: string; multiplier: string }[] = [
  { id: "MAX", label: "Max ×5", multiplier: "×5" },
  { id: "MAX20", label: "Max ×20", multiplier: "×20" },
];

function planLabel(plan: Plan): string {
  return PLANS[plan].name;
}

export default function UpgradePage() {
  const router = useRouter();
  const { quota, features } = useApp();
  const currentPlan = quota.plan;
  const [loading, setLoading] = React.useState<Plan | null>(null);
  const [maxTier, setMaxTier] = React.useState<MaxTier>(currentPlan === "MAX20" ? "MAX20" : "MAX");

  const checkout = async (plan: Plan) => {
    setLoading(plan);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
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

  const maxPlan = PLANS[maxTier];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
        <div className="mb-2 flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={() => router.push("/chat")} aria-label="Back to chat">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="font-mono text-label uppercase text-muted-foreground">Plans</span>
        </div>
        <h1 className="font-serif text-display font-medium tracking-tight">
          Pick the plan that <span className="italic text-primary">fits you</span>.
        </h1>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          You’re on the{" "}
          <span className="font-medium text-foreground">
            {currentPlan === "OWNER" ? "Owner" : planLabel(currentPlan)}
          </span>{" "}
          plan. Every paid plan unlocks all models with a monthly limit based on tokens — upgrade any time, changes apply instantly.
        </p>

        {!features.billing && (
          <div className="mt-6 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-sm">
            Billing isn’t configured on this deployment. Set the Stripe environment variables to enable upgrades.
          </div>
        )}

        <div className="mt-8 grid items-stretch gap-4 md:grid-cols-3">
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
          <PlanCard
            name={PLANS.PRO.name}
            tagline={PLANS.PRO.tagline}
            price={`${PLANS.PRO.price} €`}
            priceSuffix="HT/mo"
            features={PLANS.PRO.features}
            popular
            delay={70}
          >
            {cta("PRO", "default")}
          </PlanCard>

          {/* Max — one card, switch between ×5 and ×20 */}
          <PlanCard
            name="Max"
            tagline={maxPlan.tagline}
            price={`${maxPlan.price} €`}
            priceSuffix="HT/mo"
            features={maxPlan.features}
            accent
            delay={140}
            header={
              <div
                role="tablist"
                aria-label="Max tier"
                className="inline-flex items-center gap-0.5 rounded-full border border-border/60 bg-muted/50 p-0.5"
              >
                {MAX_TIERS.map((t) => {
                  const active = maxTier === t.id;
                  return (
                    <button
                      key={t.id}
                      role="tab"
                      aria-selected={active}
                      onClick={() => setMaxTier(t.id)}
                      className={cn(
                        "rounded-full px-3 py-1 font-mono text-caption uppercase tracking-wide transition-colors duration-fast ease-out-soft",
                        active
                          ? "bg-card text-foreground shadow-pop"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {t.multiplier}
                    </button>
                  );
                })}
              </div>
            }
          >
            {cta(maxTier, "outline")}
          </PlanCard>
        </div>

        <p className="mt-6 flex items-center gap-1.5 text-caption text-muted-foreground">
          <Info className="h-3.5 w-3.5" />
          Fair-use applies to keep Juno fast for everyone; we’ll always reach out before anything changes.
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
        "relative flex flex-col rounded-[24px] border bg-card p-6 shadow-soft transition-all duration-base ease-out-soft motion-safe:animate-rise-in [animation-fill-mode:backwards]",
        popular
          ? "border-primary/50 bg-primary/[0.04] shadow-float"
          : "hover:-translate-y-0.5 hover:shadow-float"
      )}
    >
      {popular && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-3 py-1 font-mono text-label uppercase text-primary-foreground shadow-soft">
          ◆ Most popular
        </div>
      )}
      <div className="flex min-h-8 items-start justify-between gap-3">
        <h2 className="font-serif text-heading font-medium">{name}</h2>
        {header}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{tagline}</p>
      <div className="mt-4 flex items-baseline gap-1.5">
        <span className="font-serif text-display font-medium tabular-nums">{price}</span>
        <span className="font-mono text-caption text-muted-foreground">{priceSuffix}</span>
      </div>

      <ul className="mt-5 flex-1 space-y-2.5">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-sm">
            <span
              className={cn(
                "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
                popular || accent ? "bg-primary text-primary-foreground" : "bg-primary/15 text-primary"
              )}
            >
              <Check className="h-3 w-3" />
            </span>
            <span>{f}</span>
          </li>
        ))}
      </ul>

      <div className="mt-6">{children}</div>
    </div>
  );
}
