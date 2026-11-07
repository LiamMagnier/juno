import "server-only";

import { prismaUnguarded } from "@/lib/prisma";
import { currentPeriod } from "@/lib/utils";
import { describeModel } from "@/lib/profile-activity-server";
import type { Provider } from "@/lib/providers";

/**
 * The owner's Overview (src/app/(app)/admin/page.tsx): the handful of numbers
 * an owner opens Admin to check, in one round of queries.
 *
 * Every query here is cross-account on purpose, so it runs on the unguarded
 * client, the same one /api/admin/users counts "active this month" with.
 * Days are UTC days, as the billing period is.
 */
export interface AdminOverview {
  users: { total: number; newThisWeek: number; newPrevWeek: number; activeThisMonth: number; banned: number };
  spend: { monthMicroUsd: number; prevMonthToDateMicroUsd: number; monthTokens: number };
  queues: { flagsToReview: number; openReports: number };
  /** The last 30 UTC days, oldest first: signups and spend per day. */
  days: { date: string; signups: number; spendMicroUsd: number }[];
  topModels: { model: string; label: string; provider: Provider | null; spendMicroUsd: number; tokens: number }[];
  recentUsers: { id: string; name: string | null; email: string; image: string | null; createdAt: string; plan: string | null }[];
}

const DAY = 86_400_000;
const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function adminOverview(now = new Date()): Promise<AdminOverview> {
  const today = utcDay(now);
  const since30 = new Date(today.getTime() - 29 * DAY);
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const twoWeeksAgo = new Date(now.getTime() - 14 * DAY);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const prevMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  // The same stretch of last month, so a comparison on the 7th is 7 days to 7 days.
  const prevMonthSameDay = new Date(Math.min(monthStart.getTime(), prevMonthStart.getTime() + (now.getTime() - monthStart.getTime())));

  const db = prismaUnguarded;
  const [total, newThisWeek, newPrevWeek, activeThisMonth, banned, month, prevMonth, flagsToReview, openReports, signupRows, spendRows, modelRows, recent] =
    await Promise.all([
      db.user.count(),
      db.user.count({ where: { createdAt: { gte: weekAgo } } }),
      db.user.count({ where: { createdAt: { gte: twoWeeksAgo, lt: weekAgo } } }),
      db.usage.count({ where: { period: currentPeriod(now), messageCount: { gt: 0 } } }),
      db.user.count({ where: { bannedAt: { not: null } } }),
      db.apiSpend.aggregate({ where: { createdAt: { gte: monthStart } }, _sum: { costMicroUsd: true, promptTokens: true, completionTokens: true } }),
      db.apiSpend.aggregate({ where: { createdAt: { gte: prevMonthStart, lt: prevMonthSameDay } }, _sum: { costMicroUsd: true } }),
      db.moderationFlag.count({ where: { reviewedAt: null } }),
      db.shareReport.count({ where: { status: "open" } }),
      db.$queryRaw<{ day: Date; n: bigint }[]>`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*) AS n
          FROM "User" WHERE "createdAt" >= ${since30}
         GROUP BY 1`,
      db.$queryRaw<{ day: Date; micro: bigint | null }[]>`
        SELECT date_trunc('day', "createdAt") AS day, SUM("costMicroUsd") AS micro
          FROM "ApiSpend" WHERE "createdAt" >= ${since30}
         GROUP BY 1`,
      db.apiSpend.groupBy({
        by: ["model"],
        where: { createdAt: { gte: monthStart } },
        _sum: { costMicroUsd: true, promptTokens: true, completionTokens: true },
        orderBy: { _sum: { costMicroUsd: "desc" } },
        take: 6,
      }),
      db.user.findMany({
        orderBy: { createdAt: "desc" },
        take: 6,
        select: { id: true, name: true, email: true, image: true, createdAt: true, subscription: { select: { plan: true } } },
      }),
    ]);

  const signupsByDay = new Map(signupRows.map((r) => [iso(new Date(r.day)), Number(r.n)]));
  const spendByDay = new Map(spendRows.map((r) => [iso(new Date(r.day)), Number(r.micro ?? 0)]));
  const days = Array.from({ length: 30 }, (_, i) => {
    const date = iso(new Date(since30.getTime() + i * DAY));
    return { date, signups: signupsByDay.get(date) ?? 0, spendMicroUsd: spendByDay.get(date) ?? 0 };
  });

  return {
    users: { total, newThisWeek, newPrevWeek, activeThisMonth, banned },
    spend: {
      monthMicroUsd: month._sum.costMicroUsd ?? 0,
      prevMonthToDateMicroUsd: prevMonth._sum.costMicroUsd ?? 0,
      monthTokens: (month._sum.promptTokens ?? 0) + (month._sum.completionTokens ?? 0),
    },
    queues: { flagsToReview, openReports },
    days,
    topModels: modelRows.map((m) => ({
      model: m.model,
      ...describeModel(m.model),
      spendMicroUsd: m._sum.costMicroUsd ?? 0,
      tokens: (m._sum.promptTokens ?? 0) + (m._sum.completionTokens ?? 0),
    })),
    recentUsers: recent.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      image: u.image,
      createdAt: u.createdAt.toISOString(),
      plan: u.subscription?.plan ?? null,
    })),
  };
}

/** The two queue counts the Admin bar badges, on their own for the layout. */
export async function adminQueueCounts(): Promise<{ flagsToReview: number; openReports: number }> {
  const [flagsToReview, openReports] = await Promise.all([
    prismaUnguarded.moderationFlag.count({ where: { reviewedAt: null } }),
    prismaUnguarded.shareReport.count({ where: { status: "open" } }),
  ]);
  return { flagsToReview, openReports };
}
