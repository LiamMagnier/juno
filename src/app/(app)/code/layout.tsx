import type { ReactNode } from "react";
import { requireUser } from "@/lib/session";
import { getUserPlan } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { getRequestLocale } from "@/lib/i18n-server";
import { CodeUpgradeState } from "@/components/code/code-upgrade-state";

export const dynamic = "force-dynamic";

/**
 * Code is a Pro-and-up product (PLANS[plan].code; the product switch's
 * `minPlan` reads the same policy). Every route under /code is checked here,
 * on the server, so a Free or Lite account that types the URL or follows an
 * old link gets the upgrade state instead of a composer whose sends the agent
 * route would refuse.
 */
export default async function CodeLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const plan = await getUserPlan(user.id);
  if (!PLANS[plan].code) {
    return <CodeUpgradeState plan={plan} locale={await getRequestLocale()} />;
  }
  return children;
}
