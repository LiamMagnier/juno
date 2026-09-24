import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_PLAN,
  budgetFromEnvelope,
  nearestEffort,
  parsePlan,
  planBudget,
  type ResearchPlan,
} from "@/lib/research/domain";
import { researchBudgetFor, isBudgetRefusal } from "@/lib/research/envelope";
import {
  parsePlan as previousParsePlan,
  planBudget as previousPlanBudget,
  RESEARCH_EFFORTS as PREVIOUS_EFFORTS,
} from "./fixtures/research-domain-d0997af2";

/*
 * INV-22: `ResearchRun.plan` stays readable by the previous build.
 *
 * During a deploy the build before this one can pick a run up mid-flight —
 * the PM2 research worker adopts any unleased working run — and it reads the
 * plan with its own `parsePlan`. That reader is frozen here as it stood at
 * `d0997af2`. A plan the rework writes must still give it a valid budget with
 * an effort (its `parseBudget` refuses one without), or the old build falls
 * back to the default tier and runs a different size than the person agreed.
 */

function reworkPlan(): ResearchPlan {
  const envelope = researchBudgetFor({
    scope: { questions: 5, breadth: "broad", freshness: "recent", primarySources: true, quick: false },
    plan: "MAX",
    remaining: { monthMicroUsd: 90_000_000, monthBudgetMicroUsd: 90_000_000 },
    rates: {
      worker: { inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 5 },
      lead: { inputMicroUsdPerToken: 5, outputMicroUsdPerToken: 25 },
      judge: { inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 5 },
    },
    roster: { engines: [{ name: "tavily", microUsdPerQuery: 8_000 }] },
    liveRuns: 0,
    startsToday: 0,
    eurPerUsd: 0.92,
    leadModel: "claude-opus",
  });
  assert.ok(!isBudgetRefusal(envelope));
  return {
    ...EMPTY_PLAN,
    queries: ["heat pump field trials cold climate", "heat pump running cost nordics"],
    confirmation: "required",
    confirmedAt: "2026-09-24T10:00:00.000Z",
    effort: nearestEffort(envelope),
    budget: { ...budgetFromEnvelope(envelope), startedAt: "2026-09-24T10:01:00.000Z" },
    envelope,
    scope: { questions: 5, breadth: "broad", freshness: "recent", primarySources: true, quick: false },
    estimateCaps: envelope.caps,
    title: "Heat pumps in cold climates",
    language: "en",
    today: "Today is Thursday, 24 September 2026 (UTC).",
    steering: [{ text: "Prefer Nordic data", appliedAtRound: null, createdAt: "2026-09-24T10:05:00.000Z" }],
    pausedMs: 0,
  };
}

test("the previous build reads a rework plan's budget with an effort it knows", () => {
  const plan = reworkPlan();
  const stored = JSON.parse(JSON.stringify(plan));
  const old = previousParsePlan(stored);
  assert.ok(old.budget, "the previous parseBudget refused the rework's budget");
  assert.ok((PREVIOUS_EFFORTS as readonly string[]).includes(old.budget.effort));
  assert.equal(old.effort, plan.effort);
  // Every ceiling it enforces is the envelope's, not its tier's default.
  const envelope = plan.envelope!;
  assert.equal(old.budget.workers, envelope.workers);
  assert.equal(old.budget.rounds, envelope.rounds);
  assert.equal(old.budget.pages, envelope.pages);
  assert.equal(old.budget.toolCallsPerWorker, envelope.toolCallsPerWorker);
  assert.equal(old.budget.tokens, envelope.workerTokens);
  assert.equal(old.budget.wallClockMs, envelope.wallClockMs);
  assert.equal(old.budget.judgeCalls, envelope.judgeCalls);
  assert.equal(old.budget.startedAt, "2026-09-24T10:01:00.000Z");
  assert.deepEqual(previousPlanBudget(old), old.budget);
});

test("the previous build keeps the plan it knows and drops the rest", () => {
  const old = previousParsePlan(JSON.parse(JSON.stringify(reworkPlan())));
  assert.deepEqual(old.queries, reworkPlan().queries);
  assert.equal(old.confirmedAt, "2026-09-24T10:00:00.000Z");
  assert.equal((old as Record<string, unknown>).envelope, undefined);
});

test("a plan the previous build rewrote reads here as a legacy run bounded as before", () => {
  // Its next `moveState` strips what it did not know: the envelope goes, the budget stays.
  const rewritten = previousParsePlan(JSON.parse(JSON.stringify(reworkPlan())));
  const back = parsePlan(JSON.parse(JSON.stringify(rewritten)));
  assert.equal(back.envelope, undefined);
  assert.deepEqual(planBudget(back), rewritten.budget);
});

test("a plan written by the previous build reads here unchanged", () => {
  const legacy = previousParsePlan({
    queries: ["solar output uk 2025"],
    effort: "deep",
    budget: { effort: "deep", workers: 8, rounds: 3, pages: 320, startedAt: "2026-09-20T09:00:00.000Z" },
    confirmedAt: "2026-09-20T09:00:00.000Z",
  });
  const now = parsePlan(JSON.parse(JSON.stringify(legacy)));
  assert.equal(now.envelope, undefined);
  assert.equal(now.effort, "deep");
  assert.deepEqual(planBudget(now), legacy.budget);
});
