import test from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_ENVELOPE_VERSION,
  dedupe,
  deriveIdempotencyKey,
  firstGap,
  isFutureEnvelope,
  makeEnvelope,
  operatorVisible,
  replayFrom,
  userVisible,
  type EventEnvelope,
} from "@/lib/event-envelope";

/*
 * Chat, tasks and Code each grew their own event shape, and each solved
 * ordering, deduplication, replay and visibility differently. A fix to any one
 * has to be re-made in the other two, and the third is usually missed. These
 * pin the shared behaviour so that stops being true.
 */

function envelope(
  seq: number,
  overrides: Partial<EventEnvelope> = {}
): EventEnvelope {
  return {
    ...makeEnvelope({
      runId: "run-1",
      stream: "chat",
      kind: "text",
      payload: { text: `event ${seq}` },
      seq,
      visibility: "user",
      at: "2026-08-04T12:00:00.000Z",
    }),
    ...overrides,
  };
}

test("an envelope carries everything a consumer needs to order and dedupe", () => {
  const event = envelope(1);
  assert.equal(event.v, EVENT_ENVELOPE_VERSION);
  assert.equal(event.seq, 1);
  assert.equal(event.runId, "run-1");
  assert.equal(event.idempotencyKey, "run-1:1");
  assert.equal(event.payloadVersion, 1);
});

test("the payload version is independent of the envelope version", () => {
  // A domain shape can change without every stream's envelope changing, and
  // vice versa. Collapsing them forces an unrelated migration on both.
  const event = makeEnvelope({
    runId: "r",
    stream: "code",
    kind: "file_change",
    payload: {},
    seq: 1,
    payloadVersion: 3,
  });
  assert.equal(event.v, EVENT_ENVELOPE_VERSION);
  assert.equal(event.payloadVersion, 3);
});

test("an unclassified event defaults to invisible, not to visible", () => {
  // A new kind whose author forgot to classify it should be a bug someone
  // reports, not content quietly shown where it should not be.
  const event = makeEnvelope({ runId: "r", stream: "chat", kind: "x", payload: {}, seq: 1 });
  assert.equal(event.visibility, "internal");
  assert.deepEqual(userVisible([event]), []);
  assert.deepEqual(operatorVisible([event]), []);
});

test("visibility separates what a user may see from what a log may hold", () => {
  const forUser = envelope(1, { visibility: "user" });
  const forOperator = envelope(2, { visibility: "operator" });
  const neither = envelope(3, { visibility: "internal" });
  const all = [forUser, forOperator, neither];

  assert.deepEqual(userVisible(all).map((e) => e.seq), [1]);
  // Operators see their own plus the user's — the reverse is not true.
  assert.deepEqual(operatorVisible(all).map((e) => e.seq), [1, 2]);
});

test("the idempotency key comes from position, never from content", () => {
  // Two identical tokens legitimately arrive twice. Hashing the payload would
  // collapse them and silently delete a character from the user's reply.
  const first = makeEnvelope({
    runId: "r", stream: "chat", kind: "text", payload: { text: "a" }, seq: 1,
  });
  const second = makeEnvelope({
    runId: "r", stream: "chat", kind: "text", payload: { text: "a" }, seq: 2,
  });
  assert.notEqual(first.idempotencyKey, second.idempotencyKey);
  assert.equal(deriveIdempotencyKey("r", 7), "r:7");
});

test("two runs cannot collide on a key", () => {
  assert.notEqual(deriveIdempotencyKey("run-a", 1), deriveIdempotencyKey("run-b", 1));
});

test("a redelivered batch is deduped by key and left in sequence order", () => {
  const batch = [envelope(3), envelope(1), envelope(2)];
  const withDuplicate = [...batch, envelope(2)];

  const result = dedupe(withDuplicate);
  assert.deepEqual(result.map((e) => e.seq), [1, 2, 3]);
});

test("dedupe respects what the consumer has already stored", () => {
  // The retry case: the write committed but the acknowledgement was lost, so
  // the producer resends events the consumer already has.
  const seen = new Set(["run-1:1", "run-1:2"]);
  const result = dedupe([envelope(1), envelope(2), envelope(3)], seen);
  assert.deepEqual(result.map((e) => e.seq), [3]);
});

test("dedupe by key survives a lower sequence arriving after a higher one", () => {
  // A cursor-only rule would either drop this legitimate re-delivery or accept
  // the duplicate, depending on which side the comparison fell.
  const result = dedupe([envelope(5), envelope(2)]);
  assert.deepEqual(result.map((e) => e.seq), [2, 5]);
});

test("replay is exclusive of the cursor a client already stored", () => {
  const events = [envelope(1), envelope(2), envelope(3)];
  assert.deepEqual(replayFrom(events, 1).map((e) => e.seq), [2, 3]);
  assert.deepEqual(replayFrom(events, 0).map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(replayFrom(events, 3), []);
});

test("a gap in the sequence is reported rather than rendered as complete", () => {
  // A consumer that cannot see gaps shows a truncated transcript as a whole
  // one — the same failure the outbox exists to prevent, one layer down.
  assert.equal(firstGap([envelope(1), envelope(2)], 0), null);
  assert.equal(firstGap([envelope(1), envelope(3)], 0), 2);
  assert.equal(firstGap([envelope(2)], 0), 1, "a missing first event is a gap");
});

test("an out-of-order batch with no gap is not reported as gapped", () => {
  assert.equal(firstGap([envelope(3), envelope(1), envelope(2)], 0), null);
});

test("a duplicate sequence does not create a phantom gap", () => {
  assert.equal(firstGap([envelope(1), envelope(1), envelope(2)], 0), null);
});

test("a newer producer's envelope is detectable", () => {
  assert.equal(isFutureEnvelope({ v: EVENT_ENVELOPE_VERSION }), false);
  assert.equal(isFutureEnvelope({ v: EVENT_ENVELOPE_VERSION + 1 }), true);
});

test("all three streams share the envelope", () => {
  for (const stream of ["chat", "task", "code"] as const) {
    const event = makeEnvelope({
      runId: "r", stream, kind: "k", payload: {}, seq: 1, visibility: "user",
    });
    assert.equal(event.stream, stream);
    assert.equal(event.idempotencyKey, "r:1");
  }
});
