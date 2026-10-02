import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildRunView, headlineOf } from "@/lib/run/timeline";
import { newestSentence } from "@/lib/run/excerpt";

import { T0, at, call, commentaryRow, factRow, message, noticeRow, row, segmentRow, source, toolRow } from "./fixtures/run-events";

/*
 * The client run model (SPEC §7.2): one message's activity, reasoning and
 * sources read into the ordered view the run block and the panel render.
 */

test("the run model stays importable from client components", () => {
  for (const file of ["src/lib/run/timeline.ts", "src/lib/run/legacy.ts", "src/lib/run/excerpt.ts"]) {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    assert.doesNotMatch(source, /^import "server-only";/m, file);
  }
});

const REASONING = "**Reading the question**\n\nThe user asks about heat pumps.\n\n**Checking numbers**\n\nCOP falls in the cold.";
const SECOND = REASONING.indexOf("**Checking numbers**");

function webTurn() {
  const search = call({
    callId: "jc_0_0",
    tool: "web_search",
    round: 1,
    startedAt: at(1_000),
    endedAt: at(1_900),
    args: { query: "heat pump cop winter" },
    figure: { kind: "results", n: 5 },
  });
  const readOk = call({
    callId: "jc_1_0",
    tool: "web_fetch",
    round: 2,
    startedAt: at(2_000),
    endedAt: at(2_800),
    web: { finalUrl: "https://energy.example.org/cop" },
  });
  const readFailed = call({
    callId: "jc_1_1",
    tool: "web_fetch",
    round: 2,
    index: 1,
    status: "failed",
    error: { code: "url_not_accessible" },
    startedAt: at(2_001),
    endedAt: at(2_300),
    web: { requestedUrl: "https://down.example.net/" },
  });
  const code = call({ callId: "jc_2_0", tool: "run_code", round: 3, startedAt: at(3_000), endedAt: at(4_000), figure: { kind: "files", n: 2 } });
  const doc = call({ callId: "jc_2_1", tool: "read_document", round: 3, index: 1, status: "running", args: { file: "brief.pdf" }, startedAt: at(3_000) });
  const github = call({ callId: "jc_2_2", tool: "mcp", round: 3, index: 2, connectorLabel: "GitHub", toolTitle: "Create issue" });
  const declined = call({ callId: "jc_2_3", tool: "mcp", round: 3, index: 3, connectorLabel: "Linear", status: "denied" });
  return [
    factRow(1, 0, { key: "model", modelId: "claude-x", provider: "anthropic", label: "Claude X" }),
    factRow(2, 1, { key: "tools", offered: ["web_search", "web_fetch", "run_code"], nativeSearch: false, roundBudget: 10 }),
    segmentRow(3, 100, 0, 0),
    segmentRow(4, 600, 0, SECOND),
    toolRow(5, 1_000, search),
    commentaryRow(6, 1_950, 1, "Let me read the top results.", true),
    toolRow(7, 2_000, readOk),
    toolRow(8, 2_001, readFailed),
    toolRow(9, 3_000, code),
    toolRow(10, 3_000, doc),
    toolRow(11, 3_000, github),
    toolRow(12, 3_000, declined),
    noticeRow(13, 3_500, { code: "finish_length" }),
    noticeRow(14, 3_600, { code: "tool_budget", params: { steps: 10 } }, "context"),
    row(15, 5_000, "write", "Writing the answer"),
    row(16, 9_000, "done", "Finished response"),
  ];
}

test("a typed message: items in seq order, reasoning sliced by segment", () => {
  const view = buildRunView(
    message(webTurn(), { reasoning: REASONING, sources: [source(1), source(2), { ...source(1) }] }),
  );
  assert.equal(view.typed, true);
  assert.deepEqual(
    view.items.map((item) => item.kind),
    ["reasoning", "reasoning", "tool", "commentary", "tool", "tool", "tool", "tool", "tool", "tool", "notice", "notice"],
  );
  const [first, second] = view.items;
  assert.equal(first.kind === "reasoning" && first.text, "**Reading the question**\n\nThe user asks about heat pumps.");
  assert.equal(second.kind === "reasoning" && second.text, "**Checking numbers**\n\nCOP falls in the cold.");
  assert.equal(first.kind === "reasoning" && first.live, false);
  assert.equal(second.kind === "reasoning" && second.live, true, "only the last reasoning item is live");
  assert.deepEqual(
    view.tools.map((item) => item.key),
    ["jc_0_0", "jc_1_0", "jc_1_1", "jc_2_0", "jc_2_1", "jc_2_2", "jc_2_3"],
  );
  assert.equal(view.tools[4].live, true, "a record without a terminal status is live");
  const commentary = view.items[3];
  assert.equal(commentary.kind === "commentary" && commentary.inline, true);
  const notices = view.items.filter((item) => item.kind === "notice");
  assert.deepEqual(notices.map((item) => item.kind === "notice" && item.notice?.code), ["finish_length", "tool_budget"]);
  assert.equal(view.facts.model?.key, "model");
  assert.equal(view.facts.tools?.key, "tools");
  assert.equal(view.hasReasoning, true);
});

test("counts: unique sources incl. fetched pages, searches, code, connectors, files, failures", () => {
  const view = buildRunView(message(webTurn(), { reasoning: REASONING, sources: [source(1), source(2), source(1)] }));
  assert.deepEqual(view.counts, {
    sources: 3, // two cited + the fetched page's final URL
    searches: 1,
    codeRuns: 1,
    filesCreated: 2,
    connectorsUsed: ["GitHub"], // a declined call never used Linear
    filesRead: [], // the read_document call has not succeeded yet
    failedTools: 1,
    warnings: 1, // only kind:"warning" rows; the context notice is informational
  });
});

test("timing is honest and derivable after reload", () => {
  const view = buildRunView(message(webTurn()));
  assert.equal(view.timing.startedAt, T0);
  assert.equal(view.timing.firstAnswerAt, T0 + 5_000);
  assert.equal(view.timing.endedAt, T0 + 9_000);
  assert.equal(view.timing.workedMs, 5_000, "until the first answer text");

  // A tool that runs after the answer began adds its own time, overlaps counted once.
  const late = [
    ...webTurn().slice(0, 15),
    toolRow(17, 6_000, call({ callId: "late_1", tool: "web_search", round: 4, startedAt: at(6_000), endedAt: at(7_000) })),
    toolRow(18, 6_500, call({ callId: "late_2", tool: "web_fetch", round: 5, startedAt: at(6_500), endedAt: at(7_500) })),
    row(19, 9_000, "done", "Finished response"),
  ];
  assert.equal(buildRunView(message(late)).timing.workedMs, 5_000 + 1_500);

  // No timestamps invented: without a write or done row and no `now`, nothing is known.
  const open = buildRunView(message(webTurn().slice(0, 5)));
  assert.equal(open.timing.workedMs, null);
  assert.equal(buildRunView(message(webTurn().slice(0, 5)), T0 + 1_500).timing.workedMs, 1_500);
});

test("pending approvals and the peek's newest steps", () => {
  const waiting = call({
    callId: "jc_3_0",
    tool: "mcp",
    status: "awaiting_approval",
    connectorLabel: "GitHub",
    approval: { id: "apr_1", status: "pending", riskClass: "external_write" },
  });
  const view = buildRunView(
    message([...webTurn().slice(0, 12), toolRow(20, 4_000, waiting), commentaryRow(21, 4_100, 4, "Declared up front.", false)]),
  );
  assert.deepEqual(view.pendingApprovalIds, ["apr_1"]);
  // Newest last; inline commentary is not a step (it renders under the peek), declared commentary is.
  assert.deepEqual(view.latestStepKeys, ["jc_2_3", "jc_3_0", "commentary:act_21"]);
});

test("reasoning with no segment markers is one item at the start", () => {
  const view = buildRunView(message([toolRow(1, 10, call({ callId: "a", tool: "calculate" }))], { reasoning: "  Just thinking.  " }));
  assert.equal(view.items[0].kind, "reasoning");
  assert.equal(view.items[0].kind === "reasoning" && view.items[0].text, "Just thinking.");
});

test("research completion fact and memory receipts are collected", () => {
  const view = buildRunView(
    message([
      factRow(1, 0, {
        key: "research",
        runId: "run_1",
        title: "Heat pumps",
        workedMs: 720_000,
        cited: 14,
        read: 40,
        pages: 120,
        leadModel: "Claude X",
        state: "completed",
      }),
      row(2, 1, "context", "Memory", {
        memoryReceipt: [{ id: "m1", content: "Prefers metric units" } as never],
      }),
    ]),
  );
  assert.equal(view.facts.research?.key, "research");
  assert.equal(view.facts.memory.length, 1);
});

test("an untyped message goes through the legacy adapter", () => {
  const view = buildRunView(message([{ id: "x", kind: "search", title: "Searching the web", detail: "q", createdAt: at(0) }]));
  assert.equal(view.typed, false);
  assert.equal(view.tools[0].call.tool, "provider_web_search");
});

test("the view ignores content: an answer token cannot change it", () => {
  const events = webTurn();
  const a = buildRunView({ ...message(events), content: "one" });
  const b = buildRunView({ ...message(events), content: "one two three" });
  assert.deepEqual(a, b);
});

test("provider headlines", () => {
  assert.equal(headlineOf("**Comparing climates**\n\nCOP falls…"), "Comparing climates");
  assert.equal(headlineOf("  **Short**"), "Short");
  assert.equal(headlineOf("**ab**"), null, "under 3 characters is not a headline");
  assert.equal(headlineOf("Plain opening line"), null);
  assert.equal(headlineOf("**Bold** then prose"), null);
});

test("the peek's reasoning excerpt: the newest complete sentence, any script", () => {
  assert.equal(newestSentence("First one. Second one. Third is still bei", "en"), "Second one.");
  assert.equal(newestSentence("**Heading**\n\nOnly sentence here.", "en"), "Only sentence here.");
  assert.equal(newestSentence("No sentence has ended yet", "en"), null);
  assert.equal(newestSentence("これは最初の文です。これは二番目の文です。三番目", "ja"), "これは二番目の文です。");
  assert.equal(newestSentence("", "en"), null);
});
