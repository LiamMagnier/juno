/**
 * Usage credits: top-up packs, referral rewards, and how they stack on a plan.
 *
 * Pure arithmetic, free of Prisma and of `server-only`, for the reason
 * spend-ceiling.ts is: this decides how much a customer may spend, and it is
 * only trustworthy if a test can reach it. The I/O around it (the UsageCredit
 * ledger, the per-period draw) lives in src/lib/billing/credit-ledger.ts.
 *
 * THE MODEL
 *
 *   A credit is extra model budget in micro-USD with an expiry. It extends the
 *   MONTHLY ceiling only: the 5-hour and weekly windows stay proportional to the
 *   plan's own budget, so a top-up buys more month, not a bigger burst.
 *
 *   Spend is drawn from credits only once the plan budget for the period is
 *   used. The period row records how much it has drawn (`creditDrawnMicroUsd`),
 *   so the ceiling for the period is
 *
 *       plan budget + drawn this period + still-available credit
 *
 *   and a credit drawn in March stays spent in April, while the plan budget
 *   renews. Credits are drawn soonest-expiring first.
 */

import type { Plan } from "@prisma/client";

// ---------------------------------------------------------------------------
// Top-up packs
// ---------------------------------------------------------------------------

/** Share of a pack's HT price that becomes model budget, the same 55% the plans use. */
export const CREDIT_SHARE_OF_HT = 0.55;

/** A credit is valid this many months from the day it is granted. */
export const CREDIT_VALIDITY_MONTHS = 12;

export type TopUpPackId = "5" | "20";

export interface TopUpPack {
  id: TopUpPackId;
  /** Price before VAT, EUR. Stripe Tax adds the buyer's VAT at checkout. */
  htEur: number;
  /** Model budget it credits, EUR: HT × CREDIT_SHARE_OF_HT. */
  creditEur: number;
}

function pack(id: TopUpPackId, htEur: number): TopUpPack {
  return { id, htEur, creditEur: Math.round(htEur * CREDIT_SHARE_OF_HT * 100) / 100 };
}

export const TOP_UP_PACKS: Record<TopUpPackId, TopUpPack> = {
  "5": pack("5", 5),
  "20": pack("20", 20),
};

export const TOP_UP_PACK_LIST: TopUpPack[] = [TOP_UP_PACKS["5"], TOP_UP_PACKS["20"]];

export function isTopUpPackId(value: unknown): value is TopUpPackId {
  return value === "5" || value === "20";
}

/** Only paid plans may buy a top-up; Free upgrades instead. */
export function canBuyTopUp(plan: Plan): boolean {
  return plan !== "FREE" && plan !== "OWNER";
}

/** EUR → integer micro-USD at the billing rate (EUR per USD), never negative. */
export function creditEurToMicroUsd(eur: number, eurPerUsd = 1): number {
  const rate = Number.isFinite(eurPerUsd) && eurPerUsd > 0 ? eurPerUsd : 1;
  return Math.max(0, Math.round((eur / rate) * 1_000_000));
}

/** Calendar-month add with the day clamped (Jan 31 + 1 → Feb 28/29). UTC. */
export function addMonthsUtc(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export function creditExpiry(grantedAt: Date): Date {
  return addMonthsUtc(grantedAt, CREDIT_VALIDITY_MONTHS);
}

// ---------------------------------------------------------------------------
// Ledger arithmetic
// ---------------------------------------------------------------------------

export interface CreditLot {
  id: string;
  remainingMicroUsd: number;
  expiresAtMs: number;
}

/** Credit still spendable at `nowMs`: unexpired lots with something left. */
export function availableCreditMicroUsd(lots: readonly CreditLot[], nowMs: number): number {
  let total = 0;
  for (const lot of lots) {
    if (lot.expiresAtMs > nowMs && lot.remainingMicroUsd > 0) total += lot.remainingMicroUsd;
  }
  return total;
}

/**
 * How much the period still has to draw from credits.
 *
 * `committed` is the period's settled spend, `planBudget` the plan's own
 * figure, `drawn` what the period has already taken from credits. Spend up to
 * the plan budget is the plan's; everything above it is the credits', and only
 * the part not yet drawn is owed now. Never negative: a refund-shaped dip in
 * the committed total does not hand credit back.
 */
export function creditShortfall(input: {
  committedMicroUsd: number;
  planBudgetMicroUsd: number;
  drawnMicroUsd: number;
}): number {
  const overage = Math.max(0, input.committedMicroUsd - Math.max(0, input.planBudgetMicroUsd));
  return Math.max(0, Math.round(overage - Math.max(0, input.drawnMicroUsd)));
}

export interface CreditDraw {
  id: string;
  amountMicroUsd: number;
}

/**
 * Which lots pay `needMicroUsd`, soonest-expiring first (ties by id, so the
 * plan is deterministic). Expired and empty lots are skipped. `drawn` can be
 * less than `need` when the credit runs out; the ceiling then refuses the next
 * request, which is the point.
 */
export function planCreditDraws(
  lots: readonly CreditLot[],
  needMicroUsd: number,
  nowMs: number
): { draws: CreditDraw[]; drawnMicroUsd: number } {
  let need = Math.max(0, Math.round(needMicroUsd));
  const draws: CreditDraw[] = [];
  if (need === 0) return { draws, drawnMicroUsd: 0 };
  const usable = lots
    .filter((l) => l.expiresAtMs > nowMs && l.remainingMicroUsd > 0)
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let drawn = 0;
  for (const lot of usable) {
    if (need === 0) break;
    const take = Math.min(lot.remainingMicroUsd, need);
    draws.push({ id: lot.id, amountMicroUsd: take });
    need -= take;
    drawn += take;
  }
  return { draws, drawnMicroUsd: drawn };
}

/**
 * The credit part of this period's monthly ceiling: what the period has
 * already drawn plus what is still available. Added on top of the plan budget
 * by `effectiveBudget` (spend-ceiling.ts).
 */
export function periodCreditCeilingMicroUsd(input: {
  drawnMicroUsd: number;
  availableMicroUsd: number;
}): number {
  return Math.max(0, Math.round(input.drawnMicroUsd)) + Math.max(0, Math.round(input.availableMicroUsd));
}

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

/** What each side of a rewarded referral receives, EUR of model budget. */
export const REFERRAL_CREDIT_EUR = 2;

/** A referrer is rewarded for at most this many referred accounts. */
export const REFERRAL_MAX_REWARDS = 20;

/** Cookie the /r/<code> link sets, read at sign-up. */
export const REFERRAL_COOKIE = "alevr_ref";

/** 30 days: long enough to sign up next week, short enough not to linger. */
export const REFERRAL_COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;

/** No 0/O/1/I/L: a code is read aloud and typed from a phone screen. */
const REFERRAL_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const REFERRAL_CODE_LENGTH = 8;

/** A fresh code from `randomBytes` (any source of uniform bytes). */
export function generateReferralCode(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(REFERRAL_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    out += REFERRAL_ALPHABET[bytes[i]! % REFERRAL_ALPHABET.length];
  }
  return out;
}

/** Canonical form of a typed or linked code, or null when it cannot be one. */
export function normalizeReferralCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  if (code.length !== REFERRAL_CODE_LENGTH) return null;
  for (const ch of code) if (!REFERRAL_ALPHABET.includes(ch)) return null;
  return code;
}

/**
 * The address a person actually receives mail at, for the self-referral test:
 * lowercased, `+tag` dropped, and Gmail's ignored dots removed. Two accounts
 * that normalise to the same mailbox are one person.
 */
export function canonicalMailbox(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at < 0) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

export type ReferralVerdict =
  | { reward: true }
  | { reward: false; reason: "already_rewarded" | "self_referral" | "referrer_cap" | "not_paid" };

/**
 * Whether a referred account's payment earns both sides their credit.
 *
 * Checked at the moment of the first successful paid subscription payment.
 * Self-referral is the same mailbox or the same Stripe customer; the cap is
 * on the referrer's rewarded count, so a referrer who hits it still sees the
 * pending row but earns nothing more.
 */
export function referralVerdict(input: {
  alreadyRewarded: boolean;
  referrerEmail: string;
  referredEmail: string;
  referrerCustomerId: string | null;
  referredCustomerId: string | null;
  referrerRewardedCount: number;
  amountPaidCents: number;
}): ReferralVerdict {
  if (input.alreadyRewarded) return { reward: false, reason: "already_rewarded" };
  if (!(input.amountPaidCents > 0)) return { reward: false, reason: "not_paid" };
  if (canonicalMailbox(input.referrerEmail) === canonicalMailbox(input.referredEmail)) {
    return { reward: false, reason: "self_referral" };
  }
  if (
    input.referrerCustomerId &&
    input.referredCustomerId &&
    input.referrerCustomerId === input.referredCustomerId
  ) {
    return { reward: false, reason: "self_referral" };
  }
  if (input.referrerRewardedCount >= REFERRAL_MAX_REWARDS) return { reward: false, reason: "referrer_cap" };
  return { reward: true };
}

// ---------------------------------------------------------------------------
// The fair fallback when the month runs low or out
// ---------------------------------------------------------------------------

/** Below this share of the monthly ceiling left, Auto prefers cost-1 models. */
export const LOW_BUDGET_SHARE = 0.1;

/**
 * True when the month is nearly spent. Auto then routes to the cheapest
 * models so what is left lasts, rather than one frontier turn ending it.
 * A null budget (the cap disabled) is never low.
 */
export function isBudgetLow(remainingMicroUsd: number | null, budgetMicroUsd: number | null): boolean {
  if (remainingMicroUsd == null || budgetMicroUsd == null || budgetMicroUsd <= 0) return false;
  return remainingMicroUsd < budgetMicroUsd * LOW_BUDGET_SHARE;
}

export interface BudgetFallback {
  options: Array<"topup" | "upgrade">;
  topUpPacks: Array<{ id: TopUpPackId; htEur: number; creditEur: number }>;
  cheapestUpgrade: Plan | null;
}

/**
 * What a client may offer when the monthly budget is spent: a top-up (paid
 * plans only, and only packs this deployment sells) and/or the next tier up
 * that this deployment sells. `planOrder` is PLAN_LIST's ids, cheapest first;
 * `sellable` says which of them have a Stripe price.
 */
export function budgetFallback(input: {
  plan: Plan;
  planOrder: readonly Plan[];
  sellable: (plan: Plan) => boolean;
  sellableTopUps: readonly TopUpPackId[];
}): BudgetFallback {
  const topUpPacks = canBuyTopUp(input.plan)
    ? TOP_UP_PACK_LIST.filter((p) => input.sellableTopUps.includes(p.id)).map((p) => ({
        id: p.id,
        htEur: p.htEur,
        creditEur: p.creditEur,
      }))
    : [];
  const at = input.planOrder.indexOf(input.plan);
  const cheapestUpgrade =
    input.plan === "OWNER" || at < 0
      ? null
      : (input.planOrder.slice(at + 1).find((p) => p !== "OWNER" && input.sellable(p)) ?? null);
  const options: BudgetFallback["options"] = [];
  if (topUpPacks.length > 0) options.push("topup");
  if (cheapestUpgrade) options.push("upgrade");
  return { options, topUpPacks, cheapestUpgrade };
}

// ---------------------------------------------------------------------------
// Renewal reminders (Code de la consommation L215-1, loi Chatel)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * L215-1: the professional informs the consumer "au plus tôt trois mois et au
 * plus tard un mois" before the end of the period that renews tacitly. The
 * window here sits inside that with a margin at each end, so a clock skew or
 * a late delivery cannot push the mail outside it.
 */
export const RENEWAL_REMINDER_EARLIEST_MS = 88 * DAY_MS;
export const RENEWAL_REMINDER_LATEST_MS = 32 * DAY_MS;

/** True when a renewal at `renewsAtMs` is due its reminder at `nowMs`. */
export function renewalReminderDue(renewsAtMs: number, nowMs: number): boolean {
  const lead = renewsAtMs - nowMs;
  return lead <= RENEWAL_REMINDER_EARLIEST_MS && lead >= RENEWAL_REMINDER_LATEST_MS;
}
