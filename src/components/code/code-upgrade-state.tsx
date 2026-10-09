import Link from "next/link";
import type { Plan } from "@prisma/client";

import { AppPage } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { BRAND } from "@/lib/brand/names";
import { PLANS, cheapestPlanWith } from "@/lib/plans";
import { planPriceParts } from "@/lib/price-display";

/**
 * What `/code` draws for a plan without Code (Free and Lite): the product,
 * named, with the plan that includes it and that plan's tax-included price,
 * and one way forward. Rendered by the /code layout on the server, so the
 * composer never mounts for an account whose every send the agent route
 * would refuse.
 */
export function CodeUpgradeState({ plan, locale = "en" }: { plan: Plan; locale?: string }) {
  const needed = PLANS[cheapestPlanWith("code")];
  const price = planPriceParts(needed.price, "month", locale);
  return (
    <AppPage measure="reading">
      <EmptyState
        title={`${BRAND.code.label} is included from ${needed.name}`}
        description={
          <>
            {`You’re on ${PLANS[plan].name}. ${needed.name} adds ${BRAND.code.label}, agents, deep research and voice, with every model, from `}
            <span className="tabular-nums text-foreground">{price.amount}</span> {price.suffix}.
          </>
        }
        action={
          <>
            <Button asChild>
              <Link href="/upgrade">See plans</Link>
            </Button>
            {/* Bring your own key opens Code without the plan (SPEC §2). */}
            <Button asChild variant="secondary">
              <Link href="/settings?section=connections">Use your own API key</Link>
            </Button>
          </>
        }
      />
    </AppPage>
  );
}
