import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_FLOOR_EUR,
  MAX_RUN_PAGES,
  RESEARCH_PLAN_CAPS,
  isBudgetRefusal,
  researchBudgetFor,
  researchLeadCandidates,
  targetClaimsFor,
  type ResearchBudgetRefusal,
  type ResearchEnvelope,
  type ResearchRates,
  type SearchRoster,
} from "@/lib/research/envelope";
import {
  EMPTY_PLAN,
  RESEARCH_TIERS,
  budgetFromEnvelope,
  investigationElapsedMs,
  nearestEffort,
  parsePlan,
  planBudget,
  resumeStateFor,
  type ResearchPlan,
} from "@/lib/research/domain";
import { estimateFor } from "@/lib/research/estimate";
import type { ResearchScope } from "@/types/research";
import { serverOnlyIn } from "./fixtures/server-only-graph";

/*
 * The run's sizing (SPEC §9.2, DECISIONS R1): one envelope from the scope, the
 * plan and what is left of the month, frozen on the run. These pin the plan
 * caps, the ceiling formula, the step-down, the refusals, what `limitedBy`
 * says, and the legacy `plan.budget` every writer keeps for the previous build
 * (INV-22).
 */

const HAIKU = { inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 5 };
const SONNET = { inputMicroUsdPerToken: 3, outputMicroUsdPerToken: 15 };
const OPUS = { inputMicroUsdPerToken: 5, outputMicroUsdPerToken: 25 };
const RATES: ResearchRates = { worker: HAIKU, lead: SONNET, judge: HAIKU };
const ROSTER: SearchRoster = {
  engines: [
    { name: "tavily", microUsdPerQuery: 8_000 },
    { name: "brave", microUsdPerQuery: 5_000 },
  ],
};
const EUR_PER_USD = 0.92;
const eur = (value: number) => Math.round((value / EUR_PER_USD) * 1_000_000);
const PLENTY = { monthMicroUsd: 400_000_000, monthBudgetMicroUsd: 400_000_000 };

function scope(overrides: Partial<ResearchScope> = {}): ResearchScope {
  return { questions: 4, breadth: "broad", freshness: "any", primarySources: false, quick: false, ...overrides };
}

function size(overrides: Partial<Parameters<typeof researchBudgetFor>[0]> = {}) {
  return researchBudgetFor({
    scope: scope(),
    plan: "MAX20",
    remaining: PLENTY,
    rates: RATES,
    roster: ROSTER,
    liveRuns: 0,
    startsToday: 0,
    eurPerUsd: EUR_PER_USD,
    leadModel: "lead-model",
    ...overrides,
  });
}

function envelope(value: ResearchEnvelope | ResearchBudgetRefusal): ResearchEnvelope {
  assert.ok(!isBudgetRefusal(value), `expected an envelope, got ${JSON.stringify(value)}`);
  return value;
}

function refusal(value: ResearchEnvelope | ResearchBudgetRefusal): ResearchBudgetRefusal {
  assert.ok(isBudgetRefusal(value), `expected a refusal, got an envelope`);
  return value;
}

test("envelope.ts stays importable without server-only (§13 rule 2)", () => {
  assert.deepEqual(serverOnlyIn("src/lib/research/envelope.ts"), []);
  assert.deepEqual(serverOnlyIn("src/lib/research/domain.ts"), []);
});

test("the plan caps are the §9.2 table", () => {
  assert.equal(RESEARCH_PLAN_CAPS.FREE.entitled, false);
  assert.deepEqual(
    Object.fromEntries(
      (["PRO", "MAX", "MAX20", "OWNER"] as const).map((plan) => {
        const caps = RESEARCH_PLAN_CAPS[plan];
        return [plan, [caps.ceilingEur, caps.shareOfMonth, caps.liveRuns, caps.startsPerDay, caps.clockMinutes, caps.leadInputUsdPerMTokMax]];
      })
    ),
    {
      PRO: [2.5, 0.25, 1, 5, 15, 3],
      MAX: [8, 0.15, 2, 15, 30, 5],
      MAX20: [16, 0.15, 3, 30, 60, null],
      OWNER: [8, 0.5, 3, null, 60, null],
    }
  );
  assert.equal(CHAT_FLOOR_EUR, 0.25);
});

test("FREE is refused for its plan before anything is sized", () => {
  assert.equal(refusal(size({ plan: "FREE" })).reason, "plan");
});

test("live runs and daily starts refuse at the plan's cap", () => {
  assert.deepEqual(refusal(size({ plan: "PRO", liveRuns: 1 })), { refused: true, reason: "live_runs", params: { limit: 1 } });
  assert.equal(envelope(size({ plan: "MAX", liveRuns: 1 })).v, 1);
  assert.deepEqual(refusal(size({ plan: "MAX", startsToday: 15 })), { refused: true, reason: "daily_starts", params: { limit: 15 } });
  // OWNER has no daily limit.
  assert.equal(envelope(size({ plan: "OWNER", startsToday: 500 })).v, 1);
});

test("ceiling = min(plan cap, share × month, month left − chat floor, override)", () => {
  // The plan cap binds when the month is roomy.
  assert.equal(envelope(size({ plan: "MAX20" })).ceilingMicroUsd, eur(16));
  assert.equal(envelope(size({ plan: "PRO" })).ceilingMicroUsd, eur(2.5));

  // The share binds: 15% of a €40 month is €6, under MAX20's €16.
  const share = envelope(size({ remaining: { monthMicroUsd: eur(40), monthBudgetMicroUsd: eur(40) } }));
  assert.equal(share.ceilingMicroUsd, Math.floor(0.15 * eur(40)));

  // What is left of the month, less the chat floor, binds below both.
  const left = envelope(size({ remaining: { monthMicroUsd: eur(4), monthBudgetMicroUsd: eur(200) } }));
  assert.equal(left.ceilingMicroUsd, eur(4) - eur(CHAT_FLOOR_EUR));

  // The override clamps any plan, and replaces the cap for the owner.
  assert.equal(envelope(size({ overrideCeilingMicroUsd: 3_000_000 })).ceilingMicroUsd, 3_000_000);
  assert.equal(envelope(size({ plan: "OWNER", overrideCeilingMicroUsd: 12_000_000 })).ceilingMicroUsd, 12_000_000);
});

test("a disabled monthly cap leaves the plan cap as the ceiling", () => {
  const unmetered = envelope(size({ plan: "OWNER", remaining: { monthMicroUsd: null, monthBudgetMicroUsd: null } }));
  assert.equal(unmetered.ceilingMicroUsd, eur(8));
});

test("an unreduced scope is limitedBy scope; a reduced one names what bound it", () => {
  const tiny = envelope(size({ plan: "MAX20", scope: scope({ questions: 1, breadth: "focused" }) }));
  assert.equal(tiny.limitedBy, "scope");
  assert.equal(tiny.workers, 1);
  assert.equal(tiny.rounds, 1);

  const planBound = envelope(size({ plan: "PRO", scope: scope({ questions: 6, breadth: "exhaustive" }) }));
  assert.equal(planBound.limitedBy, "plan");

  const monthBound = envelope(
    size({ plan: "MAX20", scope: scope({ questions: 6, breadth: "exhaustive" }), remaining: { monthMicroUsd: eur(40), monthBudgetMicroUsd: eur(40) } })
  );
  assert.equal(monthBound.limitedBy, "month");
});

test("the fit reduces results, rounds and calls before workers, and never below half the questions", () => {
  const wide = envelope(size({ plan: "PRO", scope: scope({ questions: 8, breadth: "exhaustive" }) }));
  assert.ok(wide.workers >= 4, `workers ${wide.workers} fell below ⌈8 / 2⌉`);
  assert.equal(wide.resultsPerQuery, 8, "results per query are the first thing a thin ceiling trims");
  assert.equal(wide.rounds, 1, "rounds go before workers");
});

test("the fitted run's price, reserves included, stays under the ceiling", () => {
  for (const plan of ["PRO", "MAX", "MAX20", "OWNER"] as const) {
    for (const questions of [1, 3, 6, 8]) {
      const fitted = size({ plan, scope: scope({ questions, breadth: "exhaustive", primarySources: true }) });
      if (isBudgetRefusal(fitted)) continue;
      assert.ok(fitted.reserve.writerMicroUsd > 0 && fitted.reserve.auditMicroUsd > 0);
      assert.ok(fitted.reserve.writerMicroUsd + fitted.reserve.auditMicroUsd < fitted.ceilingMicroUsd);
      assert.ok(fitted.pages <= MAX_RUN_PAGES);
    }
  }
});

test("judge calls follow the scope's claims, 8 to 40", () => {
  assert.equal(envelope(size({ scope: scope({ questions: 1, breadth: "focused" }) })).judgeCalls, 8);
  assert.equal(envelope(size({ scope: scope({ questions: 4 }) })).judgeCalls, 24);
  assert.equal(envelope(size({ scope: scope({ questions: 8 }) })).judgeCalls, 40);
  assert.equal(targetClaimsFor(4), 40);
  assert.equal(targetClaimsFor(0), 10);
});

test("the estimate is estimateFor over the envelope's own caps, clamped to the plan clock", () => {
  for (const plan of ["PRO", "MAX", "MAX20"] as const) {
    const s = scope({ questions: 5, breadth: "exhaustive" });
    const fitted = envelope(size({ plan, scope: s }));
    assert.deepEqual(fitted.estimate, estimateFor(s, fitted.caps));
    assert.ok(fitted.estimate.minutesUpTo <= RESEARCH_PLAN_CAPS[plan].clockMinutes);
    assert.equal(fitted.caps.maxMinutes, RESEARCH_PLAN_CAPS[plan].clockMinutes);
    assert.equal(fitted.wallClockMs, RESEARCH_PLAN_CAPS[plan].clockMinutes * 60_000);
  }
  // The tiny scope the card may skip: one question, three minutes at most.
  const tiny = envelope(size({ scope: scope({ questions: 1, breadth: "focused" }) }));
  assert.equal(tiny.estimate.minutesUpTo, 3);
});

test("below the minimum viable run the lead steps down a class, else the run is refused", () => {
  const thin = { monthMicroUsd: 1_200_000, monthBudgetMicroUsd: 200_000_000 };
  const expensive: ResearchRates = { worker: HAIKU, lead: { inputMicroUsdPerToken: 40, outputMicroUsdPerToken: 200 }, judge: HAIKU };
  const refused = refusal(size({ plan: "MAX20", rates: expensive, remaining: { ...thin, resetsAtMs: Date.UTC(2026, 9, 1) } }));
  assert.equal(refused.reason, "budget");
  assert.equal(refused.params.resetsOn, "2026-10-01");
  assert.equal(refused.params.shareLeft, 1);

  const stepped = envelope(
    size({
      plan: "MAX20",
      rates: expensive,
      remaining: thin,
      scope: scope({ questions: 1, breadth: "focused" }),
      stepDown: { leadModel: "haiku-class", rates: HAIKU },
    })
  );
  assert.equal(stepped.leadModel, "haiku-class");
});

test("the lead is filtered by the plan's class and prefers the chat's own model", () => {
  const candidates = [
    { id: "haiku", inputUsdPerMTok: 1, outputUsdPerMTok: 5, intelligence: 2, cost: 1 },
    { id: "sonnet", inputUsdPerMTok: 3, outputUsdPerMTok: 15, intelligence: 3, cost: 2 },
    { id: "opus", inputUsdPerMTok: 5, outputUsdPerMTok: 25, intelligence: 4, cost: 3 },
    { id: "fable", inputUsdPerMTok: 10, outputUsdPerMTok: 50, intelligence: 5, cost: 4 },
  ];
  assert.equal(researchLeadCandidates(candidates, { plan: "PRO" }).lead?.id, "sonnet");
  assert.equal(researchLeadCandidates(candidates, { plan: "PRO" }).stepDown?.id, "haiku");
  assert.equal(researchLeadCandidates(candidates, { plan: "MAX" }).lead?.id, "opus");
  assert.equal(researchLeadCandidates(candidates, { plan: "MAX20" }).lead?.id, "fable");
  assert.equal(researchLeadCandidates(candidates, { plan: "MAX20", preferred: "sonnet" }).lead?.id, "sonnet");
  // A preferred model above the class is not taken.
  assert.equal(researchLeadCandidates(candidates, { plan: "PRO", preferred: "opus" }).lead?.id, "sonnet");
  assert.deepEqual(researchLeadCandidates([], { plan: "PRO" }), { lead: null, stepDown: null });
});

test("the legacy plan.budget carries the envelope's limits and the nearest tier (INV-22)", () => {
  const fitted = envelope(size({ plan: "MAX20", scope: scope({ questions: 8, breadth: "exhaustive" }) }));
  const budget = budgetFromEnvelope(fitted);
  assert.equal(budget.workers, fitted.workers);
  assert.equal(budget.rounds, fitted.rounds);
  assert.equal(budget.pages, fitted.pages);
  assert.equal(budget.tokens, fitted.workerTokens);
  assert.equal(budget.judgeCalls, fitted.judgeCalls);
  assert.equal(budget.effort, nearestEffort(fitted));

  assert.equal(nearestEffort({ workers: 1, rounds: 1 }), "quick");
  assert.equal(nearestEffort({ workers: 4, rounds: 2 }), "standard");
  assert.equal(nearestEffort({ workers: 8, rounds: 3 }), "deep");
  assert.equal(nearestEffort({ workers: 12, rounds: 3 }), "max");
  // Ties go to the smaller tier.
  const between = (RESEARCH_TIERS.quick.workers * RESEARCH_TIERS.quick.rounds + RESEARCH_TIERS.standard.workers * RESEARCH_TIERS.standard.rounds) / 2;
  assert.equal(nearestEffort({ workers: between, rounds: 1 }), "quick");
});

test("the engine reads every limit from the envelope when there is one", () => {
  const fitted = envelope(size({ plan: "MAX", scope: scope({ questions: 3 }) }));
  const plan: ResearchPlan = { ...EMPTY_PLAN, effort: "max", budget: { ...budgetFromEnvelope(fitted), effort: "max", workers: 99, startedAt: "2026-09-24T10:00:00.000Z" }, envelope: fitted };
  const limits = planBudget(plan);
  assert.equal(limits.workers, fitted.workers, "the legacy copy's own numbers never win over the envelope");
  assert.equal(limits.startedAt, "2026-09-24T10:00:00.000Z");
  // Without an envelope, the legacy budget is what bounds the run, as before.
  assert.equal(planBudget({ ...plan, envelope: undefined }).workers, 99);
});

test("a plan without envelope, budget or effort reads the budget without effort (parseBudget)", () => {
  const parsed = parsePlan({ queries: ["q one here"], budget: { workers: 8, rounds: 3, pages: 40 } });
  assert.equal(parsed.budget?.effort, "deep");
  assert.equal(parsed.budget?.pages, 40);
  assert.equal(parsePlan({ budget: { pages: 40 } }).budget, undefined);
});

test("paused time does not count against the investigation clock (B13)", () => {
  const plan: ResearchPlan = {
    ...EMPTY_PLAN,
    budget: { ...RESEARCH_TIERS.standard, startedAt: "2026-09-24T10:00:00.000Z" },
    pausedMs: 10 * 60_000,
  };
  const now = new Date("2026-09-24T10:30:00.000Z");
  assert.equal(investigationElapsedMs(plan, now), 20 * 60_000);
  const pausedNow = { ...plan, pausedAt: "2026-09-24T10:25:00.000Z" };
  assert.equal(investigationElapsedMs(pausedNow, now), 15 * 60_000);
});

test("resume goes back to the gate for a drafted plan and to the writer when it was told to write (B12)", () => {
  const base = { planConfirmed: false, queryCount: 0, sourceCount: 0, readCount: 0, passageCount: 0, hasReport: false };
  assert.equal(resumeStateFor(base), "planning");
  assert.equal(resumeStateFor({ ...base, planDrafted: true }), "awaiting_plan_confirmation");
  const working = { ...base, planConfirmed: true, queryCount: 4, sourceCount: 9 };
  assert.equal(resumeStateFor(working), "investigating");
  assert.equal(resumeStateFor({ ...working, readyToWrite: true }), "synthesizing");
  assert.equal(resumeStateFor({ ...working, hasReport: true }), "validating_citations");
});

test("parsePlan round-trips every field the rework writes (INV-22)", () => {
  const fitted = envelope(size({ plan: "MAX", scope: scope({ questions: 3 }) }));
  const plan: ResearchPlan = {
    ...EMPTY_PLAN,
    queries: ["first search query", "second search query"],
    confirmation: "required",
    confirmedAt: "2026-09-24T10:00:00.000Z",
    effort: nearestEffort(fitted),
    budget: budgetFromEnvelope(fitted),
    envelope: fitted,
    scope: scope({ questions: 3 }),
    estimateCaps: fitted.caps,
    title: "Heat pumps in cold climates",
    sourceKinds: ["field trials", "manufacturer data"],
    language: "fr",
    timeZone: "Europe/Paris",
    locale: "fr-FR",
    today: "Today is Thursday, 24 September 2026 (Europe/Paris).",
    context: "<untrusted>User: hi</untrusted>",
    draftedAt: "2026-09-24T09:59:00.000Z",
    revising: true,
    revisingAt: "2026-09-24T09:59:30.000Z",
    revisions: 2,
    pendingRevision: { questions: [{ id: "objective-1", question: "What do field trials show?" }, { question: "What does it cost to run?" }], answers: { c1: "Nordics" } },
    steering: [{ text: "Focus on EU data", appliedAtRound: null, createdAt: "2026-09-24T10:05:00.000Z" }, { text: "Skip vendors", appliedAtRound: 2, createdAt: "2026-09-24T10:06:00.000Z" }],
    finishRequestedAt: "2026-09-24T10:10:00.000Z",
    pausedAt: "2026-09-24T10:11:00.000Z",
    pausedMs: 42_000,
  };
  const round = parsePlan(JSON.parse(JSON.stringify(plan)));
  for (const key of [
    "envelope", "scope", "estimateCaps", "title", "sourceKinds", "language", "timeZone", "locale", "today", "context",
    "draftedAt", "revising", "revisingAt", "revisions", "pendingRevision", "steering", "finishRequestedAt", "pausedAt", "pausedMs",
    "budget", "effort", "confirmedAt",
  ] as const) {
    assert.deepEqual(round[key], plan[key], `${key} did not survive parsePlan`);
  }
});

test("a partial envelope is no envelope: the run reads as legacy (INV-22)", () => {
  const fitted = envelope(size());
  const { workers: _dropped, ...partial } = fitted;
  assert.equal(parsePlan({ envelope: partial }).envelope, undefined);
  assert.equal(parsePlan({ envelope: "nope" }).envelope, undefined);
});

test("rates below the lead's are what sizing prices the team at", () => {
  const cheap = envelope(size({ plan: "MAX", scope: scope({ questions: 6, breadth: "exhaustive" }), rates: { worker: HAIKU, lead: SONNET, judge: HAIKU } }));
  const dear = envelope(size({ plan: "MAX", scope: scope({ questions: 6, breadth: "exhaustive" }), rates: { worker: OPUS, lead: OPUS, judge: OPUS } }));
  assert.ok(dear.workers * dear.rounds * dear.toolCallsPerWorker <= cheap.workers * cheap.rounds * cheap.toolCallsPerWorker);
});
