import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createSessionSchema,
  parseSessionListQuery,
  sessionListOrder,
} from "@/app/api/work/protocol";
import type { WorkStatus } from "@/lib/work/domain";
import {
  adoptDiscoveredSession,
  delegatedComposerMode,
  delegatedComposerPlaceholder,
} from "@/lib/work/delegation";

/*
 * Work inside a chat: the pointer, the filter, what the composer does while a
 * task is live, and which task the transcript draws.
 *
 * Every case here is one where the wrong answer is invisible from the outside.
 * A `conversationId` silently dropped by the create schema produces a task that
 * runs perfectly and can never be found again by the conversation that started
 * it. A list filter that accepted an empty string would answer "this chat's
 * task" with the whole account's Work history. And a composer that routes a
 * typed answer as an instruction leaves the run waiting for a reply it has
 * already been given.
 */

// ---------------------------------------------------------------------------
// The pointer: WorkSession.conversationId, on the wire at last
// ---------------------------------------------------------------------------

const baseCreate = { goal: "Reconcile the invoices", requestedTarget: "automatic" as const };

test("create accepts the conversation a task was delegated from", () => {
  const parsed = createSessionSchema.safeParse({ ...baseCreate, conversationId: "conv_1" });
  assert.equal(parsed.success, true);
  assert.equal(parsed.success && parsed.data.conversationId, "conv_1");
});

test("create without a conversation is still valid, and says nothing about one", () => {
  // The native clients and the /work composer have never sent this field, and a
  // schema that started requiring it — or defaulting it — would break every one
  // of them. Absent must stay absent rather than arriving as null or "".
  const parsed = createSessionSchema.safeParse(baseCreate);
  assert.equal(parsed.success, true);
  assert.equal(parsed.success && "conversationId" in parsed.data, false);
});

test("create refuses an empty or unbounded conversation id", () => {
  assert.equal(createSessionSchema.safeParse({ ...baseCreate, conversationId: "" }).success, false);
  assert.equal(
    createSessionSchema.safeParse({ ...baseCreate, conversationId: "c".repeat(201) }).success,
    false
  );
});

// ---------------------------------------------------------------------------
// The filter: finding the run again from the transcript
// ---------------------------------------------------------------------------

test("the session list can be narrowed to one conversation", () => {
  const parsed = parseSessionListQuery(new URLSearchParams("conversationId=conv_1"));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.query.conversationId, "conv_1");
});

test("an absent conversation filter selects every task, as it always did", () => {
  const parsed = parseSessionListQuery(new URLSearchParams(""));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && "conversationId" in parsed.query, false);
});

test("an empty conversation filter is refused rather than ignored", () => {
  // `?conversationId=` would otherwise reach Prisma as `{ conversationId: "" }`
  // — or, dropped, as no clause at all — and the caller would be handed the
  // account's whole Work history under a parameter that reads as a narrowing.
  const parsed = parseSessionListQuery(new URLSearchParams("conversationId="));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok === false && parsed.parameter, "conversationId");
});

test("an unbounded conversation filter is refused", () => {
  const parsed = parseSessionListQuery(
    new URLSearchParams(`conversationId=${"c".repeat(201)}`)
  );
  assert.equal(parsed.ok, false);
});

// ---------------------------------------------------------------------------
// Typing at a run that is already going
// ---------------------------------------------------------------------------

const question = { id: "q1", question: "Which folder?" };

test("an open question outranks everything, including a live run", () => {
  const mode = delegatedComposerMode({ status: "running", openQuestion: question });
  assert.deepEqual(mode, { kind: "answer", questionId: "q1", question: "Which folder?" });
});

test("a question on a finished run is still answerable", () => {
  // `waiting_input` is not the only way a question can be open — `host_offline`
  // is terminal and still a decision waiting on a person. Refusing to route the
  // answer would leave the one box on screen doing nothing.
  const mode = delegatedComposerMode({ status: "host_offline", openQuestion: question });
  assert.equal(mode?.kind, "answer");
});

test("a working run takes an instruction", () => {
  assert.deepEqual(delegatedComposerMode({ status: "running", openQuestion: null }), {
    kind: "steer",
  });
});

test("a paused run takes an instruction, because it is recorded for the resume", () => {
  assert.deepEqual(delegatedComposerMode({ status: "paused", openQuestion: null }), {
    kind: "steer",
  });
});

test("a finished run takes nothing, so the composer is an ordinary chat box", () => {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    assert.equal(delegatedComposerMode({ status, openQuestion: null }), null);
  }
});

test("a draft takes nothing: there is no attempt for an instruction to join", () => {
  assert.equal(delegatedComposerMode({ status: "draft", openQuestion: null }), null);
});

test("no task at all leaves the composer alone", () => {
  assert.equal(delegatedComposerMode({ status: null, openQuestion: null }), null);
});

test("the placeholder names the destination, not the box", () => {
  assert.equal(
    delegatedComposerPlaceholder({ kind: "answer", questionId: "q1", question: "Which folder?" }),
    "Answer Alevr’s question…"
  );
  assert.equal(
    delegatedComposerPlaceholder({ kind: "steer" }),
    "Add an instruction to the running task…"
  );
});

// ---------------------------------------------------------------------------
// Finding the run again
// ---------------------------------------------------------------------------

test("a conversation's own task is ordered by activity alone", () => {
  // Pinning is a flag about the /work list. Left in the order, a chat that
  // delegated twice where the OLDER task happens to be pinned draws the older
  // run in its transcript, because `limit: 1` takes whatever came back first.
  assert.deepEqual(sessionListOrder({ conversationId: "conv_1" }), [{ lastActivityAt: "desc" }]);
});

test("every other listing still puts pinned sessions first", () => {
  assert.deepEqual(sessionListOrder({}), [{ pinned: "desc" }, { lastActivityAt: "desc" }]);
});

test("a discovered draft is not adopted: it has never had a run", () => {
  // A create that landed while the dispatch did not. Drawn, it is a task panel
  // with no action, no plan, no run and no meter, which the reader can neither
  // start nor dismiss.
  const draft: { id: string; status: WorkStatus } = { id: "s1", status: "draft" };
  assert.equal(adoptDiscoveredSession(null, draft), null);
  const live: { id: string; status: WorkStatus } = { id: "s2", status: "running" };
  assert.equal(adoptDiscoveredSession(live, draft), live);
});

test("a discovered task replaces nothing when it is the row already on screen", () => {
  // Re-adopting an identical session resets the event cursor, so the run would
  // replay from zero every four seconds.
  const live: { id: string; status: WorkStatus } = { id: "s1", status: "running" };
  assert.equal(adoptDiscoveredSession(live, { ...live }), live);
});

test("a task that has started is adopted over whatever was there", () => {
  const live: { id: string; status: WorkStatus } = { id: "s2", status: "running" };
  assert.equal(adoptDiscoveredSession({ id: "s1", status: "completed" }, live), live);
  assert.equal(adoptDiscoveredSession(null, live), live);
});

// ---------------------------------------------------------------------------
// The model starts a task; nothing in the composer does
// ---------------------------------------------------------------------------

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the composer has no way to arm a task", () => {
  // The toggle, its approval submenu, the regex offer and the send branch all
  // went together. Any one of them coming back would be a second way to start
  // a task that the model-side gates (private, voice, regenerate) never see.
  const composer = source("src/components/chat/composer.tsx");
  for (const gone of ["Do this as a task", "Start this as a task", "onDelegate", "delegationOffer", "taskArmed"]) {
    assert.equal(composer.includes(gone), false, `composer.tsx still mentions ${gone}`);
  }
});

test("the web client opts every saved turn in, and never a private one", () => {
  const hook = source("src/hooks/use-chat.ts");
  assert.match(hook, /workHandoff: opts\.privateMode \? undefined : true/);
});

test("a started task is adopted by the one applier a resumed stream also uses", () => {
  // `createStreamApplier` is shared by the first stream and every reconnect,
  // so handling the frame there is what makes a dropped connection still draw
  // the task. A second handler written for replays is where the two drift.
  const hook = source("src/hooks/use-chat.ts");
  const applier = hook.slice(hook.indexOf("const createStreamApplier"), hook.indexOf("const findActiveGeneration"));
  assert.match(applier, /case "work": \{[\s\S]*?opts\.onWorkStarted\?\.\(chunk\.session\)/);
  const view = source("src/components/chat/chat-view.tsx");
  assert.match(view, /onWorkStarted: \(session\) => \{[\s\S]*?adoptWorkRef\.current\(session\)/);
  // Every task on the conversation is discovered by one hook; the adopted
  // session joins that list (tests/work-conversation-tasks.test.ts).
  assert.match(view, /adoptWorkRef\.current = workTasks\.adopt;/);
});

test("a discovery answer that left before the task existed cannot take the adopted panel away", () => {
  // `adoptDiscoveredSession` rightly lets an empty answer clear the panel (the
  // task was deleted elsewhere). An answer computed before the `work` frame's
  // session existed is empty for the other reason, so the hook drops any answer
  // an adoption overtook instead of applying it.
  const hook = source("src/components/chat/use-conversation-work.ts");
  const discover = hook.slice(hook.indexOf("const discover = async () => {"));
  assert.match(
    discover.slice(0, discover.indexOf("setSession(")),
    /const asked = adoptions\.current;[\s\S]*?result\.kind === "ok" && asked === adoptions\.current\)/
  );
  const adopt = hook.slice(hook.indexOf("const adopt = React.useCallback"));
  assert.match(adopt.slice(0, adopt.indexOf("}, []);")), /adoptions\.current \+= 1;/);
});
