import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_MEMBER_BUDGET_MICRO_USD,
  MEMBER_BUDGET_ROLLING_MS,
  formatBudget,
  memberBudgetMessage,
  memberBudgetVerdict,
  memberBudgetWindow,
} from "@/lib/agents/budget";
import { patchAgentSchema } from "@/lib/agents/domain";

/*
 * A crew member's own budget inside the account's windows: optional, only
 * narrows, enforced at admission and while running, and said in a sentence.
 */

test("no cap always allows; a cap is 'up to', and spent is spent", () => {
  assert.deepEqual(memberBudgetVerdict({ capMicroUsd: null, spentMicroUsd: 9e9 }), { allowed: true, remainingMicroUsd: null });
  assert.deepEqual(memberBudgetVerdict({ capMicroUsd: 5_000_000, spentMicroUsd: 1_000_000 }), { allowed: true, remainingMicroUsd: 4_000_000 });
  assert.deepEqual(memberBudgetVerdict({ capMicroUsd: 5_000_000, spentMicroUsd: 5_000_000 }), { allowed: false, remainingMicroUsd: 0 });
  // A running task's live cost counts before it reaches the ledger.
  assert.equal(memberBudgetVerdict({ capMicroUsd: 5_000_000, spentMicroUsd: 3_000_000, pendingMicroUsd: 2_500_000 }).allowed, false);
  // A zero cap means the member spends nothing.
  assert.equal(memberBudgetVerdict({ capMicroUsd: 0, spentMicroUsd: 0 }).allowed, false);
});

test("the window is the account's weekly cell, or a rolling week when the account has none", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  const weekly = { startMs: Date.parse("2026-09-28T00:00:00Z"), resetsAtMs: Date.parse("2026-10-05T00:00:00Z") };
  assert.deepEqual(memberBudgetWindow({ weekly, now }), { since: new Date(weekly.startMs), resetsAtMs: weekly.resetsAtMs });
  // Unmetered accounts report a zero-width window.
  const flat = memberBudgetWindow({ weekly: { startMs: now.getTime(), resetsAtMs: now.getTime() }, now });
  assert.equal(flat.since.getTime(), now.getTime() - MEMBER_BUDGET_ROLLING_MS);
  assert.equal(flat.resetsAtMs, null);
});

test("the sentence names the member, the cap, when it frees up and what to do", () => {
  const admission = memberBudgetMessage({ name: "Scout", capMicroUsd: 5_000_000, resetsAtMs: Date.parse("2026-10-05T09:00:00Z"), stage: "admission" });
  assert.match(admission, /^Scout has used the \$5\.00 you set for this week, so nothing was started\. It frees up Monday .*UTC\. You can raise Scout's budget in its setup\.$/);
  const running = memberBudgetMessage({ name: "Scout", capMicroUsd: 5_000_000, resetsAtMs: null, stage: "running" });
  assert.match(running, /^Scout reached the \$5\.00 you set for this week, so this task stopped\./);
  assert.doesNotMatch(admission + running, /[—–]/);
  assert.equal(formatBudget(1_234_567), "$1.23");
});

test("the cap is set through the profile patch, bounded, and clearable", () => {
  assert.equal(patchAgentSchema.safeParse({ budgetMicroUsd: 5_000_000 }).success, true);
  assert.equal(patchAgentSchema.safeParse({ budgetMicroUsd: null }).success, true);
  assert.equal(patchAgentSchema.safeParse({ budgetMicroUsd: -1 }).success, false);
  assert.equal(patchAgentSchema.safeParse({ budgetMicroUsd: MAX_MEMBER_BUDGET_MICRO_USD + 1 }).success, false);
});

test("enforced at admission, on run-now, and while running; it only narrows the run's ceiling", () => {
  const dispatch = readFileSync("src/lib/work/dispatch.ts", "utf8");
  const start = dispatch.slice(dispatch.indexOf("export async function startWorkRunForUser("));
  // After the account's windows, never instead of them.
  assert.ok(start.indexOf("checkUsageWindows(user.id, plan)") < start.indexOf("checkMemberBudget({"));
  assert.match(start, /error: "member_budget_exhausted"/);
  assert.match(start, /runBudgetForWindow\(narrowerRemaining\(windows\.remainingMicroUsd, memberBudget\.remainingMicroUsd\)\)/);
  const fire = readFileSync("src/lib/work/fire-now.ts", "utf8");
  assert.match(fire, /reason: "member_budget_exhausted"/);
  const runner = readFileSync("scripts/work-runner.ts", "utf8");
  const watch = runner.slice(runner.indexOf("const watchUsageWindow = async"));
  assert.match(watch.slice(0, 3000), /checkMemberBudget\(\{[\s\S]*?stage: "running"[\s\S]*?session\.stopForAccountBudget\(member\.message\)/);
});
