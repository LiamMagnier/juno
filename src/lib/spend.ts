import "server-only";
import { Prisma } from "@prisma/client";
import type { Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveModel } from "@/lib/models";
import { getModelMetrics } from "@/lib/model-metrics";
import { estimateGenerationCostUsd, estimateTokensFromChars } from "@/lib/pricing";
import { sendBudgetAlert } from "@/lib/email";
import { getUserPlan } from "@/lib/usage";
import {
  DEFAULT_ESTIMATE_MICRO_USD,
  UNIT_CEILING_MICRO_USD,
  effectiveBudget,
  type BudgetCapSource,
  type EffectiveBudget,
  type SpendKind,
} from "@/lib/spend-ceiling";

/**
 * The single budget module: per-plan monthly API budgets, per-request cost
 * computation, the ApiSpend ledger writer, the reservation ledger, and the
 * pre-stream budget gate.
 *
 * Money is integer micro-USD (1e-6 $) end to end. Budgets are defined in EUR
 * and treated 1:1 with the USD model prices unless API_COST_EUR_PER_USD says
 * how many EUR one USD of model spend costs (e.g. 0.92).
 *
 * The arithmetic that decides WHICH ceiling binds lives in `spend-ceiling.ts`,
 * free of Prisma so it can be tested; this module is the I/O around it.
 */

/**
 * Monthly API budget per plan, in EUR. null = the plan states no figure of its
 * own (OWNER) — which is NOT the same as unlimited. `effectiveBudget` turns a
 * null here into PERSONAL_DEFAULT_CAP_EUR, or into whatever lower number the
 * account set for itself; only `Settings.spendCapDisabled` removes the ceiling.
 *
 * Sized against NET revenue, not the sticker price: plans are sold HT and
 * URSSAF cotisations (micro-entrepreneur, ~21%) come off the top, so a plan
 * nets price × 0.79. Budgets are ~70% of that net so each plan keeps a real
 * margin after cotisations (Pro 20€ → nets 15.80€ → 11€ budget ≈ 4.80€
 * margin; Max 100€ → 79€ → 55€; Max x20 200€ → 158€ → 110€). The 5-hour and
 * weekly windows derive from these proportionally.
 *
 * FREE is a trial, not revenue: 0.15€ covers the 15 messages
 * PLANS.FREE.monthlyMessages grants even on the priciest trial-tier model
 * (Sonnet 5 at $3/$15 ≈ 1¢ per catalog-average request), so the message
 * counter — not this ceiling — is the limit trial users meet; an all-cheap-
 * tier trial settles under 2¢. This figure only stops pathological
 * long-context runs. Owner's call: set back to 0 (with
 * PLANS.FREE.monthlyMessages) to end the trial.
 */
const BUDGET_EUR: Record<Plan, number | null> = {
  FREE: 0.15,
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

/** Plan budget in micro-USD, or null when the plan states no figure (OWNER). */
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
  if (id.includes("grok-imagine-image-2.0")) return 40_000;
  if (id.includes("grok-imagine-image")) return id.includes("quality") ? 30_000 : 10_000;
  if (id.includes("glm-image") || id.includes("cogview") || id.includes("image-01")) return 20_000;
  return 30_000;
}

export interface RecordSpendInput {
  userId: string;
  model: string;
  /**
   * "work" and "research" are ledger kinds, not chat: a Work run's model spend
   * and deep research's per-search vendor fees were previously billed to nobody
   * at all. `ApiSpend.kind` is a free-text column, so widening the union is the
   * whole change — but keep it a union, so a typo cannot invent a category the
   * usage breakdown will silently drop.
   */
  kind: SpendKind;
  /** Which surface produced the spend — "web" (site) or "app" (native app). */
  source?: "web" | "app";
  promptTokens?: number;
  completionTokens?: number;
  /** Reasoning/thinking tokens when the provider reports them separately. */
  reasoningTokens?: number;
  totalTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  webSearchRequests?: number;
  xSearchRequests?: number;
  /** Fallback when the provider reported no usage: tokens ≈ chars / 4. */
  promptChars?: number;
  completionChars?: number;
  /** Streamed reasoning text length — floors thinking-heavy turns without usage. */
  reasoningChars?: number;
  fastMode?: boolean;
  /**
   * Precomputed request cost in USD (cache-aware, per-provider, tool fees).
   * Combined with a recompute from tokens so a too-low estimate can't underbill
   * the ledger.
   */
  costUsd?: number;
  /**
   * Set only by a writer that can legitimately retry the same charge — today,
   * the voice relay, which re-sends any delta it could not confirm. The unique
   * index on (userId, idempotencyKey) turns that retry into a no-op instead of
   * a second bill. Leave undefined for a caller that speaks once.
   */
  idempotencyKey?: string;
  /**
   * The `ref` this spend was reserved under, if it was. Settling here rather
   * than at each of the caller's exits is deliberate: a chat turn has four
   * places it can record spend and rather more places it can end, and a hold
   * that is never settled is a budget the user watches not recover.
   */
  ref?: string;
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
export async function recordSpend(input: RecordSpendInput): Promise<boolean> {
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
          cacheWrite5m: input.cacheWrite5m,
          cacheWrite1h: input.cacheWrite1h,
          webSearchRequests: input.webSearchRequests,
          xSearchRequests: input.xSearchRequests,
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

    const data = {
      userId: input.userId,
      model: input.model,
      kind: input.kind,
      source: input.source ?? "web",
      promptTokens,
      completionTokens,
      costMicroUsd: Math.max(0, costMicroUsd),
    };

    let inserted = true;
    if (input.idempotencyKey) {
      // A retry of a charge that already landed must be a no-op, not a second
      // bill. `create` inside a unique constraint is the only version of this
      // that is safe against two relay ticks racing — a read-then-create would
      // let both observe "absent" and both insert.
      await prisma.apiSpend
        .create({ data: { ...data, idempotencyKey: input.idempotencyKey } })
        .catch((error: unknown) => {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            inserted = false;
            return true;
          }
          throw error;
        });
    } else {
      await prisma.apiSpend.create({ data });
    }

    // The reservation ledger's settled total. Only on a real insert: a retry
    // the unique index collapsed into a no-op has already been counted, and
    // counting it again would eat the ceiling twice for one charge.
    if (inserted) await commitToSpendPeriod(input.userId, data.costMicroUsd);

    // The estimate held for this unit of work is now worth less than the truth.
    // Settling after the commit, never before: the moment between the two is
    // an over-count, which refuses work; the reverse is an under-count, which
    // admits it.
    if (input.ref) await settleSpend(input.userId, input.ref, data.costMicroUsd);
    return true;
  } catch (err) {
    console.error("[spend] failed to record spend", {
      userId: input.userId,
      model: input.model,
      kind: input.kind,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Bill a Work run's model spend to the shared ledger.
 *
 * Work never called `recordSpend` at all: a run could loop for an hour on a
 * frontier model and the usage tile would show the same figure as an idle
 * account. `WorkRun.costMicroUsd` tracked it perfectly and nothing else ever
 * read that column.
 *
 * DELTAS, not the cumulative total. A parked run reports its usage at the pause
 * boundary and again at the finish after resuming, and billing the cumulative
 * figure twice would double-charge every run a user ever paused. The
 * already-billed figure is read back from the ledger rather than from
 * `WorkRun.costMicroUsd`, because checkpoints advance that column mid-run
 * without billing anything — reading it would make the delta zero.
 *
 * The idempotency key carries the cumulative total, so a terminal write that
 * the runner retries lands once. Fire-and-forget, like every other ledger
 * writer: a run that finished must not be marked failed because a billing row
 * would not insert.
 */
export async function recordWorkRunSpend(input: {
  userId: string;
  runId: string;
  model: string | null;
  cumulativeCostMicroUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Close the Work admission hold after the terminal bill is recorded. */
  reservationRef?: string | null;
  terminal?: boolean;
}): Promise<void> {
  try {
    const cumulative = Math.max(0, Math.round(input.cumulativeCostMicroUsd));
    if (cumulative <= 0) {
      if (input.terminal && input.reservationRef) {
        await settleSpend(input.userId, input.reservationRef, 0);
      }
      return;
    }
    const prefix = `work:${input.runId}:`;
    const billed = await prisma.apiSpend.aggregate({
      where: { userId: input.userId, idempotencyKey: { startsWith: prefix } },
      _sum: { costMicroUsd: true, promptTokens: true, completionTokens: true },
    });
    const delta = cumulative - (billed._sum.costMicroUsd ?? 0);
    if (delta <= 0) {
      if (input.terminal && input.reservationRef) {
        await settleSpend(input.userId, input.reservationRef, cumulative);
      }
      return;
    }

    // The token counts are cumulative too, and `recordSpend` re-costs from them
    // and keeps the HIGHER of the two figures. Handing it cumulative tokens
    // beside a delta cost would therefore bill the whole run again at the
    // second terminal point, which is the exact bug deltas exist to avoid.
    const promptDelta = Math.max(0, (input.inputTokens ?? 0) - (billed._sum.promptTokens ?? 0));
    const completionDelta = Math.max(
      0,
      (input.outputTokens ?? 0) - (billed._sum.completionTokens ?? 0)
    );

    const recorded = await recordSpend({
      userId: input.userId,
      // A run whose model was never resolved still spent money; naming it
      // honestly beats attributing the cost to a model that did not run.
      model: input.model ?? "unknown",
      kind: "work",
      promptTokens: promptDelta,
      completionTokens: completionDelta,
      // The runner's own accounting includes tool fees and every non-chat call
      // the run made, so it is the floor rather than a hint.
      costUsd: delta / 1_000_000,
      idempotencyKey: `${prefix}${cumulative}`,
    });
    if (recorded && input.terminal && input.reservationRef) {
      await settleSpend(input.userId, input.reservationRef, cumulative);
    }
  } catch (err) {
    console.error("[spend] failed to bill a work run", {
      userId: input.userId,
      runId: input.runId,
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
 *
 * No longer returns null for a plan without a budget figure. It used to, and
 * that was the first domino: OWNER got no period, so no window, so no spend was
 * ever counted for the one account that had no ceiling either.
 *
 * An account with NO subscription row — the personal account, and every FREE
 * one — is anchored to the calendar month instead. Anchoring it to `now`, as
 * this did, produced a period starting at this instant, against which the
 * spend of the last thirty days is always exactly zero.
 */
export function billingPeriodFor(
  sub: { createdAt: Date; currentPeriodEnd: Date | null } | null,
  now = new Date()
): BillingPeriod {
  if (!sub) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { startMs: start.getTime(), endMs: end.getTime(), anchorMs: start.getTime() };
  }
  const anchor = sub.createdAt;
  const boundary = sub.currentPeriodEnd ?? anchor;
  const { start, end } = currentPeriod(boundary, now);
  return { startMs: start.getTime(), endMs: end.getTime(), anchorMs: anchor.getTime() };
}

/** Fetch the subscription and derive the current billing period. */
export async function resolveBillingPeriod(
  userId: string,
  now = new Date()
): Promise<BillingPeriod> {
  const sub = await prisma.subscription.findUnique({
    where: { userId },
    select: { createdAt: true, currentPeriodEnd: true },
  });
  return billingPeriodFor(sub, now);
}

/**
 * The key SpendPeriod rows are filed under: the ISO date of the period start.
 * Derived from the billing period rather than the calendar month so the
 * reservation ledger and the ApiSpend aggregate always cover the same window —
 * two different windows would let a hold outlive the spend it was held against.
 */
export function spendPeriodKey(period: BillingPeriod): string {
  return new Date(period.startMs).toISOString().slice(0, 10);
}

/**
 * The ceiling that binds for this account, from the plan and the account's own
 * settings. One read of Settings; pass the result on to `checkBudget` and
 * `reserveSpend` rather than resolving it twice per request.
 */
export async function resolveEffectiveBudget(
  userId: string,
  plan: Plan
): Promise<EffectiveBudget> {
  const settings = await prisma.settings.findUnique({
    where: { userId },
    select: { monthlySpendCapEur: true, spendCapDisabled: true },
  });
  return effectiveBudget({
    planBudgetMicroUsd: budgetForPlan(plan),
    userCapEur: settings?.monthlySpendCapEur ?? null,
    capDisabled: settings?.spendCapDisabled ?? false,
    eurPerUsd: eurPerUsd(),
  });
}

export interface BudgetStatus {
  allowed: boolean;
  spentMicroUsd: number;
  budgetMicroUsd: number | null;
  remainingMicroUsd: number | null;
  /** Epoch ms when the budget renews (billing period end); null = unlimited. */
  resetsAtMs: number | null;
  /** Micro-USD held by generations that are still running. */
  reservedMicroUsd: number;
  /** Which number bound — the UI reports who set the ceiling. */
  capSource: BudgetCapSource;
  /** `Settings.spendCapDisabled` is on. Say so, loudly, wherever this is read. */
  capDisabled: boolean;
}

/**
 * Pre-stream budget gate.
 *
 * Every account now has a figure: the plan's, the account's own, or
 * PERSONAL_DEFAULT_CAP_EUR when the plan states none. The one path that returns
 * "allowed, no ceiling" is `spendCapDisabled`, and it reports itself so the
 * caller cannot show it as a normal unlimited plan.
 *
 * `remainingMicroUsd` is what the mid-stream guard is handed, so it subtracts
 * open reservations as well as settled spend — otherwise a turn admitted
 * alongside two others would each be told it had the whole remainder.
 *
 * Pass a pre-resolved `period` / `budget` to avoid repeating their lookups.
 */
export async function checkBudget(
  userId: string,
  plan: Plan,
  period?: BillingPeriod | null,
  budget?: EffectiveBudget
): Promise<BudgetStatus> {
  const eff = budget ?? (await resolveEffectiveBudget(userId, plan));
  if (eff.budgetMicroUsd == null) {
    return {
      allowed: true,
      spentMicroUsd: 0,
      budgetMicroUsd: null,
      remainingMicroUsd: null,
      resetsAtMs: null,
      reservedMicroUsd: 0,
      capSource: eff.source,
      capDisabled: true,
    };
  }
  const budgetMicroUsd = eff.budgetMicroUsd;
  const p = period ?? (await resolveBillingPeriod(userId));
  const since = p ? new Date(p.startMs) : new Date(Date.now() - MONTH_MS);
  if (p) await expireStaleSpendReservations(userId);
  const [spentMicroUsd, reservedMicroUsd] = await Promise.all([
    spendSinceMicroUsd(userId, since),
    p ? openReservedMicroUsd(userId, p) : Promise.resolve(0),
  ]);
  // Lifecycle email: past 80% of the period budget, fire-and-forget the
  // budget-alert sender (it dedupes to ONE email per billing period and
  // honors settings.emailBudgetAlerts). The threshold test reuses numbers
  // already in scope, so requests far from the limit cost nothing extra.
  if (budgetMicroUsd > 0 && spentMicroUsd >= budgetMicroUsd * 0.8) {
    void sendBudgetAlert({ userId, spentMicroUsd, budgetMicroUsd, resetsAtMs: p?.endMs ?? null });
  }
  const committedAndHeld = spentMicroUsd + reservedMicroUsd;
  return {
    allowed: committedAndHeld < budgetMicroUsd,
    spentMicroUsd,
    budgetMicroUsd,
    remainingMicroUsd: Math.max(0, budgetMicroUsd - committedAndHeld),
    resetsAtMs: p?.endMs ?? null,
    reservedMicroUsd,
    capSource: eff.source,
    capDisabled: false,
  };
}

/**
 * Micro-USD held by reservations that are still open in this billing period.
 *
 * Stale reservations are reaped before this query. Keeping the query honest is
 * important: the admission UPDATE and the display value must describe the same
 * ledger. Previously the read ignored old rows while the conditional UPDATE
 * still counted them, so the UI promised room that every new run was refused.
 */
async function openReservedMicroUsd(userId: string, period: BillingPeriod): Promise<number> {
  const agg = await prisma.spendReservation.aggregate({
    where: {
      userId,
      state: "open",
      spendPeriod: { userId, period: spendPeriodKey(period) },
    },
    _sum: { estimateMicroUsd: true },
  });
  return Number(agg._sum.estimateMicroUsd ?? 0n);
}

// ---------------------------------------------------------------------------
// Reservations — closing the read-then-act window
// ---------------------------------------------------------------------------

/**
 * Materialise this period's SpendPeriod row, seeded from the ledger.
 *
 * The seed matters: ApiSpend has been the record of settled spend since long
 * before SpendPeriod existed, so a row created today with `committedMicroUsd`
 * at 0 would hand the account a fresh €15 it has already partly spent. The
 * aggregate runs once per period, on the first reservation.
 */
async function ensureSpendPeriod(userId: string, period: BillingPeriod): Promise<string> {
  const key = spendPeriodKey(period);
  const existing = await prisma.spendPeriod.findFirst({
    where: { userId, period: key },
    select: { id: true },
  });
  if (existing) return existing.id;

  const seeded = await spendSinceMicroUsd(userId, new Date(period.startMs));
  const row = await prisma.spendPeriod.upsert({
    where: { userId_period: { userId, period: key } },
    create: { userId, period: key, committedMicroUsd: BigInt(Math.max(0, seeded)) },
    // Empty on purpose: a concurrent caller that won the race has already
    // seeded it, and re-seeding would clobber whatever has settled since.
    update: {},
    select: { id: true },
  });
  return row.id;
}

export interface ReserveSpendInput {
  userId: string;
  kind: SpendKind;
  /**
   * What this unit of work is expected to cost. Omitted → the per-kind default
   * in spend-ceiling.ts.
   */
  estimateMicroUsd?: number;
  /**
   * Caller-supplied identity for the unit of work (generation id, run id,
   * session id). Unique per user, so a retry reuses its reservation rather than
   * opening a second one against the same turn.
   */
  ref: string;
  plan?: Plan;
  period?: BillingPeriod;
  budget?: EffectiveBudget;
}

export interface SpendReservationResult {
  allowed: boolean;
  reservationId: string | null;
  estimateMicroUsd: number;
  /** Room left after this hold; null when the cap is disabled. */
  remainingMicroUsd: number | null;
  budgetMicroUsd: number | null;
  capSource: BudgetCapSource;
  capDisabled: boolean;
  /** Set when refused, so the caller can say which ceiling stopped it. */
  refusedBy?: "period" | "unit";
}

/**
 * Hold money against the ceiling before the work starts.
 *
 * `checkBudget` on its own is read-then-act: it reads settled spend, and the
 * ledger is only written when a turn ENDS, so the window in which two turns can
 * both be admitted is the whole duration of every in-flight generation. This
 * closes it the way `reserveCodeMessage` closes the message-count equivalent —
 * ONE conditional UPDATE, with the predicate evaluated by the database, so two
 * concurrent callers cannot both observe the same under-ceiling total.
 *
 * The reservation row is written before the hold so that `ref`'s unique index
 * is what resolves a retry; a hold taken first would leak when the duplicate
 * insert failed.
 */
export async function reserveSpend(input: ReserveSpendInput): Promise<SpendReservationResult> {
  const estimate = Math.max(
    0,
    Math.round(input.estimateMicroUsd ?? DEFAULT_ESTIMATE_MICRO_USD[input.kind])
  );
  // A crashed request must not leave its hold in the conditional admission
  // counter forever. Work reservations belonging to queued/running/paused runs
  // are preserved by the reaper; terminal or orphaned reservations are safe to
  // release and can be retried under the same ref.
  await expireStaleSpendReservations(input.userId);
  // Resolved rather than defaulted: guessing FREE here would give a budget of
  // 0 and refuse every caller that did not happen to know the plan, which is
  // most of them — a gate that fails closed on its own ignorance is a gate that
  // gets deleted.
  const eff =
    input.budget ??
    (await resolveEffectiveBudget(input.userId, input.plan ?? (await getUserPlan(input.userId))));

  // The per-unit ceiling is a separate refusal from the monthly one: a research
  // run that fans out into searches, or a Work run that loops, can burn a whole
  // month's budget in an afternoon while every individual check passes.
  const unitCeiling = UNIT_CEILING_MICRO_USD[input.kind];
  if (!eff.capDisabled && unitCeiling != null && estimate > unitCeiling) {
    return {
      allowed: false,
      reservationId: null,
      estimateMicroUsd: estimate,
      remainingMicroUsd: 0,
      budgetMicroUsd: eff.budgetMicroUsd,
      capSource: eff.source,
      capDisabled: eff.capDisabled,
      refusedBy: "unit",
    };
  }

  const period = input.period ?? (await resolveBillingPeriod(input.userId));
  const periodId = await ensureSpendPeriod(input.userId, period);

  return prisma.$transaction(async (tx) => {
    // A retry of the same unit of work must not open a second hold. State is
    // ignored deliberately: once a turn has settled, re-reserving it would bill
    // the ceiling twice for one generation.
    const existing = await tx.spendReservation.findFirst({
      where: { userId: input.userId, ref: input.ref },
      select: { id: true, estimateMicroUsd: true },
    });
    if (existing) {
      const held = await tx.spendPeriod.findFirst({
        where: { id: periodId, userId: input.userId },
        select: { committedMicroUsd: true, reservedMicroUsd: true },
      });
      const spent = held ? Number(held.committedMicroUsd) + Number(held.reservedMicroUsd) : 0;
      return {
        allowed: true,
        reservationId: existing.id,
        estimateMicroUsd: Number(existing.estimateMicroUsd),
        // The room actually left, not the whole ceiling. A retry that was told
        // it had the full budget would hand that figure to the mid-stream
        // guard, and the guard would never fire.
        remainingMicroUsd:
          eff.budgetMicroUsd == null ? null : Math.max(0, eff.budgetMicroUsd - spent),
        budgetMicroUsd: eff.budgetMicroUsd,
        capSource: eff.source,
        capDisabled: eff.capDisabled,
      };
    }

    const held = await tx.$executeRaw(
      eff.budgetMicroUsd == null
        ? Prisma.sql`
            UPDATE "SpendPeriod"
               SET "reservedMicroUsd" = "reservedMicroUsd" + ${BigInt(estimate)},
                   "updatedAt" = now()
             WHERE "id" = ${periodId} AND "userId" = ${input.userId}`
        : Prisma.sql`
            UPDATE "SpendPeriod"
               SET "reservedMicroUsd" = "reservedMicroUsd" + ${BigInt(estimate)},
                   "updatedAt" = now()
             WHERE "id" = ${periodId} AND "userId" = ${input.userId}
               AND "committedMicroUsd" + "reservedMicroUsd" + ${BigInt(estimate)}
                   <= ${BigInt(eff.budgetMicroUsd)}`
    );

    const row = await tx.spendPeriod.findFirst({
      where: { id: periodId, userId: input.userId },
      select: { committedMicroUsd: true, reservedMicroUsd: true },
    });
    const total = row ? Number(row.committedMicroUsd) + Number(row.reservedMicroUsd) : 0;
    const remaining = eff.budgetMicroUsd == null ? null : Math.max(0, eff.budgetMicroUsd - total);

    if (held === 0) {
      return {
        allowed: false,
        reservationId: null,
        estimateMicroUsd: estimate,
        remainingMicroUsd: remaining,
        budgetMicroUsd: eff.budgetMicroUsd,
        capSource: eff.source,
        capDisabled: eff.capDisabled,
        refusedBy: "period" as const,
      };
    }

    const reservation = await tx.spendReservation.create({
      data: {
        userId: input.userId,
        periodId,
        kind: input.kind,
        estimateMicroUsd: BigInt(estimate),
        ref: input.ref,
      },
      select: { id: true },
    });
    return {
      allowed: true,
      reservationId: reservation.id,
      estimateMicroUsd: estimate,
      remainingMicroUsd: remaining,
      budgetMicroUsd: eff.budgetMicroUsd,
      capSource: eff.source,
      capDisabled: eff.capDisabled,
    };
  });
}

const ACTIVE_WORK_RUN_STATUSES = ["queued", "running", "paused"] as const;

/**
 * Close abandoned holds before an admission decision.
 *
 * The old TTL lived only in `openReservedMicroUsd`, which made the two views of
 * the ledger disagree: the read path forgot an old row, but the SQL hold still
 * saw its reserved amount. Releasing the row and decrementing the materialised
 * counter is the only safe fix. A paused Work run is intentionally retained—
 * pausing is a user decision and its reservation is the run's maximum-cost
 * promise until the user resumes or ends it.
 */
export async function expireStaleSpendReservations(
  userId: string,
  options: { now?: Date; retentionMs?: number; limit?: number } = {}
): Promise<number> {
  const cutoff = new Date((options.now ?? new Date()).getTime() - (options.retentionMs ?? 60 * 60 * 1000));
  const stale = await prisma.spendReservation.findMany({
    where: { userId, state: "open", createdAt: { lt: cutoff } },
    select: { ref: true, kind: true },
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(options.limit ?? 200, 1), 1_000),
  });
  if (stale.length === 0) return 0;

  const workRefs = stale.filter((row) => row.kind === "work").map((row) => row.ref);
  const liveWorkRefs = new Set(
    workRefs.length === 0
      ? []
      : (
          await prisma.workRun.findMany({
            where: {
              userId,
              spendReservationRef: { in: workRefs },
              status: { in: [...ACTIVE_WORK_RUN_STATUSES] },
            },
            select: { spendReservationRef: true },
          })
        )
          .map((row) => row.spendReservationRef)
          .filter((ref): ref is string => ref !== null)
  );

  let released = 0;
  for (const row of stale) {
    if (row.kind === "work" && liveWorkRefs.has(row.ref)) continue;
    if (await releaseSpend(userId, row.ref)) released += 1;
  }
  return released;
}

/**
 * Replace the estimate with the truth.
 *
 * The hold is released in full and the real figure is stamped on the
 * reservation; the money itself reached `committedMicroUsd` through
 * `recordSpend`, which is the single writer of settled spend. So the caller's
 * order is record-then-settle: settling first would briefly under-count the
 * account, and under-counting is the direction that lets a turn through.
 *
 * Conditional on `state = "open"`, so a double settle — a retried webhook, a
 * runner and a sweeper arriving together — cannot refund the hold twice.
 * Never throws: this is called from stream teardown.
 */
export async function settleSpend(
  userId: string,
  ref: string,
  actualMicroUsd: number
): Promise<boolean> {
  return closeReservation(userId, ref, "settled", Math.max(0, Math.round(actualMicroUsd)));
}

/** Abandoned work: drop the hold and commit nothing. */
export async function releaseSpend(userId: string, ref: string): Promise<boolean> {
  return closeReservation(userId, ref, "released", null);
}

async function closeReservation(
  userId: string,
  ref: string,
  state: "settled" | "released",
  actualMicroUsd: number | null
): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      const reservation = await tx.spendReservation.findFirst({
        where: { userId, ref, state: "open" },
        select: { id: true, periodId: true, estimateMicroUsd: true },
      });
      if (!reservation) return false;

      const closed = await tx.spendReservation.updateMany({
        where: { id: reservation.id, userId, state: "open" },
        data: {
          state,
          settledMicroUsd: actualMicroUsd == null ? null : BigInt(actualMicroUsd),
          settledAt: new Date(),
        },
      });
      if (closed.count !== 1) return false;

      // GREATEST(…, 0): a hold released twice must not manufacture headroom
      // that was never taken, and the column is unsigned only by convention.
      await tx.$executeRaw(Prisma.sql`
        UPDATE "SpendPeriod"
           SET "reservedMicroUsd" = GREATEST("reservedMicroUsd" - ${reservation.estimateMicroUsd}, 0),
               "updatedAt" = now()
         WHERE "id" = ${reservation.periodId} AND "userId" = ${userId}`);
      return true;
    });
  } catch (err) {
    console.error("[spend] failed to close reservation", {
      userId,
      ref,
      state,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Advance the period's settled total. Called from `recordSpend` only, and only
 * when an ApiSpend row was actually inserted — an idempotent retry that
 * collapsed into a no-op must not move the total.
 *
 * Its own try/catch: `recordSpend` is fire-and-forget by contract and this must
 * never be the thing that throws into a stream.
 */
async function commitToSpendPeriod(userId: string, costMicroUsd: number): Promise<void> {
  if (costMicroUsd <= 0) return;
  try {
    const period = await resolveBillingPeriod(userId);
    const periodId = await ensureSpendPeriod(userId, period);
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "SpendPeriod"
         SET "committedMicroUsd" = "committedMicroUsd" + ${BigInt(costMicroUsd)},
             "updatedAt" = now()
       WHERE "id" = ${periodId} AND "userId" = ${userId}`);
  } catch (err) {
    console.error("[spend] failed to advance the spend period", {
      userId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
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
 * reset on the subscriber's schedule. Takes the EFFECTIVE monthly ceiling
 * rather than the plan, so the windows tile the number actually enforced —
 * lowering the cap in settings has to move the meters with it, or the gauge
 * says "12% used" for an account that is out of budget.
 * A null ceiling (the cap disabled) means no metering.
 */
export async function getUsageWindows(
  userId: string,
  monthBudget: number | null,
  period: BillingPeriod | null,
  now = new Date()
): Promise<UsageWindows> {
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
