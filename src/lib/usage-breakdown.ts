import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * The read side of the `ApiSpend` ledger.
 *
 * `spend.ts` owns writing the ledger and gating on it; this module only ever
 * reads, and it exists so the account-wide usage surfaces (the website's
 * settings dashboard and the native Usage screen) are built from one
 * aggregation rather than each re-deriving "what did I spend on Code this
 * month" from raw rows.
 *
 * Every number here comes from `ApiSpend`, which is the only place a request's
 * true cost is recorded — so a surface built on this cannot show a total that
 * the budget gate disagrees with. Nothing is estimated or synthesised: a user
 * with no rows gets zeros and an empty series, never a plausible-looking shape.
 */

/** Surfaces a request can come from — the ledger's `kind` column. */
export const USAGE_SURFACES = ["chat", "code", "task", "image", "video", "voice"] as const;
export type UsageSurface = (typeof USAGE_SURFACES)[number];

/** Clients a request can come from — the ledger's `source` column. */
export type UsageSource = "web" | "app";

export interface UsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costMicroUsd: number;
}

export interface UsageSurfaceTotals extends UsageTotals {
  /** `kind` as stored. Rows with a kind outside `USAGE_SURFACES` keep their raw value. */
  surface: string;
}

export interface UsageModelTotals extends UsageTotals {
  model: string;
}

export interface UsageSourceTotals extends UsageTotals {
  source: string;
}

export interface UsageDay {
  /** Midnight UTC of the day, epoch ms. */
  dayMs: number;
  requests: number;
  totalTokens: number;
  costMicroUsd: number;
}

export interface UsageBreakdown {
  range: { startMs: number; endMs: number; days: number };
  totals: UsageTotals;
  surfaces: UsageSurfaceTotals[];
  models: UsageModelTotals[];
  sources: UsageSourceTotals[];
  /** One entry per day that had activity, ascending. Quiet days are absent. */
  daily: UsageDay[];
  /** Days in range with at least one request. */
  activeDays: number;
  /** Consecutive active days ending today (or yesterday, if today is still quiet). */
  currentStreakDays: number;
  longestStreakDays: number;
  /** Requests in the trailing hour and trailing 24 hours. */
  pace: { lastHour: number; last24h: number };
}

const DAY_MS = 86_400_000;

/** Midnight UTC of the day containing `ms`. */
function startOfDayMs(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function emptyTotals(): UsageTotals {
  return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costMicroUsd: 0 };
}

/**
 * Fold a `groupBy` result into the shared totals shape.
 *
 * Prisma types `_sum` as nullable per field (a group with only NULLs sums to
 * null), so every read is coalesced — a missing sum is 0 spend, never NaN
 * propagating into a percentage.
 */
function totalsFrom(row: {
  _count: { _all: number };
  _sum: { promptTokens: number | null; completionTokens: number | null; costMicroUsd: number | null };
}): UsageTotals {
  const promptTokens = row._sum.promptTokens ?? 0;
  const completionTokens = row._sum.completionTokens ?? 0;
  return {
    requests: row._count._all,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    costMicroUsd: row._sum.costMicroUsd ?? 0,
  };
}

/**
 * Aggregate one account's ledger over the trailing `days` days.
 *
 * `days` is clamped to a year: the daily series is rendered as a contribution
 * grid, and a request for an unbounded window would both scan the whole table
 * and hand the client a series no grid can draw.
 */
export async function getUsageBreakdown(
  userId: string,
  { days = 365, modelLimit = 12, now = new Date() }: { days?: number; modelLimit?: number; now?: Date } = {}
): Promise<UsageBreakdown> {
  const windowDays = Math.max(1, Math.min(365, Math.floor(days)));
  const nowMs = now.getTime();
  // Whole UTC days, inclusive of today, so the grid's last cell is "today" and
  // the client never has to reason about a partial leading day.
  const startMs = startOfDayMs(nowMs) - (windowDays - 1) * DAY_MS;
  const since = new Date(startMs);
  const where = { userId, createdAt: { gte: since } };

  const aggregate = {
    _count: { _all: true },
    _sum: { promptTokens: true, completionTokens: true, costMicroUsd: true },
  } as const;

  const [totalRow, surfaceRows, modelRows, sourceRows, dayRows, lastHour, last24h] = await Promise.all([
    prisma.apiSpend.aggregate({ where, ...aggregate }),
    prisma.apiSpend.groupBy({ by: ["kind"], where, ...aggregate }),
    prisma.apiSpend.groupBy({ by: ["model"], where, ...aggregate }),
    prisma.apiSpend.groupBy({ by: ["source"], where, ...aggregate }),
    // Prisma cannot group by a truncated timestamp, so the daily series is the
    // one raw query here. `date_trunc(… , "createdAt" AT TIME ZONE 'UTC')`
    // keeps the buckets on the same UTC grid `startOfDayMs` uses above —
    // bucketing in the server's local zone would shift every cell for any
    // deployment not running in UTC.
    prisma.$queryRaw<Array<{ day: Date; requests: bigint; tokens: bigint | null; cost: bigint | null }>>(
      Prisma.sql`
        SELECT date_trunc('day', "createdAt" AT TIME ZONE 'UTC') AS day,
               COUNT(*)::bigint AS requests,
               SUM("promptTokens" + "completionTokens")::bigint AS tokens,
               SUM("costMicroUsd")::bigint AS cost
          FROM "ApiSpend"
         WHERE "userId" = ${userId} AND "createdAt" >= ${since}
         GROUP BY 1
         ORDER BY 1 ASC
      `
    ),
    prisma.apiSpend.count({ where: { userId, createdAt: { gte: new Date(nowMs - 3_600_000) } } }),
    prisma.apiSpend.count({ where: { userId, createdAt: { gte: new Date(nowMs - DAY_MS) } } }),
  ]);

  const totals = totalsFrom(totalRow);

  const surfaces = surfaceRows
    .map((row) => ({ surface: row.kind, ...totalsFrom(row) }))
    .sort((a, b) => b.costMicroUsd - a.costMicroUsd || b.requests - a.requests);

  const models = modelRows
    .map((row) => ({ model: row.model, ...totalsFrom(row) }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests)
    .slice(0, Math.max(1, modelLimit));

  const sources = sourceRows
    .map((row) => ({ source: row.source, ...totalsFrom(row) }))
    .sort((a, b) => b.requests - a.requests);

  // `date_trunc` returns a timestamp already on the UTC grid; `getTime()` reads
  // it back as the same instant. COUNT/SUM come back as bigint over the wire
  // and are narrowed here — token counts and micro-USD both sit far below
  // Number.MAX_SAFE_INTEGER for any real account.
  const daily: UsageDay[] = dayRows.map((row) => ({
    dayMs: startOfDayMs(row.day.getTime()),
    requests: Number(row.requests),
    totalTokens: Number(row.tokens ?? 0n),
    costMicroUsd: Number(row.cost ?? 0n),
  }));

  const activeDayMs = new Set(daily.filter((d) => d.requests > 0).map((d) => d.dayMs));
  const todayMs = startOfDayMs(nowMs);

  // The streak is allowed to end yesterday: a user who has not opened Juno yet
  // today has not broken it, and zeroing it before the day is over reads as a
  // bug to the person who used it every day for a month.
  let currentStreakDays = 0;
  let cursor = activeDayMs.has(todayMs) ? todayMs : todayMs - DAY_MS;
  while (activeDayMs.has(cursor)) {
    currentStreakDays += 1;
    cursor -= DAY_MS;
  }

  let longestStreakDays = 0;
  let run = 0;
  let previousMs: number | null = null;
  for (const day of daily) {
    if (day.requests <= 0) continue;
    run = previousMs != null && day.dayMs - previousMs === DAY_MS ? run + 1 : 1;
    longestStreakDays = Math.max(longestStreakDays, run);
    previousMs = day.dayMs;
  }

  return {
    range: { startMs, endMs: nowMs, days: windowDays },
    totals,
    surfaces,
    models,
    sources,
    daily,
    activeDays: activeDayMs.size,
    currentStreakDays,
    longestStreakDays,
    pace: { lastHour, last24h },
  };
}
