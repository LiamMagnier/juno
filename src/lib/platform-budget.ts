import "server-only";
import { prismaUnguarded } from "@/lib/prisma";
import { alertOperator } from "@/lib/alerts";

/**
 * A ceiling on what the whole deployment can spend in a day.
 *
 * Per-user budgets already exist (checkBudget in src/lib/spend.ts), but nothing
 * capped the aggregate. Signup allows 5/hour per IP and 200/hour globally — up
 * to 4,800 accounts a day — and OWNER accounts have no budget at all. Every one
 * of those spends against Juno's provider accounts, so the only thing bounding
 * the bill was how many people bothered to show up.
 *
 * Off unless PLATFORM_DAILY_BUDGET_USD is set: picking a spending limit for
 * someone else's business would be a guess, and a wrong guess here cuts off
 * paying customers. When it is set, crossing it degrades new generations to the
 * cheapest capable model rather than failing them — a slower answer is a much
 * better outcome than a 500, and it keeps the product usable while an operator
 * decides what to do.
 *
 * The day boundary is UTC, matching how the rest of the deployment's scheduled
 * work is anchored.
 */

/** Aggregate spend is re-read at most this often; it is a ceiling, not a meter. */
const CACHE_TTL_MS = 60_000;

let cache: { at: number; spentMicroUsd: number } | null = null;
/** UTC day-stamp the "you have crossed the ceiling" alert last fired for. */
let alertedForDay: string | null = null;

function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function utcDayStamp(now = new Date()): string {
  return utcDayStart(now).toISOString().slice(0, 10);
}

/** Warn once per process, not once per call — this sits on the chat hot path. */
let warnedAboutMalformedBudget = false;

/** The configured ceiling in micro-USD, or null when no ceiling is set. */
export function platformDailyCeilingMicroUsd(): number | null {
  const raw = process.env.PLATFORM_DAILY_BUDGET_USD;
  if (!raw) return null;
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd <= 0) {
    // Unset means "no ceiling" and is a legitimate configuration. A value that
    // was SET and cannot be parsed is a typo, and silently treating it as no
    // ceiling removes the only thing bounding the aggregate provider bill —
    // `Number("$50")`, `Number("50 USD")` and `Number("50,00")` are all NaN, so
    // the plausible mistakes are exactly the ones that disable it.
    if (!warnedAboutMalformedBudget) {
      warnedAboutMalformedBudget = true;
      console.error(
        `[alert] PLATFORM_DAILY_BUDGET_USD is set to ${JSON.stringify(raw)}, which is not a positive number. ` +
          "No platform spending ceiling is in effect. Expected a bare number of US dollars, e.g. 50",
      );
    }
    return null;
  }
  return Math.round(usd * 1_000_000);
}

/**
 * Total spend across every account since 00:00 UTC, in micro-USD.
 *
 * Deliberately unguarded: this is a platform-wide question, not a user-scoped
 * one, which is exactly the case prismaUnguarded exists for.
 */
export async function platformSpendTodayMicroUsd(): Promise<number> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.spentMicroUsd;

  const agg = await prismaUnguarded.apiSpend.aggregate({
    where: { createdAt: { gte: utcDayStart() } },
    _sum: { costMicroUsd: true },
  });
  const spentMicroUsd = agg._sum.costMicroUsd ?? 0;
  cache = { at: now, spentMicroUsd };
  return spentMicroUsd;
}

export interface PlatformBudgetState {
  /** No ceiling configured. */
  unlimited: boolean;
  exceeded: boolean;
  spentMicroUsd: number;
  ceilingMicroUsd: number | null;
}

/**
 * Current platform budget state. Cheap — served from a 60s cache — and safe to
 * call on a request path. Never throws: a database hiccup must not take the
 * product down, so it fails open.
 */
export async function platformBudgetState(): Promise<PlatformBudgetState> {
  const ceilingMicroUsd = platformDailyCeilingMicroUsd();
  if (ceilingMicroUsd === null) {
    return { unlimited: true, exceeded: false, spentMicroUsd: 0, ceilingMicroUsd: null };
  }

  try {
    const spentMicroUsd = await platformSpendTodayMicroUsd();
    const exceeded = spentMicroUsd >= ceilingMicroUsd;

    if (exceeded) {
      const day = utcDayStamp();
      if (alertedForDay !== day) {
        alertedForDay = day;
        alertOperator({
          kind: "platform_budget_exceeded",
          key: day,
          severity: "critical",
          title: "Juno has hit its daily platform spend ceiling",
          detail: {
            day,
            spentUsd: (spentMicroUsd / 1_000_000).toFixed(2),
            ceilingUsd: (ceilingMicroUsd / 1_000_000).toFixed(2),
            effect: "New generations are being routed to the cheapest capable model.",
          },
        });
      }
    }

    return { unlimited: false, exceeded, spentMicroUsd, ceilingMicroUsd };
  } catch (err) {
    // Fail open: an aggregate query failing must not stop the product.
    console.error("[platform-budget] could not read platform spend", {
      message: err instanceof Error ? err.message : String(err),
    });
    return { unlimited: false, exceeded: false, spentMicroUsd: 0, ceilingMicroUsd };
  }
}

/** Convenience for request paths that only need the yes/no. */
export async function isPlatformBudgetExceeded(): Promise<boolean> {
  return (await platformBudgetState()).exceeded;
}

/** Test seam. */
export function __resetPlatformBudgetCacheForTests(): void {
  cache = null;
  alertedForDay = null;
}
