import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Aggregate the user's activity for the profile page: a daily token heatmap
 * (last 53 weeks) + per-model usage.
 *
 * Source of truth is the ApiSpend ledger — one row per billable model call,
 * never decremented when chats/messages are deleted. (Reading Message would
 * zero the recap the moment the user clears their history.)
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const since = new Date();
  since.setDate(since.getDate() - 371);

  const [account, spends] = await Promise.all([
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
  ]);

  const daily: Record<string, { tokens: number; count: number }> = {};
  const byModel: Record<string, { count: number; tokens: number }> = {};
  let totalTokens = 0;
  let totalMessages = 0;

  for (const spend of spends) {
    const tokens = Math.max(0, (spend.promptTokens ?? 0) + (spend.completionTokens ?? 0));
    const day = spend.createdAt.toISOString().slice(0, 10);
    daily[day] ??= { tokens: 0, count: 0 };
    daily[day].tokens += tokens;
    daily[day].count += 1;
    totalTokens += tokens;
    totalMessages += 1;

    const key = spend.model?.trim() || "unknown";
    byModel[key] ??= { count: 0, tokens: 0 };
    byModel[key].count += 1;
    byModel[key].tokens += tokens;
  }

  const models = Object.entries(byModel)
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.count - a.count || b.tokens - a.tokens);

  return NextResponse.json({
    daily,
    models,
    totalTokens,
    // "Replies" on the profile — billable generations, not chat transcript rows.
    totalMessages,
    memberSince: account?.createdAt.toISOString() ?? null,
  });
}
