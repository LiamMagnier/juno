import test from "node:test";
import assert from "node:assert/strict";
import {
  contentLanguage,
  draftResearchPlan,
  isTinyScope,
  looksLikeJson,
  parsePlannerOutput,
  plannedResearch,
  researchGoalContext,
  todayLine,
  typedConfirmationApplies,
  type PlannerCompletion,
} from "@/lib/research/planner";
import { PLANNER_RETRY_NOTE, RESEARCH_PLAN_SCHEMA } from "@/lib/research/planner.prompt";
import { PLANNER_OUTPUT_TOKENS, parsePlan } from "@/lib/research/domain";
import { createResearchEngine } from "@/lib/research/engine";
import { memoryStore } from "./fixtures/research-store";
import { TINY_PLAN, envelopeFor, plannerOutput, reworkDeps } from "./fixtures/research-deps";
import { readSource, serverOnlyIn } from "./fixtures/server-only-graph";

/*
 * SPEC §9.5, B5, DECISIONS R2: one structured call scopes the run; a reply
 * that does not validate is retried once and then fails as planner_invalid;
 * JSON-looking text is never searched as if it were lines; a tiny scope skips
 * the card; a web run never parks on a clarify form.
 */

const GOAL = "How do heat pumps cope with Nordic winters?";

test("the planner is importable without server-only", () => {
  assert.deepEqual(serverOnlyIn("src/lib/research/planner.ts"), []);
  assert.deepEqual(serverOnlyIn("src/lib/research/planner.prompt.ts"), []);
});

test("a schema-shaped reply parses; the output cap is 6,144 tokens (B5)", () => {
  const parsed = parsePlannerOutput(JSON.stringify(plannerOutput()));
  assert.ok(parsed);
  assert.equal(parsed.questions.length, 3);
  assert.deepEqual(parsed.scope, { breadth: "broad", freshness: "any", primarySources: true, quick: false });
  assert.equal(PLANNER_OUTPUT_TOKENS, 6_144);
  assert.equal(RESEARCH_PLAN_SCHEMA.name, "research_plan");
  // Fenced or prefixed replies still parse: the first balanced object is the reply.
  assert.ok(parsePlannerOutput("Here you go:\n```json\n" + JSON.stringify(plannerOutput()) + "\n```"));
});

test("a reply that is not a plan is null, never a partial plan", () => {
  assert.equal(parsePlannerOutput(""), null);
  assert.equal(parsePlannerOutput("1. heat pumps\n2. cold climates"), null);
  assert.equal(parsePlannerOutput(JSON.stringify({ ...plannerOutput(), questions: [] })), null);
  assert.equal(parsePlannerOutput(JSON.stringify({ ...plannerOutput(), scope: { breadth: "deep", freshness: "any" } })), null);
  // A truncated object — the B5 failure — does not parse.
  const cut = JSON.stringify(plannerOutput()).slice(0, 300);
  assert.equal(parsePlannerOutput(cut), null);
  assert.equal(looksLikeJson(cut), true, "and it is recognisably JSON, so no line parser may have it");
  assert.equal(looksLikeJson('  "question": "What is it?",'), true);
  assert.equal(looksLikeJson("heat pump cold climate field trials"), false);
});

test("an invalid first reply is retried once with the note and the schema; a second failure is planner_invalid", async () => {
  const calls: Array<Parameters<PlannerCompletion>[0]> = [];
  const complete: PlannerCompletion = async (request) => {
    calls.push(request);
    return { text: request.attempt === 1 ? '{"questions": [{"question": "What is' : JSON.stringify(plannerOutput()), costMicroUsd: 100 };
  };
  const ok = await draftResearchPlan({ goal: GOAL, constraints: [], pinnedSources: [], dateLine: "Today is x." }, complete);
  assert.equal(ok.ok, true);
  assert.equal(ok.costMicroUsd, 200, "both calls are billed");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.responseSchema === RESEARCH_PLAN_SCHEMA && call.maxTokens === PLANNER_OUTPUT_TOKENS));
  assert.ok(calls[1].prompt.endsWith(PLANNER_RETRY_NOTE));

  const never: PlannerCompletion = async () => ({ text: "not json", costMicroUsd: 50 });
  const failed = await draftResearchPlan({ goal: GOAL, constraints: [], pinnedSources: [], dateLine: "Today is x." }, never);
  assert.deepEqual(failed, { ok: false, reason: "planner_invalid", costMicroUsd: 100 });

  const controller = new AbortController();
  controller.abort();
  let aborted = 0;
  await draftResearchPlan(
    { goal: GOAL, constraints: [], pinnedSources: [], dateLine: "Today is x.", signal: controller.signal },
    async () => {
      aborted += 1;
      return { text: "", costMicroUsd: 0 };
    }
  );
  assert.equal(aborted, 1, "nobody is waiting for a retry");
});

test("the date line, the language and the context are in the planner's request (§9.3, §9.5)", async () => {
  let seen: Parameters<PlannerCompletion>[0] | null = null;
  const context = researchGoalContext([
    { role: "USER", content: "We are renovating a 1970s house in Tromsø." },
    { role: "ASSISTANT", content: "Good to know — what is your budget?" },
  ]);
  await draftResearchPlan(
    { goal: GOAL, context, constraints: ["EU sources only"], pinnedSources: [], dateLine: "Today is Thursday, 24 September 2026 (Europe/Oslo).", languageName: "Norwegian Bokmål" },
    async (request) => {
      seen = request;
      return { text: JSON.stringify(plannerOutput()), costMicroUsd: 0 };
    }
  );
  assert.ok(seen);
  const request = seen as Parameters<PlannerCompletion>[0];
  assert.match(request.system, /Today is Thursday, 24 September 2026 \(Europe\/Oslo\)\./);
  assert.match(request.system, /Write in Norwegian Bokmål\./);
  assert.match(request.prompt, /^How do heat pumps cope with Nordic winters\?/, "the goal is the user's own words, first");
  assert.match(request.prompt, /EU sources only/);
  assert.match(request.prompt, /Tromsø/);
});

test("the goal context is the last six turns, oldest first, capped and wrapped as untrusted (B20)", () => {
  const turns = Array.from({ length: 9 }, (_, i) => ({ role: (i % 2 ? "ASSISTANT" : "USER") as "USER" | "ASSISTANT", content: `turn ${i} ${"x".repeat(900)}` }));
  const context = researchGoalContext(turns)!;
  assert.match(context, /untrusted/i);
  assert.doesNotMatch(context, /turn 2 /, "only the last six");
  assert.ok(context.indexOf("turn 3") < context.indexOf("turn 8"), "oldest first");
  assert.ok(!context.includes("x".repeat(601)), "600 characters per turn");
  assert.equal(researchGoalContext([]), null);
});

test("the date line is frozen from the run's creation in the requester's zone, else UTC", () => {
  const at = new Date("2026-09-24T23:30:00.000Z");
  assert.equal(todayLine(at, "Asia/Tokyo"), "Today is Friday, 25 September 2026 (Asia/Tokyo).");
  assert.equal(todayLine(at, null), "Today is Thursday, 24 September 2026 (UTC).");
  assert.equal(todayLine(at, "Not/AZone"), "Today is Thursday, 24 September 2026 (UTC).");
});

test("content language: the explicit setting, else the question's language, else the UI locale (D-1 option C)", () => {
  assert.equal(contentLanguage({ explicit: "fr", planner: "de", uiLocale: "en" }), "fr");
  assert.equal(contentLanguage({ explicit: "auto", planner: "de", uiLocale: "en" }), "de");
  assert.equal(contentLanguage({ explicit: null, planner: "", uiLocale: "pt-br" }), "pt-BR");
  assert.equal(contentLanguage({}), "en");
});

test("the tiny scope is one question, at most three minutes and nothing to ask (R2)", () => {
  const scope = { questions: 1, breadth: "focused" as const, freshness: "any" as const, primarySources: false, quick: true };
  assert.equal(isTinyScope(scope, { minutesUpTo: 3, pagesUpTo: 4 }, 0), true);
  assert.equal(isTinyScope(scope, { minutesUpTo: 4, pagesUpTo: 4 }, 0), false);
  assert.equal(isTinyScope(scope, { minutesUpTo: 3, pagesUpTo: 4 }, 1), false);
  assert.equal(isTinyScope({ ...scope, questions: 2 }, { minutesUpTo: 3, pagesUpTo: 8 }, 0), false);
});

test("a revision keeps the reader's ids for the questions it kept", () => {
  const planned = plannedResearch(plannerOutput(), { keepIds: ["objective-7", undefined, "objective-7"] });
  assert.deepEqual(planned.objectives.map((o) => o.id), ["objective-7", "objective-2", "objective-3"]);
  assert.equal(planned.scope.questions, 3);
  // Every question is searched, in its own words when the planner wrote no query for it.
  assert.ok(planned.queries.some((q) => q.startsWith("Where do field trials and vendors disagree")));
});

test("a typed yes confirms only a fresh card that is the last thing asked (R3)", () => {
  const now = new Date("2026-09-24T10:10:00.000Z");
  const run = { state: "awaiting_plan_confirmation", draftedAt: "2026-09-24T10:00:00.000Z" };
  assert.equal(typedConfirmationApplies({ text: "yes", run, userMessagesSince: 0, now }), true);
  assert.equal(typedConfirmationApplies({ text: "Go ahead!", run, userMessagesSince: 0, now }), true);
  assert.equal(typedConfirmationApplies({ text: "yes, but only EU sources", run, userMessagesSince: 0, now }), false);
  assert.equal(typedConfirmationApplies({ text: "yes", run, userMessagesSince: 1, now }), false);
  assert.equal(typedConfirmationApplies({ text: "yes", run, userMessagesSince: 0, now: new Date("2026-09-24T10:31:00.000Z") }), false);
  assert.equal(typedConfirmationApplies({ text: "yes", run: { ...run, state: "investigating" }, userMessagesSince: 0, now }), false);
});

// ---------------------------------------------------------------------------
// The engine's half
// ---------------------------------------------------------------------------

test("a web run is planned in one call and waits at the card with its scope and estimate caps", async () => {
  const { store, events } = memoryStore();
  let clarify = 0;
  const engine = createResearchEngine({
    ...reworkDeps(store),
    async clarify() {
      clarify += 1;
      return { questions: [{ id: "q1", question: "Which country?", skippable: true }], costMicroUsd: 0 };
    },
    async draftPlan() {
      return { ok: true, output: plannerOutput({ clarifications: [{ id: "c1", question: "Which climate zone?", options: ["Arctic", "Temperate"] }] }), costMicroUsd: 0 };
    },
    async sizeRun({ purpose }) {
      return envelopeFor({ estimate: { minutesUpTo: purpose === "preview" ? 9 : 9, pagesUpTo: 24 } });
    },
  });
  const run = await engine.start({ userId: "u", goal: GOAL, confirmation: "required", timeZone: "Europe/Oslo", locale: "nb-NO" });
  const parked = await engine.drive({ runId: run.id, userId: "u" });
  assert.equal(parked?.state, "awaiting_plan_confirmation", "never awaiting_clarification");
  assert.equal(clarify, 0, "the merged gate replaces the clarify call");
  const plan = parsePlan(parked?.plan);
  assert.equal(plan.objectives.length, 3);
  assert.deepEqual(plan.steps, plan.objectives.map((o) => o.question));
  assert.equal(plan.clarifications?.[0].id, "c1", "the optional questions ride the card");
  assert.equal(plan.scope?.questions, 3);
  assert.deepEqual(plan.estimateCaps, envelopeFor().caps);
  assert.equal(plan.title, "Heat pumps in cold climates");
  assert.equal(plan.language, "en");
  assert.match(plan.today ?? "", /^Today is .* \(Europe\/Oslo\)\.$/);
  assert.equal(plan.envelope, undefined, "nothing is frozen before Start");
  assert.ok(events.some((e) => e.runId === run.id && e.kind === "plan_drafted"));
});

test("a tiny scope confirms itself, sized and frozen (R2)", async () => {
  const { store, events } = memoryStore();
  const engine = createResearchEngine({
    ...reworkDeps(store),
    async draftPlan() {
      return { ok: true, output: TINY_PLAN, costMicroUsd: 0 };
    },
    async sizeRun() {
      return envelopeFor({ workers: 1, rounds: 1, estimate: { minutesUpTo: 3, pagesUpTo: 4 } });
    },
  });
  const run = await engine.start({ userId: "u", goal: GOAL, confirmation: "required" });
  await engine.drive({ runId: run.id, userId: "u", until: "investigating" });
  const row = (await store.loadRun(run.id, "u"))!;
  assert.equal(row.state, "investigating");
  const plan = parsePlan(row.plan);
  assert.equal(plan.confirmation, "auto");
  assert.equal(plan.envelope?.workers, 1);
  assert.equal(row.budgetMicroUsd, BigInt(envelopeFor().ceilingMicroUsd));
  const confirmed = events.find((e) => e.runId === run.id && e.kind === "plan_confirmed");
  assert.deepEqual(confirmed?.payload, { by: "auto", tiny: true });
});

test("a planner that never validates fails the run as planner_invalid and searches nothing (B5)", async () => {
  const { store, events } = memoryStore();
  let searched = 0;
  const engine = createResearchEngine({
    ...reworkDeps(store),
    async draftPlan() {
      return { ok: false, reason: "planner_invalid", costMicroUsd: 3_000 };
    },
    async search(input) {
      searched += 1;
      return reworkDeps(store).search(input);
    },
  });
  const run = await engine.start({ userId: "u", goal: GOAL, confirmation: "required" });
  const done = await engine.drive({ runId: run.id, userId: "u" });
  assert.equal(done?.state, "failed");
  assert.equal(searched, 0);
  assert.equal(done?.costMicroUsd, BigInt(3_000), "the planner's calls are still billed");
  const finished = events.find((e) => e.runId === run.id && e.kind === "run_finished");
  assert.equal((finished?.payload as { reason?: string }).reason, "planner_invalid");
});

test("Start with edits: answers become constraints, questions become objectives, the envelope is frozen", async () => {
  const { store, events } = memoryStore();
  const sized: string[] = [];
  const engine = createResearchEngine({
    ...reworkDeps(store),
    async draftPlan() {
      return { ok: true, output: plannerOutput({ clarifications: [{ id: "c1", question: "Which climate zone?" }] }), costMicroUsd: 0 };
    },
    async sizeRun({ purpose, scope }) {
      sized.push(`${purpose}:${scope.questions}`);
      return envelopeFor({ ceilingMicroUsd: 4_000_000 });
    },
  });
  const run = await engine.start({ userId: "u", goal: GOAL, confirmation: "required" });
  await engine.drive({ runId: run.id, userId: "u" });
  const drafted = parsePlan((await store.loadRun(run.id, "u"))!.plan);
  const result = await engine.decidePlan({
    runId: run.id,
    userId: "u",
    decision: "confirm",
    questions: [
      { id: drafted.objectives[1].id, question: drafted.objectives[1].question },
      { question: "How loud are outdoor units at night?" },
    ],
    answers: { c1: "Arctic", bogus: "ignored" },
  });
  assert.deepEqual(result, { ok: true, state: "investigating" });
  const row = (await store.loadRun(run.id, "u"))!;
  const plan = parsePlan(row.plan);
  assert.deepEqual(sized, ["preview:3", "confirm:2"], "the envelope is computed at confirm time, from the edited scope");
  assert.deepEqual(plan.objectives.map((o) => o.question), [drafted.objectives[1].question, "How loud are outdoor units at night?"]);
  assert.equal(plan.objectives[0].id, drafted.objectives[1].id, "a kept question keeps its id");
  assert.equal(plan.scope?.questions, 2);
  assert.ok(plan.constraints.includes("Which climate zone? Arctic"));
  assert.ok(!plan.constraints.some((c) => c.includes("ignored")), "only answers to questions the plan asked");
  assert.ok(plan.queries.includes("How loud are outdoor units at night?"));
  assert.ok(plan.envelope);
  assert.equal(row.budgetMicroUsd, BigInt(4_000_000));
  assert.ok(events.some((e) => e.runId === run.id && e.kind === "plan_confirmed" && (e.payload as { edited?: boolean }).edited === true));
});

test("a refused sizing leaves the card where it is and says why", async () => {
  const { store } = memoryStore();
  let confirmAttempt = false;
  const engine = createResearchEngine({
    ...reworkDeps(store),
    async sizeRun({ purpose }) {
      if (purpose === "confirm") {
        confirmAttempt = true;
        return { refused: true as const, reason: "budget" as const, params: { resetsOn: "2026-10-01" } };
      }
      return envelopeFor();
    },
  });
  const run = await engine.start({ userId: "u", goal: GOAL, confirmation: "required" });
  await engine.drive({ runId: run.id, userId: "u" });
  const result = await engine.decidePlan({ runId: run.id, userId: "u", decision: "confirm" });
  assert.ok(confirmAttempt);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "refused");
  assert.equal(result.refusal?.reason, "budget");
  assert.equal((await store.loadRun(run.id, "u"))?.state, "awaiting_plan_confirmation");
});

test("revise reruns the planner with the edits, stays on the card, and stops at five (§9.4)", async () => {
  const { store, events } = memoryStore();
  const revisions: Array<{ questions: string[]; answers: Array<{ question: string; answer: string }> } | null | undefined> = [];
  const engine = createResearchEngine({
    ...reworkDeps(store),
    async draftPlan(input) {
      revisions.push(input.revision);
      return {
        ok: true,
        output: plannerOutput(
          input.revision
            ? { title: "Revised", clarifications: [], questions: [{ question: input.revision.questions[0] ?? "Fallback question here?", rationale: "r", evidence: { minSources: 1, primary: false } }] }
            : { clarifications: [{ id: "c1", question: "Which climate zone?" }] }
        ),
        costMicroUsd: 1_000,
      };
    },
  });
  const run = await engine.start({ userId: "u", goal: GOAL, confirmation: "required" });
  await engine.drive({ runId: run.id, userId: "u" });
  const drafted = parsePlan((await store.loadRun(run.id, "u"))!.plan);

  const asked = await engine.decidePlan({
    runId: run.id,
    userId: "u",
    decision: "revise",
    questions: [{ id: drafted.objectives[0].id, question: "How do air-to-water units cope below -25C?" }],
    answers: { c1: "Arctic" },
  });
  assert.deepEqual(asked, { ok: true, state: "awaiting_plan_confirmation" });
  assert.equal(parsePlan((await store.loadRun(run.id, "u"))!.plan).revising, true, "the card shows it is revising");
  const again = await engine.decidePlan({ runId: run.id, userId: "u", decision: "revise" });
  assert.equal(parsePlan((await store.loadRun(run.id, "u"))!.plan).revisions, 1, "a revise already in flight is the same request");
  assert.equal(again.ok, true);

  await engine.revisePlan({ runId: run.id, userId: "u" });
  const revised = (await store.loadRun(run.id, "u"))!;
  const plan = parsePlan(revised.plan);
  assert.equal(revised.state, "awaiting_plan_confirmation");
  assert.equal(plan.revising, undefined);
  assert.equal(plan.title, "Revised");
  assert.equal(plan.objectives[0].question, "How do air-to-water units cope below -25C?");
  assert.equal(plan.objectives[0].id, drafted.objectives[0].id);
  assert.deepEqual(revisions[1], { questions: ["How do air-to-water units cope below -25C?"], answers: [{ question: "Which climate zone?", answer: "Arctic" }] });
  assert.equal(revised.costMicroUsd, BigInt(2_000), "each planner call is billed");
  assert.ok(events.some((e) => e.runId === run.id && e.kind === "plan_revised"));

  for (let i = 0; i < 4; i += 1) {
    assert.equal((await engine.decidePlan({ runId: run.id, userId: "u", decision: "revise" })).ok, true);
    await engine.revisePlan({ runId: run.id, userId: "u" });
  }
  const sixth = await engine.decidePlan({ runId: run.id, userId: "u", decision: "revise" });
  assert.deepEqual(sixth, { ok: false, state: "awaiting_plan_confirmation", reason: "revise_limit" });
});

test("tools.ts plans through streamChat's responseSchema and never feeds JSON-looking text to the line parser", () => {
  const tools = readSource("src/lib/research/tools.ts");
  assert.match(tools, /responseSchema: request\.responseSchema/);
  assert.match(tools, /draftResearchPlan\(/);
  assert.match(tools, /if \(looksLikeJson\(text\)\) return \[\];/);
});
