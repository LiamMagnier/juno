import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { eurPerUsd } from "@/lib/spend";
import { JUNO_TOOL_MODEL_PREFIX, isJunoToolSpendModel, usageModelLabel } from "@/lib/tools/metering";

export const runtime = "nodejs";

/**
 * Aggregate the user's activity for the profile page:
 * - daily token heatmap (last ~53 weeks)
 * - per-model usage mix (same window)
 * - true lifetime totals from the ApiSpend ledger (tokens, replies, API cost)
 *
 * Cost comes from the ledger. Its token totals cannot reconstruct cache
 * discounts, batch prices or individual requests' long-context thresholds.
 * Repricing them at uncached aggregate rates would invent a larger charge;
 * reading this endpoint must never rewrite historical spend.
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
      /*
       * The activity card counts REPLIES, and background utility calls are not
       * replies. `kind: "utility"` is the walk behind chat titles, moderation,
       * memory extraction, follow-up pills and the citation judge — several
       * model calls can fire around a single message the user sent, so counting
       * their rows here would have inflated "generations this year" and the
       * heatmap by a multiple that has nothing to do with how much the user
       * wrote. Their COST is still theirs and still shows: the lifetime card
       * below reads every row, and breaks the utility spend out by kind.
       *
       * Juno's own tool fees (`juno-tool:*` rows: a search engine's price, a
       * sandbox's time) are not replies either — a turn that searched three
       * times is one reply — and carry no tokens, so they leave this window
       * too. Their cost stays in the lifetime card.
       */
      where: {
        userId: user.id,
        createdAt: { gte: since },
        kind: { not: "utility" },
        model: { not: { startsWith: JUNO_TOOL_MODEL_PREFIX } },
      },
      select: {
        model: true,
        promptTokens: true,
        completionTokens: true,
        createdAt: true,
      },
      take: 100_000,
      orderBy: { createdAt: "desc" },
    }),
    prisma.apiSpend.findMany({
      where: { userId: user.id },
      select: {
        model: true,
        kind: true,
        promptTokens: true,
        completionTokens: true,
        costMicroUsd: true,
      },
      // Hard cap for pathological accounts; aggregation is O(n) in memory.
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

  // Lifetime: preserve the price recorded when each request was settled.
  let lifetimeTokensIn = 0;
  let lifetimeTokensOut = 0;
  let lifetimeCostMicroUsd = 0;
  const byKindMap = new Map<string, { count: number; costMicroUsd: number; tokensIn: number; tokensOut: number }>();
  const byModelMap = new Map<
    string,
    { count: number; costMicroUsd: number; tokensIn: number; tokensOut: number }
  >();

  for (const spend of lifetimeSpends) {
    const tokensIn = Math.max(0, spend.promptTokens ?? 0);
    const tokensOut = Math.max(0, spend.completionTokens ?? 0);
    // ApiSpend stores integer micro-USD. An invalid legacy value contributes
    // zero to this view, never a guessed charge or a write back to the ledger.
    const cost = Number.isSafeInteger(spend.costMicroUsd) && spend.costMicroUsd >= 0
      ? spend.costMicroUsd
      : 0;

    lifetimeTokensIn += tokensIn;
    lifetimeTokensOut += tokensOut;
    lifetimeCostMicroUsd += cost;

    const kind = spend.kind || "chat";
    const kindRow = byKindMap.get(kind) ?? { count: 0, costMicroUsd: 0, tokensIn: 0, tokensOut: 0 };
    kindRow.count += 1;
    kindRow.costMicroUsd += cost;
    kindRow.tokensIn += tokensIn;
    kindRow.tokensOut += tokensOut;
    byKindMap.set(kind, kindRow);

    // Tool fees fold into one "Tools" line rather than one per tool id.
    const modelKey = usageModelLabel(spend.model);
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
  // Row count minus the background walk and the tool fees, for the same reason
  // the year window excludes them: this number is rendered under the word
  // "Replies". Their cost, their tokens and their lines in the by-kind and
  // by-model breakdowns all stay.
  const lifetimeMessages =
    lifetimeSpends.filter((s) => (s.kind || "chat") !== "utility").length -
    lifetimeSpends.filter((s) => (s.kind || "chat") !== "utility" && isJunoToolSpendModel(s.model)).length;

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
      /** Compatibility field: both totals now report settled ledger prices. */
      storedCostMicroUsd: lifetimeCostMicroUsd,
      modelsTried: byModelMap.size,
      byKind,
      byModel: byModelCost,
    },
    eurPerUsd: eurPerUsd(),
    memberSince: account?.createdAt.toISOString() ?? null,
  });
}
