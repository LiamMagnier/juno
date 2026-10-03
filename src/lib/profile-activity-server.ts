import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveModel } from "@/lib/models";
import { PROVIDERS, type Provider } from "@/lib/providers";
import { JUNO_TOOL_MODEL_PREFIX } from "@/lib/tools/metering";
import {
  addDays,
  computeStreaks,
  isValidTimeZone,
  profileHandle,
  rankModels,
  todayIn,
  type ActivityDay,
  type ProfileActivity,
} from "@/lib/profile-activity";

/**
 * The profile page's numbers, read from the `ApiSpend` ledger (one row per
 * billable model call, never decremented when a chat is deleted), plus the
 * Work and research run tables for "Longest task".
 *
 * WHAT COUNTS AS A TOKEN HERE: prompt + completion tokens of every ledger row
 * except background utility calls (`kind = 'utility'`: titles, moderation,
 * memory extraction; work nobody asked a model for) and Juno's own tool fees
 * (`juno-tool:*`, which carry no tokens). The same exclusion the account
 * section's activity card makes (api/profile/stats), so the two never draw
 * different histories of one account.
 *
 * Three queries, all aggregated in Postgres and all on `ApiSpend
 * (userId, createdAt)` or the run tables' `(userId, …)` indexes:
 *  1. one row per LOCAL calendar day, all time (lifetime, peak, streaks and
 *     the grid all come from it; an account has at most a few thousand)
 *  2. one row per model, all time
 *  3. the longest finished Work run and research run
 */
export async function getProfileActivity(
  userId: string,
  { timeZone: requested, now = new Date() }: { timeZone?: string | null; now?: Date } = {}
): Promise<ProfileActivity> {
  const timeZone = isValidTimeZone(requested) ? requested : "UTC";

  const [dayRows, modelRows, taskRows, account] = await Promise.all([
    dailyTokens(userId, timeZone),
    prisma.apiSpend.groupBy({
      by: ["model"],
      where: { userId, kind: { not: "utility" }, model: { not: { startsWith: JUNO_TOOL_MODEL_PREFIX } } },
      _count: { _all: true },
      _sum: { promptTokens: true, completionTokens: true },
    }),
    prisma.$queryRaw<Array<{ kind: "work" | "research"; ms: number | null }>>(Prisma.sql`
      SELECT 'work' AS kind, MAX(EXTRACT(EPOCH FROM ("finishedAt" - "startedAt")) * 1000)::float8 AS ms
        FROM "WorkRun"
       WHERE "userId" = ${userId} AND "terminalReason" = 'completed'
         AND "startedAt" IS NOT NULL AND "finishedAt" IS NOT NULL
      UNION ALL
      SELECT 'research' AS kind, MAX(EXTRACT(EPOCH FROM ("finishedAt" - "startedAt")) * 1000)::float8 AS ms
        FROM "ResearchRun"
       WHERE "userId" = ${userId} AND "state" IN ('completed', 'partially_completed')
         AND "startedAt" IS NOT NULL AND "finishedAt" IS NOT NULL
    `),
    prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true, username: true, name: true, email: true } }),
  ]);

  const today = todayIn(timeZone, now);
  const all: ActivityDay[] = dayRows.map((r) => ({ date: r.day, tokens: Number(r.tokens ?? 0n) })).filter((d) => d.tokens > 0);

  let lifetimeTokens = 0;
  let peakDay: ActivityDay | null = null;
  for (const day of all) {
    lifetimeTokens += day.tokens;
    if (!peakDay || day.tokens > peakDay.tokens) peakDay = day;
  }

  // 53 Monday-first weeks reach back at most 377 days; a little extra is harmless.
  const windowStart = addDays(today, -378);
  const days = all.filter((d) => d.date >= windowStart && d.date <= today);

  const longest = taskRows
    .filter((r): r is { kind: "work" | "research"; ms: number } => typeof r.ms === "number" && r.ms > 0)
    .sort((a, b) => b.ms - a.ms)[0];

  const labelled = modelRows.map((row) => {
    const { label, provider } = describeModel(row.model);
    return {
      model: row.model,
      label,
      provider,
      tokens: (row._sum.promptTokens ?? 0) + (row._sum.completionTokens ?? 0),
      requests: row._count._all,
    };
  });
  // Two ids can resolve to one name (an alias and its canonical id): one row.
  const byLabel = new Map<string, (typeof labelled)[number]>();
  for (const row of labelled) {
    const seen = byLabel.get(row.label);
    if (seen) {
      seen.tokens += row.tokens;
      seen.requests += row.requests;
    } else byLabel.set(row.label, { ...row });
  }
  const merged = [...byLabel.values()];

  return {
    username: account?.username ?? null,
    handle: account ? profileHandle(account) : "you",
    timeZone,
    today,
    memberSince: account?.createdAt.toISOString() ?? null,
    lifetimeTokens,
    peakDay,
    longestTask: longest ? { ms: Math.round(longest.ms), kind: longest.kind } : null,
    streak: computeStreaks(
      all.map((d) => d.date),
      today
    ),
    activeDays: all.length,
    days,
    models: rankModels(merged),
    modelCount: merged.filter((r) => r.tokens > 0).length,
  };
}

/**
 * Tokens per local calendar day. `createdAt` is a UTC timestamp without a
 * zone, so it is first read AS UTC, then converted to the reader's zone, and
 * only then cut to a date; cutting first would put a 23:30 message in Paris
 * on the wrong day. A zone Postgres does not know falls back to UTC.
 */
async function dailyTokens(userId: string, timeZone: string) {
  const query = (tz: string) =>
    prisma.$queryRaw<Array<{ day: string; tokens: bigint | null }>>(Prisma.sql`
      SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day,
             SUM("promptTokens" + "completionTokens")::bigint AS tokens
        FROM "ApiSpend"
       WHERE "userId" = ${userId}
         AND "kind" <> 'utility'
         AND "model" NOT LIKE ${`${JUNO_TOOL_MODEL_PREFIX}%`}
       GROUP BY 1
       ORDER BY 1 ASC
    `);
  try {
    return await query(timeZone);
  } catch (error) {
    if (timeZone === "UTC") throw error;
    return query("UTC");
  }
}

function describeModel(id: string): { label: string; provider: Provider | null } {
  const info = resolveModel(id);
  if (info) return { label: info.name, provider: info.provider };
  const [prefix, rest] = id.includes(":") ? [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)] : ["", id];
  const provider = prefix in PROVIDERS ? (prefix as Provider) : null;
  return { label: rest || id || "Unknown model", provider };
}
