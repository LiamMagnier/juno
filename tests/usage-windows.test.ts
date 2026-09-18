import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_ESTIMATE_MICRO_USD,
  REFERENCE_MONTH_MS,
  SESSION_BURST_SHARE_OF_WEEK,
  SESSION_WINDOW_MS,
  WEEKLY_WINDOW_MS,
  WINDOW_GATE_FLOOR_MICRO_USD,
  bindingWindow,
  describeWindow,
  usageWindowGrid,
  windowLimitMessage,
  windowVerdict,
} from "@/lib/spend-ceiling";
import { runBudgetForWindow } from "@/lib/work/budget";
import { runLimitFrom } from "@/components/work/clarify/run-disclosure";

/*
 * The windows, now that they refuse work rather than describe it.
 *
 * `getUsageWindows` has derived a rolling 5-hour and a rolling weekly window
 * since long before this file existed, and for all that time its only two
 * callers were the usage page and the settings gauge. They were METERS. The
 * one figure that could actually stop anything was the MONTHLY total in
 * `checkBudget`, so a single delegated run was free to spend a whole month in
 * an afternoon and the windows would faithfully describe it afterwards.
 *
 * They are the gate now, because the per-run ceiling is gone: a run goes until
 * the work is done or until the account's window is used up. That makes this
 * arithmetic the thing that decides when somebody is told to come back, and
 * these cases are what stop it being wrong in the direction that matters.
 */

const HOUR = 60 * 60 * 1000;
/** A month's worth of budget, in micro-USD: €15 at parity. */
const MONTH_BUDGET = 15_000_000;

const PERIOD = {
  anchorMs: Date.UTC(2026, 0, 1, 0, 0, 0),
  periodStartMs: Date.UTC(2026, 8, 1, 0, 0, 0),
  periodEndMs: Date.UTC(2026, 9, 1, 0, 0, 0),
  monthBudgetMicroUsd: MONTH_BUDGET,
};

test("the PACE slices tile the period budget exactly, because they are a meter", () => {
  // The only split that stays honest to the €15 ceiling. Dividing by a whole
  // four weeks — a month is 4.29 of them — would hand out more than the month
  // holds, and a window at 100% would then mean something other than "on pace
  // to spend precisely the period budget". This is the denominator of the
  // gauge, and of nothing else.
  const grid = usageWindowGrid({ ...PERIOD, nowMs: PERIOD.periodStartMs + 3 * HOUR });
  const periodMs = Math.max(PERIOD.periodEndMs - PERIOD.periodStartMs, REFERENCE_MONTH_MS);
  assert.equal(
    grid.session.paceBudgetMicroUsd,
    Math.round(MONTH_BUDGET * (SESSION_WINDOW_MS / periodMs))
  );
  assert.equal(
    grid.weekly.paceBudgetMicroUsd,
    Math.round(MONTH_BUDGET * (WEEKLY_WINDOW_MS / periodMs))
  );
  // Each grid's cells sum to the period budget to within their rounding.
  const sessions = periodMs / SESSION_WINDOW_MS;
  assert.ok(Math.abs(grid.session.paceBudgetMicroUsd * sessions - MONTH_BUDGET) < sessions);
});

test("what a window REFUSES at is a burst allowance, not the pace slice", () => {
  /*
   * The finding this case exists for. The windows became a gate while keeping
   * the meter's arithmetic verbatim, and month ÷ 144 as a hard gate is a far
   * TIGHTER per-run ceiling than the plan-shaped table it replaced: a PRO run
   * would have been dispatched at $0.076 where the table gave it $2, under a
   * composer that had just told the reader the run goes until the work is done.
   * A gate has to be a figure one sitting can actually spend.
   */
  const grid = usageWindowGrid({ ...PERIOD, nowMs: PERIOD.periodStartMs + 3 * HOUR });
  // The weekly cell is the real rolling cap: a true seven-day share of the
  // month, which is the figure the rest of the package is written around.
  assert.equal(grid.weekly.budgetMicroUsd, grid.weekly.paceBudgetMicroUsd);
  // And the session cell is a share of THAT, never of the month ÷ 144, with the
  // floor under it for an account whose share would be too small to admit a run
  // and the week's own figure over it.
  assert.equal(
    grid.session.budgetMicroUsd,
    Math.min(
      grid.weekly.budgetMicroUsd,
      Math.max(
        Math.round(grid.weekly.budgetMicroUsd * SESSION_BURST_SHARE_OF_WEEK),
        WINDOW_GATE_FLOOR_MICRO_USD
      )
    )
  );
  assert.ok(
    grid.session.budgetMicroUsd >= grid.session.paceBudgetMicroUsd * 10,
    "the gate collapsed back onto the pace slice"
  );
  // Never looser than the weekly cell, or the five-hour window could not bind
  // at all while every surface went on naming it.
  assert.ok(grid.session.budgetMicroUsd <= grid.weekly.budgetMicroUsd);
});

test("one admitted run cannot take the whole window as a hold", () => {
  /*
   * The consequence that made the pace-slice gate more than a paper problem.
   * `checkUsageWindows` subtracts open reservations and `createRun` holds
   * DEFAULT_ESTIMATE_MICRO_USD.work for the life of a run — which is LARGER
   * than a pace-sliced 5-hour window on every plan. So for as long as one Work
   * run was in flight, every chat turn on the account was refused with "you've
   * used up your 5-hour usage limit" and no second run could be dispatched.
   */
  assert.ok(WINDOW_GATE_FLOOR_MICRO_USD >= 10 * DEFAULT_ESTIMATE_MICRO_USD.work);
  for (const monthBudget of [11_000_000, 55_000_000, 110_000_000]) {
    const grid = usageWindowGrid({
      ...PERIOD,
      monthBudgetMicroUsd: monthBudget,
      nowMs: PERIOD.periodStartMs + 3 * HOUR,
    });
    const held = DEFAULT_ESTIMATE_MICRO_USD.work;
    const verdict = windowVerdict({
      session: { ...grid.session, spentMicroUsd: 0, heldMicroUsd: held },
      weekly: { ...grid.weekly, spentMicroUsd: 0, heldMicroUsd: held },
    });
    assert.equal(verdict.allowed, true, String(monthBudget));
    // And a chat turn beside it still passes, which is the symptom a reader met.
    assert.ok(verdict.remainingMicroUsd! > DEFAULT_ESTIMATE_MICRO_USD.chat, String(monthBudget));
  }
});

test("a PRO Work run is dispatched with a ceiling larger than a realistic run", () => {
  // The old per-run table gave PRO $2, and that figure is the honest benchmark
  // for "a ceiling a real task does not hit": whatever replaces it must not be
  // tighter than the thing it was argued to be kinder than.
  const OLD_PRO_RUN_CEILING = 2_000_000;
  const grid = usageWindowGrid({
    ...PERIOD,
    monthBudgetMicroUsd: 11_000_000, // PRO: €11 a month.
    nowMs: PERIOD.periodStartMs + 3 * HOUR,
  });
  const verdict = windowVerdict({
    session: { ...grid.session, spentMicroUsd: 0 },
    weekly: { ...grid.weekly, spentMicroUsd: 0 },
  });
  assert.equal(verdict.bound, "session");
  assert.ok(
    runBudgetForWindow(verdict.remainingMicroUsd).maxCostMicroUsd > OLD_PRO_RUN_CEILING,
    "a PRO run is bounded tighter than the ceiling this package removed"
  );
});

test("a period budget smaller than the floor is not handed a window it can never reach", () => {
  // FREE is €0.15 a month — a trial whose real limit is the message counter and
  // the month itself. A floor of ten Work holds would be sixteen times its
  // whole month, so the window would name a limit that could never bind while
  // `checkBudget` did the actual refusing.
  const grid = usageWindowGrid({
    ...PERIOD,
    monthBudgetMicroUsd: 150_000,
    nowMs: PERIOD.periodStartMs + 3 * HOUR,
  });
  assert.equal(grid.session.budgetMicroUsd, 150_000);
  assert.equal(grid.weekly.budgetMicroUsd, 150_000);
});

test("a cell contains now, and frees up one span later", () => {
  const nowMs = PERIOD.anchorMs + 12 * HOUR + 37 * 60_000;
  const grid = usageWindowGrid({ ...PERIOD, nowMs });
  for (const cell of [grid.session, grid.weekly]) {
    assert.ok(cell.startMs <= nowMs, "the cell starts after now");
    assert.ok(cell.resetsAtMs > nowMs, "the cell has already reset");
  }
  assert.equal(grid.session.resetsAtMs - grid.session.startMs, SESSION_WINDOW_MS);
  assert.equal(grid.weekly.resetsAtMs - grid.weekly.startMs, WEEKLY_WINDOW_MS);
  // Anchored to the subscription, not to the clock: a window resets on the
  // subscriber's own schedule rather than at whatever hour they opened the
  // page, so the offset from the anchor is a whole number of spans.
  assert.equal((grid.session.startMs - PERIOD.anchorMs) % SESSION_WINDOW_MS, 0);
  assert.equal((grid.weekly.startMs - PERIOD.anchorMs) % WEEKLY_WINDOW_MS, 0);
});

test("a run is allowed while both windows have room, and refused when either is spent", () => {
  const session = { spentMicroUsd: 100_000, budgetMicroUsd: 500_000, resetsAtMs: 1_000 };
  const weekly = { spentMicroUsd: 100_000, budgetMicroUsd: 3_000_000, resetsAtMs: 9_000 };
  assert.equal(windowVerdict({ session, weekly }).allowed, true);
  assert.equal(
    windowVerdict({ session: { ...session, spentMicroUsd: 500_000 }, weekly }).allowed,
    false
  );
  assert.equal(
    windowVerdict({ session, weekly: { ...weekly, spentMicroUsd: 3_000_000 } }).allowed,
    false
  );
});

test("the verdict names which window binds, and when that one frees up", () => {
  // A reader told the wrong one waits five hours for a weekly limit, or gives
  // up on a task that would have been startable after lunch.
  const tightSession = windowVerdict({
    session: { spentMicroUsd: 490_000, budgetMicroUsd: 500_000, resetsAtMs: 1_000 },
    weekly: { spentMicroUsd: 490_000, budgetMicroUsd: 3_000_000, resetsAtMs: 9_000 },
  });
  assert.equal(tightSession.bound, "session");
  assert.equal(tightSession.resetsAtMs, 1_000);
  assert.equal(tightSession.remainingMicroUsd, 10_000);

  const tightWeek = windowVerdict({
    session: { spentMicroUsd: 0, budgetMicroUsd: 500_000, resetsAtMs: 1_000 },
    weekly: { spentMicroUsd: 2_999_000, budgetMicroUsd: 3_000_000, resetsAtMs: 9_000 },
  });
  assert.equal(tightWeek.bound, "weekly");
  assert.equal(tightWeek.resetsAtMs, 9_000);
  assert.equal(tightWeek.remainingMicroUsd, 1_000);
});

test("an equal pair names the session window, because it frees up first", () => {
  const verdict = windowVerdict({
    session: { spentMicroUsd: 0, budgetMicroUsd: 500_000, resetsAtMs: 1_000 },
    weekly: { spentMicroUsd: 2_500_000, budgetMicroUsd: 3_000_000, resetsAtMs: 9_000 },
  });
  assert.equal(verdict.bound, "session");
});

test("holds are subtracted, or two runs admitted together both see the whole remainder", () => {
  // The read-then-act window `reserveSpend` closes for the month, and it is
  // wider here because a window is a smaller number than a month.
  const windows = {
    session: { spentMicroUsd: 0, budgetMicroUsd: 500_000, resetsAtMs: 1_000 },
    weekly: { spentMicroUsd: 0, budgetMicroUsd: 3_000_000, resetsAtMs: 9_000 },
  };
  assert.equal(windowVerdict(windows).remainingMicroUsd, 500_000);
  assert.equal(windowVerdict({ ...windows, heldMicroUsd: 200_000 }).remainingMicroUsd, 300_000);
  assert.equal(windowVerdict({ ...windows, heldMicroUsd: 500_000 }).allowed, false);
  // A hold larger than the window does not manufacture a negative remainder
  // for a caller to hand to a guard as a ceiling.
  assert.equal(windowVerdict({ ...windows, heldMicroUsd: 9_000_000 }).remainingMicroUsd, 0);
});

test("a hold is charged to the cell it was opened in, not to every cell it outlives", () => {
  /*
   * A Work run's hold lives as long as the run does, and the reaper leaves it
   * alone precisely because the run genuinely is still spending. A hold summed
   * over the billing period is therefore charged to the current 5-hour cell
   * even when it was opened six hours ago — against money that cell never saw,
   * since whatever the run has spent is already on the ledger the cell counts.
   * So each window carries its own scoped holds.
   */
  const windows = {
    session: { spentMicroUsd: 0, budgetMicroUsd: 2_500_000, resetsAtMs: 1_000, heldMicroUsd: 0 },
    weekly: {
      spentMicroUsd: 0,
      budgetMicroUsd: 3_500_000,
      resetsAtMs: 9_000,
      heldMicroUsd: 2_400_000,
    },
  };
  // The old run's hold belongs to the week and not to this sitting.
  const verdict = windowVerdict(windows);
  assert.equal(verdict.bound, "weekly");
  assert.equal(verdict.remainingMicroUsd, 1_100_000);
  // Period-scoped, the one hold is charged to both cells, and the 5-hour cell —
  // which has spent nothing — is the one reported as nearly gone.
  const periodScoped = windowVerdict({
    session: windows.session,
    weekly: { ...windows.weekly, heldMicroUsd: 0 },
    heldMicroUsd: 2_400_000,
  });
  assert.equal(periodScoped.bound, "session");
  assert.equal(periodScoped.remainingMicroUsd, 100_000);
});

test("an account with no window is allowed and names none", () => {
  // `Settings.spendCapDisabled`: no monthly ceiling means no period to slice,
  // so there is nothing to be out of. The backstop for a run dispatched under
  // this is `unattendedRunCeiling`, not nothing — see that constant.
  const verdict = windowVerdict({
    session: { spentMicroUsd: 0, budgetMicroUsd: null, resetsAtMs: 1_000 },
    weekly: { spentMicroUsd: 0, budgetMicroUsd: null, resetsAtMs: 9_000 },
  });
  assert.deepEqual(verdict, {
    allowed: true,
    bound: null,
    remainingMicroUsd: null,
    resetsAtMs: null,
  });
});

test("the refusal says which window and when it frees up", () => {
  // "You are out of budget" sends a reader to the pricing page; "you are out of
  // budget until 14:00" sends them to lunch, and only one of those is true of a
  // window.
  const session = windowLimitMessage("session", Date.UTC(2026, 8, 17, 14, 0));
  assert.match(session, /5-hour usage limit/);
  assert.match(session, /frees up at/);
  assert.match(session, /2:00/);
  const weekly = windowLimitMessage("weekly", Date.UTC(2026, 8, 21, 9, 30));
  assert.match(weekly, /weekly usage limit/);
  // The weekday, because "9:30" for something a week away is not an answer.
  assert.match(weekly, /Monday/);
  // No reset to name is not a reason to invent one.
  assert.equal(windowLimitMessage("session", null), "You've used up your 5-hour usage limit.");
  assert.equal(describeWindow("session"), "5-hour limit");
  assert.equal(describeWindow("weekly"), "weekly limit");
});

test("the windows are enforced and not merely metered", () => {
  // The finding this whole file answers: `getUsageWindows` had exactly two
  // callers and both drew meters. Its enforcing counterpart has to exist, has
  // to subtract holds the way `checkBudget` does, and has to be reachable from
  // the surfaces that start work.
  const spend = readFileSync(new URL("../src/lib/spend.ts", import.meta.url), "utf8");
  assert.match(spend, /export async function checkUsageWindows\(/);
  assert.match(spend, /openReservedMicroUsd\(/);
  // The gauge and the gate read ONE derivation, so what a reader is shown and
  // what refuses them cannot be different numbers.
  assert.match(spend, /getUsageWindows\(userId, eff\.budgetMicroUsd, p, now\)/);

  for (const file of [
    "../src/app/api/chat/route.ts",
    "../src/app/api/work/sessions/[id]/runs/route.ts",
    "../src/app/api/work/schedules/[id]/run-now/route.ts",
    "../scripts/work-scheduler.ts",
    "../scripts/work-trigger-poller.ts",
    "../scripts/work-runner.ts",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /checkUsageWindows\(/, file);
  }
});

test("the executor re-reads the window while a run works", () => {
  /*
   * The half the in-process guard cannot do. `WorkBudgetGuard` is handed the
   * window's remainder once, at dispatch, and agent-core has no database by
   * design — so a run started at 09:00 cannot know the window moved while it
   * ran. The runner does have the database, and stops the run through the
   * guard's own seam rather than by cancelling it, so the terminal reason names
   * the window instead of pointing at a person who pressed nothing.
   */
  const runner = readFileSync(new URL("../scripts/work-runner.ts", import.meta.url), "utf8");
  assert.match(runner, /stopForAccountBudget\(windowLimitMessage\(/);
  // Its own spend, less what has already been billed: the ledger cannot see a
  // live run's cost, and adding the whole cumulative figure would bill an
  // earlier stretch to the window twice.
  assert.match(runner, /billedWorkRunMicroUsd\(/);
  assert.match(runner, /pendingMicroUsd: Math\.max\(0, usage\.costMicroUsd - billed\)/);
  // And its own admission hold excluded, or the estimate and the real spend
  // that replaced it are both charged against the window.
  assert.match(runner, /ignoreReservationRef: run\.spendReservationRef/);

  // The guard carries it to a terminal reason of its own kind rather than to a
  // cancellation, and the outcome is sticky so a second poll cannot restate it.
  const guard = readFileSync(
    new URL("../runner/agent-core/src/work/budget.ts", import.meta.url),
    "utf8"
  );
  assert.match(guard, /exhausted\(limit: 'cost' \| 'tokens' \| 'runtime', detail: string\): void \{\n\s*if \(this\.hit\) return;/);
  const session = readFileSync(
    new URL("../runner/agent-core/src/work/session.ts", import.meta.url),
    "utf8"
  );
  assert.match(session, /stopForAccountBudget\(detail: string\): void \{/);
  assert.match(session, /this\.budget\.exhausted\('cost', detail\);/);
});

test("the composer names the same binding window the gate will refuse on", () => {
  /*
   * `runLimitFrom` picked the window by PERCENTAGE used while `windowVerdict`
   * picked it by absolute room left. The weekly budget is many times the
   * session budget, so the two disagreed for ordinary accounts: at 90% of the
   * session cell and 95% of the weekly one, percentage says weekly and the
   * remainder says session. The composer then read "runs until your weekly
   * limit is used up" and named a reset a day away over a run the five-hour
   * cell was about to stop — and the voice briefing said it out loud. They
   * share one derivation now, so they cannot disagree at all.
   */
  const SESSION_BUDGET = 2_500_000;
  const WEEKLY_BUDGET = 3_500_000;
  const sessionWindow = {
    pct: 0.9,
    spentMicroUsd: Math.round(SESSION_BUDGET * 0.9),
    budgetMicroUsd: SESSION_BUDGET,
    resetsAtMs: 1_000,
  };
  const weeklyWindow = {
    pct: 0.95,
    spentMicroUsd: Math.round(WEEKLY_BUDGET * 0.95),
    budgetMicroUsd: WEEKLY_BUDGET,
    resetsAtMs: 9_000,
  };
  const verdict = windowVerdict({ session: sessionWindow, weekly: weeklyWindow });
  const limit = runLimitFrom({
    spentMicroUsd: 0,
    budgetMicroUsd: 15_000_000,
    eurPerUsd: 1,
    reservedMicroUsd: 0,
    capSource: "plan",
    capDisabled: false,
    userCapEur: null,
    planBudgetMicroUsd: 15_000_000,
    windows: { session: sessionWindow, weekly: weeklyWindow },
    billing: { renewsAtMs: null, cancelAtPeriodEnd: false },
  });
  assert.equal(limit.window, verdict.bound);
  assert.equal(limit.resetsAtMs, verdict.resetsAtMs);

  // And the case the old percentage rule got backwards: the session cell has
  // less money left while the weekly cell is further through as a fraction.
  const tightSession = { ...sessionWindow, spentMicroUsd: SESSION_BUDGET - 10_000 };
  assert.ok(tightSession.pct < weeklyWindow.pct);
  assert.equal(windowVerdict({ session: tightSession, weekly: weeklyWindow }).bound, "session");
  assert.equal(bindingWindow({ session: tightSession, weekly: weeklyWindow })?.name, "session");
});
