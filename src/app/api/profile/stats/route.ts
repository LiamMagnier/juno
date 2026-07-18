import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { eurPerUsd } from "@/lib/spend";

export const runtime = "nodejs";

/**
 * Aggregate the user's activity for the profile page:
 * - daily token heatmap (last ~53 weeks)
 * - per-model usage mix (same window)
 * - true lifetime totals from the ApiSpend ledger (tokens, replies, API cost)
 *
 * Source of truth is the ApiSpend ledger — one row per billable model call,
 * never decremented when chats/messages are deleted.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const since = new Date();
  since.setDate(since.getDate() - 371);

  const [account, yearSpends, lifetimeAgg, lifetimeByKind, lifetimeModels] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, select: { createdAt: true } }),
    prisma.apiSpend.findMany({
      where: { userId: user.id, createdAt: { gte: since } },
      select: {
        model: true,
        promptTokens: true,
        completionTokens: true,
        createdAt: true,
      },
      // Cap pathological accounts; the heatmap only needs ~a year of activity.
      take: 100_000,
      orderBy: { createdAt: "desc" },
    }),
    prisma.apiSpend.aggregate({
      where: { userId: user.id },
      _sum: {
        costMicroUsd: true,
        promptTokens: true,
        completionTokens: true,
      },
      _count: true,
    }),
    prisma.apiSpend.groupBy({
      by: ["kind"],
      where: { userId: user.id },
      _sum: { costMicroUsd: true },
      _count: true,
      orderBy: { _sum: { costMicroUsd: "desc" } },
    }),
    prisma.apiSpend.groupBy({
      by: ["model"],
      where: { userId: user.id },
      _count: true,
    }),
  ]);

  const daily: Record<string, { tokens: number; count: number }> = {};
  const byModel: Record<string, { count: number; tokens: number }> = {};
  let yearTokens = 0;
  let yearMessages = 0;

  for (const spend of yearSpends) {
    const tokens = Math.max(0, (spend.promptTokens ?? 0) + (spend.completionTokens ?? 0));
    const day = spend.createdAt.toISOString().slice(0, 10);
    daily[day] ??= { tokens: 0, count: 0 };
    daily[day].tokens += tokens;
    daily[day].count += 1;
    yearTokens += tokens;
    yearMessages += 1;

    const key = spend.model?.trim() || "unknown";
    byModel[key] ??= { count: 0, tokens: 0 };
    byModel[key].count += 1;
    byModel[key].tokens += tokens;
  }

  const models = Object.entries(byModel)
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.count - a.count || b.tokens - a.tokens);

  const lifetimeTokens =
    Math.max(0, lifetimeAgg._sum.promptTokens ?? 0) + Math.max(0, lifetimeAgg._sum.completionTokens ?? 0);
  const lifetimeMessages = lifetimeAgg._count;
  const totalCostMicroUsd = Math.max(0, lifetimeAgg._sum.costMicroUsd ?? 0);

  const byKind = lifetimeByKind.map((row) => ({
    kind: row.kind || "chat",
    count: row._count,
    costMicroUsd: Math.max(0, row._sum.costMicroUsd ?? 0),
  }));

  return NextResponse.json({
    daily,
    models,
    // Year-window totals for the activity heatmap caption.
    yearTokens,
    yearMessages,
    // Backward-compatible aliases used by older clients (now lifetime).
    totalTokens: lifetimeTokens,
    totalMessages: lifetimeMessages,
    // True lifetime ledger.
    lifetime: {
      tokens: lifetimeTokens,
      messages: lifetimeMessages,
      costMicroUsd: totalCostMicroUsd,
      modelsTried: lifetimeModels.length,
      byKind,
    },
    eurPerUsd: eurPerUsd(),
    memberSince: account?.createdAt.toISOString() ?? null,
  });
}
