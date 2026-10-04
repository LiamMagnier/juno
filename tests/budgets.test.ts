import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  accountBudgetLine,
  agentBudgetLine,
  bindingBudget,
  budgetExhausted,
  budgetRemaining,
  budgetShare,
  describeBudgetLine,
  describeRoutineSpend,
  describeRunLine,
  remainingUnder,
  routineBudgetLines,
  runBudgetLine,
} from "@/lib/budgets";

/*
 * One budget vocabulary over the four existing stores (BRIEF §49): account,
 * agent, routine, run. The enforcement stays where it was; these pin the shape,
 * the sentence and which line binds.
 */

const account = accountBudgetLine({ budgetMicroUsd: 20_000_000, spentMicroUsd: 4_000_000, reservedMicroUsd: 1_000_000, resetsAtMs: 1 });
const agent = agentBudgetLine({ name: "Scout", capMicroUsd: 5_000_000, spentMicroUsd: 4_500_000, resetsAtMs: 2 });
const run = runBudgetLine({ label: "Morning brief", maxCostMicroUsd: 2_000_000, costMicroUsd: 1_900_000 });

test("remaining counts spend and holds; 'up to' means at the ceiling is spent", () => {
  assert.equal(budgetRemaining(account), 15_000_000);
  assert.equal(budgetExhausted(agentBudgetLine({ name: "x", capMicroUsd: 1, spentMicroUsd: 1, resetsAtMs: null })), true);
  assert.equal(budgetExhausted(agentBudgetLine({ name: "x", capMicroUsd: null, spentMicroUsd: 9e9, resetsAtMs: null })), false);
  assert.equal(budgetShare(account), 0.25);
  assert.equal(budgetShare(agentBudgetLine({ name: "x", capMicroUsd: null, spentMicroUsd: 1, resetsAtMs: null })), null);
});

test("the binding line is the one with least room; no ceiling never binds", () => {
  assert.equal(bindingBudget([account, agent, run])?.scope, "run");
  assert.equal(remainingUnder([account, agent, run]), 100_000);
  assert.equal(bindingBudget([account, agent])?.scope, "agent");
  const none = agentBudgetLine({ name: "x", capMicroUsd: null, spentMicroUsd: 0, resetsAtMs: null });
  assert.equal(bindingBudget([none]), null);
  assert.equal(remainingUnder([none]), null);
});

test("ties go to the narrower scope, which names what the person can change", () => {
  const a = accountBudgetLine({ budgetMicroUsd: 1_000_000, spentMicroUsd: 0, reservedMicroUsd: 0, resetsAtMs: null });
  const r = runBudgetLine({ label: "r", maxCostMicroUsd: 1_000_000, costMicroUsd: 0 });
  assert.equal(bindingBudget([a, r])?.scope, "run");
  assert.equal(bindingBudget([r, a])?.scope, "run");
});

test("one sentence per line", () => {
  assert.equal(describeBudgetLine(account), "$5.00 of $20.00 this month");
  assert.equal(describeBudgetLine(agent), "$4.50 of $5.00 this week");
  assert.equal(describeRunLine(run), "$1.90 of $2.00 for this run");
  const routine = routineBudgetLines({ name: "Morning brief", maxCostMicroUsd: 500_000, spentThisMonthMicroUsd: 3_250_000 });
  assert.equal(describeBudgetLine(routine.perRun), "Each run stops at $0.50");
  assert.equal(describeRoutineSpend(routine.month), "Its runs have cost $3.25 this billing period");
  const uncapped = routineBudgetLines({ name: "x", maxCostMicroUsd: 0, spentThisMonthMicroUsd: 0 });
  assert.equal(uncapped.perRun.ceilingMicroUsd, null, "zero is 'no ceiling of its own', as every dispatcher reads it");
  assert.match(describeBudgetLine(uncapped.perRun), /account's window applies/);
});

test("the surfaces use the shared vocabulary, not their own arithmetic", () => {
  const panel = readFileSync("src/components/agents/agent-panel.tsx", "utf8");
  assert.match(panel, /describeBudgetLine\(line\)/);
  const editor = readFileSync("src/components/work/work-schedule-editor.tsx", "utf8");
  assert.match(editor, /describeRoutineSpend\(/);
});
