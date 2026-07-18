import "server-only";
import type { Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveModel } from "@/lib/models";
import { getModelMetrics } from "@/lib/model-metrics";
import { estimateGenerationCostUsd, estimateTokensFromChars } from "@/lib/pricing";
import { sendBudgetAlert } from "@/lib/email";

/**
 * The single budget module: per-plan monthly API budgets, per-request cost
 * computation, the ApiSpend ledger writer, and the pre-stream budget gate.
 *
 * Money is integer micro-USD (1e-6 $) end to end. Budgets are defined in EUR
 * and treated 1:1 with the USD model prices unless API_COST_EUR_PER_USD says
 * how many EUR one USD of model spend costs (e.g. 0.92).
 */

/**
 * Monthly API budget per plan, in EUR. null = unlimited (OWNER).
 *
 * Sized against NET revenue, not the sticker price: plans are sold HT and
 * URSSAF cotisations (micro-entrepreneur, ~21%) come off the top, so a plan
 * nets price × 0.79. Budgets are ~70% of that net so each plan keeps a real
 * margin after cotisations (Pro 20€ → nets 15.80€ → 11€ budget ≈ 4.80€
 * margin; Max 100€ → 79€ → 55€; Max x20 200€ → 158€ → 110€). The 5-hour and
 * weekly windows derive from these proportionally.
 */
const BUDGET_EUR: Record<Plan, number | null> = {
  FREE: 0,
  PRO: 11,
  MAX: 55,
  MAX20: 110,
  OWNER: null,
};

/** How many EUR one USD of model spend costs. Defaults to 1 (EUR ≙ USD). */
export function eurPerUsd(): number {
  const raw = Number(process.env.API_COST_EUR_PER_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/** Plan budget in micro-USD, or null for unlimited (OWNER). */
export function budgetForPlan(plan: Plan): number | null {
  const eur = BUDGET_EUR[plan];
  if (eur == null) return null;
  return Math.round((eur / eurPerUsd()) * 1_000_000);
}

/**
 * Cost of one chat request in micro-USD, from the per-model $/1M in/out
 * pricing in model-metrics.ts (µUSD = tokens × $/MTok — the 10^6s cancel).
 * Unknown models fall back to a mid-tier $2/$10 per MTok rate.
 */
export function modelRequestCost({
  modelId,
  promptTokens,
  completionTokens,
}: {
  modelId: string;
  promptTokens: number;
  completionTokens: number;
}): number {
  const { input, output } = modelRatesMicroUsdPerToken(modelId);
  return Math.max(0, Math.round(promptTokens * input + completionTokens * output));
}

/**
 * Per-token cost in micro-USD for a model (input and output). Numerically equal
 * to the $/MTok rates — the 10^6 (dollars→micro) and 10^6 (per-MTok→per-token)
 * cancel. Used for real-time, mid-stream budget enforcement in the chat route.
 */
export function modelRatesMicroUsdPerToken(modelId: string): { input: number; output: number } {
  const model = resolveModel(modelId);
  const metrics = model ? getModelMetrics(model) : null;
  return { input: metrics?.inputUsdPerMTok ?? 2, output: metrics?.outputUsdPerMTok ?? 10 };
}

/**
 * Flat per-request cost for media generations, in micro-USD. Image/video
 * providers report no token usage, so each request is billed a documented
 * approximation of public list prices:
 *
 *   image — GPT Image $0.04 · Nano Banana Pro $0.06 · Gemini flash image /
 *           Imagen $0.03 · lite tiers $0.01 · Grok Imagine $0.03 (quality) /
 *           $0.01 (fast) · GLM Image / CogView / MiniMax Image $0.02
 *   video — $0.50 per clip, $0.25 for fast/mini tiers, $0.75 for
 *           cost-tier-3 flagships (Veo 3.1, Seedance 2.0, Hailuo 2.3…)
 */
export function mediaRequestCost(modelId: string, kind: "image" | "video"): number {
  const model = resolveModel(modelId);
  const id = (model?.id ?? modelId).toLowerCase();
  if (kind === "video") {
    if (/fast|mini|lite/.test(id)) return 250_000;
    return (model?.cost ?? 3) >= 3 ? 750_000 : 500_000;
  }
  if (id.includes("gpt-image")) return 40_000;
  if (id.includes("pro-image")) return 60_000;
  if (id.includes("lite")) return 10_000;
  if (id.includes("grok-imagine-image")) return id.includes("quality") ? 30_000 : 10_000;
  if (id.includes("glm-image") || id.includes("cogview") || id.includes("image-01")) return 20_000;
  return 30_000;
}

export interface RecordSpendInput {
  userId: string;
  model: string;
  kind: "chat" | "image" | "video" | "voice" | "code" | "task";
  /** Which surface produced the spend — "web" (site) or "app" (native app). */
  source?: "web" | "app";
  promptTokens?: number;
  completionTokens?: number;
  /** Reasoning/thinking tokens when the provider reports them separately. */
  reasoningTokens?: number;
  totalTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Fallback when the provider reported no usage: tokens ≈ chars / 4. */
  promptChars?: number;
  completionChars?: number;
  /** Streamed reasoning text length — floors thinking-heavy turns without usage. */
  reasoningChars?: number;
  fastMode?: boolean;
  /**
   * Precomputed request cost in USD (cache-aware, per-provider). Combined with
   * a recompute from tokens so a too-low estimate can't underbill the ledger.
   */
  costUsd?: number;
}

/**
 * Compute the request cost and append an ApiSpend ledger row. Fire-and-forget
 * safe: never throws into the caller's stream — failures are logged and the
 * generation proceeds unbilled rather than broken.
 *
 * Chat/code/task turns always recompute cost from tokens (and char floors)
 * using the shared pricing table, then take the MAX of that and any caller
 * estimate — so missing usage, ignored reasoning tokens, or a stale rate
 * never under-report spend against the plan budget.
 */
export async function recordSpend(input: RecordSpendInput): Promise<void> {
  try {
    let promptTokens = Math.max(0, input.promptTokens ?? 0);
    let completionTokens = Math.max(0, input.completionTokens ?? 0);
    let costMicroUsd = 0;

    if (input.kind === "image" || input.kind === "video") {
      if (!promptTokens) promptTokens = estimateTokensFromChars(input.promptChars);
      if (!completionTokens) completionTokens = estimateTokensFromChars(input.completionChars);
      costMicroUsd =
        input.costUsd != null && input.costUsd > 0
          ? Math.round(input.costUsd * 1_000_000)
          : mediaRequestCost(input.model, input.kind);
    } else {
      const model = resolveModel(input.model);
      if (model) {
        const billed = estimateGenerationCostUsd(model, {
          promptTokens: input.promptTokens,
          completionTokens: input.completionTokens,
          reasoningTokens: input.reasoningTokens,
          totalTokens: input.totalTokens,
          cacheRead: input.cacheRead,
          cacheWrite: input.cacheWrite,
          fastMode: input.fastMode,
          promptChars: input.promptChars,
          completionChars: input.completionChars,
          reasoningChars: input.reasoningChars,
        });
        promptTokens = billed.promptTokens;
        completionTokens = billed.completionTokens;
        const fromTokens = Math.round(billed.costUsd * 1_000_000);
        const fromCaller =
          input.costUsd != null && input.costUsd > 0 ? Math.round(input.costUsd * 1_000_000) : 0;
        // Never underbill: prefer the higher of the two honest estimates.
        costMicroUsd = Math.max(fromTokens, fromCaller);
      } else {
        if (!promptTokens) promptTokens = estimateTokensFromChars(input.promptChars);
        if (!completionTokens) {
          completionTokens = estimateTokensFromChars(
            (input.completionChars ?? 0) + (input.reasoningChars ?? 0)
          );
        }
        const fromTokens = modelRequestCost({ modelId: input.model, promptTokens, completionTokens });
        const fromCaller =
          input.costUsd != null && input.costUsd > 0 ? Math.round(input.costUsd * 1_000_000) : 0;
        costMicroUsd = Math.max(fromTokens, fromCaller);
      }
    }

    await prisma.apiSpend.create({
      data: {
        userId: input.userId,
        model: input.model,
        kind: input.kind,
        source: input.source ?? "web",
        promptTokens,
        completionTokens,
        costMicroUsd: Math.max(0, costMicroUsd),
      },
    });
  } catch (err) {
    console.error("[spend] failed to record spend", {
      userId: input.userId,
      model: input.model,
      kind: input.kind,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// Usage windows for the settings gauge (DISPLAY ONLY — the billing-period gate
// in checkBudget is the sole hard limit; windows never block on their own).
// Each window's budget is its exact TIME-PROPORTIONAL share of the period, so
// the windows TILE the period budget perfectly: the weekly budgets and the
// session budgets each sum to exactly the €15 cap across a month (a window at
// 100% = on pace to spend precisely the period budget). This is the only split
// that stays honest to the €15 ceiling — dividing by a whole 4 weeks (a month
// is really 4.29 weeks) would over-allocate. Session/week grids are anchored to
// the subscription so they reset on the subscriber's own schedule.
const SESSION_MS = 5 * 60 * 60 * 1000; // 5-hour "current session" window
const WEEK_MS = 7 * 24 * 60 * 60 * 1000; // weekly window
const MONTH_MS = 30 * 24 * 60 * 60 * 1000; // reference month (checkBudget fallback)

/** Sum of a user's spend since a given instant, in micro-USD. */
async function spendSinceMicroUsd(userId: string, since: Date): Promise<number> {
  const agg = await prisma.apiSpend.aggregate({
    where: { userId, createdAt: { gte: since } },
    _sum: { costMicroUsd: true },
  });
  return agg._sum.costMicroUsd ?? 0;
}

/**
 * Add `n` calendar months to a date, clamping the day so month lengths don't
 * overflow (Mar 31 −1mo → Feb 28/29). Time-of-day is preserved (UTC math).
 */
function addMonths(date: Date, n: number): Date {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export interface BillingPeriod {
  /** Start of the current billing period; spend is counted from here. */
  startMs: number;
  /** End of the current billing period — when the usage budget renews. */
  endMs: number;
  /** When the user first subscribed; anchors the rolling session/week grids. */
  anchorMs: number;
}

/** Whole-month difference (UTC year/month) — a starting estimate for the period. */
function monthsBetween(a: Date, b: Date): number {
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

/**
 * The current monthly period on `boundary`'s day/time schedule that contains
 * `now`: [end − 1 month, end) with `end` the first boundary strictly after now.
 * Rolls to the right cell in O(1) whether `boundary` is in the future (a live
 * Stripe period end), the past (a stale one from a delayed webhook), or years
 * ago (a subscription anniversary) — the ±month guards run at most a couple of
 * times, so a stale boundary can never count spend against an expired window.
 */
function currentPeriod(boundary: Date, now: Date): { start: Date; end: Date } {
  let k = monthsBetween(boundary, now);
  let end = addMonths(boundary, k);
  let guard = 0;
  while (end <= now && guard++ < 24) end = addMonths(boundary, ++k);
  while (addMonths(boundary, k - 1) > now && guard++ < 24) end = addMonths(boundary, --k);
  return { start: addMonths(boundary, k - 1), end };
}

/**
 * Compute the current billing period from a subscription row (pure). Budgets
 * reset on the subscriber's schedule, not the calendar 1st: boundaries follow
 * the real Stripe period end when present, else the subscription anniversary.
 * A past/stale currentPeriodEnd is rolled forward to the live cell.
 * null = OWNER / unlimited (no budget to track).
 */
export function billingPeriodFor(
  plan: Plan,
  sub: { createdAt: Date; currentPeriodEnd: Date | null } | null,
  now = new Date()
): BillingPeriod | null {
  if (budgetForPlan(plan) == null) return null; // OWNER / unlimited
  const anchor = sub?.createdAt ?? now;
  const boundary = sub?.currentPeriodEnd ?? anchor;
  const { start, end } = currentPeriod(boundary, now);
  return { startMs: start.getTime(), endMs: end.getTime(), anchorMs: anchor.getTime() };
}

/** Fetch the subscription and derive the current billing period. */
export async function resolveBillingPeriod(
  userId: string,
  plan: Plan,
  now = new Date()
): Promise<BillingPeriod | null> {
  if (budgetForPlan(plan) == null) return null;
  const sub = await prisma.subscription.findUnique({
    where: { userId },
    select: { createdAt: true, currentPeriodEnd: true },
  });
  return billingPeriodFor(plan, sub, now);
}

export interface BudgetStatus {
  allowed: boolean;
  spentMicroUsd: number;
  budgetMicroUsd: number | null;
  remainingMicroUsd: number | null;
  /** Epoch ms when the budget renews (billing period end); null = unlimited. */
  resetsAtMs: number | null;
}

/**
 * Pre-stream budget gate. OWNER is always allowed without touching the
 * database. FREE has a 0 budget and is always blocked. Paid plans are allowed
 * while spend within the current BILLING PERIOD is under budget. Pass a
 * pre-resolved `period` to avoid a second subscription lookup.
 */
export async function checkBudget(
  userId: string,
  plan: Plan,
  period?: BillingPeriod | null
): Promise<BudgetStatus> {
  const budgetMicroUsd = budgetForPlan(plan);
  if (budgetMicroUsd == null) {
    return { allowed: true, spentMicroUsd: 0, budgetMicroUsd: null, remainingMicroUsd: null, resetsAtMs: null };
  }
  const p = period ?? (await resolveBillingPeriod(userId, plan));
  const since = p ? new Date(p.startMs) : new Date(Date.now() - MONTH_MS);
  const spentMicroUsd = await spendSinceMicroUsd(userId, since);
  // Lifecycle email: past 80% of the period budget, fire-and-forget the
  // budget-alert sender (it dedupes to ONE email per billing period and
  // honors settings.emailBudgetAlerts). The threshold test reuses numbers
  // already in scope, so requests far from the limit cost nothing extra.
  if (budgetMicroUsd > 0 && spentMicroUsd >= budgetMicroUsd * 0.8) {
    void sendBudgetAlert({ userId, spentMicroUsd, budgetMicroUsd, resetsAtMs: p?.endMs ?? null });
  }
  return {
    allowed: spentMicroUsd < budgetMicroUsd,
    spentMicroUsd,
    budgetMicroUsd,
    remainingMicroUsd: Math.max(0, budgetMicroUsd - spentMicroUsd),
    resetsAtMs: p?.endMs ?? null,
  };
}

export interface UsageWindow {
  spentMicroUsd: number;
  /** This window's proportional slice of the period budget; null = unlimited. */
  budgetMicroUsd: number | null;
  /** spend ÷ budget (0..∞; 1 = on pace for the full period budget). */
  pct: number;
  /** Epoch ms when this window's grid cell rolls over. */
  resetsAtMs: number;
}

export interface UsageWindows {
  session: UsageWindow;
  weekly: UsageWindow;
}

/**
 * Rolling 5-hour and weekly usage windows, anchored to the subscription so they
 * reset on the subscriber's schedule. Pass the pre-resolved billing `period`;
 * null → OWNER/unlimited (no metering).
 */
export async function getUsageWindows(
  userId: string,
  plan: Plan,
  period: BillingPeriod | null,
  now = new Date()
): Promise<UsageWindows> {
  const monthBudget = budgetForPlan(plan);
  const nowMs = now.getTime();
  if (monthBudget == null || period == null) {
    const w: UsageWindow = { spentMicroUsd: 0, budgetMicroUsd: null, pct: 0, resetsAtMs: nowMs };
    return { session: w, weekly: w };
  }
  // Time-proportional budgets: each window gets its exact fraction of the
  // period budget, so weekly (× ~4.29/mo) and session (× 144/mo) each sum to €15.
  const periodMs = Math.max(period.endMs - period.startMs, MONTH_MS);
  const elapsed = Math.max(0, nowMs - period.anchorMs);
  const sessionStart = period.anchorMs + Math.floor(elapsed / SESSION_MS) * SESSION_MS;
  const weekStart = period.anchorMs + Math.floor(elapsed / WEEK_MS) * WEEK_MS;
  const [sessionSpent, weekSpent] = await Promise.all([
    spendSinceMicroUsd(userId, new Date(sessionStart)),
    spendSinceMicroUsd(userId, new Date(weekStart)),
  ]);
  const mk = (spent: number, budget: number, resetsAtMs: number): UsageWindow => ({
    spentMicroUsd: spent,
    budgetMicroUsd: budget,
    pct: budget > 0 ? spent / budget : 0,
    resetsAtMs,
  });
  return {
    session: mk(sessionSpent, Math.round(monthBudget * (SESSION_MS / periodMs)), sessionStart + SESSION_MS),
    weekly: mk(weekSpent, Math.round(monthBudget * (WEEK_MS / periodMs)), weekStart + WEEK_MS),
  };
}

/** "August 1" — the first day of next month (UTC); fallback reset label. */
export function nextResetLabel(now = new Date()): string {
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return reset.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/** Friendly sentence for the 402 budget_exceeded response. */
export function budgetExceededMessage(plan: Plan, resetsAtMs?: number | null): string {
  if (plan === "FREE") {
    return "The Free plan doesn't include a model budget. Upgrade to Pro to start chatting.";
  }
  const when = resetsAtMs
    ? new Date(resetsAtMs).toLocaleDateString("en-US", { month: "long", day: "numeric" })
    : nextResetLabel();
  return `You've used up your plan's usage budget — it renews on ${when}. Upgrade your plan for a bigger budget.`;
}
