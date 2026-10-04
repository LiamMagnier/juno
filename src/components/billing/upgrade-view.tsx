"use client";

import * as React from "react";
import { ChevronDown, Loader2 } from "@/components/ui/icons";
import { toast } from "sonner";
import type { Plan } from "@prisma/client";

import { AppPage } from "@/components/app/app-page";
import { useApp } from "@/components/app/app-provider";
import { PlanOrbit } from "@/components/billing/plan-orbit";
import { PlanCompare } from "@/components/billing/plan-compare";
import { usePriceLocale } from "@/components/billing/use-price-locale";
import { Button } from "@/components/ui/button";
import { MetalCta } from "@/components/effects/metal-cta";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { planPriceParts, vatNote, type BillingInterval as PriceInterval } from "@/lib/price-display";
import type { AppBootstrap } from "@/types/app";
import { StatusIcons } from "@/lib/app-icons";
import { PLANS, planRank } from "@/lib/plans";
import { capabilitiesLost, capabilityChanges } from "@/lib/billing/plan-capabilities";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { cn } from "@/lib/utils";

type BillingInterval = PriceInterval;

/*
 * THE PLANS PAGE, in the house construction (styles in plans.css).
 *
 *   the opening   a centred serif line, as the homepage opens a section, with
 *                 the month so far in the dot meter and the interval switch
 *   the stage     every plan on its own orbit around you, drawn by the dot
 *                 engine; picking one sends the presence trajectory to it
 *   the decision  the chosen plan's name, price, what it adds to yours, and
 *                 the page's one metal button, between dot rules
 *   side by side  every plan in one table drawn in dots
 *   questions     the terms in plain words
 *
 * A tier is offered only when its Stripe price is configured (checkout
 * answers 503 otherwise); the reader's own plan always shows. Every figure is
 * tax-included via planPriceParts(). Annual is ten months for twelve.
 */
const ORDER: Plan[] = ["FREE", "LITE", "PRO", "PLUS", "MAX", "MAX20", "ULTRA"];

/** Questions people ask before they pay; each restates what the code enforces. */
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

const FAQ_DISCLOSURE =
  "group [interpolate-size:allow-keywords] " +
  "[&::details-content]:[block-size:0] [&::details-content]:overflow-clip " +
  "[&::details-content]:transition-[block-size,content-visibility] [&::details-content]:[transition-behavior:allow-discrete] " +
  "[&::details-content]:duration-base [&::details-content]:ease-in-out " +
  "[&[open]::details-content]:[block-size:auto] motion-reduce:[&::details-content]:transition-none";

/** The month so far, in the engine's own dots. */
function MonthMeter({ pct }: { pct: number }) {
  const dots = 28;
  const on = Math.round((pct / 100) * dots);
  return (
    <span className="plans-usage" aria-hidden>
      {Array.from({ length: dots }, (_, i) => (
        <i key={i} data-on={i < on || undefined} />
      ))}
    </span>
  );
}

export function UpgradeView({
  currentPlan,
  features,
}: {
  currentPlan: Plan;
  features: Pick<AppBootstrap["features"], "billing" | "purchasablePlans" | "purchasableAnnualPlans">;
}) {
  const { spend } = useApp();
  const locale = usePriceLocale();
  const [loading, setLoading] = React.useState<Plan | null>(null);
  const [interval, setInterval] = React.useState<BillingInterval>("month");
  const annualAvailable = features.purchasableAnnualPlans.length > 0;

  const offerable = React.useCallback(
    (plan: Plan) => {
      if (plan === "FREE" || plan === currentPlan) return true;
      const sellable = interval === "year" ? features.purchasableAnnualPlans : features.purchasablePlans;
      return sellable.includes(plan);
    },
    [features.purchasablePlans, features.purchasableAnnualPlans, interval, currentPlan]
  );
  const plans = ORDER.filter(offerable);

  // Opens on Pro for anyone below it, else the next plan up, else your own.
  const [picked, setPicked] = React.useState<Plan>(() => {
    if (planRank(currentPlan) < planRank("PRO") && plans.includes("PRO")) return "PRO";
    return plans.find((p) => planRank(p) > planRank(currentPlan)) ?? (plans.includes(currentPlan) ? currentPlan : plans[0]);
  });
  const selected = plans.includes(picked) ? picked : plans[plans.length - 1];

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

  const price = (plan: Plan) => planPriceParts(PLANS[plan].price, interval, locale);
  const usedPct =
    spend.budgetMicroUsd != null && spend.budgetMicroUsd > 0
      ? Math.min(100, Math.round(((spend.spentMicroUsd + spend.reservedMicroUsd) / spend.budgetMicroUsd) * 100))
      : null;

  const rank = planRank(selected) - planRank(currentPlan);
  const changes = capabilityChanges(currentPlan, selected);
  const lost = rank < 0 ? capabilitiesLost(currentPlan, selected) : [];
  const p = price(selected);

  const action = (() => {
    if (selected === currentPlan) {
      return (
        <Button variant="secondary" size="lg" className="w-full" disabled>
          Your current plan
        </Button>
      );
    }
    if (rank < 0) {
      return (
        <Button variant="secondary" size="lg" className="w-full" onClick={manage} disabled={!features.billing}>
          {selected === "FREE" ? "Downgrade to Free" : `Switch to ${PLANS[selected].name}`}
        </Button>
      );
    }
    const button = (
      <Button size="lg" className="w-full" onClick={() => checkout(selected)} disabled={!features.billing || loading !== null} aria-busy={loading === selected}>
        {loading === selected && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />}
        {loading === selected ? "Opening checkout…" : `Get ${PLANS[selected].name}`}
      </Button>
    );
    return features.billing ? <MetalCta>{button}</MetalCta> : button;
  })();

  const onPlanKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = plans[Math.min(plans.length - 1, Math.max(0, plans.indexOf(selected) + step))];
    setPicked(next);
    event.currentTarget.querySelector<HTMLElement>(`[data-plan="${next}"]`)?.focus();
  };

  const faq = FAQ.filter((entry) => !entry.annualOnly || annualAvailable);
  const priceLabel = (plan: Plan) => (plan === "FREE" ? price(plan).amount : `${price(plan).amount}/mo`);

  return (
    <AppPage measure="wide">
      {/* The opening, as the homepage opens a section. */}
      <header className="mx-auto mb-10 max-w-3xl text-center">
        <h1 className="ed-rise text-balance font-serif text-[clamp(2.6rem,1.6rem+3.2vw,4.25rem)] font-normal leading-[1.02] tracking-[-0.02em]" style={{ ["--i" as string]: 0 }}>
          Room to go further.
        </h1>
        <p className="ed-rise mx-auto mt-4 max-w-[36rem] text-pretty text-body-lg text-muted-foreground" style={{ ["--i" as string]: 1 }}>
          Every plan is the same {PRODUCT_NAME}. A wider orbit is more of the month to spend, on more of the models.
        </p>
        <div className="ed-rise mt-7 flex flex-wrap items-center justify-center gap-x-8 gap-y-4" style={{ ["--i" as string]: 2 }}>
          {usedPct != null && (
            <span className="flex items-center gap-3">
              <MonthMeter pct={usedPct} />
              <span className="font-mono text-caption tabular-nums text-muted-foreground">
                {PLANS[currentPlan].name} · {usedPct}% of this month
              </span>
            </span>
          )}
          {annualAvailable && (
            <span className="flex items-center gap-3">
              <SegmentedControl<BillingInterval>
                value={interval}
                onChange={setInterval}
                options={[
                  { value: "month", label: "Monthly" },
                  { value: "year", label: "Yearly" },
                ]}
                ariaLabel="Billing interval"
                optionClassName="coarse:py-2"
              />
              <span className="text-caption text-muted-foreground">2 months free</span>
            </span>
          )}
        </div>
      </header>

      {!features.billing && (
        <div role="status" className="mb-6 flex items-start gap-2 rounded-field border border-warning/40 bg-warning/10 p-4 text-body">
          <StatusIcons.warning className="mt-1 size-4 shrink-0 text-warning" aria-hidden />
          Billing isn’t configured on this deployment. Set the Stripe environment variables to enable upgrades.
        </div>
      )}

      <div className="ed-rise" style={{ ["--i" as string]: 3 }}>
        <PlanOrbit plans={plans} selected={selected} current={currentPlan} priceOf={priceLabel} onSelect={setPicked} onKeyDown={onPlanKey} />
      </div>

      {/* Phone: the stage keeps the orbits; this row does the choosing. */}
      <div role="radiogroup" aria-label="Plans" onKeyDown={onPlanKey} className="-mx-4 mt-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 md:hidden">
        {plans.map((plan) => (
          <button
            key={plan}
            type="button"
            role="radio"
            aria-checked={plan === selected}
            data-plan={plan}
            onClick={() => setPicked(plan)}
            className={cn(
              "grid shrink-0 snap-start justify-items-start gap-0.5 rounded-card px-4 py-2.5 text-left transition-colors duration-fast ease-out-soft",
              plan === selected ? "bg-card text-foreground shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.14)]" : "text-muted-foreground"
            )}
          >
            <span className="font-serif text-heading leading-none">{PLANS[plan].name}</span>
            <span className="font-mono text-micro tabular-nums">{priceLabel(plan)}</span>
          </button>
        ))}
      </div>

      {/* The decision. */}
      <section aria-live="polite" className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-[minmax(0,1fr)_3px_minmax(0,1.25fr)] md:gap-10">
        <div key={`${selected}-${interval}`} className="min-w-0">
          <h2 className="font-serif text-display font-normal leading-none">{PLANS[selected].name}</h2>
          <p className="mt-3 text-body text-muted-foreground">{PLANS[selected].tagline}</p>
          <p className="mt-6 flex items-baseline gap-2">
            <span key={p.amount} className="plans-roll font-serif text-[3.5rem] font-normal leading-none tracking-[-0.02em] tabular-nums">
              {p.amount}
            </span>
            <span className="font-mono text-caption text-muted-foreground">{p.suffix}</span>
          </p>
          {p.note && <p className="mt-1.5 text-caption text-muted-foreground">{p.note}</p>}
          <div className="mt-7 max-w-[20rem]">{action}</div>
          <p className="mt-3 text-caption text-muted-foreground">
            {rank > 0 ? "Applies the moment you pay. Cancel any time." : rank < 0 ? "Takes effect at the end of the period you have paid for." : "Change plans any time."}
          </p>
        </div>
        <div className="plans-rule-v hidden md:block" aria-hidden />
        <div className="min-w-0">
          <p className="font-mono text-caption text-muted-foreground">{rank > 0 ? `What ${PLANS[selected].name} adds` : `What ${PLANS[selected].name} includes`}</p>
          <ul key={selected} className="ed-stagger mt-4 grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
            {changes.map((row) => {
              const fresh = row.gained && rank > 0;
              return (
                <li key={row.id} className={cn("flex items-start gap-3 text-ui", (row.id === "models" || row.id === "usage") && "sm:col-span-2")}>
                  <span className="mt-[6px] shrink-0">
                    <span className="plans-dot" data-new={fresh || undefined} aria-hidden />
                  </span>
                  <span className={fresh ? "text-foreground" : "text-muted-foreground"}>
                    {row.label}
                    {fresh && <span className="sr-only"> (new)</span>}
                  </span>
                </li>
              );
            })}
          </ul>
          {lost.length > 0 && (
            <p className="mt-5 text-caption text-muted-foreground">
              You would give up: {lost.map((row) => row.label.split(":")[0].toLowerCase()).join(", ")}.
            </p>
          )}
        </div>
      </section>

      <div className="plans-rule mt-14" aria-hidden />

      <section className="mt-14" aria-labelledby="plans-compare">
        <h2 id="plans-compare" className="text-center font-serif text-[clamp(1.9rem,1.3rem+1.6vw,2.6rem)] font-normal leading-tight">
          Every plan, side by side.
        </h2>
        <div className="mt-8">
          <PlanCompare plans={plans} selected={selected} current={currentPlan} priceOf={priceLabel} onSelect={setPicked} />
        </div>
      </section>

      <div className="plans-rule mt-14" aria-hidden />

      <section className="mt-14 grid grid-cols-1 gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]" aria-labelledby="upgrade-faq">
        <div>
          <h2 id="upgrade-faq" className="font-serif text-title font-normal">
            Questions
          </h2>
          <p className="mt-2 text-caption text-muted-foreground">{vatNote(locale)}</p>
        </div>
        <div>
          {faq.map((entry, i) => (
            <div key={entry.q}>
              {i > 0 && <div className="plans-rule" aria-hidden />}
              <details className={FAQ_DISCLOSURE}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-4 text-ui font-medium transition-colors duration-fast ease-out-soft hover:text-foreground motion-reduce:transition-none [&::-webkit-details-marker]:hidden">
                  {entry.q}
                  <ChevronDown
                    className="size-4 shrink-0 text-muted-foreground transition-[transform,color] duration-base ease-in-out group-hover:text-foreground group-open:rotate-180 group-open:text-foreground motion-reduce:transition-none"
                    aria-hidden="true"
                  />
                </summary>
                <p className="pb-4 text-body text-muted-foreground motion-safe:animate-fade-in">{entry.a}</p>
              </details>
            </div>
          ))}
        </div>
      </section>

      <p className="mt-12 text-center text-caption text-muted-foreground">
        {`Fair use keeps ${PRODUCT_NAME} fast for everyone; we reach out before anything changes. `}
        By subscribing you accept the{" "}
        <a href="/legal/cgu" className="rounded-xs underline underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground">
          terms of service
        </a>{" "}
        and the{" "}
        <a href="/legal/confidentialite" className="rounded-xs underline underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground">
          privacy policy
        </a>
        .
      </p>
    </AppPage>
  );
}
