import assert from "node:assert/strict";
import test from "node:test";

import {
  CodeTaskTranscript,
  MAX_TOOL_OUTPUT_CHARS,
  codeToolLabel,
  codeToolStatus,
  type TaskEventRow,
} from "../src/lib/agent-protocol/code-task-transcript";
import { legacyToolStatus } from "../src/lib/agent-protocol/legacy";
import { AGENT_PROTOCOL } from "../src/lib/agent-protocol/protocol.generated";

/*
 * A CODE TASK'S EVENTS, READ THE ONE WAY BOTH THE LIVE VIEW AND THE PERSISTED
 * OUTCOME READ THEM.
 *
 * Three streams matter: what the cloud runner wrote before the protocol (still
 * in the database), what a shipped Mac still writes, and what a producer that
 * speaks the protocol writes now — protocol rows plus legacy twins it marks.
 * Each must fold to the same kind of transcript, with outcomes that are typed
 * fields rather than the words the row happened to be written with.
 */

let seq = 0;
const at = (n: number) => `2026-09-30T10:00:${String(n).padStart(2, "0")}.000Z`;
const row = (kind: string, payload: Record<string, unknown>): TaskEventRow => {
  seq += 1;
  return { seq, kind, payload, createdAt: at(seq % 60) };
};
const protocolRow = (type: string, fields: Record<string, unknown>, extra: Record<string, unknown> = {}): TaskEventRow =>
  row("protocol", {
    v: AGENT_PROTOCOL.v,
    id: `p-${seq + 1}`,
    sessionId: "task-1",
    seq: seq + 1,
    at: at((seq + 1) % 60),
    type,
    ...extra,
    ...fields,
  });

test("a cloud run stored before the protocol still reads, with typed outcomes", () => {
  seq = 0;
  const transcript = new CodeTaskTranscript("task-old", { includeAgentSummaries: true });
  transcript.applyAll([
    row("user", { text: "Fix the login test" }),
    row("text", { text: "Cloud Code run started on liam/juno with Sonnet.\n" }),
    row("reasoning_delta", { text: "Probably timing." }),
    row("tool", { name: "bash", summary: "$ npm test — failed", detail: "1 failing", exitCode: 1 }),
    row("tool", { name: "bash", summary: "$ ls — ok" }),
    row("tool", { name: "read_file", summary: "Read src/login.ts" }),
    row("tool", { name: "approval", summary: "Auto-allowed in sandbox: $ npm ci", risk: "outside", autoAllowed: true }),
    row("tool", { name: "approval", summary: "Denied — this run is set to Plan: $ rm -rf build", risk: "destructive" }),
    row("tool", { name: "write_file", summary: "Denied write_file: Denied: plan mode only allows read-only tools." }),
    row("text", { text: "Fixed it." }),
    row("file_change", { path: "src/login.ts", changeKind: "edit", added: 3, removed: 1, diff: "@@ -1 +1 @@" }),
    row("agent", { agent: { id: "a1", title: "Check tests", role: "reviewer", status: "completed", summary: "All good." } }),
    row("done", { finishReason: "end_turn", branch: "juno/cloud-x", prUrl: "https://github.com/liam/juno/pull/9", prNumber: 9 }),
  ]);

  const rows = transcript.activity();
  const tools = rows.filter((entry) => entry.kind === "tool" && entry.toolStatus !== undefined);
  assert.deepEqual(
    tools.map((entry) => [entry.title, entry.toolStatus]),
    [
      ["$ npm test", "error"],
      ["$ ls", "ok"],
      ["Read src/login.ts", "unknown"],
      ["Denied write_file: Denied: plan mode only allows read-only tools.", "denied"],
    ],
    "the suffix is gone from the title and the outcome is a field",
  );
  // The runner's answers-by-mode are one row each, told apart by the decision.
  const allowed = rows.find((entry) => entry.title.startsWith("Auto-allowed"));
  assert.equal(allowed?.kind, "done");
  const refused = rows.find((entry) => entry.title.startsWith("Denied — "));
  assert.equal(refused?.kind, "warning");
  assert.equal(refused?.title, "Denied — this run is set to Plan: $ rm -rf build");

  assert.equal(transcript.content, "Cloud Code run started on liam/juno with Sonnet.\n\n\nFixed it.");
  assert.equal(transcript.reasoning, "Probably timing.");
  assert.deepEqual(transcript.fileChanges, [
    { path: "src/login.ts", changeKind: "edit", added: 3, removed: 1, patch: "@@ -1 +1 @@" },
  ]);
  assert.equal(transcript.view.pullRequest?.prNumber, 9);
  assert.equal(rows.at(-1)?.title, "Agent reviewer · Check tests — completed");
  assert.equal(transcript.view.turns[0]?.status, "completed");
});

test("a shipped Mac's device task rows fold too", () => {
  seq = 0;
  const transcript = new CodeTaskTranscript("task-mac");
  transcript.applyAll([
    row("status", { status: "running" }),
    row("user", { text: "Run the tests" }),
    row("tool", { name: "Reasoning", summary: "Tests first." }),
    row("tool", { name: "run_tests", summary: "Run swift test", detail: "execute" }),
    row("tool", { name: "succeeded", summary: "214 tests passed" }),
    row("tool", { name: "denied", summary: "git push" }),
    row("approval_request", { requestId: "apr-1", summary: "git push", risk: "destructive", detail: "run_command" }),
    row("status", { status: "awaiting_approval" }),
  ]);
  assert.equal(transcript.reasoning, "Tests first.");
  assert.deepEqual(
    transcript.activity().filter((entry) => entry.kind === "tool").map((entry) => entry.toolStatus),
    ["unknown", "ok", "denied"],
  );
  assert.deepEqual(transcript.pendingApproval, {
    requestId: "apr-1",
    summary: "git push",
    risk: "destructive",
    detail: "run_command",
  });
  transcript.apply(row("approval_response", { requestId: "apr-1", approve: false }));
  assert.equal(transcript.pendingApproval, null);
  const decision = transcript.activity().find((entry) => entry.id.endsWith("-decision"));
  assert.equal(decision?.title, "Denied");
});

test("a protocol producer's legacy twins are skipped, not shown twice", () => {
  seq = 0;
  const transcript = new CodeTaskTranscript("task-1");
  transcript.applyAll([
    protocolRow("turn.started", { origin: "user" }, { turnId: "t1" }),
    row("user", { text: "Go", protocolEventId: "p-1" }),
    protocolRow("item.user_message", { itemId: "u1", text: "Go", delivery: "prompt" }, { turnId: "t1" }),
    protocolRow("item.tool_call", { itemId: "c1", toolName: "bash", toolKind: "execute", title: "$ npm test" }, { turnId: "t1" }),
    protocolRow("item.tool_result", { itemId: "c1", status: "error", exitCode: 2, output: "boom" }, { turnId: "t1" }),
    row("tool", { name: "bash", summary: "$ npm test", exitCode: 2, protocolEventId: "p-5" }),
    protocolRow("item.assistant_text.delta", { itemId: "a1", text: "It failed." }, { turnId: "t1" }),
    row("text", { text: "It failed.", protocolEventId: "p-7" }),
    protocolRow("item.tool_call", { itemId: "c2", toolName: "bash", toolKind: "execute", title: "$ npm ci" }, { turnId: "t1" }),
    protocolRow(
      "approval.requested",
      { approvalId: "c2", itemId: "c2", action: "bash", summary: "$ npm ci", risk: "critical" },
      { turnId: "t1" },
    ),
    protocolRow(
      "approval.resolved",
      { approvalId: "c2", decision: "deny", by: "mode", feedback: "this run is set to Plan" },
      { turnId: "t1" },
    ),
    protocolRow("item.tool_result", { itemId: "c2", status: "denied", summary: "this run is set to Plan" }, { turnId: "t1" }),
  ]);
  assert.equal(transcript.content, "It failed.", "the twin text row did not double the reply");
  const rows = transcript.activity();
  assert.deepEqual(
    rows.map((entry) => [entry.kind, entry.title, entry.toolStatus ?? null]),
    [
      ["tool", "$ npm test", "error"],
      // One refused call, one row: the mode's answer, not a second "denied" call row.
      ["warning", "Denied — this run is set to Plan: $ npm ci", null],
    ],
  );
  assert.equal(rows[0]?.exitCode, 2);
  assert.equal(rows[0]?.detail, "boom");
});

test("rollback answers keep their place; the reader's asks only live", () => {
  seq = 0;
  const events = [
    row("user", { text: "Edit it" }),
    row("file_change", { path: "a.ts", changeKind: "edit", added: 1, removed: 0 }),
    row("reject_change", { requestId: "r1", path: "a.ts" }),
    row("rollback_result", { requestId: "r1", status: "applied", paths: ["a.ts"] }),
  ];
  const live = new CodeTaskTranscript("t", { includeRollbackAsks: true });
  live.applyAll(events);
  assert.deepEqual(
    live.activity().map((entry) => entry.title),
    ["edit a.ts", "Asked to revert a file", "Rolled back a.ts"],
  );
  const persisted = new CodeTaskTranscript("t");
  persisted.applyAll(events);
  assert.deepEqual(
    persisted.activity().map((entry) => entry.title),
    ["edit a.ts", "Rolled back a.ts"],
  );
});

test("a persisted row reads its typed status, and an old one goes through the adapter", () => {
  const typed = { id: "1", kind: "tool" as const, title: "$ npm test", createdAt: at(1), toolStatus: "denied" };
  assert.equal(codeToolStatus(typed), "denied");
  assert.equal(codeToolLabel(typed), "$ npm test");
  const old = { id: "2", kind: "tool" as const, title: "$ npm test — failed", createdAt: at(2) };
  assert.equal(codeToolStatus(old), "error");
  assert.equal(codeToolLabel(old), "$ npm test");
  assert.equal(codeToolStatus({ ...old, title: "$ ls", exitCode: 0 } as typeof old), "ok");
  assert.equal(legacyToolStatus({ name: "cancelled", summary: "Not executed" }), "not_executed");
});

test("a long-running command's streamed output is one row holding its end", () => {
  seq = 0;
  const transcript = new CodeTaskTranscript("task-1");
  const chunk = "y".repeat(8_000);
  transcript.applyAll([
    protocolRow("turn.started", { origin: "user" }, { turnId: "t1" }),
    protocolRow("item.tool_call", { itemId: "c1", toolName: "run_command", toolKind: "execute", title: "Run swift build" }),
    // A Mac streams output in 8,000-character chunks; a long build is hundreds.
    ...Array.from({ length: 50 }, () => protocolRow("item.tool_output", { itemId: "c1", channel: "stdout", text: chunk })),
    protocolRow("item.tool_output", { itemId: "c1", channel: "stdout", text: "error: the reason it stopped" }),
    protocolRow("item.tool_result", { itemId: "c1", status: "error", summary: "exit 1" }),
  ]);
  const rows = transcript.activity();
  assert.equal(rows.length, 1, "one call, one row");
  const detail = rows[0]?.detail ?? "";
  assert.ok(detail.length <= MAX_TOOL_OUTPUT_CHARS + 40, "bounded, not the whole 400 KB");
  assert.ok(detail.endsWith("error: the reason it stopped"), "the end of the output, where the failure is");
  assert.equal(rows[0]?.toolStatus, "error");
});

test("a rewind drops the rows it takes back, and what follows it is shown", () => {
  seq = 0;
  const transcript = new CodeTaskTranscript("task-1");
  transcript.applyAll([
    protocolRow("turn.started", { origin: "user" }, { turnId: "t1" }),
    protocolRow("item.tool_call", { itemId: "c1", toolName: "bash", toolKind: "execute", title: "$ rm build" }),
    protocolRow("item.tool_result", { itemId: "c1", status: "ok" }),
    protocolRow("turn.completed", { stopReason: "end_turn" }),
    protocolRow("transcript.restarted", { rewoundToTurnId: "t1" }),
    protocolRow("turn.started", { origin: "user" }, { turnId: "t2" }),
    protocolRow("item.tool_call", { itemId: "c2", toolName: "bash", toolKind: "execute", title: "$ make" }),
    protocolRow("item.tool_result", { itemId: "c2", status: "ok" }),
  ]);
  assert.deepEqual(
    transcript.activity().map((entry) => entry.title),
    ["$ make"],
  );
});

test("an automatic allow persisted before the fold still reads as a success", () => {
  // Message.activity rows written by the old outcome writer: the runner's
  // `Auto-allowed in sandbox:` row was drawn as a success receipt.
  const persisted = { id: "evt-4", kind: "tool" as const, title: "Auto-allowed in sandbox: $ npm ci", createdAt: at(4) };
  assert.equal(codeToolStatus(persisted), "ok");
  assert.equal(legacyToolStatus({ summary: "Auto-allowed in sandbox: $ npm ci" }), "ok");
});
