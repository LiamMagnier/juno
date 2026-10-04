import test from "node:test";
import assert from "node:assert/strict";
import { broadenedQueries, widenQuery } from "@/lib/research/broaden";
import { DIGEST_NOTICE, evidenceDigest } from "@/lib/research/digest";
import { parsePlan } from "@/lib/research/domain";
import { STAGE_RETRY_LIMIT, createResearchEngine } from "@/lib/research/engine";
import { isUsableReport, reportSections } from "@/lib/research/report-structure";
import { memoryStore } from "./fixtures/research-store";
import { USABLE_REPORT, plannerOutput, reworkDeps } from "./fixtures/research-deps";
import { serverOnlyIn } from "./fixtures/server-only-graph";

/*
 * RESEARCH_V2 §2: every way a normal run used to end with nothing now
 * recovers. F5 (an empty first sweep), F6 (a writer that cannot write) and
 * F7 (a stage that throws) are driven here end to end through the engine with
 * injected deps; the planner's ladder (F1–F4) is in
 * research-planner-structured.test.ts and research-planner-fallback.test.ts.
 */

const GOAL = "How do heat pumps cope with Nordic winters?";

const kinds = (events: Array<{ runId: string; kind: string; payload: unknown }>, runId: string, kind: string) =>
  events.filter((e) => e.runId === runId && e.kind === kind).map((e) => e.payload as Record<string, unknown>);

test("the new modules are importable without server-only", () => {
  assert.deepEqual(serverOnlyIn("src/lib/research/broaden.ts"), []);
  assert.deepEqual(serverOnlyIn("src/lib/research/digest.ts"), []);
});

// ── F5: the wider sweep ─────────────────────────────────────────────────────

test("widenQuery takes out quotes, operators, question words, filler and future years", () => {
  assert.equal(widenQuery('"Daikin Altherma 3" COP site:daikin.com 2031', { year: 2026 }), "Daikin Altherma 3 COP");
  assert.equal(widenQuery("How do heat pumps perform below freezing in 2026?", { year: 2026 }), "heat pumps perform below freezing 2026");
  assert.equal(widenQuery("What is the rated output of the very long named thing that keeps going", { maxTerms: 4 }), "rated output very long");
});

test("broadenedQueries: each question's key terms then the goal's, none already issued, at least two words", () => {
  const wide = broadenedQueries({
    goal: GOAL,
    questions: ["How do heat pumps perform below freezing?", "Why?", "How do heat pumps perform below freezing?"],
    alreadyIssued: ["HEAT PUMPS PERFORM BELOW FREEZING"],
    limit: 4,
    year: 2026,
  });
  assert.deepEqual(wide, ["heat pumps cope Nordic winters"]);
  assert.equal(broadenedQueries({ goal: GOAL, questions: [], alreadyIssued: [], limit: 0 }).length, 0);
});

test("F5: an empty first sweep is widened once, and the run carries on to a report", async () => {
  const { store, events } = memoryStore();
  const base = reworkDeps(store);
  const searched: string[] = [];
  const engine = createResearchEngine({
    ...base,
    async search(input) {
      searched.push(input.query);
      const widened = events.some((e) => e.kind === "follow_up_scheduled" && (e.payload as { reason?: string }).reason === "no_results");
      return widened ? base.search(input) : { hits: [], costMicroUsd: 1_000 };
    },
  });
  const run = await engine.start({ userId: "u", goal: GOAL, confirmation: "auto" });
  const done = await engine.drive({ runId: run.id, userId: "u" });
  assert.equal(done?.state, "completed");
  const scheduled = kinds(events, run.id, "follow_up_scheduled").filter((p) => p.reason === "no_results");
  assert.equal(scheduled.length, 1, "once");
  const wider = scheduled[0].queries as string[];
  assert.ok(wider.length > 0 && wider.length <= 4);
  assert.ok(wider.every((query) => searched.includes(query)), "the wider searches ran");
  assert.ok(parsePlan(done?.plan).broadenedAt);
  assert.ok(kinds(events, run.id, "error").some((p) => p.scope === "search" && p.recoverable === true), "and the activity says so");
});

test("F5: a second empty sweep fails no_sources, saying the searches were already widened", async () => {
  const { store, events } = memoryStore();
  const engine = createResearchEngine({
    ...reworkDeps(store),
    async search() {
      return { hits: [], costMicroUsd: 1_000 };
    },
  });
  const run = await engine.start({ userId: "u", goal: GOAL, confirmation: "auto" });
  const done = await engine.drive({ runId: run.id, userId: "u" });
  assert.equal(done?.state, "failed");
  assert.match(done?.error ?? "", /even after widening/);
  assert.equal(kinds(events, run.id, "follow_up_scheduled").filter((p) => p.reason === "no_results").length, 1);
  const finished = kinds(events, run.id, "run_finished")[0];
  assert.equal(finished?.reason, "no_sources");
});

// ── F6: the evidence digest ─────────────────────────────────────────────────

const SOURCES = [
  { id: "s1", url: "https://sintef.no/heat-pumps", title: "SINTEF field trial" },
  { id: "s2", url: "https://energy.example/costs", title: "Running costs (2026)" },
];
const OBJECTIVES = parsePlan({ objectives: plannerOutput().questions.map((q, i) => ({ id: `objective-${i + 1}`, question: q.question, status: "open", importance: 1, evidenceRequirements: [], childObjectiveIds: [] })) }).objectives;

test("the digest lays the findings under their questions, cited by citable position, and lists what stayed open", () => {
  const digest = evidenceDigest({
    goal: GOAL,
    plan: { objectives: OBJECTIVES, title: "Heat pumps in cold climates" },
    sources: SOURCES,
    findings: [
      { claim: "Seasonal COP stayed above 2.5 at -20C.", quote: "…", sourceId: "s1", objectiveId: "objective-1" },
      { claim: "Running costs fell 40% against oil.", quote: "…", sourceId: "s2", objectiveId: "objective-2" },
      { claim: "A finding whose page did not make the corpus.", quote: "…", sourceId: "gone", objectiveId: "objective-1" },
    ],
  });
  assert.ok(digest);
  assert.match(digest, /^<!-- juno:report title="Heat pumps in cold climates" -->\n# Heat pumps in cold climates/);
  assert.match(digest, /## How do heat pumps perform below freezing\?\n\n- Seasonal COP stayed above 2\.5 at -20C\. \[1\]/);
  assert.match(digest, /- Running costs fell 40% against oil\. \[2\]/);
  assert.doesNotMatch(digest, /did not make the corpus/, "never cited by a number that points elsewhere");
  const gaps = digest.slice(digest.indexOf("juno:section=gaps"));
  assert.match(gaps, /Where do field trials and vendors disagree\?/, "the unanswered question is open");
  assert.match(digest, /\[Running costs %?\(?2026\)?\]\(https:\/\/energy\.example\/costs\)|\[Running costs \(2026\)\]\(https:\/\/energy\.example\/costs\)/);
  const sections = reportSections(digest);
  assert.ok(sections.some((s) => s.kind === "bottom-line"));
  assert.equal(sections.filter((s) => s.kind === "question").length, 3);
  assert.ok(isUsableReport(digest.slice(digest.indexOf("# "))));
});

test("the digest is null only when nothing at all could be read", () => {
  assert.equal(evidenceDigest({ goal: GOAL, plan: { objectives: OBJECTIVES }, sources: [], findings: [] }), null);
  assert.ok(evidenceDigest({ goal: GOAL, plan: { objectives: OBJECTIVES }, sources: SOURCES, findings: [] }));
  assert.match(DIGEST_NOTICE, /evidence/);
});

test("F6: a writer that never writes delivers the digest, with its findings cited, through the audit, as partially_completed", async () => {
  const { store, events } = memoryStore();
  let audited = "";
  let runId = "";
  let noted = false;
  const engine = createResearchEngine({
    ...reworkDeps(store),
    async synthesize(input) {
      if (!noted) {
        // The workers' notes, as a round would have left them.
        noted = true;
        const first = input.sources[0];
        await store.addFinding!({
          runId,
          userId: input.userId,
          workerId: "w1-1",
          round: 1,
          objectiveId: input.plan.objectives[0].id,
          sourceId: first.id,
          url: first.url,
          claim: "Seasonal COP stayed above 2.5 at -20C.",
          quote: "seasonal COP of 2.6",
          locator: null,
          confidence: 0.9,
        });
      }
      return { report: "", costMicroUsd: 1_000 };
    },
    async validateReport({ report }) {
      audited = report;
      return null;
    },
  });
  const run = await engine.start({ userId: "u", goal: GOAL, confirmation: "auto" });
  runId = run.id;
  const done = await engine.drive({ runId: run.id, userId: "u" });
  assert.equal(done?.state, "partially_completed");
  assert.equal(done?.error, DIGEST_NOTICE);
  assert.match(done?.report ?? "", /Seasonal COP stayed above 2\.5 at -20C\. \[1\]/);
  assert.equal(audited, done?.report, "the digest goes through the same audit");
  assert.ok(kinds(events, run.id, "report_ready").some((p) => p.digest === true));
  assert.equal(kinds(events, run.id, "report_revision").length, 0, "never sent back to the writer that could not write");
});

// ── F7: a stage that throws ─────────────────────────────────────────────────

test(`F7: a writer that throws is retried, and the ${STAGE_RETRY_LIMIT}rd failure delivers the digest instead of a fourth try`, async () => {
  const { store, events } = memoryStore();
  let calls = 0;
  const engine = createResearchEngine({
    ...reworkDeps(store),
    async synthesize() {
      calls += 1;
      throw new Error("provider 529 overloaded");
    },
  });
  const run = await engine.start({ userId: "u", goal: GOAL, confirmation: "auto" });
  const done = await engine.drive({ runId: run.id, userId: "u" });
  assert.equal(calls, STAGE_RETRY_LIMIT);
  assert.equal(done?.state, "partially_completed", "not a run that reads 'working' forever");
  const stage = kinds(events, run.id, "error").filter((p) => p.scope === "stage");
  assert.deepEqual(stage.map((p) => p.attempt), [1, 2, 3]);
  assert.ok(stage.every((p) => p.state === "synthesizing" && p.recoverable === true));
  assert.equal(parsePlan(done?.plan).digest, true);
});

test("F7: a stage that throws once is retried at once and the run completes; the count is cleared", async () => {
  const { store } = memoryStore();
  let calls = 0;
  const engine = createResearchEngine({
    ...reworkDeps(store),
    async synthesize() {
      calls += 1;
      if (calls === 1) throw new Error("ECONNRESET");
      return { report: USABLE_REPORT, costMicroUsd: 1_000 };
    },
  });
  const run = await engine.start({ userId: "u", goal: GOAL, confirmation: "auto" });
  const done = await engine.drive({ runId: run.id, userId: "u" });
  assert.equal(calls, 2);
  assert.equal(done?.state, "completed");
  assert.equal(parsePlan(done?.plan).stageFailures, undefined);
});

test("F7: a review that keeps throwing writes with the sources already read", async () => {
  const { store, events } = memoryStore();
  let progressCalls = 0;
  const flaky = {
    ...store,
    async progress(runId: string, userId: string) {
      const row = await store.loadRun(runId, userId);
      if (row?.state === "reviewing" && progressCalls < STAGE_RETRY_LIMIT) {
        progressCalls += 1;
        throw new Error("connection terminated");
      }
      return store.progress(runId, userId);
    },
  };
  const engine = createResearchEngine({ ...reworkDeps(flaky), store: flaky });
  const run = await engine.start({ userId: "u", goal: GOAL, confirmation: "auto" });
  const done = await engine.drive({ runId: run.id, userId: "u" });
  assert.equal(progressCalls, STAGE_RETRY_LIMIT);
  assert.equal(done?.state, "completed", "the writer wrote from what was read");
  const stage = kinds(events, run.id, "error").filter((p) => p.scope === "stage");
  assert.match(String(stage.at(-1)?.message), /Writing with the sources already read/);
});

test("F7: an aborted drive is the caller leaving, not a stage failure", async () => {
  const { store, events } = memoryStore();
  const controller = new AbortController();
  const engine = createResearchEngine({
    ...reworkDeps(store),
    async synthesize() {
      controller.abort();
      throw new Error("aborted");
    },
  });
  const run = await engine.start({ userId: "u", goal: GOAL, confirmation: "auto" });
  const left = await engine.drive({ runId: run.id, userId: "u", signal: controller.signal });
  assert.equal(left?.state, "synthesizing");
  assert.equal(kinds(events, run.id, "error").filter((p) => p.scope === "stage").length, 0);
});

// ── §6: the usage windows are the run's money limit ─────────────────────────

test("§6: a usage window spent mid-run stops the rounds and the run writes with what it has", async () => {
  const { store, events } = memoryStore();
  let asked = 0;
  let followUpsWithoutWindow = 0;
  const demanding = plannerOutput({
    questions: plannerOutput().questions.map((q) => ({ ...q, evidence: { minSources: 4, primary: true } })),
  });
  // Control: the same run with room in the window schedules follow-up rounds.
  {
    const control = memoryStore();
    const engine = createResearchEngine({ ...reworkDeps(control.store), async draftPlan() { return { ok: true, output: demanding, costMicroUsd: 0 }; } });
    const r = await engine.start({ userId: "u", goal: GOAL, confirmation: "auto" });
    await engine.drive({ runId: r.id, userId: "u" });
    followUpsWithoutWindow = kinds(control.events, r.id, "follow_up_scheduled").length;
  }
  assert.ok(followUpsWithoutWindow > 0, "the control run goes another round");
  const engine = createResearchEngine({
    ...reworkDeps(store),
    async draftPlan() {
      return { ok: true, output: demanding, costMicroUsd: 0 };
    },
    async windowSpent() {
      asked += 1;
      return true;
    },
  });
  const run = await engine.start({ userId: "u", goal: GOAL, confirmation: "auto" });
  const done = await engine.drive({ runId: run.id, userId: "u" });
  assert.ok(done?.report, "a report was written");
  assert.ok(done && ["completed", "partially_completed"].includes(done.state));
  assert.ok(parsePlan(done?.plan).windowSpentAt);
  const window = kinds(events, run.id, "error").filter((p) => p.scope === "window");
  assert.equal(window.length, 1, "said once");
  assert.equal(kinds(events, run.id, "follow_up_scheduled").length, 0, "no further rounds");
  assert.ok(asked >= 1);
});

test("§6: a window read that fails never stops a run that may have room", async () => {
  const { store } = memoryStore();
  const engine = createResearchEngine({
    ...reworkDeps(store),
    async windowSpent() {
      throw new Error("db down");
    },
  });
  const run = await engine.start({ userId: "u", goal: GOAL, confirmation: "auto" });
  const done = await engine.drive({ runId: run.id, userId: "u" });
  assert.equal(done?.state, "completed");
  assert.equal(parsePlan(done?.plan).windowSpentAt, undefined);
});
