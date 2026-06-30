"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApp } from "@/components/app/app-provider";
import { PLAN_LIST, planRank } from "@/lib/plans";
import { cn } from "@/lib/utils";
import type { Plan } from "@prisma/client";

export default function UpgradePage() {
  const router = useRouter();
  const { quota, features } = useApp();
  const currentPlan = quota.plan;
  const [loading, setLoading] = React.useState<Plan | null>(null);

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
          You’re on the <span className="font-medium text-foreground">{currentPlan === "OWNER" ? "Owner" : currentPlan.charAt(0) + currentPlan.slice(1).toLowerCase()}</span> plan. Upgrade any time — changes apply instantly.
        </p>

        {!features.billing && (
          <div className="mt-6 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-sm">
            Billing isn’t configured on this deployment. Set the Stripe environment variables to enable upgrades.
          </div>
        )}

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {PLAN_LIST.map((plan, i) => {
            const isCurrent = plan.id === currentPlan;
            const rankDiff = planRank(plan.id) - planRank(currentPlan);
            const popular = plan.id === "PRO";
            return (
              <div
                key={plan.id}
                style={{ animationDelay: `${i * 70}ms` }}
                className={cn(
                  "relative flex flex-col rounded-xl border bg-card p-6 shadow-soft transition-all duration-base ease-out-soft motion-safe:animate-rise-in [animation-fill-mode:backwards]",
                  popular
                    ? "border-primary/50 bg-primary/[0.04] shadow-float md:-translate-y-2"
                    : "hover:-translate-y-0.5 hover:shadow-float"
                )}
              >
                {popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-1 font-mono text-label uppercase text-primary-foreground shadow-soft">
                    ◆ Most popular
                  </div>
                )}
                <h2 className="font-serif text-heading font-medium">{plan.name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{plan.tagline}</p>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="font-serif text-display font-medium">${plan.price}</span>
                  <span className="font-mono text-caption text-muted-foreground">/mo</span>
                </div>

                <ul className="mt-5 flex-1 space-y-2.5">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-sm">
                      <span
                        className={cn(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
                          popular ? "bg-primary text-primary-foreground" : "bg-primary/15 text-primary"
                        )}
                      >
                        <Check className="h-3 w-3" />
                      </span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>

                <div className="mt-6">
                  {isCurrent ? (
                    <Button variant="outline" className="w-full" disabled>
                      Current plan
                    </Button>
                  ) : plan.id === "FREE" ? (
                    <Button variant="outline" className="w-full" onClick={manage} disabled={!features.billing}>
                      Downgrade
                    </Button>
                  ) : rankDiff > 0 ? (
                    <Button
                      variant={popular ? "default" : "outline"}
                      className="w-full"
                      onClick={() => checkout(plan.id)}
                      disabled={!features.billing || loading !== null}
                    >
                      {loading === plan.id ? "Redirecting…" : `Upgrade to ${plan.name}`}
                    </Button>
                  ) : (
                    <Button variant="outline" className="w-full" onClick={manage} disabled={!features.billing}>
                      Manage
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
