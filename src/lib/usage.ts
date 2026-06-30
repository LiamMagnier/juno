import type { Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { PLANS } from "@/lib/plans";
import { currentPeriod } from "@/lib/utils";
import { isOwnerEmail } from "@/lib/owner";

export interface QuotaStatus {
  plan: Plan;
  used: number;
  limit: number | null; // null = unlimited
  remaining: number | null;
}

export async function getUserPlan(userId: string): Promise<Plan> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, subscription: { select: { plan: true, status: true } } },
  });
  if (!user) return "FREE";
  // Owner accounts (OWNER_EMAILS) get unlimited access regardless of billing.
  if (isOwnerEmail(user.email)) return "OWNER";
  const sub = user.subscription;
  if (!sub) return "FREE";
  // Only entitle paid features while the subscription is actually paying.
  return sub.status === "ACTIVE" || sub.status === "TRIALING" ? sub.plan : "FREE";
}

export async function getQuota(userId: string, plan?: Plan): Promise<QuotaStatus> {
  const p = plan ?? (await getUserPlan(userId));
  const usage = await prisma.usage.findUnique({
    where: { userId_period: { userId, period: currentPeriod() } },
  });
  const used = usage?.messageCount ?? 0;
  const limit = PLANS[p].monthlyMessages;
  return { plan: p, used, limit, remaining: limit == null ? null : Math.max(0, limit - used) };
}

/** Atomically checks the monthly cap and, if allowed, consumes one message. */
export async function consumeMessage(
  userId: string,
  plan: Plan
): Promise<{ allowed: boolean; quota: QuotaStatus }> {
  const period = currentPeriod();
  const limit = PLANS[plan].monthlyMessages;

  const current = await prisma.usage.upsert({
    where: { userId_period: { userId, period } },
    create: { userId, period, messageCount: 0 },
    update: {},
  });

  if (limit != null && current.messageCount >= limit) {
    return { allowed: false, quota: { plan, used: current.messageCount, limit, remaining: 0 } };
  }

  const updated = await prisma.usage.update({
    where: { userId_period: { userId, period } },
    data: { messageCount: { increment: 1 } },
  });

  return {
    allowed: true,
    quota: {
      plan,
      used: updated.messageCount,
      limit,
      remaining: limit == null ? null : Math.max(0, limit - updated.messageCount),
    },
  };
}

/** Refund one consumed message (used when generation fails), floored at 0. */
export async function refundMessage(userId: string, plan: Plan): Promise<QuotaStatus> {
  const period = currentPeriod();
  const current = await prisma.usage.findUnique({ where: { userId_period: { userId, period } } });
  if (current && current.messageCount > 0) {
    await prisma.usage.update({
      where: { userId_period: { userId, period } },
      data: { messageCount: { decrement: 1 } },
    });
  }
  return getQuota(userId, plan);
}
