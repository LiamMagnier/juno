import { NextResponse } from "next/server";
import type { Plan, Prisma, SubStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getOwnerUser } from "@/lib/admin";
import { isOwnerEmail } from "@/lib/owner";
import { currentPeriod } from "@/lib/utils";

export const runtime = "nodejs";

const PAGE_SIZE = 50;

/** Same derivation as getUserPlan, but from already-fetched rows (no N+1). */
function effectivePlan(email: string, sub: { plan: Plan; status: SubStatus } | null): Plan {
  if (isOwnerEmail(email)) return "OWNER";
  if (!sub) return "FREE";
  return sub.status === "ACTIVE" || sub.status === "TRIALING" ? sub.plan : "FREE";
}

export async function GET(req: Request) {
  const owner = await getOwnerUser();
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const url = new URL(req.url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const q = (url.searchParams.get("q") ?? "").trim();

  const where: Prisma.UserWhereInput = q
    ? {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      }
    : {};

  const now = new Date();
  const period = currentPeriod(now);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [users, total, totalUsers, activeThisMonth, flaggedCount] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        createdAt: true,
        bannedAt: true,
        banReason: true,
        strikes: true,
        subscription: { select: { plan: true, status: true } },
      },
    }),
    prisma.user.count({ where }),
    prisma.user.count(),
    prisma.usage.count({ where: { period, messageCount: { gt: 0 } } }),
    prisma.user.count({ where: { OR: [{ strikes: { gt: 0 } }, { bannedAt: { not: null } }] } }),
  ]);

  const ids = users.map((u) => u.id);
  const [usage, spend, flags] = await Promise.all([
    prisma.usage.findMany({
      where: { userId: { in: ids }, period },
      select: { userId: true, messageCount: true },
    }),
    prisma.apiSpend.groupBy({
      by: ["userId", "source"],
      where: { userId: { in: ids }, createdAt: { gte: monthStart } },
      _sum: { costMicroUsd: true },
    }),
    prisma.moderationFlag.groupBy({
      by: ["userId"],
      where: { userId: { in: ids } },
      _count: { _all: true },
    }),
  ]);

  const messagesByUser = new Map(usage.map((u) => [u.userId, u.messageCount]));
  // Per-user total + per-surface split (web vs native app) of this month's spend.
  const spendByUser = new Map<string, { total: number; web: number; app: number }>();
  for (const s of spend) {
    const row = spendByUser.get(s.userId) ?? { total: 0, web: 0, app: 0 };
    const amount = s._sum.costMicroUsd ?? 0;
    row.total += amount;
    if (s.source === "app") row.app += amount;
    else row.web += amount;
    spendByUser.set(s.userId, row);
  }
  const flagsByUser = new Map(flags.map((f) => [f.userId, f._count._all]));

  return NextResponse.json({
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      image: u.image,
      createdAt: u.createdAt.toISOString(),
      plan: effectivePlan(u.email, u.subscription),
      subscriptionStatus: u.subscription?.status ?? null,
      messagesThisMonth: messagesByUser.get(u.id) ?? 0,
      monthSpendMicroUsd: spendByUser.get(u.id)?.total ?? 0,
      monthSpendWebMicroUsd: spendByUser.get(u.id)?.web ?? 0,
      monthSpendAppMicroUsd: spendByUser.get(u.id)?.app ?? 0,
      bannedAt: u.bannedAt?.toISOString() ?? null,
      banReason: u.banReason,
      strikes: u.strikes,
      flagCount: flagsByUser.get(u.id) ?? 0,
    })),
    page,
    pageSize: PAGE_SIZE,
    total,
    totals: { users: totalUsers, activeThisMonth, flaggedCount },
  });
}
