import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EMPTY_PLAN, parsePlan, type ResearchPlan } from "@/lib/research/domain";
import { activeWorkingMs, runModelsOf, RESEARCH_IDLE_GAP_MS } from "@/lib/research/view";
import { completedDuration, formatWorkedMs } from "@/components/research/run-format";
import { modelsLine } from "@/components/research/research-view";
import type { ResearchEnvelope } from "@/types/research";

/*
 * Two honesty bugs in one report: the reader said "30h 27m" for a run that
 * worked for about fifteen minutes, and "Written by" named a model the person
 * had not chosen. Time is now worked time from the run's own event log, and
 * every model shown is one the run recorded.
 */

const T0 = new Date("2026-10-09T08:00:00.000Z");
const MIN = 60_000;
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

test("completed duration counts only working stretches, never the night the run sat idle", () => {
  // Planned and investigated for 12 minutes, then nobody drove the run for
  // thirty hours (a restart, a lease waiting to be adopted), then it wrote for
  // three minutes and finished.
  const events = [
    { at: at(0), state: "clarifying" },
    { at: at(1), state: "planning" },
    { at: at(2), state: "investigating" },
    { at: at(5) },
    { at: at(9) },
    { at: at(12) },
    // ...silence until the next morning.
    { at: at(12 + 30 * 60), state: "synthesizing" },
    { at: at(12 + 30 * 60 + 3), state: "validating_citations" },
    { at: at(12 + 30 * 60 + 4), state: "completed" },
  ];
  const worked = activeWorkingMs({ startedAt: T0, end: at(12 + 30 * 60 + 4), events });
  // 12 minutes of work, the idle night capped at one quiet stretch, 4 minutes to finish.
  assert.equal(worked, 12 * MIN + RESEARCH_IDLE_GAP_MS + 4 * MIN);
  assert.ok(worked < 30 * MIN, `worked ${worked / MIN} min`);
});

test("the plan gate and a pause are not work", () => {
  const events = [
    { at: at(0), state: "planning" },
    { at: at(2), state: "awaiting_plan_confirmation" },
    // Confirmed the next day.
    { at: at(2 + 20 * 60), state: "investigating" },
    { at: at(2 + 20 * 60 + 5), state: "paused" },
    { at: at(2 + 20 * 60 + 65), state: "investigating" },
    { at: at(2 + 20 * 60 + 70), state: "completed" },
  ];
  const worked = activeWorkingMs({ startedAt: T0, end: at(2 + 20 * 60 + 70), events });
  assert.equal(worked, 2 * MIN + 5 * MIN + 5 * MIN);
});

test("a live run counts to now, capped at one quiet stretch", () => {
  const events = [{ at: at(0), state: "investigating" }, { at: at(3) }];
  assert.equal(activeWorkingMs({ startedAt: T0, end: at(4), events }), 4 * MIN);
  assert.equal(activeWorkingMs({ startedAt: T0, end: at(3 + 600), events }), 3 * MIN + RESEARCH_IDLE_GAP_MS);
});

test("the recap shows worked time, not first ask to last word", () => {
  assert.equal(completedDuration({ finishedAt: at(1830).toISOString(), workingMs: 17 * MIN }), "17 min");
  assert.equal(completedDuration({ finishedAt: null, workingMs: 17 * MIN }), null);
  // No figure from the server: no time, rather than a wrong one.
  assert.equal(completedDuration({ finishedAt: at(10).toISOString() }), null);
  assert.equal(formatWorkedMs(30 * 60 * MIN + 27 * MIN), "30h 27m");
  assert.equal(formatWorkedMs(42_000), "42s");
});

const ENVELOPE: ResearchEnvelope = {
  v: 1,
  ceilingMicroUsd: 2_000_000,
  reserve: { writerMicroUsd: 1, auditMicroUsd: 1 },
  workers: 3,
  rounds: 2,
  toolCallsPerWorker: 20,
  pages: 40,
  resultsPerQuery: 20,
  engines: ["exa"],
  workerTokens: 1000,
  wallClockMs: 30 * MIN,
  workerWallClockMs: 10 * MIN,
  judgeCalls: 10,
  leadModel: "gpt-5-pro",
  limitedBy: "scope",
  estimate: { minutesUpTo: 12, pagesUpTo: 40 },
  caps: { maxWorkers: 3, maxRounds: 2, maxPages: 40, maxMinutes: 30, secondsPerPage: 6, fixedMinutes: 2 },
};
const LABELS: Record<string, string> = { "gpt-5-pro": "GPT-5 Pro", "claude-haiku": "Claude Haiku 4.5", "claude-fable": "Claude Fable 5.1" };
const labelOf = (id: string) => LABELS[id] ?? id;
const plan = (patch: Partial<ResearchPlan>): ResearchPlan => ({ ...EMPTY_PLAN, ...patch });

test("an older run with no recorded writer shows no model at all", () => {
  // The envelope's lead is all an older run has; it is not proof of who wrote.
  const old = runModelsOf(plan({ envelope: { ...ENVELOPE, leadModel: "claude-fable" } }), labelOf);
  assert.equal(old.leadModel, null);
  assert.equal(old.models, null);
});

test("a chosen model that ran everything is named once, and wrote the report", () => {
  const recorded = runModelsOf(
    plan({ envelope: { ...ENVELOPE, workerModel: "gpt-5-pro", chosen: true }, writtenBy: "gpt-5-pro" }),
    labelOf
  );
  assert.deepEqual(recorded.leadModel, { id: "gpt-5-pro", label: "GPT-5 Pro" });
  const line = modelsLine(recorded.models, true);
  assert.deepEqual(line, [{ parts: [{ phrase: "Ran on" }, { kind: "label", value: "GPT-5 Pro" }] }]);
});

test("a chosen model without tools says who searched instead, and why", () => {
  const recorded = runModelsOf(
    plan({ envelope: { ...ENVELOPE, workerModel: "claude-haiku", workerNote: "no_tools", chosen: true } }),
    labelOf
  );
  assert.deepEqual(modelsLine(recorded.models, false), [
    { parts: [{ phrase: "Running on" }, { kind: "label", value: "GPT-5 Pro" }] },
    { parts: [{ phrase: "Search by" }, { kind: "label", value: "Claude Haiku 4.5" }] },
    { parts: [{ kind: "label", value: "GPT-5 Pro" }, { phrase: "has no tool calling" }] },
  ]);
});

test("Auto names both the lead and the researchers", () => {
  const recorded = runModelsOf(plan({ envelope: { ...ENVELOPE, leadModel: "claude-fable", workerModel: "claude-haiku" } }), labelOf);
  assert.deepEqual(modelsLine(recorded.models, false), [
    { parts: [{ phrase: "Led by" }, { kind: "label", value: "Claude Fable 5.1" }] },
    { parts: [{ phrase: "Researchers on" }, { kind: "label", value: "Claude Haiku 4.5" }] },
  ]);
});

test("an evidence digest has no writer", () => {
  const recorded = runModelsOf(plan({ envelope: { ...ENVELOPE, workerModel: "gpt-5-pro", chosen: true }, writtenBy: "gpt-5-pro", digest: true }), labelOf);
  assert.equal(recorded.leadModel, null);
});

test("the recorded models survive the plan's round trip", () => {
  const parsed = parsePlan({
    ...EMPTY_PLAN,
    writtenBy: "gpt-5-pro",
    envelope: {
      ...ENVELOPE,
      workerModel: "claude-haiku",
      workerNote: "no_tools",
      chosen: true,
      rates: { lead: { inputMicroUsdPerToken: 15, outputMicroUsdPerToken: 120 }, worker: { inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 5 } },
    },
  });
  assert.equal(parsed.writtenBy, "gpt-5-pro");
  assert.equal(parsed.envelope?.workerModel, "claude-haiku");
  assert.equal(parsed.envelope?.workerNote, "no_tools");
  assert.equal(parsed.envelope?.chosen, true);
  assert.equal(parsed.envelope?.rates?.lead.outputMicroUsdPerToken, 120);
});

test("every stage of a run reads the model the run recorded (source contract)", () => {
  const worker = readFileSync("src/lib/research/agents/worker.ts", "utf8");
  const tools = readFileSync("src/lib/research/tools.ts", "utf8");
  const run = readFileSync("src/lib/research/run.ts", "utf8");
  const workers = readFileSync("src/lib/research/stages/workers.ts", "utf8");
  // A chosen model leads and researches unless it has no tools; no step-down.
  assert.match(worker, /if \(!limit\) return \{ lead: chosen, worker: chosen, workerNote: null, chosen: true, stepDown: null \}/);
  // Researchers run on the recorded worker model.
  assert.match(worker, /configuredResearchModel\(input\.workerModelId\)/);
  assert.match(workers, /workerModelId: plan\.envelope\.workerModel/);
  // Clarify, the legacy planner and the query expander run on the run's lead.
  for (const name of ["clarifyResearchGoal", "planResearchQueries", "expandResearchQueries"]) {
    const fn = tools.slice(tools.indexOf(`export const ${name}`), tools.indexOf(`export const ${name}`) + 600);
    assert.match(fn, /runLeadModel\(modelId\)/, name);
  }
  // Sizing and planning honour the person's choice; the citation judge runs on it.
  assert.match(run, /researchRunModels\(\{ plan: userPlan, preferred: input\.plan\.preferredLead \?\? null \}\)/);
  assert.match(run, /researchRunModels\(\{ plan: userPlan, preferred: input\.preferredLead \?\? null \}\)/);
  assert.match(run, /plan\.envelope\?\.chosen \? configuredResearchModel\(plan\.envelope\.leadModel\)/);
  // The completion names the recorded writer, never "the strongest configured".
  assert.doesNotMatch(run, /researchLeadModel\(\)\?\.id \|\| ""/);
});
