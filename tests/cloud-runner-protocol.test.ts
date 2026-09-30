import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DurableOutbox } from "../scripts/lib/runner-outbox.mjs";
import { AgentProtocolProjector } from "../runner/agent-core/src/protocol-projector";
import { LegacyTaskDowncast } from "../runner/agent-core/src/protocol-legacy";
import { validateAgentEvent } from "../src/lib/agent-protocol/protocol.generated";
import { CodeTaskTranscript } from "../src/lib/agent-protocol/code-task-transcript";

/*
 * THE CLOUD DRIVER'S EVENT STREAM, END TO END: ENGINE → PROTOCOL → ROWS → FOLD.
 *
 * The driver only runs inside a GitHub Actions job, so the suite lifts its
 * EventSink out of the source (the technique tests/cloud-runner-controls.test.ts
 * uses) and drives it with the engine events a real run emits. What it queues
 * is exactly what the events route stores; that is then read back through the
 * web's transcript fold, the same one the live view and the persisted outcome
 * use. So this pins, in one pass: the rows are valid protocol, every legacy twin
 * names its protocol event, a protocol reader shows each thing once, an old
 * reader still gets the rows it always got, and outcomes are typed fields.
 */

const SOURCE = readFileSync(new URL("../scripts/cloud-code-runner.mjs", import.meta.url), "utf8");

function lift(pattern: RegExp, what: string): string {
  const found = pattern.exec(SOURCE)?.[0];
  assert.ok(found, `${what} is no longer declared the way this test lifts it`);
  return found;
}

const classSource = lift(/\nclass EventSink \{[\s\S]*?\n\}\n/, "class EventSink");
const helpers = [
  lift(/\nfunction redactPayload\(payload\) \{[\s\S]*?\n\}\n/, "redactPayload"),
  lift(/\nfunction redactDeep\(value\) \{[\s\S]*?\n\}\n/, "redactDeep"),
].join("\n");

type Row = { kind: string; payload: Record<string, unknown> };
interface Sink {
  outbox: { peek(): Row[]; size: number };
  emitProtocol(events: unknown[]): void;
  scheduleFlush(): void;
  kick(): void;
  engineEvent(event: unknown): void;
  hostEvent(body: unknown, extra?: unknown): unknown;
  flushText(): void;
  flushReasoning(): void;
}

// The class, in a scope holding exactly the names it reads. The network and
// the timers are stubbed below; nothing here reaches either.
const makeSink = new Function(
  "DurableOutbox",
  "redact",
  "TASK_ID",
  "RUN_NONCE",
  "PROTOCOL_KIND",
  "FLUSH_AT_COUNT",
  `${helpers}\n${classSource}\nreturn (token, protocol) => new EventSink(token, protocol);`,
)(
  DurableOutbox,
  (value: string) => value.replace(/sk-[A-Za-z0-9]{20,}/g, "[redacted]"),
  "task-1",
  "run-1",
  "protocol",
  10_000,
) as (token: string, protocol: unknown) => Sink;

function driver(negotiated: boolean) {
  const projector = new AgentProtocolProjector({
    sessionId: "task-1",
    runId: "run-1",
    target: "cloud",
    repository: { owner: "liam", name: "juno" },
    announceSession: false,
    approvalsAnsweredByMode: true,
    now: () => new Date("2026-09-30T10:00:00.000Z"),
  });
  const sink = makeSink("token", {
    negotiated,
    projector,
    downcast: new LegacyTaskDowncast({ approvalsAnsweredByMode: true, markDerived: negotiated }),
  });
  sink.scheduleFlush = () => {};
  sink.kick = () => {};
  return { sink, projector };
}

/** What a run reports: the driver's announcements, then the engine's events. */
function run(negotiated: boolean): Row[] {
  const { sink, projector } = driver(negotiated);
  sink.hostEvent(
    { type: "session.created", target: "cloud", repository: { owner: "liam", name: "juno" }, model: "claude-sonnet-5", mode: "auto_edit" },
    { turnId: null },
  );
  sink.hostEvent({ type: "session.state", state: "running" }, { turnId: null });
  sink.emitProtocol(projector.openTurn([{ text: "Fix the test", delivery: "prompt" }]));
  sink.hostEvent({ type: "item.notice", itemId: projector.itemId("notice"), source: "host", text: "Cloud Code run started on liam/juno." });

  sink.engineEvent({ type: "session_started", sessionId: "s", cwd: "/w", provider: "p", model: "claude-sonnet-5", mode: "auto-edit" });
  sink.engineEvent({ type: "turn_started", turnIndex: 0 });
  sink.engineEvent({ type: "thinking_delta", text: "Run it " });
  sink.engineEvent({ type: "thinking_delta", text: "first." });
  sink.engineEvent({ type: "assistant_delta", text: "Running " });
  sink.engineEvent({ type: "assistant_delta", text: "the tests." });
  sink.engineEvent({ type: "tool_started", callId: "t1", name: "bash", input: { command: "npm test" }, risk: "command" });
  sink.engineEvent({ type: "tool_finished", callId: "t1", name: "bash", output: "1 failing\nkey sk-abcdefghijklmnopqrstuvwxyz", isError: true, durationMs: 900, exitCode: 1 });
  // The engine asks; the driver answers by its mode, and says so first.
  const request = { callId: "t2", toolName: "bash", input: { command: "npm ci" }, risk: "command", summary: "npm ci" };
  sink.engineEvent({ type: "approval_requested", request });
  projector.noteApprovalAnswer("t2", { by: "mode", feedback: "this run is set to Accept edits" });
  sink.engineEvent({ type: "approval_resolved", callId: "t2", decision: "deny" });
  sink.engineEvent({ type: "tool_denied", callId: "t2", name: "bash", reason: "The user declined this action." });
  sink.engineEvent({ type: "assistant_message", text: "Running the tests." });
  sink.engineEvent({ type: "turn_finished", turnIndex: 0, stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20 } });

  sink.hostEvent(
    { type: "item.file_change", itemId: projector.itemId("file"), path: "a.ts", change: "modified", linesAdded: 2, linesRemoved: 1, patch: "@@" },
    { turnId: null },
  );
  sink.hostEvent({ type: "code.pull_request", branch: "juno/cloud-task-1", prUrl: "https://github.com/liam/juno/pull/3", prNumber: 3 }, { turnId: null });
  sink.hostEvent({ type: "session.state", state: "completed", reason: "end_turn" }, { turnId: null });
  sink.flushText();
  sink.flushReasoning();
  return sink.outbox.peek().map((entry) => ({ kind: (entry as Row).kind, payload: (entry as Row).payload }));
}

test("a negotiated run posts valid protocol rows, each legacy twin naming its event", () => {
  const rows = run(true);
  const protocol = rows.filter((row) => row.kind === "protocol");
  const legacy = rows.filter((row) => row.kind !== "protocol");
  assert.ok(protocol.length > 10);
  for (const row of protocol) assert.deepEqual(validateAgentEvent(row.payload), [], `${String(row.payload.type)} breaks the contract`);
  const ids = new Set(protocol.map((row) => row.payload.id));
  for (const row of legacy) {
    assert.ok(ids.has(row.payload.protocolEventId), `legacy ${row.kind} does not name a protocol event it was derived from`);
  }
  // Streamed prose is coalesced: one delta event per burst, not one per token.
  assert.equal(protocol.filter((row) => row.payload.type === "item.assistant_text.delta").length, 1);
  assert.equal(protocol.filter((row) => row.payload.type === "item.thinking.delta").length, 1);
  // Secrets in output are redacted inside the nested protocol payload too.
  assert.equal(JSON.stringify(rows).includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
});

test("an old reader gets the rows the runner always wrote, without the outcome suffix", () => {
  const legacy = run(false);
  assert.equal(legacy.some((row) => row.kind === "protocol"), false, "an older server is sent no protocol rows");
  assert.equal(legacy.some((row) => "protocolEventId" in row.payload), false);
  const tool = legacy.find((row) => row.kind === "tool" && row.payload.name === "bash");
  assert.equal(tool?.payload.summary, "$ npm test");
  assert.equal(tool?.payload.exitCode, 1);
  const refusal = legacy.filter((row) => row.kind === "tool" && row.payload.name === "approval");
  assert.equal(refusal.length, 1, "one refused call, one row");
  assert.equal(refusal[0].payload.summary, "Denied — this run is set to Accept edits: npm ci");
  assert.equal(legacy.some((row) => row.kind === "approval_request"), false, "nobody was asked");
  assert.deepEqual(
    legacy.filter((row) => row.kind === "user").map((row) => row.payload.text),
    ["Fix the test"],
  );
  const done = legacy.find((row) => row.kind === "done");
  assert.deepEqual(done?.payload, {
    finishReason: "end_turn",
    branch: "juno/cloud-task-1",
    prUrl: "https://github.com/liam/juno/pull/3",
    prNumber: 3,
  });
  assert.deepEqual(legacy.find((row) => row.kind === "file_change")?.payload, {
    path: "a.ts",
    changeKind: "edit",
    added: 2,
    removed: 1,
    diff: "@@",
  });
});

test("the web's fold reads the negotiated stream once, with typed outcomes", () => {
  const rows = run(true).map((row, index) => ({ seq: index + 1, kind: row.kind, payload: row.payload, createdAt: "2026-09-30T10:00:00.000Z" }));
  const transcript = new CodeTaskTranscript("task-1", { includeAgentSummaries: true });
  transcript.applyAll(rows);
  assert.equal(transcript.content, "Running the tests.", "the reply once, not once per vocabulary");
  assert.equal(transcript.reasoning, "Run it first.");
  const activity = transcript.activity();
  assert.deepEqual(
    activity.map((row) => [row.kind, row.title, row.toolStatus ?? null]),
    [
      ["tool", "Cloud Code run started on liam/juno.", null],
      ["tool", "$ npm test", "error"],
      ["warning", "Denied — this run is set to Accept edits: npm ci", null],
      ["write", "edit a.ts", null],
    ],
  );
  assert.equal(transcript.view.pullRequest?.prNumber, 3);
  assert.equal(transcript.view.state, "completed");
  assert.equal(transcript.tokens?.completionTokens, 20);
});

test("a sub-agent's full snapshot still reaches the readers that draw its card", () => {
  const snapshot = {
    id: "agent-1",
    title: "Write the tests",
    role: "builder",
    model: "claude-sonnet-5",
    isolation: "worktree",
    writes: true,
    status: "running",
    currentActivity: "Reading src/app.ts",
    usage: { inputTokens: 10, outputTokens: 2 },
    filesChanged: ["src/app.test.ts"],
  };
  for (const negotiated of [true, false]) {
    const { sink } = driver(negotiated);
    sink.engineEvent({ type: "subagent_update", agent: snapshot });
    const rows = sink.outbox.peek().map((entry) => ({ kind: (entry as Row).kind, payload: (entry as Row).payload }));
    // The web's agents panel and the iPhone's task view read `agent` rows, and
    // want the whole snapshot — the model and the files are not in the protocol.
    const agentRows = rows.filter((row) => row.kind === "agent");
    assert.equal(agentRows.length, 1, `one agent row (negotiated: ${negotiated})`);
    assert.deepEqual((agentRows[0].payload.agent as Record<string, unknown>).filesChanged, ["src/app.test.ts"]);
    assert.equal((agentRows[0].payload.agent as Record<string, unknown>).model, "claude-sonnet-5");
    if (negotiated) {
      const source = rows.find((row) => row.kind === "protocol" && row.payload.type === "item.subagent");
      assert.ok(source, "the protocol carries the sub-agent too");
      assert.equal(agentRows[0].payload.protocolEventId, source.payload.id, "marked as its twin");
      // …so the fold reads the sub-agent once, not once per vocabulary.
      const transcript = new CodeTaskTranscript("task-1", { includeAgentSummaries: true });
      transcript.applyAll(rows.map((row, index) => ({ seq: index + 1, ...row, createdAt: "2026-09-30T10:00:00.000Z" })));
      assert.equal(transcript.view.items.filter((item) => item.kind === "subagent").length, 1);
    } else {
      assert.equal("protocolEventId" in agentRows[0].payload, false);
    }
  }
});

test("an approval the mode answers is never pending at any point a flush can run", () => {
  const { sink, projector } = driver(true);
  // A flush can run between any two engine events (the kick at FLUSH_AT_COUNT
  // is a microtask, and the engine awaits the approval callback), never in
  // the middle of one: the rows one engine event yields are queued together.
  const boundaries: number[] = [];
  const step = (fn: () => void) => {
    fn();
    boundaries.push(sink.outbox.size);
  };
  step(() => sink.emitProtocol(projector.openTurn([{ text: "Install", delivery: "prompt" }])));
  step(() => sink.engineEvent({ type: "turn_started", turnIndex: 0 }));
  const request = { callId: "t9", toolName: "bash", input: { command: "npm ci" }, risk: "command", summary: "npm ci" };
  step(() => sink.engineEvent({ type: "approval_requested", request }));
  step(() => {
    projector.noteApprovalAnswer("t9", { by: "mode" });
    sink.engineEvent({ type: "approval_resolved", callId: "t9", decision: "allow" });
  });
  step(() => sink.engineEvent({ type: "tool_started", callId: "t9", name: "bash", input: { command: "npm ci" }, risk: "command" }));
  step(() =>
    sink.engineEvent({ type: "tool_finished", callId: "t9", name: "bash", output: "ok", isError: false, durationMs: 5, exitCode: 0 }),
  );

  const rows = sink.outbox
    .peek()
    .map((entry, index) => ({ seq: index + 1, kind: (entry as Row).kind, payload: (entry as Row).payload, createdAt: "2026-09-30T10:00:00.000Z" }));
  const types = rows.filter((row) => row.kind === "protocol").map((row) => row.payload.type);
  const requested = types.indexOf("approval.requested");
  assert.ok(requested >= 0, "the request is still on the record");
  assert.equal(types[requested + 1], "approval.resolved", "and its answer is right behind it");
  for (const end of boundaries) {
    const transcript = new CodeTaskTranscript("task-1");
    transcript.applyAll(rows.slice(0, end));
    assert.equal(transcript.pendingApproval, null, `a reader handed ${end} row(s) is offered no decision`);
  }
});

test("the prompt comes first, and survives a run that fails before the engine starts", () => {
  for (const negotiated of [true, false]) {
    const { sink, projector } = driver(negotiated);
    sink.hostEvent({ type: "session.created", target: "cloud", repository: { owner: "liam", name: "juno" } }, { turnId: null });
    sink.hostEvent({ type: "session.state", state: "running" }, { turnId: null });
    sink.emitProtocol(projector.openTurn([{ text: "Fix the login bug", delivery: "prompt" }]));
    sink.hostEvent({ type: "item.notice", itemId: projector.itemId("notice"), source: "host", text: "Cloud Code run started." });
    // The clone fails: the fatal handler's rows.
    sink.hostEvent({ type: "session.error", error: { code: "internal", message: "clone failed", retryable: false } }, { turnId: null });
    sink.hostEvent({ type: "session.state", state: "failed", reason: "clone failed" }, { turnId: null });

    const rows = sink.outbox.peek().map((entry, index) => ({
      seq: index + 1,
      kind: (entry as Row).kind,
      payload: (entry as Row).payload,
      createdAt: "2026-09-30T10:00:00.000Z",
    }));
    const legacy = rows.filter((row) => row.kind !== "protocol");
    assert.equal(legacy[0]?.kind, "user", "an old reader's first row is the prompt, as it always was");
    assert.equal(legacy[0]?.payload.text, "Fix the login bug");
    if (negotiated) {
      const transcript = new CodeTaskTranscript("task-1");
      transcript.applyAll(rows);
      const view = transcript.view;
      assert.equal(view.turns.length, 1);
      assert.equal(view.turns[0].status, "failed", "the turn the prompt opened ends with the run");
      const first = view.items[0];
      assert.equal(first?.kind, "user_message");
      assert.equal(first?.kind === "user_message" ? first.text : null, "Fix the login bug");
      assert.equal(transcript.errorMessage, "clone failed");
    }
  }
});

test("the engine's first turn continues the one the prompt opened", () => {
  const rows = run(true).filter((row) => row.kind === "protocol");
  const turns = rows.filter((row) => row.payload.type === "turn.started");
  assert.equal(turns.length, 1, "one turn, not a host turn and an engine turn");
  const prompt = rows.find((row) => row.payload.type === "item.user_message");
  assert.equal(prompt?.payload.turnId, turns[0].payload.turnId);
  const completed = rows.find((row) => row.payload.type === "turn.completed");
  assert.equal(completed?.payload.turnId, turns[0].payload.turnId);
});
