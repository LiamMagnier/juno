import test from "node:test";
import assert from "node:assert/strict";
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
  delegationAttemptKey,
  delegationOffer,
} from "@/lib/work/delegation";

/*
 * Work inside a chat: the pointer, the filter, and the two decisions the
 * composer makes while somebody is typing.
 *
 * Every case here is one where the wrong answer is invisible from the outside.
 * A `conversationId` silently dropped by the create schema produces a task that
 * runs perfectly and can never be found again by the conversation that started
 * it. A list filter that accepted an empty string would answer "this chat's
 * task" with the whole account's Work history. An offer that fires on a
 * question spends a run ceiling — real money, on a clock — on a sentence that
 * wanted a reply. And a composer that routes a typed answer as an instruction
 * leaves the run waiting for a reply it has already been given.
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
// Offering: the quieter trigger, which must stay quiet
// ---------------------------------------------------------------------------

test("a sentence that names a document to produce is offered as a task", () => {
  const offer = delegationOffer("Draft a report on our Q3 support volumes and where it went wrong");
  assert.notEqual(offer, null);
  assert.match(offer!.caption, /Run it as a task\?$/);
});

test("a sentence that names a stretch of time is offered as a task", () => {
  assert.notEqual(delegationOffer("Keep checking the deploy every morning until it is green"), null);
});

test("a question is never offered, however much it matches", () => {
  // `web_research` is the most-matched capability in the whole rule set and is
  // deliberately not evidence of delegation: "research X" is a question that
  // wants an answer in the next thirty seconds.
  assert.equal(delegationOffer("Research the new EU battery rules and tell me about them"), null);
});

test("naming a connected app is not enough on its own", () => {
  // "What did Linear say" names a connector and wants a reply. An offer here
  // would be a regex proposing to spend a run ceiling on a lookup.
  assert.equal(delegationOffer("What did the Linear ticket say about the migration"), null);
});

test("a connected app plus a verb that acts through it is offered", () => {
  assert.notEqual(
    delegationOffer("Email the finance team the numbers from the Linear board"),
    null
  );
});

test("a draft too short to have a verb in it is never offered", () => {
  assert.equal(delegationOffer("draft a report"), null);
  assert.equal(delegationOffer(""), null);
  assert.equal(delegationOffer("   "), null);
});

test("the offer names at most two things, so it stays a sentence", () => {
  const offer = delegationOffer(
    "Email the team a spreadsheet of the latest prices, researched with sources, every morning"
  );
  assert.notEqual(offer, null);
  // Four capabilities match that goal. The caption must not read them all back.
  assert.equal(offer!.caption.split(" and ").length <= 2, true);
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
    "Answer Juno’s question…"
  );
  assert.equal(
    delegatedComposerPlaceholder({ kind: "steer" }),
    "Add an instruction to the running task…"
  );
});

// ---------------------------------------------------------------------------
// Pressing the button twice
// ---------------------------------------------------------------------------

const inputs = {
  goal: "Reconcile the invoices",
  permissionPolicy: "ask",
  connectorIds: ["gmail", "drive"],
  attachmentIds: ["att_1", "att_2"],
  projectId: "proj_1" as string | null,
  model: "juno-1",
  reasoningEffort: "medium" as string | null,
};

test("the same press twice keeps its keys, so a refused start reuses its draft", () => {
  assert.equal(delegationAttemptKey(inputs), delegationAttemptKey({ ...inputs }));
  // Whitespace is not a different errand: the composer trims before it sends.
  assert.equal(
    delegationAttemptKey(inputs),
    delegationAttemptKey({ ...inputs, goal: "  Reconcile the invoices  " })
  );
});

test("changing how often it asks is a different press", () => {
  // The sharpest case in the whole key. Refused under `ask`, the reader opens
  // the "+" menu, switches to `manual` and presses again; a goal-keyed attempt
  // would reuse the draft created under `ask` while the pill and the disclosure
  // line under the field both state `manual`.
  assert.notEqual(
    delegationAttemptKey(inputs),
    delegationAttemptKey({ ...inputs, permissionPolicy: "manual" })
  );
});

test("taking a connected app back off is a different press", () => {
  // A narrowing that has to reach the server, and one a count would have missed:
  // the ids are what is compared.
  assert.notEqual(
    delegationAttemptKey(inputs),
    delegationAttemptKey({ ...inputs, connectorIds: ["gmail"] })
  );
});

test("a file, the project, the model and the effort each mint a fresh press", () => {
  const changes = [
    { attachmentIds: ["att_1"] },
    { projectId: null },
    { model: "juno-2" },
    { reasoningEffort: null },
  ];
  for (const change of changes) {
    assert.notEqual(delegationAttemptKey(inputs), delegationAttemptKey({ ...inputs, ...change }));
  }
});

test("the grants are a set, so their order is not a new press", () => {
  assert.equal(
    delegationAttemptKey(inputs),
    delegationAttemptKey({
      ...inputs,
      connectorIds: ["drive", "gmail"],
      attachmentIds: ["att_2", "att_1"],
    })
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
