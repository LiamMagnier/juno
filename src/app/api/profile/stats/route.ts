import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { resolveModel } from "@/lib/models";
import { recomputeCostMicroUsd } from "@/lib/pricing";
import { eurPerUsd } from "@/lib/spend";

export const runtime = "nodejs";

/**
 * Aggregate the user's activity for the profile page:
 * - daily token heatmap (last ~53 weeks)
 * - per-model usage mix (same window)
 * - true lifetime totals from the ApiSpend ledger (tokens, replies, API cost)
 *
 * Cost is the MAX of the stored ledger value and a recompute from tokens ×
 * current rates — so historical under-billed rows (missing reasoning, wrong
 * rates) still show honest spend on the profile.
 *
 * Source of truth is the ApiSpend ledger — one row per billable model call,
 * never decremented when chats/messages are deleted.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const since = new Date();
  since.setDate(since.getDate() - 371);

  const [account, yearSpends, lifetimeSpends] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, select: { createdAt: true } }),
    prisma.apiSpend.findMany({
      where: { userId: user.id, createdAt: { gte: since } },
      select: {
        model: true,
        promptTokens: true,
        completionTokens: true,
        costMicroUsd: true,
        createdAt: true,
      },
      take: 100_000,
      orderBy: { createdAt: "desc" },
    }),
    prisma.apiSpend.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        model: true,
        kind: true,
        promptTokens: true,
        completionTokens: true,
        costMicroUsd: true,
      },
      // Hard cap for pathological accounts; recompute is O(n) in memory.
      take: 200_000,
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const daily: Record<string, { tokens: number; count: number }> = {};
  const byModelYear: Record<string, { count: number; tokens: number }> = {};
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
    byModelYear[key] ??= { count: 0, tokens: 0 };
    byModelYear[key].count += 1;
    byModelYear[key].tokens += tokens;
  }

  const models = Object.entries(byModelYear)
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.count - a.count || b.tokens - a.tokens);

  // Lifetime: recompute cost from tokens so under-billed ledger rows surface.
  let lifetimeTokensIn = 0;
  let lifetimeTokensOut = 0;
  let lifetimeCostMicroUsd = 0;
  let lifetimeStoredCostMicroUsd = 0;
  const byKindMap = new Map<string, { count: number; costMicroUsd: number; tokensIn: number; tokensOut: number }>();
  const byModelMap = new Map<
    string,
    { count: number; costMicroUsd: number; tokensIn: number; tokensOut: number }
  >();

  for (const spend of lifetimeSpends) {
    const tokensIn = Math.max(0, spend.promptTokens ?? 0);
    const tokensOut = Math.max(0, spend.completionTokens ?? 0);
    const stored = Math.max(0, spend.costMicroUsd ?? 0);
    const recomputed = recomputeCostMicroUsd(spend.model, tokensIn, tokensOut, resolveModel);
    // Prefer the higher of stored vs recomputed — never under-report to the user.
    const cost = Math.max(stored, recomputed);

    lifetimeTokensIn += tokensIn;
    lifetimeTokensOut += tokensOut;
    lifetimeCostMicroUsd += cost;
    lifetimeStoredCostMicroUsd += stored;

    const kind = spend.kind || "chat";
    const kindRow = byKindMap.get(kind) ?? { count: 0, costMicroUsd: 0, tokensIn: 0, tokensOut: 0 };
    kindRow.count += 1;
    kindRow.costMicroUsd += cost;
    kindRow.tokensIn += tokensIn;
    kindRow.tokensOut += tokensOut;
    byKindMap.set(kind, kindRow);

    const modelKey = spend.model?.trim() || "unknown";
    const modelRow = byModelMap.get(modelKey) ?? {
      count: 0,
      costMicroUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
    modelRow.count += 1;
    modelRow.costMicroUsd += cost;
    modelRow.tokensIn += tokensIn;
    modelRow.tokensOut += tokensOut;
    byModelMap.set(modelKey, modelRow);
  }

  const byKind = [...byKindMap.entries()]
    .map(([kind, v]) => ({ kind, ...v }))
    .sort((a, b) => b.costMicroUsd - a.costMicroUsd || b.count - a.count);

  const byModelCost = [...byModelMap.entries()]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.costMicroUsd - a.costMicroUsd || b.count - a.count)
    .slice(0, 12);

  const lifetimeTokens = lifetimeTokensIn + lifetimeTokensOut;
  const lifetimeMessages = lifetimeSpends.length;

  // Persist repairs so plan budget (which sums costMicroUsd) matches the
  // honest recompute — fire-and-forget, capped so a huge ledger can't stall.
  const repairs = lifetimeSpends
    .map((spend) => {
      const tokensIn = Math.max(0, spend.promptTokens ?? 0);
      const tokensOut = Math.max(0, spend.completionTokens ?? 0);
      const recomputed = recomputeCostMicroUsd(spend.model, tokensIn, tokensOut, resolveModel);
      const stored = Math.max(0, spend.costMicroUsd ?? 0);
      if (recomputed <= stored) return null;
      return { id: spend.id, costMicroUsd: recomputed };
    })
    .filter((r): r is { id: string; costMicroUsd: number } => r != null)
    .slice(0, 2_000);
  if (repairs.length > 0) {
    void Promise.all(
      repairs.map((r) =>
        prisma.apiSpend
          .update({ where: { id: r.id }, data: { costMicroUsd: r.costMicroUsd } })
          .catch(() => null)
      )
    ).catch(() => null);
  }

  return NextResponse.json({
    daily,
    models,
    yearTokens,
    yearMessages,
    totalTokens: lifetimeTokens,
    totalMessages: lifetimeMessages,
    lifetime: {
      tokens: lifetimeTokens,
      tokensIn: lifetimeTokensIn,
      tokensOut: lifetimeTokensOut,
      messages: lifetimeMessages,
      costMicroUsd: lifetimeCostMicroUsd,
      /** Raw sum of ledger rows before recompute repair (debug / transparency). */
      storedCostMicroUsd: lifetimeStoredCostMicroUsd,
      modelsTried: byModelMap.size,
      byKind,
      byModel: byModelCost,
    },
    eurPerUsd: eurPerUsd(),
    memberSince: account?.createdAt.toISOString() ?? null,
  });
}
