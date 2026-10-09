import type { ReactNode } from "react";
import { requireUser } from "@/lib/session";
import { getUserPlan } from "@/lib/usage";
import { codeAccessFor } from "@/lib/code-v2/code-access";
import { getRequestLocale } from "@/lib/i18n-server";
import { CodeUpgradeState } from "@/components/code/code-upgrade-state";

export const dynamic = "force-dynamic";

/**
 * Code is a Pro-and-up product (PLANS[plan].code; the product switch's
 * `minPlan` reads the same policy). Every route under /code is checked here,
 * on the server, so a Free or Lite account that types the URL or follows an
 * old link gets the upgrade state instead of a composer whose sends the agent
 * route would refuse.
 *
 * Bringing your own inference opens it too (Alevr Code v2 SPEC §2): a stored
 * API key, or a registered Mac running your own subscriptions. Those runs are
 * not paid by the plan; anything that would be is still refused where it
 * spends (see src/lib/code-v2/code-access.ts).
 */
export default async function CodeLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const plan = await getUserPlan(user.id);
  if (!(await codeAccessFor(user.id, plan)).allowed) {
    return <CodeUpgradeState plan={plan} locale={await getRequestLocale()} />;
  }
  return children;
}
