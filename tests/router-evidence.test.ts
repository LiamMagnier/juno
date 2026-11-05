import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { MODEL_LIST, type ModelInfo } from "@/lib/models";
import { OVER_BUDGET_REASON, decisionReasons, routeAuto, type RouteInput } from "@/lib/router/decide";
import {
  MIN_SAMPLES,
  PRIOR_ERROR_RATE,
  aggregateOutcomes,
  modelReliability,
  outcomeErrored,
  posterior,
  posteriorLatency,
  reliabilityFactor,
  shrink,
} from "@/lib/router/evidence";
import { receiptFromDecision, receiptSummary } from "@/lib/router/receipt";
import { TASK_CLASSES, type TaskClass } from "@/lib/router/task-class";
import { completionStateFor, endingSaysNothingAboutModel, outcomeTimings } from "@/lib/router/telemetry-rules";

/*
 * Auto learns from what it already records (master brief Part 4.2): thumbs,
 * regenerations, model switches, edits, errors and latency — the
 * RoutingOutcome columns — not only from the prompt's keywords. These pin:
 *
 *   - errors pool per model across task classes, so a model failing everywhere
 *     loses odds before any single (model, class) cell reaches the guard;
 *   - a believed cell is never double-counted with the pooled rate;
 *   - measured latency of completed turns replaces the latency prior;
 *   - when measurement changes the pick, the decision and the receipt say so;
 *   - endings the platform caused (a drain, a lost lease, the budget guard)
 *     are not evidence against a model.
 */

const byId = (id: string): ModelInfo => {
  const m = MODEL_LIST.find((x) => x.id === id);
  assert.ok(m, `catalogue has ${id}`);
  return m;
};

const POOL: ModelInfo[] = [
  "openai:gpt-6-luna",
  "openai:gpt-6.1-sol",
  "anthropic:claude-haiku-5-5",
  "anthropic:claude-sonnet-5-5",
  "google:gemini-3.8-flash",
  "xai:grok-4.7",
  "qwen:qwen3.8-flash",
].map(byId);

function route(message: string, extra: Partial<RouteInput> = {}) {
  return routeAuto({ message, plan: "PRO", catalogue: POOL, isConfigured: () => true, paidTier: new Set(["google"]), ...extra });
}

type Row = Parameters<typeof aggregateOutcomes>[0][number];
const row = (modelId: string, taskClass: TaskClass, over: Partial<Row> = {}): Row => ({
  modelId,
  taskClass,
  completionState: "completed",
  userRegenerated: false,
  userSwitchedModel: false,
  userEdited: false,
  feedback: null,
  toolRounds: 0,
  retryCount: 0,
  latencyMs: 2_000,
  costMicroUsd: 300,
  ...over,
});
const rows = (n: number, make: (i: number) => Row) => Array.from({ length: n }, (_, i) => make(i));

describe("what counts as an error", () => {
  test("failed and partial are errors; a Stop and a completed turn are not", () => {
    assert.equal(outcomeErrored({ completionState: "failed" }), true);
    assert.equal(outcomeErrored({ completionState: "partial" }), true);
    assert.equal(outcomeErrored({ completionState: "stopped" }), false);
    assert.equal(outcomeErrored({ completionState: "completed" }), false);
  });

  test("cells count errors, and latency only from completed turns", () => {
    const cell = aggregateOutcomes([
      row("m", "everyday", { latencyMs: 1_000 }),
      row("m", "everyday", { latencyMs: 3_000, feedback: "UP" }),
      row("m", "everyday", { completionState: "failed", latencyMs: 50 }),
      row("m", "everyday", { completionState: "partial", latencyMs: 9_000 }),
      row("m", "everyday", { completionState: "stopped", latencyMs: 400 }),
    ]).values().next().value!;
    assert.equal(cell.n, 5);
    assert.equal(cell.errors, 2);
    assert.equal(cell.successes, 2);
    assert.equal(cell.latencyN, 2, "a turn that failed fast says nothing about speed");
    assert.equal(cell.latencyMsSum, 4_000);
  });
});

describe("reliability pools across task classes", () => {
  test("below the guard nothing moves; above it the error rate is shrunk toward the prior", () => {
    assert.equal(reliabilityFactor(undefined), null);
    assert.equal(reliabilityFactor({ modelId: "m", n: MIN_SAMPLES - 1, errors: MIN_SAMPLES - 1 }), null);
    const atPrior = reliabilityFactor({ modelId: "m", n: 1000, errors: 1000 * PRIOR_ERROR_RATE })!;
    assert.ok(Math.abs(atPrior - 1) < 1e-9, "a model measured at the prior rate keeps its odds");
    const flaky = reliabilityFactor({ modelId: "m", n: 300, errors: 100 })!;
    const expected = (1 - shrink(100, 300, PRIOR_ERROR_RATE)) / (1 - PRIOR_ERROR_RATE);
    assert.equal(flaky, expected);
    assert.ok(flaky < 0.75);
    assert.ok(reliabilityFactor({ modelId: "m", n: 300, errors: 0 })! > 1, "a clean record is a small credit");
  });

  test("errors spread thin across classes still reach the pooled rate", () => {
    // 15 erroring turns in each of the nine classes: no cell reaches the
    // 20-sample guard, but the model has 135 turns and two-thirds failed.
    const spread = TASK_CLASSES.flatMap((taskClass) =>
      rows(15, (i) => row("openai:gpt-6-luna", taskClass, { completionState: i % 3 === 0 ? "completed" : "failed" }))
    );
    const table = aggregateOutcomes(spread);
    for (const cell of table.values()) assert.ok(cell.n < MIN_SAMPLES);
    const pooled = modelReliability(table).get("openai:gpt-6-luna")!;
    assert.deepEqual([pooled.n, pooled.errors], [135, 90]);

    const prior = { success: 0.9, toolRounds: 0, retries: 0.02 };
    const cell = table.get(`openai:gpt-6-luna\u0000everyday`);
    const post = posterior(cell, prior, pooled);
    assert.equal(post.source, "reliability");
    assert.equal(post.measured, false);
    assert.equal(post.n, 135);
    assert.ok(post.success < 0.9 * 0.7, String(post.success));
    assert.equal(post.toolRounds, prior.toolRounds);
  });

  test("a believed cell is used alone — its successes already count its errors", () => {
    const table = aggregateOutcomes([
      ...rows(40, () => row("m", "coding")),
      ...rows(200, () => row("m", "writing", { completionState: "failed" })),
    ]);
    const prior = { success: 0.8, toolRounds: 0, retries: 0.02 };
    const post = posterior(table.get(`m\u0000coding`), prior, modelReliability(table).get("m"));
    assert.equal(post.source, "measured");
    assert.equal(post.success, shrink(40, 40, 0.8));
  });

  test("the router moves off a model that fails across every class, before any cell is believed", () => {
    const before = route("hey, what's 2+2?");
    const failing = TASK_CLASSES.flatMap((taskClass) =>
      rows(MIN_SAMPLES - 1, () => row(before.model.id, taskClass, { completionState: "failed" }))
    );
    const after = route("hey, what's 2+2?", { evidence: aggregateOutcomes(failing) });
    assert.notEqual(after.model.id, before.model.id);
    const demoted = after.ranked.find((c) => c.modelId === before.model.id)!;
    assert.equal(demoted.evidence, "reliability");
    assert.equal(demoted.measured, false);
    assert.equal(demoted.samples, (MIN_SAMPLES - 1) * TASK_CLASSES.length);
    // And the receipt says measurement chose, naming the model it moved from.
    assert.equal(after.factors.evidence.shiftedFrom, before.model.id);
    assert.ok(after.reasons.some((r) => r.includes(`favoured it over ${before.model.name}`)), after.reasons.join(" | "));
    assert.match(receiptSummary(receiptFromDecision(after))!, /Results on similar Alevr requests tipped the choice/);
  });
});

describe("when price chose, measurement is never credited", () => {
  test("every provider down and nothing in budget: the cheapest call, with no shift claimed", () => {
    // Clean evidence for a model that is not the cheapest call, on a class
    // this prompt is not: it pools into that model's reliability, so the
    // measurement check would run.
    const evidence = aggregateOutcomes(rows(150, () => row("anthropic:claude-sonnet-5-5", "coding")));
    const hard =
      "Refactor this repository's auth module across multiple files to use a distributed session store, handle race conditions, and prove it correct step by step.";
    const d = route(hard, { isProviderAvailable: () => false, remainingBudgetMicroUsd: 0, evidence });
    assert.equal(d.degraded, "all_providers_unavailable", "every provider down stays the headline");
    assert.equal(d.priceOrdered, true);
    const cheapestCall = Math.min(...d.ranked.map((c) => c.callMicroUsd));
    assert.equal(d.ranked[0].callMicroUsd, cheapestCall, "price chose");
    assert.ok(d.ranked.some((c) => c.evidence !== "prior"), "some candidate carries evidence");
    // The case that used to lie: the priors alone pick another model.
    const byPrior = [...d.ranked].sort(
      (a, b) => a.priorTotalMicroUsd - b.priorTotalMicroUsd || a.modelId.localeCompare(b.modelId)
    )[0];
    assert.notEqual(byPrior.modelId, d.model.id);

    assert.equal(d.factors.evidence.shiftedFrom, null);
    assert.ok(!d.reasons.some((r) => /favoured it over|measured on|lowest expected cost/.test(r)), d.reasons.join(" | "));
    assert.ok(d.reasons.includes(OVER_BUDGET_REASON), d.reasons.join(" | "));
    const summary = receiptSummary(receiptFromDecision(d))!;
    assert.ok(!/tipped the choice|\bbest\b/.test(summary), summary);
    assert.match(summary, /^Every eligible provider was reporting trouble/);
  });

  test("low budget, nothing in budget and a measured cell: every decision fact is kept, none invented", () => {
    const before = route("hey, what's 2+2?", { lowBudget: true });
    const evidence = aggregateOutcomes(rows(150, () => row(before.model.id, before.profile.taskClass)));
    const d = route("hey, what's 2+2?", { lowBudget: true, remainingBudgetMicroUsd: 0, evidence });
    assert.equal(d.degraded, "over_budget");
    assert.equal(d.budgetSaver, true);
    assert.equal(d.priceOrdered, true);
    assert.ok(d.reasons.length <= 4, d.reasons.join(" | "));
    assert.ok(d.reasons.includes(OVER_BUDGET_REASON), d.reasons.join(" | "));
    assert.ok(d.reasons.includes("saving your remaining budget"), d.reasons.join(" | "));
    // Price chose: neither the expected-cost comparison nor the measurement is offered as why.
    assert.ok(!d.reasons.some((r) => /lowest expected cost|measured on|favoured it over/.test(r)), d.reasons.join(" | "));
    assert.equal(d.factors.evidence.shiftedFrom, null);
    assert.match(
      receiptSummary(receiptFromDecision(d))!,
      /^Nothing fit what's left of your budget, so Auto tried the lowest-cost model\./
    );
  });

  test("task signals give way before any decision fact", () => {
    const d = route("hey, what's 2+2?");
    const profile = { ...d.profile, signals: ["signal one", "signal two", "signal three"] };
    const winner = { ...d.ranked[0], measured: true, samples: 150 };
    const ranked = [winner, ...d.ranked.slice(1)];
    // Three facts (comparison, measurement, budget saver): one signal fits.
    const full = decisionReasons(profile, winner, ranked, null, { budgetSaver: true });
    assert.equal(full.length, 4);
    assert.deepEqual(full.slice(1), [
      `lowest expected cost of ${ranked.length} eligible models`,
      "measured on 150 similar Alevr turns",
      "saving your remaining budget",
    ]);
    assert.equal(full[0], "signal one");
    // Price-ordered: the budget line replaces the comparison and the measurement.
    const priced = decisionReasons(profile, winner, ranked, "over_budget", {
      budgetSaver: true,
      shiftedFrom: { modelId: "x", name: "X" },
    });
    assert.deepEqual(priced, ["signal one", "signal two", OVER_BUDGET_REASON, "saving your remaining budget"]);
  });
});

describe("quality signals the code records", () => {
  const signals: [string, Partial<Row>][] = [
    ["thumbs down", { feedback: "DOWN" }],
    ["regenerated", { userRegenerated: true }],
    ["switched model", { userSwitchedModel: true }],
    ["edited and re-sent", { userEdited: true }],
  ];
  for (const [name, over] of signals) {
    test(`${name} on this task class moves Auto off the model`, () => {
      const before = route("hey, what's 2+2?");
      const evidence = aggregateOutcomes(rows(150, () => row(before.model.id, before.profile.taskClass, over)));
      const after = route("hey, what's 2+2?", { evidence });
      assert.notEqual(after.model.id, before.model.id, name);
      assert.equal(after.factors.evidence.shiftedFrom, before.model.id);
    });
  }

  test("thumbs up and silence on many turns keep the pick, now measured", () => {
    const before = route("hey, what's 2+2?");
    const evidence = aggregateOutcomes(
      rows(150, (i) => row(before.model.id, before.profile.taskClass, { feedback: i % 2 ? "UP" : null }))
    );
    const after = route("hey, what's 2+2?", { evidence });
    assert.equal(after.model.id, before.model.id);
    assert.equal(after.factors.evidence.source, "measured");
    assert.equal(after.factors.evidence.samples, 150);
    assert.equal(after.factors.evidence.shiftedFrom, null, "measurement agreed with the prior");
    assert.ok(after.reasons.some((r) => r === "measured on 150 similar Alevr turns"), after.reasons.join(" | "));
  });

  test("a few bad turns are not enough (the sample guard)", () => {
    const before = route("hey, what's 2+2?");
    const evidence = aggregateOutcomes(rows(MIN_SAMPLES - 1, () => row(before.model.id, before.profile.taskClass, { feedback: "DOWN" })));
    const after = route("hey, what's 2+2?", { evidence });
    assert.equal(after.model.id, before.model.id);
    assert.equal(after.factors.evidence.source, "prior");
  });
});

describe("measured latency", () => {
  test("below the guard the prior stands; above it the completed-turn mean pulls the estimate", () => {
    const few = aggregateOutcomes(rows(MIN_SAMPLES - 1, () => row("m", "everyday", { latencyMs: 60_000 }))).values().next().value;
    assert.deepEqual(posteriorLatency(few, 3), { seconds: 3, measured: false });
    const many = aggregateOutcomes(rows(120, () => row("m", "everyday", { latencyMs: 60_000 }))).values().next().value;
    const post = posteriorLatency(many, 3);
    assert.equal(post.measured, true);
    assert.equal(post.seconds, shrink(120 * 60, 120, 3));
  });

  test("a model measured slow on small talk loses the latency it was credited with", () => {
    const before = route("hey, what's 2+2?");
    const slow = aggregateOutcomes(rows(200, () => row(before.model.id, "everyday", { latencyMs: 45_000 })));
    const after = route("hey, what's 2+2?", { evidence: slow });
    const scored = after.ranked.find((c) => c.modelId === before.model.id)!;
    const was = before.ranked.find((c) => c.modelId === before.model.id)!;
    assert.equal(scored.latencyMeasured, true);
    assert.ok(scored.expectedLatencyS > was.expectedLatencyS * 5, `${scored.expectedLatencyS} vs ${was.expectedLatencyS}`);
    assert.ok(scored.latencyMicroUsd > was.latencyMicroUsd);
  });
});

describe("telemetry honesty", () => {
  test("endings the platform caused are not evidence", () => {
    assert.equal(endingSaysNothingAboutModel({ shutdown: true }), true);
    assert.equal(endingSaysNothingAboutModel({ leaseLost: true }), true);
    assert.equal(endingSaysNothingAboutModel({ budgetHalted: true }), true);
    assert.equal(endingSaysNothingAboutModel({ shutdown: false, leaseLost: false, budgetHalted: false }), false);
    assert.equal(endingSaysNothingAboutModel(undefined), false);
    assert.equal(endingSaysNothingAboutModel(null), false);
  });

  test("finish reasons map onto the states the router learns from", () => {
    assert.equal(completionStateFor("stop", false), "completed");
    assert.equal(completionStateFor("tool_calls", false), "completed");
    assert.equal(completionStateFor("user_stopped", true), "stopped");
    assert.equal(completionStateFor("network_error", true), "partial");
    assert.equal(completionStateFor("error", false), "failed");
    assert.equal(completionStateFor("sensitive", false), "failed");
  });

  test("first token and turn length come from one start", () => {
    // The finished trace measured both from the chat route's start.
    assert.deepEqual(outcomeTimings({ latency: { totalMs: 4_200, ttftMs: 650 } }, 1_000, 99_999), {
      latencyMs: 4_200,
      firstTokenMs: 650,
    });
    // The pair once stored as 65 ms to first token on a 49 ms turn cannot recur.
    const mixed = outcomeTimings({ latency: { totalMs: 49, ttftMs: 65 } }, 0, 0);
    assert.ok(mixed.firstTokenMs! <= mixed.latencyMs, JSON.stringify(mixed));
    // A turn that never streamed text has no first token.
    assert.deepEqual(outcomeTimings({ latency: { totalMs: 900, ttftMs: null } }, 0, 0), { latencyMs: 900, firstTokenMs: null });
    // No trace: the turn's own clock, and the first token unknown rather than borrowed from another clock.
    assert.deepEqual(outcomeTimings(null, 1_000, 3_500), { latencyMs: 2_500, firstTokenMs: null });
  });
});
