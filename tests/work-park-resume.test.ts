import test from "node:test";
import assert from "node:assert/strict";

import { WORK_ASK_TOOL_NAME, WorkAgentSession, WorkRunParked } from "../runner/agent-core/src/work/session.js";
import { WorkPlan } from "../runner/agent-core/src/work/plan.js";
import type {
  WorkApprovalAnswer,
  WorkApprovalRequest,
  WorkEmittedEvent,
  WorkQuestion,
  WorkToolDefinition,
} from "../runner/agent-core/src/work/types.js";
import type { ProviderAdapter, ProviderRequest, ProviderStreamEvent } from "../runner/agent-core/src/providers/types.js";
import type { ChatMessage } from "../runner/agent-core/src/types.js";
import {
  APPROVED_WHILE_PARKED,
  DECLINED_WHILE_PARKED,
  DEFAULT_ATTENDED_WAIT_MS,
  DEFAULT_MAX_PARKED_RUNS_PER_ACCOUNT,
  attendedWaitMs,
  deriveQuestionState,
  judgeRecordedApproval,
  maxParkedRunsPerAccount,
  planParkedDecisions,
  type RecordedApproval,
} from "../src/lib/work/park-resume-rules";
import { actionDigest, policyDigest } from "../src/lib/work/digests";
import { deriveOpenQuestions } from "../src/components/work/work-decisions";
import { GOAL_WAITING_FOR_ANSWER, planGoalStep, type GoalTaskView, type GoalView } from "../src/lib/agents/goals";
import type { ClientWorkEvent } from "../src/lib/work/serializers";

/*
 * "Needs you" after a run is parked, at the runtime and the pure rules.
 *
 * A cloud run that asks and gets no answer inside the attended wait is set
 * aside. These pin the three things that make a later answer count: the park
 * is not reported as a failure, the restored run is handed what the person
 * said instead of asking again, and a recorded approval covers the re-asked
 * call only for the same digest, the same policy and before its own expiry.
 * The database half (requeue, routes, goal expiry) is
 * tests/work-park-resume.integration.test.ts.
 */

type Turn = { text?: string; call?: { name: string; input: Record<string, unknown> } };

/** A provider that plays `turns` in order; call ids carry `prefix`, as a real lab's are fresh per response. */
function scripted(turns: Turn[], prefix = "call"): ProviderAdapter & { requests: ChatMessage[][] } {
  let id = 0;
  const adapter = {
    id: "test",
    name: "Test Lab",
    defaultModel: "test-model",
    requests: [] as ChatMessage[][],
    models: () => ["test-model"],
    capabilities: () => ({
      tools: true,
      vision: false,
      computerUse: false,
      reasoningLevels: [],
      maxContext: 100_000,
      streaming: true,
      mcp: false,
    }),
    async *stream(request: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
      adapter.requests.push(JSON.parse(JSON.stringify(request.messages)) as ChatMessage[]);
      const turn = turns.shift();
      assert.ok(turn, "the script ran out of turns");
      if (turn.text) yield { type: "text_delta", text: turn.text };
      if (turn.call) {
        id += 1;
        yield { type: "tool_call", id: `${prefix}_${id}`, name: turn.call.name, input: turn.call.input };
      }
      yield { type: "done", stopReason: turn.call ? "tool_use" : "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return adapter as ProviderAdapter & { requests: ChatMessage[][] };
}

function sendTool(sent: string[]): WorkToolDefinition {
  return {
    kind: "edit",
    tier: "connector",
    intents: ["connector.mail.send"],
    intentFor: () => "connector.mail.send",
    actionFor: () => "work.connector.send_message",
    riskFor: () => "sensitive",
    provenanceFor: () => ({ source: "mail", sourceKind: "connector", action: "work.connector.send_message", trust: "trusted" }),
    spec: { name: "mail_send", description: "Send a message.", inputSchema: { type: "object" } },
    summarize: () => "Send a message",
    execute: (input) => {
      sent.push(String((input as { to?: unknown }).to ?? ""));
      return Promise.resolve({ output: "sent" });
    },
  };
}

const POLICY = { policy: "conservative" };

interface Callbacks {
  ask?: (question: WorkQuestion, session: WorkAgentSession) => Promise<string>;
  approve?: (request: WorkApprovalRequest, session: WorkAgentSession) => Promise<WorkApprovalAnswer>;
}

function options(provider: ProviderAdapter, tools: WorkToolDefinition[], events: WorkEmittedEvent[], callbacks: Callbacks, ref: { session: WorkAgentSession | null }) {
  return {
    runId: "run-park",
    goal: "Pay the right invoices.",
    provider,
    model: "test-model",
    cwd: "/tmp",
    tools,
    budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 },
    approvalMode: "conservative" as const,
    permissionPolicy: POLICY,
    compaction: false as const,
    callbacks: {
      onEvent: (event: WorkEmittedEvent) => events.push(event),
      askQuestion: (question: WorkQuestion) => {
        assert.ok(callbacks.ask, `asked "${question.question}" with nobody to answer`);
        return callbacks.ask(question, ref.session!);
      },
      requestApproval: (request: WorkApprovalRequest) => {
        assert.ok(callbacks.approve, `asked to approve ${request.action} with nobody to answer`);
        return callbacks.approve(request, ref.session!);
      },
    },
  };
}

/** The runner's park: pause the session, then unwind the tool call. */
function park(session: WorkAgentSession, what: "answer" | "approval"): never {
  session.pause(`Waiting for an ${what}.`);
  throw new WorkRunParked(`paused-waiting-for-${what}`);
}

function toolResults(messages: readonly ChatMessage[]): Array<{ id: string; content: string; isError: boolean }> {
  const out: Array<{ id: string; content: string; isError: boolean }> = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const part of message.content) {
      if (part.type === "tool_result") out.push({ id: part.toolCallId, content: part.content, isError: part.isError === true });
    }
  }
  return out;
}

async function parkOnQuestion() {
  const events: WorkEmittedEvent[] = [];
  const ref: { session: WorkAgentSession | null } = { session: null };
  const provider = scripted([{ call: { name: WORK_ASK_TOOL_NAME, input: { question: "Which Invoices folder?", why: "Two are called Invoices." } } }]);
  const session = new WorkAgentSession({
    ...options(provider, [], events, { ask: (_q, s) => park(s, "answer") }, ref),
    plan: new WorkPlan([{ id: "s1", title: "Pay" }]),
  });
  ref.session = session;
  const result = await session.run();
  assert.equal(result.state, "paused");
  if (result.state !== "paused") throw new Error("unreachable");
  return { events, checkpoint: result.checkpoint };
}

test("a park is not a failure: paused, checkpointed, and no error row in the timeline", async () => {
  const { events, checkpoint } = await parkOnQuestion();
  assert.deepEqual(events.filter((event) => event.kind === "error"), [], "an ordinary park writes no error event");
  assert.equal(events.filter((event) => event.kind === "paused").length, 1);
  const parked = WorkAgentSession.parkedToolCalls(checkpoint);
  assert.deepEqual(parked.map((call) => call.name), [WORK_ASK_TOOL_NAME]);
  assert.deepEqual(toolResults(checkpoint.messages).map((r) => r.content), ["Stopped before this finished."]);
});

test("a genuine tool failure on the way is still reported as an error", async () => {
  const events: WorkEmittedEvent[] = [];
  const ref: { session: WorkAgentSession | null } = { session: null };
  const provider = scripted([{ call: { name: WORK_ASK_TOOL_NAME, input: { question: "Which?", why: "Because." } } }]);
  const session = new WorkAgentSession({
    ...options(provider, [], events, { ask: () => Promise.reject(new Error("the database went away")) }, ref),
    plan: new WorkPlan([{ id: "s1", title: "Pay" }]),
  });
  ref.session = session;
  const result = await session.run();
  assert.equal(result.state, "finished");
  assert.equal(events.filter((event) => event.kind === "error").length, 1);
});

test("an answer given while parked reaches the restored run as the question's result, once", async () => {
  const { checkpoint } = await parkOnQuestion();
  const parked = WorkAgentSession.parkedToolCalls(checkpoint);
  const planned = planParkedDecisions({
    calls: parked,
    askToolName: WORK_ASK_TOOL_NAME,
    answers: new Map([[parked[0].id, "The 2024 one"]]),
    approvals: [],
    policy: POLICY,
    now: new Date(),
  });

  const events: WorkEmittedEvent[] = [];
  const ref: { session: WorkAgentSession | null } = { session: null };
  const provider = scripted([{ text: "Paying from Invoices 2024." }]);
  let asked = 0;
  const session = WorkAgentSession.restore(checkpoint, options(provider, [], events, { ask: () => { asked += 1; return Promise.resolve("no"); } }, ref));
  ref.session = session;
  const settled = session.settleParkedCalls(planned.resolutions);
  assert.deepEqual(settled, [parked[0].id]);
  planned.decisions.delivered(settled);
  await session.run();

  assert.equal(asked, 0, "the person is not asked again");
  const sent = toolResults(provider.requests[0]);
  assert.deepEqual(sent, [{ id: parked[0].id, content: "The 2024 one", isError: false }], "the model reads the answer, not 'Stopped before this finished.'");
  assert.equal(planned.decisions.takeAnswer("Which Invoices folder?"), null, "an answer already delivered is not reused for a fresh ask");
  // Settling is idempotent: the result is no longer a stopped placeholder.
  assert.deepEqual(session.settleParkedCalls(planned.resolutions), []);
});

test("with no answer recorded the restored run keeps the stopped result and asks again", async () => {
  const { checkpoint } = await parkOnQuestion();
  const parked = WorkAgentSession.parkedToolCalls(checkpoint);
  const planned = planParkedDecisions({ calls: parked, askToolName: WORK_ASK_TOOL_NAME, answers: new Map(), approvals: [], policy: POLICY, now: new Date() });
  assert.equal(planned.resolutions.size, 0);

  const events: WorkEmittedEvent[] = [];
  const ref: { session: WorkAgentSession | null } = { session: null };
  const provider = scripted([
    { call: { name: WORK_ASK_TOOL_NAME, input: { question: "Which Invoices folder?", why: "Two are called Invoices." } } },
    { text: "Done." },
  ], "resumed");
  const questions: string[] = [];
  const session = WorkAgentSession.restore(checkpoint, options(provider, [], events, { ask: (q) => { questions.push(q.id); return Promise.resolve("2024"); } }, ref));
  ref.session = session;
  assert.deepEqual(session.settleParkedCalls(planned.resolutions), []);
  await session.run();
  assert.equal(questions.length, 1, "asked again, once");
  assert.notEqual(questions[0], parked[0].id, "under a new id");
});

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/** The row the cloud runner writes for a request (scripts/work-runner.ts `requestApproval`). */
function rowFor(request: WorkApprovalRequest, decision: string, expiresAt = new Date(Date.now() + 15 * 60_000)): RecordedApproval {
  const detail = JSON.parse(request.digestInput) as unknown;
  return {
    id: "approval-1",
    action: request.action,
    actionDigest: actionDigest(request.action, detail),
    policyDigest: policyDigest(POLICY),
    decision,
    expiresAt,
    detail,
  };
}

async function parkOnApproval() {
  const events: WorkEmittedEvent[] = [];
  const sent: string[] = [];
  const ref: { session: WorkAgentSession | null } = { session: null };
  const requests: WorkApprovalRequest[] = [];
  const provider = scripted([{ call: { name: "mail_send", input: { to: "ana@example.com", body: "Paid." } } }]);
  const session = new WorkAgentSession({
    ...options(provider, [sendTool(sent)], events, { approve: (request, s) => { requests.push(request); return park(s, "approval"); } }, ref),
    plan: new WorkPlan([{ id: "s1", title: "Pay" }]),
  });
  ref.session = session;
  const result = await session.run();
  assert.equal(result.state, "paused");
  if (result.state !== "paused") throw new Error("unreachable");
  assert.deepEqual(sent, [], "nothing is sent before anyone decides");
  assert.deepEqual(events.filter((event) => event.kind === "error"), []);
  return { checkpoint: result.checkpoint, request: requests[0] };
}

async function resumeWith(row: RecordedApproval, script: Turn[], now = new Date()) {
  const { checkpoint } = await parkOnApproval();
  const parked = WorkAgentSession.parkedToolCalls(checkpoint);
  const planned = planParkedDecisions({ calls: parked, askToolName: WORK_ASK_TOOL_NAME, answers: new Map(), approvals: [row], policy: POLICY, now });
  const events: WorkEmittedEvent[] = [];
  const sent: string[] = [];
  const askedAgain: WorkApprovalRequest[] = [];
  const ref: { session: WorkAgentSession | null } = { session: null };
  const provider = scripted(script, "resumed");
  const session = WorkAgentSession.restore(
    checkpoint,
    options(provider, [sendTool(sent)], events, {
      approve: (request) => {
        const recorded = planned.decisions.takeApproval(request, POLICY, now);
        if (recorded?.use) return Promise.resolve(recorded.decision);
        askedAgain.push(request);
        return Promise.resolve("denied");
      },
    }, ref)
  );
  ref.session = session;
  session.settleParkedCalls(planned.resolutions);
  await session.run();
  return { sent, askedAgain, provider, planned, parked };
}

const SAME = { name: "mail_send", input: { to: "ana@example.com", body: "Paid." } };

test("approve-after-park: the re-asked call runs on the recorded decision, the person approves once", async () => {
  const { request } = await parkOnApproval();
  const { sent, askedAgain, provider, parked } = await resumeWith(rowFor(request, "allowed"), [{ call: SAME }, { text: "Sent." }]);
  assert.deepEqual(sent, ["ana@example.com"], "sent exactly once");
  assert.deepEqual(askedAgain, [], "not asked again");
  assert.deepEqual(toolResults(provider.requests[0]).find((r) => r.id === parked[0].id)?.content, APPROVED_WHILE_PARKED);
});

test("the recorded decision covers the parked call once, not a second identical action", async () => {
  const { request } = await parkOnApproval();
  const { sent, askedAgain } = await resumeWith(rowFor(request, "allowed"), [{ call: SAME }, { call: SAME }, { text: "Sent twice?" }]);
  assert.deepEqual(sent, ["ana@example.com"], "the second send was not covered");
  assert.equal(askedAgain.length, 1, "the second identical action asks again");
});

test("a different action than the one approved asks again (digest)", async () => {
  const { request } = await parkOnApproval();
  const { sent, askedAgain } = await resumeWith(rowFor(request, "allowed"), [
    { call: { name: "mail_send", input: { to: "someone-else@example.com", body: "Paid." } } },
    { text: "Done." },
  ]);
  assert.deepEqual(sent, []);
  assert.equal(askedAgain.length, 1);

  // Same call, different action name: the recomputed digest differs from the stored one.
  const row = rowFor(request, "allowed");
  const verdict = judgeRecordedApproval({ row, action: "work.connector.delete_message", detail: row.detail, policy: POLICY, now: new Date() });
  assert.deepEqual(verdict, { use: false, reason: "digest_mismatch" });
});

test("an expired approval asks again; its expiry is the stored one, never extended", async () => {
  const { request } = await parkOnApproval();
  const expired = rowFor(request, "allowed", new Date(Date.now() - 1_000));
  const { sent, askedAgain, provider, parked } = await resumeWith(expired, [{ call: SAME }, { text: "Done." }]);
  assert.deepEqual(sent, []);
  assert.equal(askedAgain.length, 1);
  assert.equal(toolResults(provider.requests[0]).find((r) => r.id === parked[0].id)?.content, "Stopped before this finished.", "an expired decision is not announced as an approval");
  assert.deepEqual(
    judgeRecordedApproval({ row: expired, action: expired.action, detail: expired.detail, policy: POLICY, now: new Date() }),
    { use: false, reason: "expired" }
  );
});

test("a narrowed policy asks again; a denial is applied as a denial", async () => {
  const { request } = await parkOnApproval();
  const row = rowFor(request, "allowed");
  assert.deepEqual(
    judgeRecordedApproval({ row, action: row.action, detail: row.detail, policy: { policy: "conservative", host: "manual" }, now: new Date() }),
    { use: false, reason: "policy_changed" }
  );
  const pending = rowFor(request, "pending");
  assert.deepEqual(judgeRecordedApproval({ row: pending, action: row.action, detail: row.detail, policy: POLICY, now: new Date() }), { use: false, reason: "undecided" });

  const denied = rowFor(request, "denied", new Date(Date.now() - 1_000));
  const { sent, askedAgain, provider, parked } = await resumeWith(denied, [{ call: SAME }, { text: "Not sent." }]);
  assert.deepEqual(sent, []);
  assert.deepEqual(askedAgain, [], "a recorded no is not asked again");
  const result = toolResults(provider.requests[0]).find((r) => r.id === parked[0].id);
  assert.deepEqual(result, { id: parked[0].id, content: DECLINED_WHILE_PARKED, isError: true });
});

// ---------------------------------------------------------------------------
// Which question is open, and the numbers
// ---------------------------------------------------------------------------

const started = (seq: number) => ({ seq, kind: "run_started", payload: { executor: "cloud" } });
const asked = (seq: number, id: string) => ({ seq, kind: "question_asked", payload: { kind: "question_asked", question: { id, question: "Which?" } } });
const answered = (seq: number, id: string, text: string) => ({ seq, kind: "question_answered", payload: { questionId: id, text } });

test("a question is open only in the execution that asked it, until it is answered", () => {
  assert.deepEqual(deriveQuestionState([started(1), asked(5, "q1")], "q1"), { asked: true, open: true, answer: null });
  assert.deepEqual(deriveQuestionState([started(1), asked(5, "q1"), answered(7, "q1", "A")], "q1"), { asked: true, open: false, answer: "A" });
  // Resumed without an answer: the next execution asks under a new id, and the old one is closed.
  const resumed = [started(1), asked(5, "q1"), started(9), asked(12, "q2")];
  assert.equal(deriveQuestionState(resumed, "q1").open, false);
  assert.equal(deriveQuestionState(resumed, "q2").open, true);
  assert.deepEqual(deriveQuestionState(resumed, "nope"), { asked: false, open: false, answer: null });
  // A fixed id asked again (the plan review) is open again in the new execution.
  assert.equal(deriveQuestionState([started(1), asked(5, "plan"), started(9), asked(11, "plan")], "plan").open, true);
  // A Mac run writes no cloud marker, and the session's own run_started is not one.
  assert.equal(deriveQuestionState([{ seq: 1, kind: "run_started", payload: { goal: "x" } }, asked(3, "q1")], "q1").open, true);
});

test("the web card closes a question the next cloud execution left behind", () => {
  const event = (seq: number, kind: string, payload: Record<string, unknown>): ClientWorkEvent =>
    ({ id: `e${seq}`, runId: "r", seq, kind, payloadVersion: 1, visibility: "user", payload, eventKey: null, agentId: null, createdAt: new Date(seq * 1000).toISOString() }) as unknown as ClientWorkEvent;
  const events = [
    event(1, "run_started", { executor: "cloud" }),
    event(2, "question_asked", { kind: "question_asked", question: { id: "q1", question: "Which?", why: "Two." } }),
    event(3, "run_started", { executor: "cloud" }),
    event(4, "question_asked", { kind: "question_asked", question: { id: "q2", question: "Which one?", why: "Two." } }),
  ];
  assert.deepEqual(deriveOpenQuestions(events).map((q) => q.id), ["q2"]);
  assert.deepEqual(deriveOpenQuestions(events.slice(0, 2)).map((q) => q.id), ["q1"]);
});

test("the attended wait and the parked bound read env, bounded, with conservative defaults", () => {
  assert.equal(DEFAULT_ATTENDED_WAIT_MS, 60_000);
  assert.equal(attendedWaitMs(undefined), 60_000);
  assert.equal(attendedWaitMs(""), 60_000);
  assert.equal(attendedWaitMs("soon"), 60_000);
  assert.equal(attendedWaitMs("30000"), 30_000);
  assert.equal(attendedWaitMs("10"), 1_000);
  assert.equal(attendedWaitMs("999999999"), 240_000);
  assert.equal(DEFAULT_MAX_PARKED_RUNS_PER_ACCOUNT, 10);
  assert.equal(maxParkedRunsPerAccount(undefined), 10);
  assert.equal(maxParkedRunsPerAccount("2.5"), 10);
  assert.equal(maxParkedRunsPerAccount("0"), 1);
  assert.equal(maxParkedRunsPerAccount("4"), 4);
  assert.equal(maxParkedRunsPerAccount("1000"), 100);
});

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

const now = new Date("2026-10-27T12:00:00Z");
const goal: GoalView = {
  id: "g1",
  title: "Close the month",
  detail: "",
  status: "active",
  milestones: [{ id: "a", title: "Pay invoices", done: false }],
  successCriteria: [],
  budgetMicroUsd: null,
  spentMicroUsd: 0,
  maxRuns: 6,
  runsUsed: 1,
  maxAttemptsPerStep: 2,
  dueAt: null,
  cadence: "none",
};
const task = (partial: Partial<GoalTaskView>): GoalTaskView => ({
  sessionId: "s1",
  stepKey: "a",
  status: "running",
  attempt: 1,
  acted: false,
  costMicroUsd: 0,
  createdAt: new Date("2026-10-27T10:00:00Z"),
  ...partial,
});

test("a goal step that parked says it is waiting for the person, not working", () => {
  assert.equal(planGoalStep(goal, [task({ status: "paused", pauseReason: "waiting" })], now).nextAction, GOAL_WAITING_FOR_ANSWER);
  assert.equal(planGoalStep(goal, [task({ status: "waiting_input" })], now).nextAction, GOAL_WAITING_FOR_ANSWER);
  assert.equal(planGoalStep(goal, [task({ status: "paused", pauseReason: "user" })], now).nextAction, "Paused on the current step; resume it to continue");
  assert.equal(planGoalStep(goal, [task({ status: "running" })], now).nextAction, "Working on the current step");
});

test("a goal step that waited out its answer asks the person instead of retrying itself", () => {
  const step = planGoalStep(goal, [task({ status: "interrupted", waitedOut: true })], now);
  assert.equal(step.kind, "ask");
  if (step.kind === "ask") {
    assert.equal(step.blocker.kind, "needs_decision");
    assert.match(step.blocker.text, /waited 24 hours for your answer/);
    assert.equal(step.pause, false);
  }
  // An ordinary interruption before acting is still retried on its own.
  assert.equal(planGoalStep(goal, [task({ status: "interrupted" })], now).kind, "retry");
  // Continue retries the waited-out step, within the run bound.
  assert.equal(planGoalStep(goal, [task({ status: "interrupted", waitedOut: true })], now, { retryApproved: true }).kind, "retry");
});
