import test from "node:test";
import assert from "node:assert/strict";
import { IDLE_RUN, type PaneRun } from "@/lib/compare/pane-run";
import {
  buildCompareReport,
  compareReportFileName,
  compareReportToJson,
  compareReportToMarkdown,
  formatCost,
  LATE_START_MS,
  type ComparePaneEntry,
} from "@/lib/compare/report";
import { createRunSpec } from "@/lib/compare/run-spec";
import { AUTO_MODEL_ID } from "@/lib/auto-model";
import type { ModelInfo } from "@/lib/models";

/*
 * Master brief 4.3: the comparison as a record. Verdicts are drawn only from
 * measured latency and stated cost bases, never from estimates presented as
 * measurements, and the Markdown and JSON exports are built from the same
 * object the page's summary reads.
 */

const MODELS: Record<string, ModelInfo> = {
  "anthropic:claude-opus-5-5": { id: "anthropic:claude-opus-5-5", provider: "anthropic", providerModel: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true } as unknown as ModelInfo,
  "openai:gpt-6-luna": { id: "openai:gpt-6-luna", provider: "openai", providerModel: "gpt-6-luna", name: "GPT-6 Luna", reasoning: true } as unknown as ModelInfo,
  "google:gemini-3.1-flash-lite": { id: "google:gemini-3.1-flash-lite", provider: "google", providerModel: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", reasoning: false } as unknown as ModelInfo,
};
const resolve = (id: string) => MODELS[id];

const SPEC = createRunSpec({
  id: "spec-1",
  prompt: "Compare | pipes\nand lines",
  settings: { webSearch: true, reasoningEffort: "high" },
  timeZone: "UTC",
  now: new Date("2026-10-25T14:03:00.000Z"),
});

function run(partial: Partial<PaneRun>): PaneRun {
  return {
    ...IDLE_RUN,
    status: "done",
    specId: SPEC.id,
    inputFingerprint: SPEC.fingerprint,
    startedAt: 0,
    startOffsetMs: 0,
    finishReason: "stop",
    ...partial,
  };
}

function entries(): ComparePaneEntry[] {
  return [
    {
      paneId: "p1",
      modelId: "anthropic:claude-opus-5-5",
      run: run({
        requestedModelId: "anthropic:claude-opus-5-5",
        servedModelId: "anthropic:claude-opus-5-5",
        content: "Opus says [MDN](https://developer.mozilla.org/).",
        appliedEffort: "high",
        webSearchApplied: true,
        firstOutputAt: 900,
        firstAnswerAt: 1_500,
        finishedAt: 6_000,
        promptTokens: 1_000,
        completionTokens: 500,
        costUsd: 0.02,
        usageBasis: "reported",
        sources: [{ title: "MDN", url: "https://developer.mozilla.org/", snippet: "" }, { title: "Shared", url: "https://shared.example/x", snippet: "" }],
      }),
    },
    {
      paneId: "p2",
      modelId: "openai:gpt-6-luna",
      run: run({
        requestedModelId: "openai:gpt-6-luna",
        servedModelId: "openai:gpt-6-luna",
        content: "Luna answers.",
        appliedEffort: "high",
        webSearchApplied: true,
        firstOutputAt: 400,
        firstAnswerAt: 400,
        finishedAt: 3_000,
        promptTokens: 900,
        completionTokens: 300,
        costUsd: 0.004,
        usageBasis: "estimated",
        sources: [{ title: "Shared too", url: "https://www.shared.example/x/?utm_source=x", snippet: "" }],
      }),
    },
    {
      paneId: "p3",
      modelId: "google:gemini-3.1-flash-lite",
      run: run({
        requestedModelId: "google:gemini-3.1-flash-lite",
        servedModelId: "google:gemini-3.1-flash-lite",
        content: "Lite stopped",
        appliedEffort: null,
        webSearchApplied: false,
        startOffsetMs: 2_400,
        startedAt: 2_400,
        firstOutputAt: 2_600,
        finishedAt: 2_900,
        finishReason: "user_stopped",
        promptTokens: 900,
        completionTokens: 10,
        costUsd: 0.00001,
        usageBasis: "reported",
      }),
    },
  ];
}

const report = () => buildCompareReport({ spec: SPEC, panes: entries(), resolveModel: resolve, generatedAt: new Date("2026-10-25T14:05:00.000Z") });

test("the record carries the frozen input and confirms every pane sent it", () => {
  const r = report();
  assert.equal(r.schema, "alevr.compare.v1");
  assert.equal(r.input.prompt, SPEC.prompt);
  assert.equal(r.input.fingerprint, SPEC.fingerprint);
  assert.equal(r.input.reasoningEffortLabel, "High");
  assert.equal(r.input.sampling, "provider_default");
  assert.equal(r.identicalInput, true);
  const tampered = entries();
  tampered[1].run = { ...tampered[1].run, inputFingerprint: "different" };
  assert.equal(buildCompareReport({ spec: SPEC, panes: tampered, resolveModel: resolve }).identicalInput, false);
});

test("verdicts come from measured latency and priced cost, and say when a cost is an estimate", () => {
  const { summary } = report();
  // Lite's first output (200ms after ITS own start) is a real measurement even
  // though it was stopped later, and its late start does not count against it.
  assert.deepEqual(summary.fastestFirstOutput && [summary.fastestFirstOutput.label, summary.fastestFirstOutput.value], ["Gemini 3.1 Flash Lite", 200]);
  // Lite also ended soonest in wall-clock terms, but it was stopped: not a finish.
  assert.deepEqual(summary.fastestFinish && [summary.fastestFinish.label, summary.fastestFinish.value], ["GPT-6 Luna", 3_000]);
  assert.equal(summary.lowestCost?.label, "Gemini 3.1 Flash Lite");
  assert.equal(summary.lowestCost?.estimated, false);
  assert.equal(summary.lowestCost?.allReported, false, "Luna's cost is an estimate, so the field is mixed");
});

test("conditions that differ between panes are surfaced, not smoothed over", () => {
  const r = report();
  assert.equal(r.summary.effortsMatch, false, "Lite ran with no effort while the others ran High");
  assert.equal(r.summary.searchApplied, false, "Lite could not search");
  assert.deepEqual(r.summary.lateStarts, [{ label: "Gemini 3.1 Flash Lite", offsetMs: 2_400 }]);
  assert.ok(2_400 > LATE_START_MS);
  const lite = r.panes[2];
  assert.equal(lite.effort.label, "No thinking");
  assert.equal(lite.effort.honoured, false);
  assert.equal(lite.webSearch.applied, false);
  assert.ok(r.notes.some((n) => /effort differs/i.test(n)));
  assert.ok(r.notes.some((n) => /not every model could search/i.test(n)));
});

test("latency, usage and cost each state their basis", () => {
  const [opus, luna] = report().panes;
  assert.equal(opus.latency.basis, "measured_in_browser");
  assert.equal(opus.latency.firstOutputMs, 900);
  assert.equal(opus.latency.firstAnswerMs, 1_500);
  assert.equal(opus.latency.totalMs, 6_000);
  assert.deepEqual(opus.cost, { usd: 0.02, basis: "reported_usage" });
  assert.deepEqual(luna.cost, { usd: 0.004, basis: "estimated" });
  assert.equal(luna.usage.basis, "estimated");
});

test("citations are compared across panes in the record", () => {
  const r = report();
  const [opus, luna, lite] = r.panes;
  assert.equal(opus.citations.total, 2);
  assert.equal(opus.citations.shared, 1);
  assert.deepEqual(opus.citations.refs.find((ref) => ref.host === "shared.example")?.sharedWith, ["GPT-6 Luna"]);
  assert.equal(opus.citations.refs.find((ref) => ref.host === "developer.mozilla.org")?.inText, true);
  assert.equal(luna.citations.total, 1);
  assert.equal(lite.citations.total, 0);
  assert.equal(r.summary.citations.union, 2);
  assert.deepEqual(r.summary.citations.sharedByAll, [], "Lite cites nothing, so nothing is shared by all three");
  assert.deepEqual(r.summary.citations.sharedHosts, [{ host: "shared.example", labels: ["Claude Opus 5.5", "GPT-6 Luna"] }]);
});

test("a verdict needs at least two contenders; idle and other comparisons' panes are left out", () => {
  const panes = entries();
  panes[1].run = { ...IDLE_RUN };
  panes[2].run = { ...panes[2].run, specId: "an-older-spec" };
  const r = buildCompareReport({ spec: SPEC, panes, resolveModel: resolve });
  assert.equal(r.panes.length, 1);
  assert.equal(r.summary.fastestFirstOutput, null);
  assert.equal(r.summary.lowestCost, null);
  assert.equal(r.summary.effortsMatch, null);
});

test("a server-swapped model and an Auto pick are told apart", () => {
  const panes = entries().slice(0, 2);
  panes[0].run = { ...panes[0].run, servedModelId: "openai:gpt-6-luna" };
  panes[1] = { ...panes[1], modelId: AUTO_MODEL_ID, run: { ...panes[1].run, requestedModelId: AUTO_MODEL_ID } };
  const r = buildCompareReport({ spec: SPEC, panes, resolveModel: resolve });
  assert.equal(r.panes[0].model.changed, true);
  assert.deepEqual(r.summary.modelChanged, ["GPT-6 Luna"]);
  assert.equal(r.panes[1].model.auto, true);
  assert.equal(r.panes[1].model.changed, false, "Auto choosing is not a swap");
});

test("Markdown export: one table, estimates marked with ~, latency labelled as measured in the browser", () => {
  const md = compareReportToMarkdown(report());
  assert.match(md, /^# Model comparison/);
  assert.match(md, /> Compare \| pipes\n> and lines/, "the prompt is quoted line by line");
  assert.match(md, new RegExp(`Input fingerprint: \`${SPEC.fingerprint}\` \\(identical for every model\\)`));
  assert.match(md, /Gemini 3\.1 Flash Lite started 2\.4 s later/);
  const rows = md.split("\n").filter((line) => /^\| \d \|/.test(line));
  assert.equal(rows.length, 3);
  assert.match(rows[0], /\| Claude Opus 5\.5 \| High \| on \| 0\.9 s \| 6\.0 s \| 1,000 \/ 500 \| \$0\.020 \| 2 \| done \|/);
  assert.match(rows[1], /\| ~900 \/ 300 \| ~\$0\.0040 \|/, "an estimated cost and its tokens carry ~");
  assert.match(rows[2], /\| No thinking \| unavailable \|.*\| stopped \|/);
  assert.match(md, /Latency is measured in the browser/);
  assert.doesNotMatch(md, /measured cost|cost \(measured\)/i, "a cost is never called measured");
  assert.match(md, /Lowest cost: Gemini 3\.1 Flash Lite, <\$0\.0001 \(some costs are estimates\)/);
  assert.match(md, /### 1\. Claude Opus 5\.5 \(2, 1 only here\)/);
  assert.match(md, /\[Shared\]\(https:\/\/shared\.example\/x\) \(also GPT-6 Luna\)/);
  assert.match(md, /\[MDN\]\(https:\/\/developer\.mozilla\.org\/\) \(linked in the answer\)/);
  assert.match(md, /## Answers[\s\S]*### 2\. GPT-6 Luna\n\nLuna answers\./);
  assert.match(md, /## Notes/);
});

test("JSON export round-trips the record and names its file", () => {
  const r = report();
  const parsed = JSON.parse(compareReportToJson(r));
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(r)));
  assert.equal(parsed.panes[0].latency.basis, "measured_in_browser");
  assert.equal(compareReportFileName(r, "md"), "alevr-compare-20261025-1405.md");
  assert.equal(compareReportFileName(r, "json"), "alevr-compare-20261025-1405.json");
});

test("formatCost marks every non-reported basis as approximate", () => {
  assert.equal(formatCost(0.0123, "reported_usage"), "$0.012");
  assert.equal(formatCost(0.0123, "reported"), "$0.012");
  assert.equal(formatCost(0.0123, "estimated"), "~$0.012");
  assert.equal(formatCost(0.0123, null), "~$0.012");
  assert.equal(formatCost(null, "reported"), "—");
});
