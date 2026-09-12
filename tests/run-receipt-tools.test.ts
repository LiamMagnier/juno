/**
 * The tool rows: what `buildRun` carries into the panel, and what the copied
 * receipt says about it.
 *
 * The receipt is the half most worth testing. It is read once, elsewhere,
 * usually pasted into a bug report — so a receipt that contradicts the panel is
 * discovered by the one person least able to check it. Everything here is
 * therefore asserted against the SAME constants the panel renders from, which
 * is the point of those constants living in `run-receipt.ts` at all.
 *
 * The other half is degradation. A message persisted before this shipped, a run
 * made with tool detail turned off, and a provider that never sent its
 * arguments all have to render, and they have to render DIFFERENTLY from each
 * other — collapsing them into one apologetic sentence is the failure this
 * whole feature exists to fix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildRun } from "@/components/chat/thought-process-panel";
import {
  TOOLS_DESCRIPTION,
  TOOLS_NO_DETAIL_NOTE,
  TOOL_ARGS_NOTE,
  TOOL_RESULT_NOTE,
  toRunMarkdown,
  toRunSummary,
  toSourcesMarkdown,
  toStepMarkdown,
  toolArgsLabel,
  toolResultLabel,
} from "@/lib/run-receipt";
import type { ClientActivityEvent, ClientToolDetail } from "@/types/chat";

const T0 = Date.parse("2026-08-08T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

let seq = 0;
function ev(partial: Partial<ClientActivityEvent> & Pick<ClientActivityEvent, "kind">): ClientActivityEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    title: "",
    createdAt: iso(0),
    ...partial,
  } as ClientActivityEvent;
}

/** A completed connector call, as the route emits it after `closeToolDetail`. */
function toolRow(tool: Partial<ClientToolDetail> & { server: string; name: string }, at = 0) {
  return ev({
    kind: "tool",
    title: `Using ${tool.server}`,
    detail: tool.name,
    createdAt: iso(at),
    tool: tool as ClientToolDetail,
  });
}

/** The minimum a run needs for `buildRun` to produce an elapsed span. */
const bookends = () => [ev({ kind: "write", title: "Writing", createdAt: iso(100) })];

// ─────────────────────────────────────────────────────── buildRun · the model

test("a tool row carries its payload through buildRun untouched", () => {
  const tool: ClientToolDetail = {
    server: "Linear",
    name: "linear__create_issue",
    args: '{\n  "title": "Fix login"\n}',
    result: '{\n  "id": "ENG-4"\n}',
    status: "ok",
    durationMs: 1240,
  };
  const run = buildRun([toolRow(tool), ...bookends()], null);

  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0].object, "Linear · linear__create_issue");
  // Identity, not a copy: nothing in the client is allowed to re-format or
  // re-measure a payload the server already cut and labelled.
  assert.equal(run.calls[0].tool, tool);
});

test("the preflight 'Connected tools ready' row is not a call", () => {
  const run = buildRun(
    [ev({ kind: "tool", title: "Connected tools ready", detail: "Linear · GitHub" }), ...bookends()],
    null,
  );
  assert.deepEqual(run.calls, []);
});

test("a row persisted before this shipped has no payload and still renders", () => {
  const run = buildRun([ev({ kind: "tool", title: "Using Linear", detail: "linear__create_issue" })], null);
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0].tool, undefined);
  assert.equal(run.calls[0].object, "Linear · linear__create_issue");
});

test("warnings stay warnings and never acquire a tool payload", () => {
  const run = buildRun(
    [ev({ kind: "warning", title: "Connector timed out" }), toolRow({ server: "S", name: "t", resultNote: "empty" })],
    null,
  );
  assert.equal(run.calls.filter((c) => c.warn).length, 1);
  assert.equal(run.calls.find((c) => c.warn)?.tool, undefined);
});

// ─────────────────────────────────────────────────── buildRun · every page

test("every visited page is carried, with no cap and no sample", () => {
  const visits = Array.from({ length: 40 }, (_, i) =>
    ev({ kind: "visit", title: "Visited source", detail: `Page ${i}`, url: `https://example.com/${i}` }),
  );
  const run = buildRun(visits, null);
  assert.equal(run.sources.length, 40);
  assert.equal(run.sourceCount, 40);
  assert.equal(run.sources[39].title, "Page 39");
});

test("the same URL twice is one page", () => {
  const run = buildRun(
    [
      ev({ kind: "visit", title: "Visited source", detail: "A", url: "https://a.test/x" }),
      ev({ kind: "visit", title: "Visited source", detail: "A again", url: "https://a.test/x" }),
    ],
    null,
  );
  assert.equal(run.sources.length, 1);
  assert.equal(run.sources[0].title, "A");
});

test("access is 'unknown' when the producer did not say, and never guessed as 'listed'", () => {
  const run = buildRun(
    [
      ev({ kind: "visit", title: "Visited source", detail: "A", url: "https://a.test/1" }),
      ev({ kind: "visit", title: "Reading source", detail: "B", url: "https://b.test/1" }),
      ev({ kind: "visit", title: "Read source", detail: "C", url: "https://c.test/1" }),
      ev({ kind: "visit", title: "Listed source", detail: "D", url: "https://d.test/1" }),
    ],
    null,
  );
  assert.deepEqual(
    run.sources.map((s) => s.access),
    ["unknown", "read", "read", "listed"],
  );
});

test("only a listed source is tagged in the sources receipt", () => {
  const run = buildRun(
    [
      ev({ kind: "visit", title: "Reading source", detail: "Read me", url: "https://a.test/1" }),
      ev({ kind: "visit", title: "Listed source", detail: "Only listed", url: "https://b.test/1" }),
      ev({ kind: "visit", title: "Visited source", detail: "Unknown", url: "https://c.test/1" }),
    ],
    null,
  );
  assert.equal(
    toSourcesMarkdown(run),
    "- [Read me](https://a.test/1)\n- [Only listed](https://b.test/1) (listed, not read)\n- [Unknown](https://c.test/1)",
  );
});

// ───────────────────────────────────────────────────────── labels · the cut

test("the result label quantifies the cut against the length the server measured", () => {
  const label = toolResultLabel({
    server: "S",
    name: "t",
    result: "x".repeat(4000),
    resultTruncated: true,
    resultChars: 26318,
    status: "ok",
  });
  assert.equal(label, "result · first 4000 of 26318 chars");
});

test("a failed call is labelled 'error', and still says it was cut", () => {
  assert.equal(toolResultLabel({ server: "S", name: "t", result: "Tool error: boom", status: "failed" }), "error");
  assert.equal(
    toolResultLabel({
      server: "S",
      name: "t",
      result: "y".repeat(10),
      resultTruncated: true,
      resultChars: 900,
      status: "failed",
    }),
    "error · first 10 of 900 chars",
  );
});

test("a cut with no measured total degrades to the bare word, never to a computed one", () => {
  assert.equal(
    toolResultLabel({ server: "S", name: "t", result: "abc", resultTruncated: true, status: "ok" }),
    "result · truncated",
  );
});

test("arguments say they were cut but claim no total, because nothing measured one", () => {
  assert.equal(toolArgsLabel({ server: "S", name: "t", args: "{}" }), "arguments · json");
  assert.equal(toolArgsLabel({ server: "S", name: "t", args: "{}", argsTruncated: true }), "arguments · json · truncated");
});

// ───────────────────────────────────────────────── receipt · the Tools block

test("the receipt prints every call, its payloads and the redaction caption", () => {
  const run = buildRun(
    [
      toolRow({
        server: "Linear",
        name: "linear__create_issue",
        args: '{\n  "title": "Fix login"\n}',
        result: '{\n  "id": "ENG-4"\n}',
        status: "ok",
        durationMs: 1240,
      }),
      ...bookends(),
    ],
    null,
  );
  const md = toRunMarkdown(run);

  assert.match(md, /\n## Tools\n/);
  assert.ok(md.includes(TOOLS_DESCRIPTION));
  assert.match(md, /\n### Linear · linear__create_issue\n/);
  assert.match(md, /\nDuration 1\.2s\n/);
  assert.match(md, /```json\n\{\n {2}"title": "Fix login"\n\}\n```/);
  assert.match(md, /```\n\{\n {2}"id": "ENG-4"\n\}\n```/);
  // A successful call carries no marker — absence is the ordinary case here,
  // exactly as on screen.
  assert.doesNotMatch(md, /Succeeded/);
  assert.doesNotMatch(md, /\nFailed\n/);
});

test("a run with no calls grows no Tools block at all", () => {
  const run = buildRun([ev({ kind: "model", title: "Selected model", detail: "Claude" }), ...bookends()], null);
  const md = toRunMarkdown(run);
  assert.doesNotMatch(md, /## Tools/);
  assert.ok(!md.includes(TOOLS_DESCRIPTION));
});

test("a failed call says so, and prints no duration when the call never reached the network", () => {
  const run = buildRun(
    [
      toolRow({
        server: "Linear",
        name: "linear__unknown",
        argsNote: "unavailable",
        result: "Unknown tool: linear__unknown",
        status: "failed",
      }),
    ],
    null,
  );
  const md = toRunMarkdown(run);

  assert.match(md, /\nFailed\n/);
  // NEVER "Duration 0.0s". Absent, not zero — a zero would read as "the
  // connector answered instantly", which is the opposite of what happened.
  assert.doesNotMatch(md, /Duration/);
  assert.ok(md.includes(`Arguments: ${TOOL_ARGS_NOTE.unavailable}`));
  assert.match(md, /error:\n/);
});

test("each reason for a missing argument gets its own sentence", () => {
  const notes = ["unavailable", "empty", "unparsable", "over_budget"] as const;
  const sentences = new Set(notes.map((n) => TOOL_ARGS_NOTE[n]));
  // Four distinct facts about a call; collapsing them would make the panel
  // vaguer than the data behind it.
  assert.equal(sentences.size, 4);

  for (const note of notes) {
    const run = buildRun([toolRow({ server: "S", name: "t", argsNote: note, result: "ok", status: "ok" })], null);
    assert.ok(toRunMarkdown(run).includes(`Arguments: ${TOOL_ARGS_NOTE[note]}`), note);
  }
});

test("every result note has a sentence, including 'unfinished'", () => {
  const notes = ["pending", "unfinished", "empty", "over_budget"] as const;
  assert.equal(new Set(notes.map((n) => TOOL_RESULT_NOTE[n])).size, 4);

  for (const note of notes) {
    const run = buildRun([toolRow({ server: "S", name: "t", args: "{}", resultNote: note })], null);
    const md = toRunMarkdown(run);
    assert.ok(md.includes(`Result: ${TOOL_RESULT_NOTE[note]}`), note);
    // No status while there is no ending to report.
    if (note === "pending" || note === "unfinished") assert.doesNotMatch(md, /\nFailed\n/);
  }
});

test("a call whose detail was never recorded is named once and explained once", () => {
  const run = buildRun(
    [
      ev({ kind: "tool", title: "Using Linear", detail: "linear__create_issue" }),
      ev({ kind: "tool", title: "Using GitHub", detail: "github__list_issues" }),
    ],
    null,
  );
  const md = toRunMarkdown(run);

  assert.match(md, /\n### Linear · linear__create_issue\n/);
  assert.match(md, /\n### GitHub · github__list_issues$/);
  assert.equal(md.split(TOOLS_NO_DETAIL_NOTE).length - 1, 1);
  // Nothing is invented for them: no fenced block, no note about arguments
  // that were never on the wire in the first place.
  assert.doesNotMatch(md, /Arguments:/);
  assert.doesNotMatch(md, /```/);
});

test("the no-detail note is absent when every call carried one", () => {
  const run = buildRun([toolRow({ server: "S", name: "t", args: "{}", result: "r", status: "ok" })], null);
  assert.ok(!toRunMarkdown(run).includes(TOOLS_NO_DETAIL_NOTE));
});

// ──────────────────────────────────────────────── receipt · fencing payloads

test("a payload containing a fence does not close the block early", () => {
  // A GitHub issue body or a Notion page routinely contains Markdown. A three-
  // backtick fence around it closes at the payload's own fence and the rest of
  // the receipt renders as prose with the run's headings inside it.
  const result = "Here is code:\n```js\nconst a = 1;\n```\ndone";
  const run = buildRun([toolRow({ server: "S", name: "t", args: "{}", result, status: "ok" })], null);
  const md = toRunMarkdown(run);

  assert.ok(md.includes("````\n" + result + "\n````"));
});

test("the fence grows past the longest run in the payload", () => {
  const result = "a ````` b";
  const run = buildRun([toolRow({ server: "S", name: "t", args: "{}", result, status: "ok" })], null);
  assert.ok(toRunMarkdown(run).includes("``````\n" + result + "\n``````"));
});

// ───────────────────────────────────────────────────────── receipt · order

test("Tools sits between Sources and Reasoning, as it does on screen", () => {
  const run = buildRun(
    [
      ev({ kind: "visit", title: "Visited source", detail: "A", url: "https://a.test/1" }),
      toolRow({ server: "S", name: "t", args: "{}", result: "r", status: "ok" }, 10),
      ...bookends(),
    ],
    null,
  );
  const md = toRunMarkdown(run, "The model's trace.");

  const sources = md.indexOf("Sources:");
  const tools = md.indexOf("## Tools");
  const reasoning = md.indexOf("## Reasoning");
  assert.ok(sources >= 0 && tools > sources && reasoning > tools);
});

// ─────────────────────────────────────────────── buildRun · the spine's steps
//
// `steps` is the panel's only noun. What matters here is not that it exists but
// that it refuses to invent: a step with no measured duration carries `ms: null`
// rather than 0, a source that was never a numbered citation carries
// `citeIndex: null` rather than a plausible index, and no two steps are ever
// running at once.

test("every kind lands on one Step shape, in phase order", () => {
  const run = buildRun(
    [
      ev({ kind: "search", title: "Searching the web", detail: "retry budgets" }),
      ev({ kind: "visit", title: "Read source", detail: "Reliability at scale", url: "https://nature.com/a" }),
      toolRow({ server: "Linear", name: "create_issue", args: "{}", result: "r", status: "ok", durationMs: 1400 }, 10),
      ev({ kind: "warning", title: "Linear did not respond in time", createdAt: iso(12) }),
      ev({ kind: "write", title: "Writing", createdAt: iso(100) }),
      ev({ kind: "usage", title: "Usage", detail: "812 output · $0.04", createdAt: iso(200) }),
    ],
    null,
  );

  const kinds = run.steps.map((s) => `${s.phase}:${s.kind}`);
  assert.deepEqual(kinds, [
    "research:search",
    "research:source",
    "think:tool",
    "think:notice",
    "write:write",
  ]);
  assert.equal(run.steps.filter((s) => s.running).length, 0);
  assert.equal(run.steps.find((s) => s.kind === "search")?.label, "Searched \u201Cretry budgets\u201D");
  assert.equal(run.steps.find((s) => s.kind === "source")?.detail, "nature.com");
  assert.equal(run.steps.find((s) => s.kind === "tool")?.ms, 1400);
  assert.equal(run.steps.find((s) => s.kind === "notice")?.failed, true);
  assert.equal(run.steps.find((s) => s.kind === "write")?.detail, "812 tokens");
});

test("a call that never reached the network has no figure at all — absent, not zero", () => {
  const run = buildRun([toolRow({ server: "S", name: "t", argsNote: "unavailable", status: "failed" })], null);
  const step = run.steps.find((s) => s.kind === "tool");
  assert.equal(step?.ms, null);
  assert.equal(step?.failed, true);
});

test("a listed source is marked and a read one is not", () => {
  const run = buildRun(
    [
      ev({ kind: "visit", title: "Listed source", detail: "D", url: "https://d.test/1" }),
      ev({ kind: "visit", title: "Read source", detail: "C", url: "https://c.test/1" }),
    ],
    null,
  );
  assert.deepEqual(
    run.steps.filter((s) => s.kind === "source").map((s) => s.detail),
    ["d.test · listed", "c.test"],
  );
});

test("citeIndex is null unless the model was handed a numbered corpus", () => {
  const events = [ev({ kind: "visit", title: "Visited source", detail: "A", url: "https://a.test/1" })];

  // Native search: the model never saw an index, so a bracket in its text means
  // nothing and a chip pointing at an arbitrary source is worse than no chip.
  const ungrounded = buildRun(events, null, null, {
    sources: [{ title: "A", url: "https://a.test/1", snippet: "" }],
  });
  assert.equal(ungrounded.steps.find((s) => s.kind === "source")?.source?.citeIndex, null);

  const grounded = buildRun(events, null, null, {
    sources: [{ title: "A", url: "https://a.test/1", snippet: "", cited: true }],
  });
  assert.equal(grounded.steps.find((s) => s.kind === "source")?.source?.citeIndex, 1);
});

test("a live run has exactly one running step and it carries no figure", () => {
  const now = T0 + 4000;
  const run = buildRun([ev({ kind: "model", title: "Selected model", detail: "Claude" })], now);
  const running = run.steps.filter((s) => s.running);
  assert.equal(running.length, 1);
  assert.equal(running[0].ms, null);
  assert.equal(running[0].label, "Thinking");
});

test("an empty live run says it is waiting rather than drawing a skeleton", () => {
  const run = buildRun([], Date.now());
  assert.equal(run.steps.length, 1);
  assert.equal(run.steps[0].label, "Waiting for the model");
});

test("provider parts become think steps; an unbroken trace becomes one", () => {
  const parts = ["**Weighing the benchmarks**\nThe 2026 figures are not comparable.", "**Choosing**\nGo with A."];
  const withParts = buildRun([], null, T0, { reasoningParts: parts, reasoning: parts.join("\n\n") });
  assert.deepEqual(
    withParts.steps.filter((s) => s.kind === "think").map((s) => s.label),
    ["Weighing the benchmarks", "Choosing"],
  );

  // Anthropic, Zhipu, Mistral, Google: one block, no boundaries on the wire.
  // The panel must not re-split the prose to manufacture steps.
  const flat = buildRun([], null, T0, { reasoning: "One unbroken block of thought." });
  const think = flat.steps.filter((s) => s.kind === "think");
  assert.equal(think.length, 1);
  assert.equal(think[0].label, "Full reasoning trace");
  assert.equal(think[0].detail, "This model streams one unbroken trace.");
});

// ──────────────────────────────────────────────────────── toRunSummary
//
// The one sentence the panel pins to the top when a run ends, and the second
// line of the receipt. It is built only from counted facts: a clause with no
// number behind it is not written.

test("the summary names what was counted, with a conjunction before the last clause", () => {
  const visits = ["nature.com/a", "nature.com/b", "arxiv.org/c"].map((u) =>
    ev({ kind: "visit", title: "Read source", detail: u, url: `https://${u}` }),
  );
  const run = buildRun(
    [
      ev({ kind: "search", title: "Searching the web", detail: "q1" }),
      ev({ kind: "search", title: "Searching the web", detail: "q2" }),
      ...visits,
      toolRow({ server: "Linear", name: "create_issue", args: "{}", result: "r", status: "ok" }, 10),
      toolRow({ server: "Linear", name: "list_issues", args: "{}", result: "r", status: "ok" }, 20),
      ev({ kind: "write", title: "Writing", createdAt: iso(100) }),
      ev({ kind: "usage", title: "Usage", detail: "3,100 input · 812 output · $0.04", createdAt: iso(1100) }),
    ],
    null,
  );

  const summary = toRunSummary(run);
  assert.match(summary, /^Thought for /);
  assert.ok(summary.includes("ran 2 searches"));
  // "across N domains" only when it says something the source count does not.
  assert.ok(summary.includes("read 3 sources across 2 domains"));
  assert.ok(summary.includes("called Linear twice"));
  assert.ok(summary.endsWith("and wrote 812 tokens."));
});

test("domains are not named when every source had its own", () => {
  const run = buildRun(
    [
      ev({ kind: "visit", title: "Read source", detail: "A", url: "https://a.test/1" }),
      ev({ kind: "visit", title: "Read source", detail: "B", url: "https://b.test/1" }),
      ev({ kind: "usage", title: "Usage", detail: "$0.01", createdAt: iso(500) }),
    ],
    null,
  );
  // Sentence-cased on the first clause, because it IS the first clause here.
  assert.equal(toRunSummary(run), "Read 2 sources.");
});

test("more than one connector is counted, never listed", () => {
  const run = buildRun(
    [
      toolRow({ server: "Linear", name: "a", args: "{}", result: "r", status: "ok" }),
      toolRow({ server: "GitHub", name: "b", args: "{}", result: "r", status: "ok" }),
      toolRow({ server: "Notion", name: "c", args: "{}", result: "r", status: "ok" }),
      ev({ kind: "usage", title: "Usage", detail: "$0.01", createdAt: iso(500) }),
    ],
    null,
  );
  assert.equal(toRunSummary(run), "Called 3 connectors.");
});

test("a run that reported no usage says it stopped, and says it first", () => {
  const run = buildRun(
    [
      ev({ kind: "search", title: "Searching the web", detail: "q" }),
      ev({ kind: "write", title: "Writing", createdAt: iso(100) }),
    ],
    null,
  );
  const summary = toRunSummary(run);
  assert.match(summary, /^Stopped after /);
  assert.ok(summary.includes("ran 1 search"));
});

test("a run with nothing counted still answers, and never invents a clause", () => {
  // A plain completion: a model event, a write, a usage with no token figure.
  const run = buildRun(
    [
      ev({ kind: "model", title: "Selected model", detail: "Claude" }),
      ev({ kind: "write", title: "Writing", createdAt: iso(100) }),
      ev({ kind: "usage", title: "Usage", detail: "$0.01", createdAt: iso(2000) }),
    ],
    null,
  );
  const summary = toRunSummary(run);
  // THINK was measured, so that is the one clause there is. Nothing says
  // "read some sources" or "called a connector".
  assert.match(summary, /^Thought for /);
  assert.doesNotMatch(summary, /read|called|ran |wrote/);
});

test("a run with no events at all is honest about having nothing", () => {
  const run = buildRun([], null);
  assert.equal(toRunSummary(run), "Nothing was recorded for this run.");
  // …and falls back to the finish note when that is the only true thing left.
  assert.equal(toRunSummary(run, "Stopped by user."), "Stopped by user.");
});

test("the receipt opens with the same sentence the panel shows", () => {
  const run = buildRun(
    [
      ev({ kind: "model", title: "Selected model", detail: "Claude Opus 5" }),
      ev({ kind: "write", title: "Writing", createdAt: iso(100) }),
      ev({ kind: "usage", title: "Usage", detail: "812 output · $0.04", createdAt: iso(1100) }),
    ],
    null,
  );
  const md = toRunMarkdown(run);
  assert.equal(md.split("\n")[0], "# Run — Claude Opus 5");
  assert.equal(md.split("\n")[1], toRunSummary(run));
});

// ──────────────────────────────────────────────────────── toStepMarkdown

test("a copied step says what its row says, payload included", () => {
  const run = buildRun(
    [toolRow({ server: "Linear", name: "create_issue", args: '{"t":1}', result: "boom", status: "failed" })],
    null,
  );
  const step = run.steps.find((s) => s.kind === "tool")!;
  const md = toStepMarkdown(step);

  assert.match(md, /^### Linear · create_issue\n/);
  assert.match(md, /\nFailed\n/);
  // No duration line: the call never reached the network, so there is no
  // number — and a "Duration 0.0s" would read as "it answered instantly".
  assert.doesNotMatch(md, /Duration/);
  assert.ok(md.includes('```json\n{"t":1}\n```'));
  assert.ok(md.includes("error:"));
});

test("a copied source step carries its URL", () => {
  const run = buildRun([ev({ kind: "visit", title: "Read source", detail: "A", url: "https://a.test/1" })], null);
  const md = toStepMarkdown(run.steps.find((s) => s.kind === "source")!);
  assert.ok(md.includes("https://a.test/1"));
});
