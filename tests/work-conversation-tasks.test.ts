import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CONVERSATION_LIVE_STATUSES,
  CONVERSATION_WAITING_STATUSES,
  MAX_LIVE_TASKS_PER_CONVERSATION,
  composerTaskId,
  conversationAtCapMessage,
  memberAtCapMessage,
  mergeDiscoveredTasks,
  tasksToDraw,
  waitingTasksFirst,
  type ConversationTaskRow,
} from "@/lib/work/conversation-tasks";
import { delegatedComposerPlaceholder } from "@/lib/work/delegation";
import { aggregateAgentState } from "@/lib/agents/domain";
import { threadAgentState } from "@/components/agents/thread-agent-state";
import type { ClientAgent } from "@/lib/agents/types";
import type { ClientWorkSession } from "@/lib/work/serializers";

/*
 * Several live tasks per conversation. The chat used to follow one task, the
 * newest, and the server refused a second; a routine firing in a crew
 * member's thread then replaced the person's task on screen and blocked
 * start_task. Now every live task draws, under a cap with a sentence.
 */

const row = (id: string, status: string, createdAt: string, extra: Partial<ConversationTaskRow> = {}): ConversationTaskRow => ({
  id,
  status,
  needsAttention: false,
  createdAt,
  lastActivityAt: createdAt,
  ...extra,
});

test("the cap is four, and its sentence names what is running", () => {
  assert.equal(MAX_LIVE_TASKS_PER_CONVERSATION, 4);
  assert.ok(!CONVERSATION_LIVE_STATUSES.includes("draft"));
  const message = conversationAtCapMessage(["A", "B", "C", "D"]);
  assert.equal(message, 'This conversation already has 4 tasks going: "A", "B", "C" and "D". Let one finish or stop one before starting another. Nothing new was started.');
  assert.match(memberAtCapMessage("Mira", ["A", "B", "C", "D"]), /^Mira already has 4 tasks going: "A", "B", "C" and "D"\. Let one finish before handing Mira more\. Nothing was handed off\.$/);
});

test("every live task draws, oldest first, with the newest finished one when there is room", () => {
  const rows = [
    row("routine", "running", "2026-09-30T08:00:00Z"),
    row("person", "waiting_input", "2026-09-30T09:00:00Z"),
    row("old-done", "completed", "2026-09-29T08:00:00Z", { lastActivityAt: "2026-09-29T09:00:00Z" }),
    row("new-done", "failed", "2026-09-30T07:00:00Z", { lastActivityAt: "2026-09-30T07:30:00Z" }),
    row("draft", "draft", "2026-09-30T10:00:00Z"),
  ];
  assert.deepEqual(tasksToDraw(rows).map((r) => r.id), ["new-done", "routine", "person"]);
  // At the cap the finished card gives way; live ones never do.
  const full = ["a", "b", "c", "d"].map((id, i) => row(id, "running", `2026-09-30T0${i}:00:00Z`));
  assert.deepEqual(tasksToDraw([...full, rows[3]]).map((r) => r.id), ["a", "b", "c", "d"]);
  const over = [...full, row("e", "queued", "2026-09-30T05:00:00Z")];
  assert.equal(tasksToDraw(over).length, 5, "a live task over the cap is still drawn, never hidden");
});

test("a later discovery never takes away a card that is on screen, and an unchanged answer keeps identity", () => {
  const a = row("a", "running", "2026-09-30T08:00:00Z");
  const b = row("b", "completed", "2026-09-30T07:00:00Z");
  const current = [b, a];
  // `b` finished and fell out of the answer (a newer finished task took its
  // place); it stays, because the person may be reading its result.
  const next = mergeDiscoveredTasks(current, [a]);
  assert.equal(next, current, "nothing changed, so the same array comes back");
  const moved = mergeDiscoveredTasks(current, [{ ...a, status: "completed", lastActivityAt: "2026-09-30T09:00:00Z" }]);
  assert.deepEqual(moved.map((r) => [r.id, r.status]), [["b", "completed"], ["a", "completed"]]);
  const added = mergeDiscoveredTasks(current, [row("c", "queued", "2026-09-30T10:00:00Z"), row("d", "draft", "2026-09-30T11:00:00Z")]);
  assert.deepEqual(added.map((r) => r.id), ["b", "a", "c"], "drafts are never drawn");
});

test("the composer answers the task that is waiting, else steers the newest live one", () => {
  const reports = [
    { sessionId: "routine", createdAt: "2026-09-30T08:00:00Z", live: true, waiting: false },
    { sessionId: "person", createdAt: "2026-09-30T09:00:00Z", live: true, waiting: false },
    { sessionId: "done", createdAt: "2026-09-30T10:00:00Z", live: false, waiting: false },
  ];
  assert.equal(composerTaskId(reports), "person");
  assert.equal(composerTaskId([...reports, { sessionId: "asks", createdAt: "2026-09-30T07:00:00Z", live: true, waiting: true }]), "asks");
  assert.equal(composerTaskId([reports[2]]), null);
  assert.equal(delegatedComposerPlaceholder({ kind: "steer" }), "Add an instruction to the running task…");
  assert.equal(delegatedComposerPlaceholder({ kind: "steer" }, "Q3 plan"), "Add an instruction to “Q3 plan”…");
  assert.equal(delegatedComposerPlaceholder({ kind: "answer", questionId: "q", question: "?" }, "Inbox"), "Answer the question from “Inbox”…");
});

test("a member's state aggregates every task: waiting beats working beats the rest", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  const task = (sessionId: string, status: string, minutesAgo: number, needsAttention = false) => ({
    sessionId,
    title: sessionId,
    status,
    needsAttention,
    lastActivityAt: new Date(now.getTime() - minutesAgo * 60_000),
  });
  // A waiting task and a NEWER running routine: the face says waiting, about the waiting task.
  const mixed = aggregateAgentState({ status: "active", tasks: [task("person", "waiting_approval", 30), task("routine", "running", 1)], now });
  assert.equal(mixed.state, "waiting");
  assert.equal(mixed.task?.sessionId, "person");
  assert.equal(aggregateAgentState({ status: "active", tasks: [task("a", "completed", 5), task("b", "running", 60)], now }).state, "working");
  assert.equal(aggregateAgentState({ status: "active", tasks: [task("a", "completed", 5), task("b", "failed", 60)], now }).state, "blocked");
  assert.equal(aggregateAgentState({ status: "active", tasks: [task("a", "completed", 5)], now }).state, "done");
  const idle = aggregateAgentState({ status: "active", tasks: [task("a", "completed", 600)], now });
  assert.deepEqual(idle, { state: "idle", task: null });
  assert.equal(aggregateAgentState({ status: "paused", tasks: [task("a", "waiting_input", 1)], now }).state, "sleeping");
  assert.deepEqual(aggregateAgentState({ status: "active", tasks: [], now }), { state: "idle", task: null });
});

test("the thread's face reads every task in it, and a waiting task elsewhere still wins", () => {
  const agent = { id: "ag", status: "active", state: "idle", task: null } as unknown as ClientAgent;
  const session = (id: string, status: string): ClientWorkSession =>
    ({ id, title: id, status, needsAttention: false, lastActivityAt: new Date().toISOString() }) as ClientWorkSession;
  assert.equal(threadAgentState(agent, false, [session("routine", "running"), session("person", "waiting_input")]), "waiting");
  assert.equal(threadAgentState(agent, false, [session("routine", "running")]), "working");
  const elsewhere = { ...agent, state: "waiting", task: { sessionId: "other-thread" } } as unknown as ClientAgent;
  assert.equal(threadAgentState(elsewhere, false, [session("routine", "running")]), "waiting");
  assert.equal(threadAgentState(agent, false, []), "idle", "until discovery, the server's read stands");
});

test("start_task and hand-offs refuse at the cap, not at the first live task", () => {
  const task = readFileSync("src/lib/chat/task-tool.ts", "utf8");
  const flow = task.slice(task.indexOf("async function startTask("));
  assert.doesNotMatch(flow, /if \(live\) return/);
  assert.match(flow, /live\.length >= MAX_LIVE_TASKS_PER_CONVERSATION/);
  const handoff = readFileSync("src/lib/chat/handoff-tool.ts", "utf8");
  assert.match(handoff, /live\.length >= MAX_LIVE_TASKS_PER_CONVERSATION/);
  // The shipped apps follow one task per chat through the list route: the
  // usual order, with a task waiting on the person put first.
  const list = readFileSync("src/app/api/work/sessions/route.ts", "utf8");
  assert.match(list, /orderBy: sessionListOrder\(parsed\.query\)/);
  assert.match(list, /waitingTasksFirst\(waiting, listed, limit\)/);
});

test("an app that follows one task per chat sees the task waiting on the person first", () => {
  // A newer routine is running while an older request waits on an answer: the
  // apps' composer must land on the waiting one, or its question is unanswerable.
  const running = { id: "routine" };
  const asking = { id: "request" };
  assert.deepEqual(waitingTasksFirst([asking], [running, asking], 1), [asking]);
  assert.deepEqual(waitingTasksFirst([asking], [running, asking], 5), [asking, running], "no duplicates");
  assert.deepEqual(waitingTasksFirst([], [running, asking], 1), [running], "nothing waiting: the usual order");
  assert.deepEqual([...CONVERSATION_WAITING_STATUSES], ["waiting_input", "waiting_approval"]);
});

test("the chat view draws a card per task and keeps one stream per task", () => {
  const view = readFileSync("src/components/chat/chat-view.tsx", "utf8");
  assert.match(view, /useConversationWorkSessions\(privateMode \? null : currentConversationId\)/);
  assert.match(view, /workTasks\.sessions\.map\(\(session\) => \(\{/);
  assert.match(view, /<ConversationTaskPanel/);
  const panel = readFileSync("src/components/chat/conversation-task-panel.tsx", "utf8");
  assert.match(panel, /useWorkSessionFollower\(session\)/);
  assert.match(panel, /<WorkRunPanel work=\{work\}/);
});
