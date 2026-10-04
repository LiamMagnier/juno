import Link from "next/link";
import { notFound } from "next/navigation";
import type { Plan } from "@prisma/client";

import { Pricing } from "@/components/landing/pricing";
import "@/components/landing/overview.css";
import { PricingGallery, type PricingView } from "./gallery";
import "@/components/billing/plans.css";

/**
 * Dev-only gallery for every surface that shows plans and prices, rendered
 * for any plan without a signed-in account:
 *
 *   /dev/pricing?view=upgrade&plan=FREE     the /upgrade page as that plan
 *   /dev/pricing?view=billing&plan=LITE     Settings › Usage & billing
 *   /dev/pricing?view=code&plan=FREE        what /code shows below Pro
 *   /dev/pricing?view=landing&lang=fr       the landing's pricing section
 *
 *   &used=0.95   how far into the month's budget the account is (0..1)
 *   &billing=0   Stripe not configured on the deployment
 *
 * Not linked from anywhere and 404s outside development, the same contract as
 * /dev/settings.
 */
const PLANS_SHOWN: Plan[] = ["FREE", "LITE", "PRO", "PLUS", "MAX", "MAX20", "ULTRA", "OWNER"];
const VIEWS = ["upgrade", "billing", "code", "landing"] as const;

export default async function PricingDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const view = (VIEWS as readonly string[]).includes(String(params.view)) ? (params.view as (typeof VIEWS)[number]) : "upgrade";
  const plan = (PLANS_SHOWN as string[]).includes(String(params.plan)) ? (params.plan as Plan) : "FREE";
  const used = Math.min(1, Math.max(0, Number(params.used ?? 0.35) || 0));
  const billing = params.billing !== "0";
  const lang = typeof params.lang === "string" ? params.lang : "en";

  const href = (next: Record<string, string>) => {
    const q = new URLSearchParams({ view, plan, ...next });
    return `/dev/pricing?${q.toString()}`;
  };

  return (
    <>
      <nav
        aria-label="Gallery"
        className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2 text-caption text-muted-foreground"
      >
        {VIEWS.map((v) => (
          <Link key={v} href={href({ view: v })} className={v === view ? "text-foreground" : undefined}>
            {v}
          </Link>
        ))}
        <span aria-hidden="true">|</span>
        {PLANS_SHOWN.map((p) => (
          <Link key={p} href={href({ plan: p })} className={p === plan ? "text-foreground" : undefined}>
            {p}
          </Link>
        ))}
      </nav>
      {view === "landing" ? (
        <div className="bg-background">
          <Pricing locale={lang} />
        </div>
      ) : (
        <PricingGallery view={view as PricingView} plan={plan} usedShare={used} billing={billing} />
      )}
    </>
  );
}
