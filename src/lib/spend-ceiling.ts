/**
 * The spend ceiling: which number binds, and what a reservation does to it.
 *
 * Split out of `spend.ts` and free of `server-only` and of any I/O for the same
 * reason `chat-budget-guard.ts` is: this is money arithmetic, it decides whether
 * a generation is allowed to start, and until now none of it was covered by a
 * test because every path to it went through Prisma.
 *
 * The failure this exists to close: `BUDGET_EUR.OWNER` was null, so
 * `budgetForPlan` returned null, so `checkBudget` returned `allowed: true`
 * without reading the database — and `createStreamBudgetGuard` no-ops on a null
 * ceiling, so the personal account had neither a pre-flight gate nor a
 * mid-stream abort. One runaway tool loop on the owner's account was billable
 * without limit. Giving the owner a real, finite ceiling turns both back on.
 */

/**
 * The personal account's monthly ceiling in EUR when nothing else says
 * otherwise. Not "unlimited": an account with no plan budget is the one that
 * most needs a number, because it is the one no billing system is watching.
 */
export const PERSONAL_DEFAULT_CAP_EUR = 15;

/** Which number ended up binding — surfaced verbatim so the UI can say who set it. */
export type BudgetCapSource = "plan" | "user" | "personal-default" | "disabled";

export interface EffectiveBudget {
  /**
   * The binding ceiling in micro-USD. null ONLY when the cap is explicitly
   * disabled — never again as a stand-in for "this plan has no figure".
   */
  budgetMicroUsd: number | null;
  source: BudgetCapSource;
  /** True when `Settings.spendCapDisabled` is on. Every surface must say so. */
  capDisabled: boolean;
}

export interface EffectiveBudgetInput {
  /** `budgetForPlan(plan)` — null for a plan with no figure of its own. */
  planBudgetMicroUsd: number | null;
  /** `Settings.monthlySpendCapEur` — the account's own ceiling. */
  userCapEur: number | null;
  /** `Settings.spendCapDisabled` — the only bypass there is. */
  capDisabled: boolean;
  /** How many EUR one USD of model spend costs; defaults to 1 (EUR ≙ USD). */
  eurPerUsd?: number;
}

/** EUR → micro-USD at the billing rate, the same conversion `budgetForPlan` uses. */
export function eurToMicroUsd(eur: number, eurPerUsd = 1): number {
  const rate = Number.isFinite(eurPerUsd) && eurPerUsd > 0 ? eurPerUsd : 1;
  return Math.max(0, Math.round((eur / rate) * 1_000_000));
}

/**
 * The ceiling that actually applies: the MINIMUM of the plan's figure and the
 * account's own, with a plan that has no figure falling back to
 * PERSONAL_DEFAULT_CAP_EUR.
 *
 * MIN and not MAX, deliberately: lowering the number in settings must always
 * work, and raising it must never buy more than the plan already paid for. A
 * FREE plan's 0 therefore stays 0 no matter what the account writes.
 *
 * `spendCapDisabled` is the single bypass and it is checked first, so emptying
 * the number field can never switch enforcement off by accident — the two
 * controls are separate on purpose.
 */
export function effectiveBudget(input: EffectiveBudgetInput): EffectiveBudget {
  if (input.capDisabled) {
    return { budgetMicroUsd: null, source: "disabled", capDisabled: true };
  }

  const userCapMicroUsd =
    input.userCapEur != null && Number.isFinite(input.userCapEur)
      ? eurToMicroUsd(input.userCapEur, input.eurPerUsd)
      : null;

  if (input.planBudgetMicroUsd == null) {
    // No plan figure — the personal account. The user's own number binds, and
    // in its absence the default does. This is the branch that used to return
    // "unlimited".
    if (userCapMicroUsd != null) {
      return { budgetMicroUsd: userCapMicroUsd, source: "user", capDisabled: false };
    }
    return {
      budgetMicroUsd: eurToMicroUsd(PERSONAL_DEFAULT_CAP_EUR, input.eurPerUsd),
      source: "personal-default",
      capDisabled: false,
    };
  }

  if (userCapMicroUsd == null || userCapMicroUsd >= input.planBudgetMicroUsd) {
    return { budgetMicroUsd: input.planBudgetMicroUsd, source: "plan", capDisabled: false };
  }
  return { budgetMicroUsd: userCapMicroUsd, source: "user", capDisabled: false };
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

/** Every surface that can spend money. Matches `SpendReservation.kind`. */
export type SpendKind = "chat" | "work" | "voice" | "research" | "code" | "task" | "image" | "video";

/**
 * What a unit of work is assumed to cost before it has run.
 *
 * Held against the ceiling for the whole duration of the generation, which is
 * the window `checkBudget` alone could not close: it is read-then-act, and the
 * ledger is only written when a turn ENDS, so any number of concurrent turns
 * could each read the same under-budget total and all be admitted.
 *
 * Deliberately modest. An estimate that is too high refuses work the user could
 * have afforded; one that is too low is corrected the moment the real figure
 * lands, and the mid-stream guard is the backstop in between.
 */
export const DEFAULT_ESTIMATE_MICRO_USD: Record<SpendKind, number> = {
  chat: 50_000, // $0.05 — a long tool-using turn on a frontier model
  work: 250_000,
  voice: 100_000,
  research: 300_000, // planner + search fees before synthesis even starts
  code: 50_000,
  task: 50_000,
  image: 40_000,
  video: 500_000,
};

/**
 * Per-unit ceilings: the most one single unit of work may cost, independent of
 * how much room is left in the month.
 *
 * The monthly ceiling alone cannot stop one runaway run from consuming the
 * whole month in an afternoon, and the two surfaces where that is a realistic
 * shape — a research run that fans out into searches, and a Work run that loops
 * — are exactly the two with no per-request human in the loop.
 */
export const UNIT_CEILING_MICRO_USD: Partial<Record<SpendKind, number>> = {
  research: 1_000_000, // $1 per deep-research run
  work: 2_000_000, // $2, the same figure a manually started Work run gets
};

/**
 * The ceiling for a Work run nobody is watching.
 *
 * `maxCostMicroUsd` of 0 means UNLIMITED to `budgetExceeded`, and scheduled and
 * trigger-fired runs defaulted to 0 while a manually started run defaulted to
 * $2 — so the runs with a human watching were capped and the ones firing at
 * 03:00 were not. Substituted at run creation rather than changed in
 * `budgetExceeded`, because 0-means-unlimited is the persisted contract that
 * `WorkRun.maxCostMicroUsd` and the client both already speak.
 */
export const UNATTENDED_RUN_DEFAULT_MICRO_USD = 1_000_000;

/** Applies the unattended default to a requested run ceiling of 0. */
export function unattendedRunCeiling(requestedMicroUsd: number): number {
  if (!Number.isFinite(requestedMicroUsd) || requestedMicroUsd <= 0) {
    return UNATTENDED_RUN_DEFAULT_MICRO_USD;
  }
  return Math.floor(requestedMicroUsd);
}

/** A spend period's two running totals, in micro-USD. */
export interface SpendLedger {
  /** Settled cost of finished work. */
  committedMicroUsd: number;
  /** Estimated cost of work still in flight. */
  reservedMicroUsd: number;
}

/**
 * The admission rule, written once so the SQL and the tests cannot drift.
 *
 * Returns the ledger AFTER the hold, or null when the hold would breach the
 * ceiling. `committed + reserved + estimate` is the total the account is on the
 * hook for, so an in-flight generation counts against a second one starting —
 * that, and not the read, is what makes two concurrent turns unable to both
 * pass. A null ceiling (the cap disabled) admits everything.
 *
 * The real implementation performs this as ONE conditional SQL UPDATE, exactly
 * as `reserveCodeMessage` does for message counts: a read followed by a write
 * would let both callers observe the same under-ceiling total.
 */
export function applyHold(
  ledger: SpendLedger,
  estimateMicroUsd: number,
  ceilingMicroUsd: number | null
): SpendLedger | null {
  const estimate = Math.max(0, Math.round(estimateMicroUsd));
  if (ceilingMicroUsd == null) {
    return { ...ledger, reservedMicroUsd: ledger.reservedMicroUsd + estimate };
  }
  if (ledger.committedMicroUsd + ledger.reservedMicroUsd + estimate > ceilingMicroUsd) return null;
  return { ...ledger, reservedMicroUsd: ledger.reservedMicroUsd + estimate };
}

/**
 * Settling replaces the estimate with the truth.
 *
 * The hold is released in full; the real figure reached `committedMicroUsd`
 * through `recordSpend`, which is the one writer of settled money and the one
 * that also appends the ApiSpend row. So an over-estimate is refunded rather
 * than kept — the difference is returned for the caller to log, not re-applied.
 *
 * Floored at zero because a reservation released twice must not manufacture
 * headroom that was never held.
 */
export function applySettle(
  ledger: SpendLedger,
  estimateMicroUsd: number,
  actualMicroUsd: number
): { ledger: SpendLedger; refundMicroUsd: number } {
  const estimate = Math.max(0, Math.round(estimateMicroUsd));
  const actual = Math.max(0, Math.round(actualMicroUsd));
  return {
    ledger: {
      committedMicroUsd: ledger.committedMicroUsd,
      reservedMicroUsd: Math.max(0, ledger.reservedMicroUsd - estimate),
    },
    refundMicroUsd: Math.max(0, estimate - actual),
  };
}

/** Abandoned work: drop the hold, commit nothing. */
export function applyRelease(ledger: SpendLedger, estimateMicroUsd: number): SpendLedger {
  return applySettle(ledger, estimateMicroUsd, estimateMicroUsd).ledger;
}

/**
 * How long an unsettled hold counts against the ceiling.
 *
 * A stream that dies without settling would otherwise pin its estimate against
 * the account for ever, and the user's only symptom would be a budget that
 * never recovers. Longer than any generation Juno will run, short enough that a
 * crashed worker costs an hour of headroom rather than a month.
 */
export const RESERVATION_TTL_MS = 60 * 60 * 1000;

/** Human-readable attribution for the effective ceiling, for the settings tile. */
export function describeCapSource(source: BudgetCapSource): string {
  switch (source) {
    case "user":
      return "Set by you";
    case "plan":
      return "Set by your plan";
    case "personal-default":
      return "Juno's default for accounts without a plan budget";
    case "disabled":
      return "Enforcement is switched off";
  }
}
