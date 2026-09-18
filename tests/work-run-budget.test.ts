import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Plan } from "@prisma/client";
import { NO_BUDGET, budgetExceeded, narrowestBudget } from "@/lib/work/domain";
import {
  WORK_MAX_STEPS_PER_RUN,
  ceilingFieldValue,
  runBudgetForWindow,
} from "@/lib/work/budget";
import {
  UNATTENDED_RUN_DEFAULT_MICRO_USD,
  UNIT_CEILING_MICRO_USD,
  unattendedRunCeiling,
  unitCeilingMicroUsd,
} from "@/lib/spend-ceiling";

/*
 * What bounds a Work run, now that no per-run ceiling does.
 *
 * This file used to pin a five-row table: a cost, a token and a runtime ceiling
 * per plan, PRO's at $2 / 600,000 / twenty minutes, with every dispatcher, the
 * composer's "Stops at …" sentence and the schedule editor's placeholders held
 * in step against it. The table is gone. The only limit on a run is the
 * account's rolling 5-hour window and its weekly window, and the cases here are
 * what stop the old shape coming back in any of its three disguises:
 *
 *   a fixed figure filed per plan, which cut short the run that genuinely
 *   needed thirty minutes while the month sat barely touched;
 *
 *   a ceiling of zero on every axis, which is not "no per-run limit" but "no
 *   limit the guard can enforce at all" — a runaway loop with nothing in front
 *   of it;
 *
 *   and a surface still promising one of the old numbers, which is the same
 *   defect as a control implying something the runtime cannot do, only quieter.
 */

const PLANS: readonly Plan[] = ["FREE", "PRO", "MAX", "MAX20", "OWNER"];

test("a run's ceiling is what the window has left, on the cost axis alone", () => {
  const budget = runBudgetForWindow(420_000);
  assert.equal(budget.maxCostMicroUsd, 420_000);
  // Zero is not a deletion: `budgetExceeded` skips an axis at zero, which is
  // how "no ceiling on how long it runs or how many tokens it uses" is said in
  // the vocabulary the executor, the `WorkRun` columns and the native clients
  // all already speak.
  assert.equal(budget.maxTokens, 0);
  assert.equal(budget.maxRuntimeMs, 0);
});

test("the cost axis stays wired, because a guard with every axis at zero stops nothing", () => {
  const budget = runBudgetForWindow(420_000);
  const spent = { costMicroUsd: 420_000, tokens: 50_000_000, runtimeMs: 12 * 60 * 60_000 };
  const verdict = budgetExceeded(budget, spent);
  assert.equal(verdict.exceeded, true);
  assert.equal(verdict.exceeded && verdict.limit, "cost");
  // Twelve hours and fifty million tokens on their own are not a reason to
  // stop: the account decides what it can afford, and it has said so in money.
  assert.equal(budgetExceeded(budget, { ...spent, costMicroUsd: 1 }).exceeded, false);
});

test("a nearly-spent window still produces a ceiling that can stop a run", () => {
  // Floored at one micro-USD. Rounding the last fraction of a window down to
  // zero would hand the run the one budget `budgetExceeded` cannot enforce,
  // which is the exact inversion of what the caller asked for.
  assert.equal(runBudgetForWindow(0).maxCostMicroUsd, 1);
  assert.equal(runBudgetForWindow(0.4).maxCostMicroUsd, 1);
  assert.ok(budgetExceeded(runBudgetForWindow(0), { costMicroUsd: 1, tokens: 0, runtimeMs: 0 }).exceeded);
});

test("an account with no window gets a finite backstop rather than nothing", () => {
  /*
   * The hole `spend-ceiling.ts` was written to close, seen from the other side.
   * `BUDGET_EUR.OWNER` being null once switched off both the pre-flight gate
   * and the mid-stream abort on the one account no billing system watches.
   * Removing the per-run ceiling would reopen it for any account with
   * `Settings.spendCapDisabled`: no monthly ceiling means no period to slice,
   * so no window — and then no ceiling at all. Switching enforcement off is a
   * decision to stop metering, not a decision to let an unattended loop run all
   * night.
   */
  assert.equal(runBudgetForWindow(null).maxCostMicroUsd, UNATTENDED_RUN_DEFAULT_MICRO_USD);
  assert.ok(runBudgetForWindow(null).maxCostMicroUsd > 0);
  // And the same backstop reaches a run whose dispatcher wrote a zero, which
  // is what `createRun` substitutes.
  assert.equal(unattendedRunCeiling(0), UNATTENDED_RUN_DEFAULT_MICRO_USD);
});

test("admission no longer refuses a Work run by a per-run ceiling", () => {
  // The unit ceiling used to be the plan's own run ceiling, so that admission
  // and the executor's guard refused a run by the same number. Both numbers are
  // gone; leaving a $2 entry here would refuse at the door every run the
  // windows had room for, which is the per-run ceiling back under a quieter
  // name.
  for (const plan of PLANS) {
    assert.equal(unitCeilingMicroUsd("work", plan), undefined, plan);
  }
  // Deep research keeps its own, because a fan-out of searches is still a
  // realistic way to spend a month in an afternoon with no human in the loop.
  assert.equal(unitCeilingMicroUsd("research", "FREE"), UNIT_CEILING_MICRO_USD.research);
  assert.equal(unitCeilingMicroUsd("chat", "MAX"), undefined);
});

test("a run's admission hold is an estimate, not the window it may spend", () => {
  // The two were one number while the ceiling was a small fixed one. Holding
  // the window's whole remainder would take the account's entire window the
  // moment a run started: a second run refused, and the reader unable to send a
  // chat message while their task worked.
  const store = readFileSync(new URL("../src/lib/work/store.ts", import.meta.url), "utf8");
  assert.match(store, /estimateMicroUsd: DEFAULT_ESTIMATE_MICRO_USD\.work,/);
  assert.doesNotMatch(store, /estimateMicroUsd: budget\.maxCostMicroUsd/);
});

test("a schedule may still lower a ceiling, and nothing may raise one", () => {
  // `narrowestBudget` stays: a schedule, a skill, a project or a host asking
  // for LESS than the window was never about the plan table. It skips zeros
  // rather than clamping to them, which is what makes an untouched field mean
  // "no ceiling of its own" rather than "nothing".
  const window = runBudgetForWindow(2_000_000);
  const merged = narrowestBudget(
    { maxCostMicroUsd: 500_000, maxTokens: 120_000, maxRuntimeMs: 0 },
    window
  );
  assert.equal(merged.maxCostMicroUsd, 500_000);
  // A schedule that wants a token ceiling of its own gets one even though the
  // window imposes none.
  assert.equal(merged.maxTokens, 120_000);
  assert.equal(merged.maxRuntimeMs, 0);
  // Above the window is narrowed back to it: the account's number wins.
  assert.equal(
    narrowestBudget({ maxCostMicroUsd: 90_000_000, maxTokens: 0, maxRuntimeMs: 0 }, window)
      .maxCostMicroUsd,
    2_000_000
  );
  // A schedule with nothing of its own runs under the window and only that.
  assert.deepEqual(narrowestBudget(NO_BUDGET, window), window);
});

test("the step cap is one honest figure rather than a ratio of a clock that is gone", () => {
  /*
   * `maxStepsForBudget` scaled the runtime's own `MAX_STEPS_PER_RUN` of 200 by
   * the ratio of the run's runtime ceiling to PRO's twenty minutes. There is no
   * runtime ceiling left to take a ratio of, so the ratio would collapse to 1
   * and two hundred model turns would quietly become the thing that ends long
   * work — for a reason no surface names.
   */
  assert.ok(WORK_MAX_STEPS_PER_RUN >= 1_200, "a long run would stop at the step cap");
  const runner = readFileSync(new URL("../scripts/work-runner.ts", import.meta.url), "utf8");
  assert.match(runner, /maxSteps: WORK_MAX_STEPS_PER_RUN,/);
  assert.doesNotMatch(runner, /maxStepsForBudget/);
  // The detectors that actually catch a circle, in seconds rather than at step
  // twelve hundred: a non-progressing verdict sets the halt reason and aborts.
  const session = readFileSync(
    new URL("../runner/agent-core/src/work/session.ts", import.meta.url),
    "utf8"
  );
  assert.match(session, /const verdict = this\.plan\.observeToolCall\(call\.name, call\.input\);/);
  assert.match(session, /if \(verdict\.state !== 'progressing'\) \{\n\s*this\.haltReason = verdict\.reason;/);
  assert.match(session, /this\.aborter\?\.abort\(\);/);
});

test("a schedule field takes a number or nothing, and has no ceiling to be checked against", () => {
  // Empty is zero, which every dispatcher reads as "no ceiling of this
  // schedule's own" — that is what makes an untouched field mean "whatever my
  // windows allow" rather than "nothing".
  assert.equal(ceilingFieldValue(""), 0);
  assert.equal(ceilingFieldValue("   "), 0);
  assert.equal(ceilingFieldValue("0.05"), 0.05);
  assert.equal(ceilingFieldValue("2"), 2);
  // There is no honest upper bound to refuse against: a schedule fires in the
  // future, and what its window has left at 07:00 tomorrow is not knowable
  // today. What is still refused is what cannot be a ceiling at all.
  assert.equal(ceilingFieldValue("-1"), null);
  assert.equal(ceilingFieldValue("lots"), null);
});

test("the schedule editor asks for a figure without naming one that is not a figure", () => {
  // The editor is a client component a test cannot import, so its source is
  // what holds the wiring. A `max` attribute or a numeric placeholder here
  // would be a guess at a window's remainder hours before it fires.
  const editor = readFileSync(
    new URL("../src/components/work/work-schedule-editor.tsx", import.meta.url),
    "utf8"
  );
  assert.match(editor, /ceilingFieldValue\(draft\.budget\.costUsd\)/);
  assert.match(editor, /ceilingFieldValue\(draft\.budget\.tokens\)/);
  assert.match(editor, /ceilingFieldValue\(draft\.budget\.minutes\)/);
  assert.doesNotMatch(editor, /max=\{ceiling\./);
  // A call, not a mention: the comment above `ceilingField` explains what the
  // plan table used to do here and is the reason the removal is legible.
  assert.doesNotMatch(editor, /runBudgetForPlan\(/);
  // A quarter-dollar step cannot express the few cents a morning somebody
  // actually writes.
  assert.doesNotMatch(editor, /step="0\.25"/);
});

test("no surface still promises a ceiling that no longer exists", () => {
  // A sentence promising a limit the runtime does not apply is the same defect
  // as a control implying something the runtime cannot do. These are the four
  // places that read the plan table out loud.
  for (const file of [
    "../src/components/work/clarify/run-disclosure.tsx",
    "../src/components/work/voice/work-voice-briefing.ts",
    "../src/components/work/work-schedule-editor.tsx",
    "../src/components/work/work-detail-panels.tsx",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    // Calls, not mentions. Each of these files keeps a paragraph naming what it
    // used to read and why that number is gone, which is how the removal stays
    // legible to whoever reads the file next.
    assert.doesNotMatch(source, /runBudgetForPlan\(|runCeilingsFor\(|RUN_CEILINGS\b/, file);
    assert.doesNotMatch(source, /minutes of working time/, file);
  }
  // And the composer says what is true instead, from the account's own windows
  // rather than from a figure of its own.
  const disclosure = readFileSync(
    new URL("../src/components/work/clarify/run-disclosure.tsx", import.meta.url),
    "utf8"
  );
  assert.match(disclosure, /export function runLimitFrom\(spend: ClientSpend\): RunLimit/);
  assert.match(disclosure, /runs until your 5-hour limit is used up/);
});

/** The argument text of a `createRun({ ... })` call, by counting braces. */
function createRunArguments(source: string): string[] {
  const calls: string[] = [];
  const opener = "createRun({";
  for (let at = source.indexOf(opener); at !== -1; at = source.indexOf(opener, at + 1)) {
    let depth = 0;
    let cursor = at + opener.length - 1;
    for (; cursor < source.length; cursor += 1) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(at + opener.length, cursor));
  }
  return calls;
}

const DISPATCHERS = [
  "../src/app/api/work/sessions/[id]/runs/route.ts",
  // The Run-now button and an `api` trigger's fire URL are ONE implementation
  // (see its own docblock), so the file that builds the run for both is where
  // the window has to be read and merged. Pointing this at the route instead
  // would pass while the fire URL dispatched runs with no window behind them.
  "../src/lib/work/fire-now.ts",
  "../scripts/work-scheduler.ts",
  "../scripts/work-trigger-poller.ts",
];

test("every dispatcher sizes the run from the window it was admitted against", () => {
  // Each of these builds a `budget` object for `createRun`, and the failure —
  // a zero copied straight onto the run, or a flat constant that ignores the
  // account — is invisible from any client until a run has spent an unbounded
  // amount or stopped far too early. Reading the window twice would be as bad:
  // a chat turn landing between the two reads would refuse a run against one
  // number while the guard measured it against another.
  for (const file of DISPATCHERS) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /runBudgetForWindow\(/, file);
    assert.doesNotMatch(source, /runBudgetForPlan/, file);
  }
  for (const file of DISPATCHERS.slice(1)) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /narrowestBudget\(/, file);
  }
});

test("a metered scheduled fire runs on its window, not on the unattended backstop", () => {
  /*
   * Both unattended dispatchers used to build the cost axis as
   * `unattendedRunCeiling(schedule.maxCostMicroUsd)`, and that returns
   * UNATTENDED_RUN_DEFAULT_MICRO_USD for the zero a schedule with no figure of
   * its own stores. `narrowestBudget` then took the minimum, so every metered
   * scheduled and trigger-fired run was dispatched at min($1, window) — a
   * per-run ceiling, on every plan, contradicting the docs, the composer and
   * the schedule editor, and differing from the same schedule pressed by hand,
   * which got the window. The reader then saw `budget_exceeded` on a run their
   * window had plenty of room for, and running it again hit the same $1.
   *
   * The backstop belongs to the account that has no window, and
   * `runBudgetForWindow(null)` is where it lives.
   */
  const WINDOW_REMAINDER = 6_400_000; // Comfortably above the $1 backstop.
  const scheduleWithNoFigures = { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 };
  const dispatched = narrowestBudget(
    scheduleWithNoFigures,
    runBudgetForWindow(WINDOW_REMAINDER)
  );
  assert.equal(dispatched.maxCostMicroUsd, WINDOW_REMAINDER);
  assert.notEqual(dispatched.maxCostMicroUsd, UNATTENDED_RUN_DEFAULT_MICRO_USD);
  // A schedule that DOES set a smaller figure still gets it: asking for less
  // was never the plan table's doing.
  assert.equal(
    narrowestBudget({ ...scheduleWithNoFigures, maxCostMicroUsd: 400_000 },
      runBudgetForWindow(WINDOW_REMAINDER)).maxCostMicroUsd,
    400_000
  );
  // And the cap-disabled account, which genuinely has no window, still gets the
  // backstop rather than nothing.
  assert.equal(
    narrowestBudget(scheduleWithNoFigures, runBudgetForWindow(null)).maxCostMicroUsd,
    UNATTENDED_RUN_DEFAULT_MICRO_USD
  );

  // The dispatchers themselves: the schedule's own figure reaches
  // `narrowestBudget` raw, with no ceiling wrapped around it.
  for (const file of ["../scripts/work-scheduler.ts", "../scripts/work-trigger-poller.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /maxCostMicroUsd: schedule\.maxCostMicroUsd,/, file);
    assert.doesNotMatch(source, /unattendedRunCeiling\(/, file);
  }
  // And the helper text no longer promises the figure that is gone.
  const editor = readFileSync(
    new URL("../src/components/work/work-schedule-editor.tsx", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(editor, /stops at \$1 unless you set a figure/);
});

test("every dispatcher hands the plan it resolved to spend admission", () => {
  // `reserveSpend` will read the plan itself when handed nothing, and a
  // dispatcher that let it would give a subscription lapsing mid-request the
  // chance to be admitted against one plan and dispatched under another.
  let checked = 0;
  for (const file of DISPATCHERS) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const calls = createRunArguments(source);
    assert.ok(calls.length > 0, file);
    for (const args of calls) {
      // A scheduler marker row never dispatches an executor and never reserves
      // spend, so it has no plan to hand on and needs none.
      if (args.includes("spendReservation: false")) continue;
      assert.match(args, /^\s*plan[,:]/m, file);
      checked += 1;
    }
  }
  // The skip above must not be able to empty the case out.
  assert.equal(checked, 4);
  // And the store passes it on rather than dropping it on the floor.
  const store = readFileSync(new URL("../src/lib/work/store.ts", import.meta.url), "utf8");
  assert.match(store, /plan: input\.plan,/);
});
