import test from "node:test";
import assert from "node:assert/strict";
import {
  dedupe,
  deriveIdempotencyKey,
  firstGap,
  operatorVisible,
  replayFrom,
  userVisible,
  type EventEnvelope,
} from "@/lib/event-envelope";
import {
  chatEnvelope,
  chatEnvelopes,
  chatEventVisibility,
  codeEnvelope,
  codeEventVisibility,
  isClassifiedCodeEvent,
  taskEnvelope,
  taskEventVisibility,
} from "@/lib/event-streams";
import { SESSION_EVENT_KINDS, planSessionEventAppend } from "@/lib/code-remote-sessions";
import { eventKey } from "../scripts/lib/runner-outbox.mjs";
import type { StreamChunk } from "@/types/chat";

/*
 * The three streams against one envelope.
 *
 * Chat, Work-ready tasks and Code each solved ordering, deduplication, replay
 * and visibility separately. These tests do two things: check that the adapters
 * put each stream's real events into the shared envelope correctly, and pin the
 * places where an implementation still lives somewhere the shared one cannot
 * reach — so the duplication cannot drift without a test going red.
 */

// ---------------------------------------------------------------- drift

test("the cloud runner's key derivation is the envelope's, character for character", () => {
  // scripts/lib/runner-outbox.mjs runs as a plain node script with no build
  // step, so it cannot import the TypeScript module. That makes this the only
  // thing standing between one event and two different idempotency keys —
  // which would defeat the deduplication both sides depend on.
  for (const [runId, seq] of [
    ["run_1", 1],
    ["run_1", 2_000],
    ["task_abc-def", 42],
    ["", 0],
  ] as const) {
    assert.equal(eventKey(runId, seq), deriveIdempotencyKey(runId, seq));
  }
});

test("the remote-session gap rule agrees with firstGap on every case it rejects", () => {
  // planSessionEventAppend is the host-append planner; firstGap is the
  // consumer-side check. If they disagreed about what a hole is, a batch the
  // host accepted could still render as a truncated transcript.
  const batch = (seqs: number[]) =>
    seqs.map((seq) => ({ seq, kind: "text_delta", payload: {} }));

  const plan = planSessionEventAppend(3, batch([4, 6]));
  assert.equal(plan.ok, false);
  assert.equal(plan.ok === false && plan.expectedSeq, 5);
  assert.equal(firstGap([4, 6].map(envelopeAt), 3), 5);

  // And agree that a contiguous batch has no hole.
  assert.equal(planSessionEventAppend(3, batch([4, 5, 6])).ok, true);
  assert.equal(firstGap([4, 5, 6].map(envelopeAt), 3), null);

  // Replays below the cursor are a hole to neither.
  assert.equal(planSessionEventAppend(3, batch([1, 2, 4])).ok, true);
  assert.equal(firstGap([1, 2, 4].map(envelopeAt), 3), null);
});

test("the one place the two rules deliberately differ is a duplicate inside the new range", () => {
  // The host planner rejects the whole batch; firstGap sees no hole, because a
  // repeated seq leaves nothing missing. Recorded rather than reconciled: the
  // host is the writer and refusing an ambiguous batch is the conservative
  // answer there, while a consumer that already has the event has no reason to
  // call the transcript truncated. Changing either is a behaviour change, and
  // this is what makes it a decision.
  const duplicated = [{ seq: 4, kind: "text_delta", payload: {} }, { seq: 4, kind: "text_delta", payload: {} }];
  assert.equal(planSessionEventAppend(3, duplicated).ok, false);
  assert.equal(firstGap([4, 4].map(envelopeAt), 3), null);
});

test("every remote session event kind is classified deliberately", () => {
  // An unlisted kind falls through to `internal` and silently stops rendering.
  // The failure directions are not symmetrical, so the default is right — but a
  // kind the catalog already knows about should never be relying on it. Note
  // this asks whether the kind was *classified*, not what it was classified as:
  // `heartbeat` is internal on purpose, and the two cases are indistinguishable
  // from the visibility alone.
  for (const kind of SESSION_EVENT_KINDS) {
    assert.ok(isClassifiedCodeEvent(kind), `${kind} is unclassified`);
  }
  // And the one that is internal deliberately still is.
  assert.equal(codeEventVisibility("heartbeat"), "internal");
});

// ---------------------------------------------------------------- chat

test("chat frames carry the envelope's metadata without changing shape", () => {
  const chunk: StreamChunk = { type: "delta", text: "hello" };
  const envelope = chatEnvelope("gen_1", 7, chunk, "2026-08-05T00:00:00.000Z");

  assert.equal(envelope.stream, "chat");
  assert.equal(envelope.runId, "gen_1");
  assert.equal(envelope.seq, 7);
  assert.equal(envelope.kind, "delta");
  assert.equal(envelope.idempotencyKey, "gen_1:7");
  // The payload is the frame itself — the client parses exactly what it always
  // did, and no domain type was flattened to get here.
  assert.deepEqual(envelope.payload, chunk);
});

test("a heartbeat is the only chat frame with nothing to say to anybody", () => {
  assert.equal(chatEventVisibility("ping"), "internal");
  assert.equal(chatEventVisibility("delta"), "user");
  assert.equal(chatEventVisibility("error"), "user");
});

test("the chat activity timeline is user data, not operator data", () => {
  // Its detail carries source titles and model names. A "Visited source" line
  // is a fact about what the user asked for, and belongs in no dashboard.
  assert.equal(chatEventVisibility("activity"), "user");
  const envelope = chatEnvelope("gen_1", 1, {
    type: "activity",
    event: { id: "a", kind: "visit", title: "Visited source", detail: "example.com", createdAt: "" },
  } as StreamChunk);
  assert.equal(operatorVisible([envelope]).length, 1);
  assert.equal(userVisible([envelope]).length, 1);
});

test("numbering a chat stream starts at 1 and follows the order sent", () => {
  const envelopes = chatEnvelopes("gen_1", [
    { type: "delta", text: "a" },
    { type: "ping" },
    { type: "delta", text: "b" },
  ]);
  assert.deepEqual(envelopes.map((e) => e.seq), [1, 2, 3]);
  // Two identical deltas stay two events: the key comes from position, never
  // from content, so nothing collapses a repeated token.
  const identical = chatEnvelopes("gen_1", [
    { type: "delta", text: "x" },
    { type: "delta", text: "x" },
  ]);
  assert.equal(dedupe(identical).length, 2);
});

test("a heartbeat is dropped from what the user sees but keeps its position", () => {
  const envelopes = chatEnvelopes("gen_1", [
    { type: "delta", text: "a" },
    { type: "ping" },
    { type: "delta", text: "b" },
  ]);
  assert.deepEqual(userVisible(envelopes).map((e) => e.seq), [1, 3]);
  // The gap in what is *rendered* is not a gap in the stream.
  assert.equal(firstGap(envelopes, 0), null);
});

// ---------------------------------------------------------------- task

test("runner events split user work from operator machinery", () => {
  assert.equal(taskEventVisibility("text"), "user");
  assert.equal(taskEventVisibility("file_change"), "user");
  // The queue wait and the egress decisions describe the machine the task ran
  // on, not the work it did.
  assert.equal(taskEventVisibility("queue"), "operator");
  assert.equal(taskEventVisibility("egress"), "operator");
  assert.equal(taskEventVisibility("heartbeat"), "internal");
});

test("an unknown runner event kind defaults to invisible rather than over-shared", () => {
  assert.equal(taskEventVisibility("some_new_kind"), "internal");
  const envelope = taskEnvelope({ taskId: "t1", seq: 1, kind: "some_new_kind", payload: {} });
  assert.equal(userVisible([envelope]).length, 0);
  assert.equal(operatorVisible([envelope]).length, 0);
});

test("a runner event's key matches what the outbox would have sent for it", () => {
  const envelope = taskEnvelope({ taskId: "task_9", seq: 12, kind: "text", payload: { text: "hi" } });
  assert.equal(envelope.idempotencyKey, eventKey("task_9", 12));
});

// ---------------------------------------------------------------- code

test("code session output is the user's own repository, printed", () => {
  assert.equal(codeEventVisibility("command_output"), "user");
  assert.equal(codeEventVisibility("heartbeat"), "internal");
});

test("code events replay from a cursor without repeating the cursor itself", () => {
  const events = [1, 2, 3, 4].map((seq) =>
    codeEnvelope({ sessionId: "sess_1", seq, kind: "text_delta", payload: { text: `t${seq}` } })
  );
  assert.deepEqual(replayFrom(events, 2).map((e) => e.seq), [3, 4]);
});

test("a producer re-sending an unacknowledged batch is deduplicated by key", () => {
  // Deliberately including a LOWER seq than one already stored: a cursor-only
  // rule would either drop the legitimate re-delivery or accept the duplicate,
  // depending on which side the comparison fell.
  const first = codeEnvelope({ sessionId: "s", seq: 5, kind: "text_delta", payload: {} });
  const retry = codeEnvelope({ sessionId: "s", seq: 5, kind: "text_delta", payload: {} });
  const newer = codeEnvelope({ sessionId: "s", seq: 6, kind: "text_delta", payload: {} });
  assert.deepEqual(dedupe([first, retry, newer]).map((e) => e.seq), [5, 6]);
  assert.deepEqual(dedupe([retry, newer], new Set([first.idempotencyKey])).map((e) => e.seq), [6]);
});

test("all three streams are distinguishable inside one collection", () => {
  // The point of a shared envelope is that a consumer can hold events from more
  // than one stream without losing which is which.
  const mixed: EventEnvelope[] = [
    chatEnvelope("gen", 1, { type: "delta", text: "a" }),
    taskEnvelope({ taskId: "gen", seq: 1, kind: "text", payload: {} }),
    codeEnvelope({ sessionId: "gen", seq: 1, kind: "text_delta", payload: {} }),
  ];
  assert.deepEqual(mixed.map((e) => e.stream), ["chat", "task", "code"]);
  // Same runId and seq across streams still collide on key — which is why a
  // consumer must dedupe within a stream, not across them.
  assert.equal(new Set(mixed.map((e) => e.idempotencyKey)).size, 1);
});

/** A bare envelope at a given sequence, for the gap-rule comparisons. */
function envelopeAt(seq: number): EventEnvelope {
  return codeEnvelope({ sessionId: "s", seq, kind: "text_delta", payload: {} });
}
