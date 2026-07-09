import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getQuota } from "@/lib/usage";
import { checkBudget, eurPerUsd, getUsageWindows, billingPeriodFor } from "@/lib/spend";

export const runtime = "nodejs";

/**
 * JSON mirror of the spend/limits payload the web client gets via the
 * server-rendered AppBootstrap (lib/app-data.ts) — built for the native app so
 * it can render the same plan budget + 5-hour session + weekly meters and stay
 * in lockstep with the website. Auth is the shared session cookie.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const quota = await getQuota(user.id);
  const subscription = await prisma.subscription.findUnique({
    where: { userId: user.id },
    select: { createdAt: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
  });
  const period = billingPeriodFor(quota.plan, subscription);
  const [budget, windows] = await Promise.all([
    checkBudget(user.id, quota.plan, period),
    getUsageWindows(user.id, quota.plan, period),
  ]);

  return NextResponse.json({
    quota,
    spend: {
      spentMicroUsd: budget.spentMicroUsd,
      budgetMicroUsd: budget.budgetMicroUsd,
      remainingMicroUsd: budget.remainingMicroUsd,
      eurPerUsd: eurPerUsd(),
      windows: {
        session: {
          spentMicroUsd: windows.session.spentMicroUsd,
          budgetMicroUsd: windows.session.budgetMicroUsd,
          pct: windows.session.pct,
          resetsAtMs: windows.session.resetsAtMs,
        },
        weekly: {
          spentMicroUsd: windows.weekly.spentMicroUsd,
          budgetMicroUsd: windows.weekly.budgetMicroUsd,
          pct: windows.weekly.pct,
          resetsAtMs: windows.weekly.resetsAtMs,
        },
      },
      billing: {
        renewsAtMs: budget.resetsAtMs,
        cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      },
    },
  });
}
