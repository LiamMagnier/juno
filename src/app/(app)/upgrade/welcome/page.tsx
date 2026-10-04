"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppPage } from "@/components/app/app-page";
import { useApp } from "@/components/app/app-provider";
import { DotRings } from "@/components/home/dot-construction";
import { Button } from "@/components/ui/button";
import { PLANS } from "@/lib/plans";
import "@/components/billing/plans.css";

/**
 * Where the in-app checkout returns after paying (`return_url` in the checkout
 * route). The plan itself is settled by the Stripe webhook, usually before
 * this page paints; the page refreshes the account once so the name below and
 * the sidebar both read the new plan.
 */
const RINGS = [0.14, 0.24, 0.34, 0.44].map((rx, i) => ({ rx, ry: rx * 1.25, faint: i === 3 }));
const ARCS = [{ ring: 2, from: 120, to: 340 }];

export default function UpgradeWelcomePage() {
  const { quota } = useApp();
  const router = useRouter();
  React.useEffect(() => {
    const id = window.setTimeout(() => router.refresh(), 1200);
    return () => window.clearTimeout(id);
  }, [router]);
  const plan = PLANS[quota.plan];

  return (
    <AppPage measure="wide">
      <div className="alv plans-stage mx-auto mt-4 max-w-5xl">
        <DotRings rings={RINGS} arcs={ARCS} className="plans-stage-dots" />
        <div className="absolute inset-0 z-[3] grid place-items-center px-6 text-center">
          <div>
            <h1 className="ed-rise font-serif text-[clamp(2.4rem,1.5rem+3vw,4rem)] font-normal leading-[1.02] tracking-[-0.02em]" style={{ ["--i" as string]: 0 }}>
              {quota.plan === "FREE" ? "Thank you." : `Welcome to ${plan.name}.`}
            </h1>
            <p className="ed-rise mx-auto mt-4 max-w-md text-body-lg text-muted-foreground" style={{ ["--i" as string]: 1 }}>
              {quota.plan === "FREE"
                ? "Your payment is being confirmed. Your plan switches over in a moment."
                : "Everything in your plan is on now. Your receipt is on its way by email."}
            </p>
            <div className="ed-rise mt-8 flex justify-center gap-3" style={{ ["--i" as string]: 2 }}>
              <Button asChild size="lg" className="h-12 px-8">
                <Link href="/chat">Start a chat</Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </AppPage>
  );
}
