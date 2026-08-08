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
  toSourcesMarkdown,
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
