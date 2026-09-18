/**
 * The spend ceiling: which number binds, and what a reservation does to it.
 *
 * Three ceilings live here now — the monthly one, the per-unit one, and the
 * rolling 5-hour and weekly windows at the foot of the file. The windows are
 * the one that bounds a delegated run; see the section header down there for
 * why they stopped being meters.
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

import type { Plan } from "@prisma/client";

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

/**
 * Every surface that can spend money. Matches `SpendReservation.kind`.
 *
 * "utility" is the odd one out and deliberately so: it is not a surface the
 * user is looking at, it is the background walk in `runUtilityPrompt` — chat
 * titles, AI moderation, memory extraction and consolidation, follow-up pills,
 * the memory editor, the research citation judge. That spend reached no ledger
 * at all until it got this name, so it was invisible to both the monthly
 * ceiling and the usage page. Filing it under "chat" would have made it
 * visible and simultaneously unreadable: the ledger's request counts and
 * cost-per-turn for real conversations would have absorbed a title generation
 * that the account never asked for.
 */
export type SpendKind =
  | "chat"
  | "work"
  | "voice"
  | "research"
  | "code"
  | "task"
  | "image"
  | "video"
  | "utility";

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
  // Nothing reserves under this kind today: the utility walk is fire-and-check
  // background work that runs to completion and then bills, with no pre-spend
  // gate in front of it (see runUtilityPrompt). The figure is here because the
  // Record is exhaustive over SpendKind — and it is a real one, not a filler:
  // one small prompt on a free-tier model, so a caller that ever does reserve
  // holds something close to the truth rather than a chat turn's estimate.
  utility: 5_000, // $0.005
};

/**
 * Per-unit ceilings: the most one single unit of work may cost, independent of
 * how much room is left in the month.
 *
 * The monthly ceiling alone cannot stop one runaway run from consuming the
 * whole month in an afternoon, and a deep-research run that fans out into
 * searches is a realistic shape for exactly that, with no per-request human in
 * the loop.
 *
 * `work` used to be here too, at the figure a PRO run was dispatched under, so
 * that admission refused a run by the same number the executor's guard would
 * have stopped it at. Both numbers are gone: a Work run has no per-run ceiling
 * any more, only the account's rolling windows, and those are enforced at
 * dispatch and again while the run is going (`windowVerdict` above,
 * `checkUsageWindows` in spend.ts). Leaving a $2 entry here would refuse at the
 * door every run the windows had room for — which is the per-run ceiling back
 * again under a quieter name.
 */
export const UNIT_CEILING_MICRO_USD: Partial<Record<SpendKind, number>> = {
  research: 1_000_000, // $1 per deep-research run
};

/**
 * The per-unit ceiling that binds for this account, on this kind of work.
 *
 * A kind with no entry has no per-unit ceiling, and `work` is now one of them:
 * what bounds a run is the window, not a figure filed per plan. `plan` is kept
 * on the signature because a per-unit ceiling is a pricing decision and the
 * next kind to need one will need it plan-shaped; dropping the parameter would
 * make that a change at every call site rather than a change here.
 */
export function unitCeilingMicroUsd(kind: SpendKind, _plan: Plan): number | undefined {
  return UNIT_CEILING_MICRO_USD[kind];
}

/**
 * The ceiling for a run with no window behind it.
 *
 * `maxCostMicroUsd` of 0 means UNLIMITED to `budgetExceeded`, and scheduled and
 * trigger-fired runs defaulted to 0 while a manually started run defaulted to
 * $2 — so the runs with a human watching were capped and the ones firing at
 * 03:00 were not. Substituted at run creation rather than changed in
 * `budgetExceeded`, because 0-means-unlimited is the persisted contract that
 * `WorkRun.maxCostMicroUsd` and the client both already speak.
 *
 * ── What it means now that the per-run ceiling is gone ──────────────────────
 *
 * Every dispatcher writes the binding window's remainder into
 * `maxCostMicroUsd`, so a zero no longer reaches here from an ordinary run. The
 * one account that can still produce one is the account with
 * `Settings.spendCapDisabled`: no monthly ceiling means no period to slice, so
 * `getUsageWindows` returns a null budget and there is no window to enforce.
 *
 * That account gets this figure rather than nothing, and the decision is
 * explicit because the alternative is the hole `spend-ceiling.ts` was written
 * to close. `BUDGET_EUR.OWNER` being null once switched off both the pre-flight
 * gate and the mid-stream abort on the one account no billing system watches;
 * removing the per-run ceiling would reopen it from the other side — no per-run
 * cap AND no window — and a loop on that account would be billable without
 * limit for as long as it ran. Switching enforcement off is a decision to stop
 * METERING, not a decision to let one unattended process spend without bound,
 * and the surfaces say so rather than drawing a meter at 0%.
 */
export const UNATTENDED_RUN_DEFAULT_MICRO_USD = 1_000_000;

/** Applies the no-window backstop to a requested run ceiling of 0. */
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

// ---------------------------------------------------------------------------
// The rolling windows
// ---------------------------------------------------------------------------

/**
 * The two windows that now bound a run, and the arithmetic that decides which
 * one binds.
 *
 * Until this section existed the windows were meters. `getUsageWindows` derived
 * them, the usage page and the settings gauge drew them, and the only thing
 * that could actually refuse work was the MONTHLY figure in `checkBudget` — so
 * a single run was free to spend a whole month in an afternoon and the windows
 * would describe it afterwards. A limit the product states and the runtime does
 * not apply is the defect this codebase is written against, and it was sitting
 * in the one place a reader was most likely to trust.
 *
 * They are enforcing now because they are the ONLY thing bounding a run. The
 * per-run ceiling is gone (see `src/lib/work/budget.ts`); what is left is the
 * model the references use — you work until you are finished or until the
 * account's five-hour window is used up, and then you wait for it to free up.
 * That is a kinder limit than a per-run one, and a truer one: it is the
 * account's number rather than the task's, so a run is never cut short while
 * the account still has room to spend.
 *
 * The arithmetic is here rather than in `spend.ts` for the reason the rest of
 * this module is: every path to it went through Prisma, so none of it could be
 * tested. `spend.ts` reads the ledger and calls these.
 */

/** The rolling "current session" window — five hours, as the references use. */
export const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;

/** The rolling weekly window. */
export const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A reference month, used when a billing period is shorter than one.
 *
 * The windows are TIME-PROPORTIONAL slices of the period budget, so they tile
 * it exactly: the weekly budgets and the session budgets each sum to the whole
 * period cap. Dividing by a whole four weeks — a month is 4.29 of them — would
 * hand out more than the month holds.
 */
export const REFERENCE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export type UsageWindowName = "session" | "weekly";

/** Which grid cell a window is in right now, and what that cell is worth. */
export interface UsageWindowCell {
  /** Start of the cell that contains `now`; spend is counted from here. */
  startMs: number;
  /** When this cell rolls over and the window frees up. */
  resetsAtMs: number;
  /** This cell's time-proportional slice of the period budget. */
  budgetMicroUsd: number;
}

export interface UsageWindowGrid {
  session: UsageWindowCell;
  weekly: UsageWindowCell;
}

/**
 * Where the two rolling grids stand, from the billing period alone.
 *
 * Anchored to the subscription rather than to the clock, so a window resets on
 * the subscriber's own schedule and not at whatever hour they happened to open
 * the page. Pure, so the boundary arithmetic that decides when somebody is told
 * to come back is covered by a test rather than by a screenshot.
 */
export function usageWindowGrid(input: {
  anchorMs: number;
  periodStartMs: number;
  periodEndMs: number;
  monthBudgetMicroUsd: number;
  nowMs: number;
}): UsageWindowGrid {
  const periodMs = Math.max(input.periodEndMs - input.periodStartMs, REFERENCE_MONTH_MS);
  const elapsed = Math.max(0, input.nowMs - input.anchorMs);
  const cell = (span: number): UsageWindowCell => {
    const startMs = input.anchorMs + Math.floor(elapsed / span) * span;
    return {
      startMs,
      resetsAtMs: startMs + span,
      budgetMicroUsd: Math.round(input.monthBudgetMicroUsd * (span / periodMs)),
    };
  };
  return { session: cell(SESSION_WINDOW_MS), weekly: cell(WEEKLY_WINDOW_MS) };
}

/** One window as the ledger reports it. A null budget means nothing is metered. */
export interface WindowSpend {
  spentMicroUsd: number;
  budgetMicroUsd: number | null;
  resetsAtMs: number;
}

export interface WindowVerdict {
  /** False when either window is spent. */
  allowed: boolean;
  /**
   * Which window binds — the one with the least room, spent or not.
   *
   * Named rather than flattened into a boolean because a reader told the wrong
   * one waits five hours for a weekly limit, or gives up on a task that would
   * have been startable after lunch. Null only when there is no window at all.
   */
  bound: UsageWindowName | null;
  /** Room left in the binding window; null when there is no window. */
  remainingMicroUsd: number | null;
  /** When the binding window frees up; null when there is no window. */
  resetsAtMs: number | null;
}

/**
 * Which window binds, given what each has spent and what is held against them.
 *
 * `heldMicroUsd` is open reservations plus any spend the caller knows about
 * that has not reached the ledger yet. It must be subtracted, or two runs
 * admitted together would each be told they had the whole remainder — the same
 * read-then-act window `reserveSpend` closes for the month, and it is wider
 * here because a window is a smaller number than a month.
 *
 * The tie-break is the session window, and it is the kind answer rather than an
 * arbitrary one: when both windows have the same room left, the session window
 * is the one that frees up first, so naming it tells the reader the shorter
 * wait, which is also the true one.
 */
export function windowVerdict(input: {
  session: WindowSpend;
  weekly: WindowSpend;
  heldMicroUsd?: number;
}): WindowVerdict {
  const held = Math.max(0, Math.round(input.heldMicroUsd ?? 0));
  const candidates: Array<{ name: UsageWindowName; remaining: number; resetsAtMs: number }> = [];
  for (const [name, window] of [
    ["session", input.session],
    ["weekly", input.weekly],
  ] as const) {
    if (window.budgetMicroUsd == null) continue;
    candidates.push({
      name,
      remaining: window.budgetMicroUsd - window.spentMicroUsd - held,
      resetsAtMs: window.resetsAtMs,
    });
  }
  if (candidates.length === 0) {
    return { allowed: true, bound: null, remainingMicroUsd: null, resetsAtMs: null };
  }
  // Strictly less, so an equal pair leaves the session window in front.
  const binding = candidates.reduce((tightest, next) =>
    next.remaining < tightest.remaining ? next : tightest
  );
  return {
    allowed: binding.remaining > 0,
    bound: binding.name,
    remainingMicroUsd: Math.max(0, binding.remaining),
    resetsAtMs: binding.resetsAtMs,
  };
}

/** The binding window in the reader's words, as the tail of a sentence. */
export function describeWindow(bound: UsageWindowName): string {
  return bound === "session" ? "5-hour limit" : "weekly limit";
}

/**
 * The sentence a refusal carries.
 *
 * It names the window and when it frees up, because "you are out of budget" and
 * "you are out of budget until 14:00" send a reader to two different places —
 * the first to the pricing page, the second to lunch. A window is a wait rather
 * than a purchase, and saying so is the whole difference between this limit and
 * the monthly one it sits inside.
 */
export function windowLimitMessage(bound: UsageWindowName, resetsAtMs: number | null): string {
  const window = bound === "session" ? "5-hour usage limit" : "weekly usage limit";
  if (resetsAtMs == null) return `You've used up your ${window}.`;
  const when = new Date(resetsAtMs).toLocaleString("en-US", {
    ...(bound === "weekly" ? { weekday: "long" as const } : {}),
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `You've used up your ${window}. It frees up at ${when} UTC.`;
}
