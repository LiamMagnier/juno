import test from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_CONTROL_MESSAGE,
  decidePlanSchema,
  errorCodeForControlReason,
  researchControlSchema,
  startResearchSchema,
  statusForControlReason,
  steerResearchSchema,
  validLocale,
  validTimeZone,
} from "@/app/api/research/protocol";
import { EMPTY_PLAN, type ResearchPlan } from "@/lib/research/domain";
import {
  countsOf,
  dtoEffort,
  latestFindingsOf,
  phaseDetailFor,
  questionViews,
  researchPhaseFor,
  summaryOf,
  workingMsOf,
} from "@/lib/research/view";
import { envelopeFor } from "./fixtures/research-deps";
import { readSource, serverOnlyIn } from "./fixtures/server-only-graph";

/*
 * SPEC §9.4: the research API keeps every old body working and gains
 * revise, finish and guidance. The route handlers need a session, so the
 * exported schemas and the pure view builders are what is tested here, plus
 * a read of the routes as text for the wiring.
 */

test("the protocol and the view builders are importable without server-only", () => {
  assert.deepEqual(serverOnlyIn("src/app/api/research/protocol.ts"), []);
  assert.deepEqual(serverOnlyIn("src/lib/research/view.ts"), []);
});

test("an old start body — a client budget and a depth — is accepted, and both are ignored by the route", () => {
  const old = startResearchSchema.safeParse({
    goal: "How do heat pumps cope with Nordic winters?",
    budgetMicroUsd: "8000000",
    effort: "deep",
    conversationId: "c1",
  });
  assert.equal(old.success, true);
  const route = readSource("src/app/api/research/route.ts");
  assert.match(route, /research\.start\.client_budget_ignored/);
  assert.match(route, /research\.start\.effort_ignored/);
  assert.doesNotMatch(route, /budgetMicroUsd: parsed\.data\.budgetMicroUsd/, "the client's ceiling never reaches the run");
  assert.doesNotMatch(route, /^\s+effort: parsed\.data\.effort,?$/m, "nor its depth");
  assert.match(route, /researchEntitlement\(/);
  assert.match(route, /confirmation: "required"/);
});

test("the start body gains timeZone, locale and language, and a bad value is dropped, not a 400", () => {
  const parsed = startResearchSchema.parse({
    goal: "How do heat pumps cope with Nordic winters?",
    timeZone: "Europe/Oslo",
    locale: "nb-no",
    language: 42,
  });
  assert.equal(parsed.timeZone, "Europe/Oslo");
  assert.equal(parsed.language, undefined);
  assert.equal(validTimeZone("Europe/Oslo"), "Europe/Oslo");
  assert.equal(validTimeZone("Mars/Olympus"), undefined);
  assert.equal(validLocale("nb-no"), "nb-NO");
  assert.equal(validLocale("not a tag"), undefined);
});

test("the plan decision gains revise, questions and answers; old steps and queries still parse", () => {
  assert.equal(decidePlanSchema.safeParse({ decision: "revise" }).success, true);
  assert.equal(
    decidePlanSchema.safeParse({
      decision: "confirm",
      questions: [{ id: "objective-1", question: "How cold is too cold?" }, { question: "What does it cost?" }],
      answers: { c1: "Arctic" },
    }).success,
    true
  );
  assert.equal(decidePlanSchema.safeParse({ decision: "confirm", steps: ["Read the field trials."], queries: ["heat pump trial"] }).success, true);
  // 1–8 questions, each ≤ 300 characters.
  assert.equal(decidePlanSchema.safeParse({ decision: "confirm", questions: [] }).success, false);
  assert.equal(decidePlanSchema.safeParse({ decision: "confirm", questions: Array.from({ length: 9 }, () => ({ question: "Why is that?" })) }).success, false);
  assert.equal(decidePlanSchema.safeParse({ decision: "confirm", questions: [{ question: "x".repeat(301) }] }).success, false);
  assert.equal(decidePlanSchema.safeParse({ decision: "maybe" }).success, false);
});

test("steer takes guidance of up to 1,000 characters, alone or with the old fields", () => {
  assert.equal(steerResearchSchema.safeParse({ guidance: "Prefer EU sources" }).success, true);
  assert.equal(steerResearchSchema.safeParse({ constraint: "EU only" }).success, true);
  assert.equal(steerResearchSchema.safeParse({ sourceUrl: "https://example.eu/report" }).success, true);
  assert.equal(steerResearchSchema.safeParse({ guidance: "x".repeat(1_001) }).success, false);
  assert.equal(steerResearchSchema.safeParse({}).success, false);
  assert.match(readSource("src/app/api/research/[id]/steer/route.ts"), /queued: true, appliesAt: "next_round"/);
});

test("control gains finish; a sixth revision is 429 research.revise_limit", () => {
  assert.equal(researchControlSchema.safeParse({ action: "finish" }).success, true);
  assert.equal(researchControlSchema.safeParse({ action: "restart" }).success, false);
  assert.equal(statusForControlReason("revise_limit"), 429);
  assert.equal(errorCodeForControlReason("revise_limit"), "research.revise_limit");
  assert.equal(statusForControlReason("not_found"), 404);
  assert.equal(statusForControlReason("not_running"), 409);
  assert.equal(statusForControlReason("refused"), 402);
  for (const message of Object.values(RESEARCH_CONTROL_MESSAGE)) assert.doesNotMatch(message, /deep/i);
  const control = readSource("src/app/api/research/[id]/control/route.ts");
  assert.match(control, /engine\.requestFinish\(/);
  const plan = readSource("src/app/api/research/[id]/plan/route.ts");
  assert.match(plan, /reviseResearchPlanInBackground\(/);
});

test("effort is null in the DTO for every run sized by scope (§9.4)", () => {
  const legacy: ResearchPlan = { ...EMPTY_PLAN, effort: "deep" };
  assert.equal(dtoEffort(legacy), "deep", "a pre-rework run keeps its tier");
  assert.equal(dtoEffort({ ...legacy, envelope: envelopeFor() }), null);
  assert.equal(dtoEffort({ ...legacy, scope: { questions: 3, breadth: "broad", freshness: "any", primarySources: false, quick: false } }), null);
});

test("the phase follows the state, and investigating says whether it is searching or reading", () => {
  assert.equal(researchPhaseFor("planning", null, false), "planning");
  assert.equal(researchPhaseFor("awaiting_plan_confirmation", null, false), "awaiting_start");
  assert.equal(researchPhaseFor("investigating", { kind: "query_issued", payload: { query: "heat pumps" } }, false), "searching");
  assert.equal(researchPhaseFor("investigating", { kind: "source_read", payload: { url: "https://www.sintef.no/x" } }, false), "reading");
  assert.equal(researchPhaseFor("synthesizing", null, false), "writing");
  assert.equal(researchPhaseFor("validating_citations", null, true), "checking");
  assert.equal(researchPhaseFor("paused", null, false), "paused");
  assert.equal(researchPhaseFor("partially_completed", null, true), "done");
  assert.equal(researchPhaseFor("partially_completed", null, false), "stopped");
  assert.equal(researchPhaseFor("cancelled", null, false), "stopped");
  assert.equal(researchPhaseFor("failed", null, false), "failed");
  assert.deepEqual(phaseDetailFor("searching", { kind: "query_issued", payload: { query: "heat  pumps" } }), { query: "heat pumps" });
  assert.deepEqual(phaseDetailFor("reading", { kind: "source_read", payload: { url: "https://www.sintef.no/x" } }), { domain: "sintef.no" });
});

test("questions carry their status; counts use one vocabulary; findings are the newest five", () => {
  const plan: ResearchPlan = {
    ...EMPTY_PLAN,
    objectives: [
      { id: "a", question: "A?", importance: 1, status: "covered", evidenceRequirements: [], childObjectiveIds: [] },
      { id: "b", question: "B?", importance: 0.9, status: "partially_covered", evidenceRequirements: [], childObjectiveIds: [] },
      { id: "c", question: "C?", importance: 0.8, status: "open", evidenceRequirements: [], childObjectiveIds: [] },
    ],
    issuedQueries: ["q1", "q2"],
    workerQueries: ["q3"],
    seedPagesRead: 4,
  };
  assert.deepEqual(questionViews(plan, "investigating").map((q) => q.status), ["covered", "partial", "searching"]);
  assert.deepEqual(questionViews(plan, "awaiting_plan_confirmation").map((q) => q.status), ["covered", "partial", "pending"]);
  assert.deepEqual(countsOf({ plan, sources: [{ read: true }, { read: false }, { read: true }], cited: 1 }), {
    found: 3,
    read: 2,
    cited: 1,
    searches: 3,
    pages: 4,
  });
  const findings = Array.from({ length: 7 }, (_, i) => ({
    id: `f${i}`,
    workerId: "w",
    round: 1,
    objectiveId: null,
    sourceId: i === 6 ? "s1" : null,
    url: `https://example.com/${i}`,
    claim: `claim ${i}`,
    quote: `quote ${i}`,
    locator: null,
    confidence: null,
    createdAt: new Date(Date.UTC(2026, 8, 24, 10, i)),
  }));
  const latest = latestFindingsOf(findings, [{ id: "s1", url: "https://src.example/one", title: "Source One" }]);
  assert.equal(latest.length, 5);
  assert.deepEqual(latest[0], { id: "f6", claim: "claim 6", quote: "quote 6", url: "https://src.example/one", title: "Source One" });
});

test("working time leaves out the gate and every pause (§9.4, B13)", () => {
  const createdAt = new Date("2026-09-24T10:00:00.000Z");
  const plan: ResearchPlan = {
    ...EMPTY_PLAN,
    draftedAt: "2026-09-24T10:01:00.000Z",
    confirmedAt: "2026-09-24T10:11:00.000Z",
    pausedMs: 5 * 60_000,
  };
  const now = new Date("2026-09-24T10:31:00.000Z");
  assert.equal(workingMsOf({ createdAt, finishedAt: null, state: "investigating" }, plan, now), 16 * 60_000);
  // At the gate, the clock stopped when the card appeared.
  const atGate = { ...EMPTY_PLAN, draftedAt: "2026-09-24T10:01:00.000Z" };
  assert.equal(workingMsOf({ createdAt, finishedAt: null, state: "awaiting_plan_confirmation" }, atGate, now), 60_000);
});

test("a summary row is the §9.4 shape", () => {
  const row = summaryOf({
    id: "r1",
    conversationId: "c1",
    state: "completed",
    plan: { ...EMPTY_PLAN, title: "Heat pumps" },
    goal: "How do heat pumps cope?",
    createdAt: new Date("2026-09-24T10:00:00.000Z"),
    finishedAt: new Date("2026-09-24T10:20:00.000Z"),
    assistantMessageId: "m1",
    hasReport: true,
    latest: null,
  });
  assert.deepEqual(row, {
    id: "r1",
    conversationId: "c1",
    state: "completed",
    phase: "done",
    title: "Heat pumps",
    createdAt: "2026-09-24T10:00:00.000Z",
    finishedAt: "2026-09-24T10:20:00.000Z",
    live: false,
    assistantMessageId: "m1",
  });
  const route = readSource("src/app/api/research/route.ts");
  assert.match(route, /searchParams\.get\("live"\) === "1"/);
  assert.match(route, /listResearchRunSummaries\(/);
});

test("the citations loader falls back to the run that points at the message", () => {
  const claims = readSource("src/lib/research/claims.ts");
  assert.match(claims, /where: \{ assistantMessageId: messageId, userId \}/);
  assert.match(claims, /kind: "run_completed"/);
});

test("reading a run never loads a snapshot to say whether it was read (research-UI bug 14)", () => {
  const run = readSource("src/lib/research/run.ts");
  assert.match(run, /\("snapshot" IS NOT NULL\) AS "read"/);
  assert.match(run, /listSourcesForView\(run\.id, run\.userId\)/);
});
