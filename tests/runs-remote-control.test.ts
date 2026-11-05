import assert from "node:assert/strict";
import test from "node:test";
import {
  codeApprovalKey,
  codeStopKey,
  decideRunApproval,
  modeForbidsApproval,
  stopRun,
  type CodeSessionForControl,
  type ControlResult,
  type RunControlDeps,
} from "../src/lib/runs/remote-control";
import {
  isHighRisk,
  liveRunsDigest,
  pendingCodeApprovals,
  projectCodeRun,
  projectWorkRun,
  sortLiveRuns,
  type CodeEventRow,
} from "../src/lib/runs/live-runs";
import { runApprovalSchema, runStopSchema } from "../src/lib/runs/protocol";

/*
 * Remote control of live runs (REA 8): the rules behind /api/runs/stop and
 * /api/runs/approval, against an in-memory world. Ownership is the first
 * thing every path checks, a Stop is idempotent across retries and devices,
 * nothing the run did not ask can be answered, and every Code stop and answer
 * leaves an audit row.
 */

const T0 = new Date("2026-10-18T09:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

type Command = { id: string; key: string; kind: string; payload: Record<string, unknown>; status: string };

interface World {
  sessions: Array<CodeSessionForControl & { userId: string; deviceId: string; sessionId: string }>;
  events: Record<string, CodeEventRow[]>;
  commands: Command[];
  audits: Array<Record<string, unknown>>;
  workRuns: Array<{ id: string; userId: string; sessionId: string; status: string; hostId: string | null }>;
  workApprovals: Array<{ id: string; userId: string; runId: string }>;
  paired: boolean;
  cancelCalls: string[];
  decisions: Array<{ id: string; body: unknown }>;
}

function world(overrides: Partial<World> = {}): World {
  return {
    sessions: [
      {
        id: "row-1",
        userId: "owner",
        deviceId: "mac-1",
        sessionId: "s-1",
        isRunning: false,
        isAwaitingApproval: true,
        currentStatus: "awaiting_approval",
        permissionMode: "approvalRequired",
        lastEventSequence: 7,
      },
    ],
    events: {
      "row-1": [
        { seq: 5, kind: "user_message", payload: { text: "Tidy the README" }, createdAt: at(0) },
        { seq: 6, kind: "tool_start", payload: { name: "shell", summary: "Running tests" }, createdAt: at(10) },
        { seq: 7, kind: "approval_request", payload: { requestId: "req-1", summary: "Run rm -rf build", risk: "command" }, createdAt: at(20) },
      ],
    },
    commands: [],
    audits: [],
    workRuns: [{ id: "run-1", userId: "owner", sessionId: "ws-1", status: "running", hostId: null }],
    workApprovals: [{ id: "wa-1", userId: "owner", runId: "run-1" }],
    paired: true,
    cancelCalls: [],
    decisions: [],
    ...overrides,
  };
}

function deps(w: World, cancel: (runId: string) => ControlResult = () => ({ status: 200, body: { run: { status: "cancelled" } } })): RunControlDeps {
  return {
    async findCodeSession(userId, deviceId, sessionId) {
      return w.sessions.find((s) => s.userId === userId && s.deviceId === deviceId && s.sessionId === sessionId) ?? null;
    },
    async codeEventsTail(_userId, remoteSessionId, take) {
      return [...(w.events[remoteSessionId] ?? [])].sort((a, b) => b.seq - a.seq).slice(0, take);
    },
    async requireCodePair() {
      return w.paired ? null : { status: 403, body: { error: "not_paired" } };
    },
    async enqueueCodeCommand(input) {
      const existing = w.commands.find((c) => c.key === input.idempotencyKey);
      if (existing) return { commandId: existing.id, status: existing.status, created: false, payload: existing.payload };
      const payload = input.kind === "approval"
        ? { approvalId: input.payload.requestId, approved: input.payload.approved }
        : input.payload;
      const command = { id: `cmd-${w.commands.length + 1}`, key: input.idempotencyKey, kind: input.kind, payload, status: "pending" };
      w.commands.push(command);
      return { commandId: command.id, status: command.status, created: true, payload };
    },
    async findWorkRun(userId, runId) {
      return w.workRuns.find((r) => r.userId === userId && r.id === runId) ?? null;
    },
    async cancelWorkRun(runId) {
      w.cancelCalls.push(runId);
      return cancel(runId);
    },
    async findWorkApproval(userId, approvalId) {
      return w.workApprovals.find((a) => a.userId === userId && a.id === approvalId) ?? null;
    },
    async decideWorkApproval(id, body) {
      w.decisions.push({ id, body });
      return { status: 200, body: { approval: { id, decision: body.decision } } };
    },
    async audit(input) {
      w.audits.push(input as unknown as Record<string, unknown>);
    },
  };
}

const codeRef = { kind: "code" as const, deviceId: "mac-1", sessionId: "s-1" };
const workRef = { kind: "work" as const, runId: "run-1" };
const DIGEST = "a".repeat(64);

// --- ownership --------------------------------------------------------------

test("another account's Code session is not found, and nothing is queued or audited", async () => {
  const w = world();
  const stop = await stopRun(deps(w), { userId: "intruder", actor: "ios", ref: codeRef });
  const answer = await decideRunApproval(deps(w), { userId: "intruder", actor: "ios", ref: codeRef, approvalId: "req-1", approve: true });
  assert.equal(stop.status, 404);
  assert.equal(answer.status, 404);
  assert.equal(w.commands.length, 0);
  assert.equal(w.audits.length, 0);
});

test("another account's Work run cannot be stopped or answered", async () => {
  const w = world();
  const stop = await stopRun(deps(w), { userId: "intruder", actor: "ios", ref: workRef });
  const answer = await decideRunApproval(deps(w), { userId: "intruder", actor: "ios", ref: workRef, approvalId: "wa-1", approve: true, actionDigest: DIGEST });
  assert.equal(stop.status, 404);
  assert.equal(answer.status, 404);
  assert.deepEqual(w.cancelCalls, []);
  assert.deepEqual(w.decisions, []);
});

test("a Work approval id from one run cannot answer another run's question", async () => {
  const w = world({
    workRuns: [
      { id: "run-1", userId: "owner", sessionId: "ws-1", status: "running", hostId: null },
      { id: "run-2", userId: "owner", sessionId: "ws-2", status: "running", hostId: null },
    ],
  });
  const result = await decideRunApproval(deps(w), {
    userId: "owner", actor: "ios", ref: { kind: "work", runId: "run-2" }, approvalId: "wa-1", approve: true, actionDigest: DIGEST,
  });
  assert.equal(result.status, 404);
  assert.deepEqual(w.decisions, []);
});

test("a Code command needs a live remote-control pair with the Mac", async () => {
  const w = world({ paired: false });
  const stop = await stopRun(deps(w), { userId: "owner", actor: "ios", ref: codeRef });
  assert.equal(stop.status, 403);
  assert.equal(w.commands.length, 0);
  assert.equal(w.audits.length, 0);
});

// --- idempotent stop --------------------------------------------------------

test("Stop on a Code session queues one stop and audits it once, however often it is pressed", async () => {
  const w = world();
  const first = await stopRun(deps(w), { userId: "owner", actor: "ios", ref: codeRef });
  const second = await stopRun(deps(w), { userId: "owner", actor: "web", ref: codeRef });
  assert.equal(first.status, 202);
  assert.equal(first.body.outcome, "stop_requested");
  assert.ok(second.status >= 200 && second.status < 300);
  assert.equal(second.body.outcome, "already_stopping");
  assert.equal(second.body.commandId, first.body.commandId);
  assert.equal(w.commands.length, 1);
  assert.equal(w.commands[0].key, codeStopKey("row-1", 7));
  assert.equal(w.audits.length, 1);
  assert.equal(w.audits[0].kind, "run_stop_requested");
  assert.equal(w.audits[0].actor, "ios");
  assert.deepEqual(w.audits[0].detail, {
    kind: "code", deviceId: "mac-1", sessionId: "s-1", commandId: "cmd-1", idempotencyKey: codeStopKey("row-1", 7),
  });
});

test("Stop on a Code session that is no longer live is a 2xx that queues nothing", async () => {
  const w = world();
  Object.assign(w.sessions[0], { isRunning: false, isAwaitingApproval: false, currentStatus: "completed" });
  const result = await stopRun(deps(w), { userId: "owner", actor: "ios", ref: codeRef });
  assert.equal(result.status, 200);
  assert.equal(result.body.outcome, "already_stopped");
  assert.equal(w.commands.length, 0);
});

test("Stop on a Work run cancels through the control route and audits; a second Stop is already_stopped", async () => {
  const w = world();
  const first = await stopRun(deps(w), { userId: "owner", actor: "ios", ref: workRef });
  assert.equal(first.status, 200);
  assert.equal(first.body.outcome, "stopped");
  assert.deepEqual(w.cancelCalls, ["run-1"]);
  assert.equal(w.audits.length, 1);
  assert.equal(w.audits[0].kind, "run_stop_requested");
  assert.equal(w.audits[0].runId, "run-1");

  w.workRuns[0].status = "cancelled";
  const second = await stopRun(deps(w), { userId: "owner", actor: "ios", ref: workRef });
  assert.equal(second.status, 200);
  assert.equal(second.body.outcome, "already_stopped");
  assert.deepEqual(w.cancelCalls, ["run-1"]);
  assert.equal(w.audits.length, 1);
});

test("a Stop that races the run's own ending is already_stopped, not a conflict", async () => {
  const w = world();
  const result = await stopRun(
    deps(w, () => ({ status: 409, body: { error: "run_not_live", status: "completed" } })),
    { userId: "owner", actor: "ios", ref: workRef }
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.outcome, "already_stopped");
  assert.equal(w.audits.length, 0);
});

// --- approvals --------------------------------------------------------------

test("a Code answer is queued once with the exact request id and audited", async () => {
  const w = world();
  const result = await decideRunApproval(deps(w), { userId: "owner", actor: "ios", ref: codeRef, approvalId: "req-1", approve: true });
  assert.equal(result.status, 202);
  assert.equal(w.commands.length, 1);
  assert.equal(w.commands[0].key, codeApprovalKey("row-1", "req-1"));
  assert.deepEqual(w.commands[0].payload, { approvalId: "req-1", approved: true });
  assert.equal(w.audits.at(-1)?.kind, "approval_decided");

  const replay = await decideRunApproval(deps(w), { userId: "owner", actor: "web", ref: codeRef, approvalId: "req-1", approve: true });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replay, true);
  assert.equal(w.commands.length, 1);
});

test("a different second answer to the same Code request is a conflict, not an overwrite", async () => {
  const w = world();
  await decideRunApproval(deps(w), { userId: "owner", actor: "ios", ref: codeRef, approvalId: "req-1", approve: true });
  const conflict = await decideRunApproval(deps(w), { userId: "owner", actor: "web", ref: codeRef, approvalId: "req-1", approve: false });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, "already_decided");
  assert.equal(w.commands.length, 1);
  assert.equal(w.audits.at(-1)?.kind, "approval_replay_refused");
});

test("a request the journal does not show as pending cannot be answered", async () => {
  const w = world();
  w.events["row-1"].push({ seq: 8, kind: "approval_response", payload: { requestId: "req-1", approved: false }, createdAt: at(30) });
  const answered = await decideRunApproval(deps(w), { userId: "owner", actor: "ios", ref: codeRef, approvalId: "req-1", approve: true });
  const invented = await decideRunApproval(deps(w), { userId: "owner", actor: "ios", ref: codeRef, approvalId: "req-forged", approve: true });
  assert.equal(answered.status, 409);
  assert.equal(invented.status, 409);
  assert.equal(w.commands.length, 0);
  assert.equal(w.audits.length, 2);
  assert.ok(w.audits.every((row) => row.kind === "approval_replay_refused" && row.severity === "refusal"));
});

test("a mode that forbids acting refuses an approve server-side, but a deny still goes through", async () => {
  const w = world();
  w.sessions[0].permissionMode = "plan";
  const approve = await decideRunApproval(deps(w), { userId: "owner", actor: "ios", ref: codeRef, approvalId: "req-1", approve: true });
  assert.equal(approve.status, 403);
  assert.equal(approve.body.error, "mode_forbids");
  const deny = await decideRunApproval(deps(w), { userId: "owner", actor: "ios", ref: codeRef, approvalId: "req-1", approve: false });
  assert.equal(deny.status, 202);
  assert.equal(modeForbidsApproval("approvalRequired"), false);
  assert.equal(modeForbidsApproval("readOnly"), true);
});

test("a Work answer goes through the decision route with the digest, and without one is refused", async () => {
  const w = world();
  const missing = await decideRunApproval(deps(w), { userId: "owner", actor: "ios", ref: workRef, approvalId: "wa-1", approve: true });
  assert.equal(missing.status, 400);
  const sent = await decideRunApproval(deps(w), { userId: "owner", actor: "ios", ref: workRef, approvalId: "wa-1", approve: false, actionDigest: DIGEST });
  assert.equal(sent.status, 200);
  assert.deepEqual(w.decisions, [{ id: "wa-1", body: { decision: "denied", actionDigest: DIGEST } }]);
});

// --- projection --------------------------------------------------------------

test("a Code run projects its turn's steps, current action, cost and open question", () => {
  const w = world();
  const run = projectCodeRun({
    session: {
      deviceId: "mac-1", sessionId: "s-1", title: "README", currentStatus: "awaiting_approval",
      isRunning: false, isAwaitingApproval: true, permissionMode: "approvalRequired",
      usage: { costUsd: 0.42 }, sessionUpdatedAt: at(20), lastMessageAt: at(0),
    },
    hostName: "Studio",
    hostOnline: true,
    events: [
      { seq: 1, kind: "user_message", payload: { text: "earlier" }, createdAt: at(-600) },
      { seq: 2, kind: "tool_start", payload: { name: "computer", summary: "old" }, createdAt: at(-590) },
      ...w.events["row-1"],
    ],
  });
  assert.equal(run.key, "code:mac-1:s-1");
  assert.equal(run.status, "waiting_approval");
  assert.equal(run.steps, 1);
  assert.equal(run.currentAction, "Running tests");
  assert.equal(run.usesComputer, false);
  assert.equal(run.startedAt, at(0).toISOString());
  assert.equal(run.costUsd, 0.42);
  assert.equal(run.approvals.length, 1);
  assert.equal(run.approvals[0].id, "req-1");
  assert.equal(run.approvals[0].highRisk, true);
});

test("canonical envelopes and a finished turn are read like the phone reads them", () => {
  const events: CodeEventRow[] = [
    {
      seq: 1, kind: "canonical_session_event",
      payload: { event: { payload: { approvalRequested: { requestId: "r-9", summary: "Click Buy", risk: "purchase" } } } },
      createdAt: at(0),
    },
  ];
  assert.equal(pendingCodeApprovals(events)[0]?.id, "r-9");
  assert.equal(pendingCodeApprovals(events)[0]?.highRisk, true);
  events.push({ seq: 2, kind: "completed", payload: {}, createdAt: at(1) });
  assert.deepEqual(pendingCodeApprovals(events), []);
});

test("a Work run projects cost, steps, target and only unexpired pending approvals", () => {
  const run = projectWorkRun({
    run: {
      id: "run-1", status: "waiting_approval", effectiveTarget: "cloud", requestedTarget: "automatic",
      costMicroUsd: 1_250_000, startedAt: at(0), createdAt: at(-5), updatedAt: at(30), sessionTitle: "Book flights",
    },
    hostName: "Studio",
    hostOnline: false,
    steps: 4,
    latestTool: { payload: { tool: "computer_use", summary: "Clicking Search" } },
    approvals: [
      { id: "a-1", summary: "Pay $420", risk: "irreversible", actionDigest: DIGEST, decision: "pending", createdAt: at(10), expiresAt: at(600) },
      { id: "a-2", summary: "Old", risk: "edit", actionDigest: DIGEST, decision: "pending", createdAt: at(5), expiresAt: at(15) },
      { id: "a-3", summary: "Done", risk: "edit", actionDigest: DIGEST, decision: "allowed", createdAt: at(5), expiresAt: at(600) },
    ],
    now: at(60),
  });
  assert.equal(run.target, "cloud");
  assert.equal(run.hostName, null);
  assert.equal(run.hostOnline, true);
  assert.equal(run.costUsd, 1.25);
  assert.equal(run.steps, 4);
  assert.equal(run.usesComputer, true);
  assert.equal(run.currentAction, "Clicking Search");
  assert.deepEqual(run.approvals.map((a) => a.id), ["a-1"]);
  assert.equal(run.approvals[0].actionDigest, DIGEST);
  assert.equal(run.approvals[0].highRisk, true);
});

test("risk: unknown words fail closed to high risk; routine ones do not", () => {
  for (const risk of ["safe", "neutral", "edit", "Low"]) assert.equal(isHighRisk(risk), false, risk);
  for (const risk of ["command", "sensitive", "irreversible", "purchase", "send", "settings", "brand-new"]) {
    assert.equal(isHighRisk(risk), true, risk);
  }
});

test("needs-you runs sort first and the digest changes when a row does", () => {
  const base = projectWorkRun({
    run: { id: "r", status: "running", effectiveTarget: "mac", requestedTarget: "mac", costMicroUsd: 0, startedAt: at(0), createdAt: at(0), updatedAt: at(50), sessionTitle: "A" },
    hostName: "Studio", hostOnline: true, steps: 1, latestTool: null, approvals: [], now: at(60),
  });
  const waiting = { ...base, key: "work:w", updatedAt: at(10).toISOString(), approvals: [{ ...base.approvals[0], id: "x", summary: "s", detail: null, risk: "edit", highRisk: false, actionDigest: DIGEST, requestedAt: "", expiresAt: null }] };
  const sorted = sortLiveRuns([base, waiting]);
  assert.equal(sorted[0].key, "work:w");
  assert.notEqual(liveRunsDigest([base]), liveRunsDigest([{ ...base, steps: 2 }]));
});

test("the wire schemas accept the two run shapes and refuse anything else", () => {
  assert.equal(runStopSchema.safeParse({ run: codeRef }).success, true);
  assert.equal(runStopSchema.safeParse({ run: workRef }).success, true);
  assert.equal(runStopSchema.safeParse({ run: { kind: "agent", id: "x" } }).success, false);
  assert.equal(runApprovalSchema.safeParse({ run: workRef, approvalId: "wa-1", approve: true, actionDigest: "nope" }).success, false);
  assert.equal(runApprovalSchema.safeParse({ run: codeRef, approvalId: "req-1", approve: "yes" }).success, false);
});
