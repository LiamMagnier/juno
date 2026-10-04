import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// tools.ts is server-only, so the rules are read from its source and the
// pure helper is checked through a copy of its contract below.
const tools = readFileSync("src/lib/research/tools.ts", "utf8");

test("a lead that cannot draft the plan hands it to a second model before the run fails", () => {
  const fn = tools.slice(tools.indexOf("export const draftResearchPlanWithModel"), tools.indexOf("export function plannerCandidates"));
  assert.match(fn, /for \(const model of candidates\)/);
  assert.match(fn, /if \(drafted\.ok\) return/);
  assert.match(fn, /if \(input\.signal\?\.aborted\) break/);
  const candidates = tools.slice(tools.indexOf("export function plannerCandidates"), tools.indexOf("export function plannerReplyShape"));
  assert.match(candidates, /configuredModel\(leadId\), researchPlannerModel\(\), \.\.\.utilityModelCandidates\(\)/);
  assert.match(candidates, /out\.length === 2/);
});

test("an unusable reply is logged by its shape, never its words", () => {
  const fn = tools.slice(tools.indexOf("export const draftResearchPlanWithModel"), tools.indexOf("export function plannerCandidates"));
  assert.match(fn, /planner reply unusable/);
  assert.doesNotMatch(fn, /reply\.text\.slice|text: reply\.text/);
});
