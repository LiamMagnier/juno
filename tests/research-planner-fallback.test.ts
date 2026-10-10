import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// tools.ts is server-only, so the rules are read from its source and the
// pure helper is checked through a copy of its contract below.
const tools = readFileSync("src/lib/research/tools.ts", "utf8");

test("a lead that cannot draft the plan hands it to a second model, then to the plain-text planner (F3, F4)", () => {
  const fn = tools.slice(tools.indexOf("export const draftResearchPlanWithModel"), tools.indexOf("export function linesPlannerCandidates"));
  assert.match(fn, /for \(const \[index, model\] of candidates\.entries\(\)\)/);
  assert.match(fn, /if \(drafted\.ok\) return/);
  assert.match(fn, /if \(input\.signal\?\.aborted\) return \{ ok: false/);
  assert.match(fn, /onFallback\?\.\("second_model"\)/);
  assert.match(fn, /onFallback\?\.\("lines"\)/);
  assert.match(fn, /planFromLines\(reply\.text\)/);
  assert.match(fn, /plannedBy: "lines"/);
  // Every call is billed, the unusable ones too.
  assert.match(fn, /costMicroUsd \+= reply\.costMicroUsd/);
  const candidates = tools.slice(tools.indexOf("export function plannerCandidates"), tools.indexOf("export function plannerReplyShape"));
  assert.match(candidates, /configuredModel\(leadId\), researchPlannerModel\(\), \.\.\.utilityModelCandidates\(\)/);
  assert.match(candidates, /out\.length === 2/);
});

test("an unusable reply is logged by its shape, never its words", () => {
  const fn = tools.slice(tools.indexOf("export const draftResearchPlanWithModel"), tools.indexOf("export function linesPlannerCandidates"));
  assert.match(fn, /planner reply unusable/);
  assert.doesNotMatch(fn, /reply\.text\.slice|text: reply\.text/);
});

test("F2: the planner thinks lightly — the model's low tier, else its floor — on every planning call", () => {
  const effort = tools.slice(tools.indexOf("export function plannerReasoningEffort"), tools.indexOf("export const draftResearchPlanWithModel"));
  assert.match(effort, /caps\.tiers\.includes\("low"\)\) return "low"/);
  assert.match(effort, /REASONING_TIERS\.find/);
  const fn = tools.slice(tools.indexOf("export const draftResearchPlanWithModel"), tools.indexOf("export function linesPlannerCandidates"));
  assert.equal(fn.match(/reasoningEffort: /g)?.length, 2, "the structured attempts and the plain-text planner");
});

test("F6: the writer's retry runs on the second candidate model, unless the person chose the lead", () => {
  const writer = tools.slice(tools.indexOf("export const writeResearchReport"));
  assert.match(writer, /const pool = plannerCandidates\(plan\.envelope\?\.leadModel, \{ strict: !!plan\.envelope\?\.chosen \}\)/);
  assert.match(writer, /\(corpusScale < 1 \? pool\[1\] : undefined\) \?\? pool\[0\]/);
  // The model that wrote is reported, so "Written by" is recorded, not guessed.
  assert.match(writer, /model: model\.id/);
});

test("a chosen lead plans and writes alone: no second model behind it", () => {
  const candidates = tools.slice(tools.indexOf("export function plannerCandidates"), tools.indexOf("export function plannerReplyShape"));
  assert.match(candidates, /if \(opts\.strict\) \{\n    const lead = configuredModel\(leadId\);\n    return lead \? \[lead\] : \[\];/);
  const lines = tools.slice(tools.indexOf("export function linesPlannerCandidates"), tools.indexOf("export function plannerCandidates"));
  assert.match(lines, /if \(opts\.strict\) return tried\.slice\(0, 1\)/);
  const fn = tools.slice(tools.indexOf("export const draftResearchPlanWithModel"), tools.indexOf("export function linesPlannerCandidates"));
  assert.match(fn, /const strict = !!input\.leadModel && input\.leadModel === input\.preferredLead/);
});
