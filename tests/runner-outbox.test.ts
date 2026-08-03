import test from "node:test";
import assert from "node:assert/strict";
import {
  DurableOutbox,
  backoffDelayMs,
  eventKey,
  isRetryableStatus,
  parseRetryAfter,
} from "../scripts/lib/runner-outbox.mjs";

/*
 * `EventSink.post()` took a batch off the queue, posted it, and on a network
 * error or a non-OK response logged and returned. The batch was already gone.
 * A short backend blip during a long run silently dropped that slice of the
 * transcript, and nothing recorded that it had happened.
 */

test("events survive a failed flush and are retried", () => {
  const outbox = new DurableOutbox({ runId: "run-1" });
  outbox.add("text", { text: "one" });
  outbox.add("tool", { name: "bash" });

  const batch = outbox.peek();
  assert.equal(batch.length, 2);
  // The POST fails: nothing is acknowledged, so nothing is lost.
  assert.equal(outbox.size, 2, "a failed flush must not consume the buffer");

  outbox.acknowledge(batch);
  assert.equal(outbox.size, 0);
});

test("acknowledgement is by key, so a concurrent add is not swallowed", () => {
  const outbox = new DurableOutbox({ runId: "run-1" });
  outbox.add("text", { text: "in flight" });
  const inFlight = outbox.peek();

  // The agent keeps working while the POST is out.
  outbox.add("text", { text: "arrived during the post" });

  outbox.acknowledge(inFlight);
  assert.equal(outbox.size, 1, "only the acknowledged event may be removed");
  assert.equal(outbox.peek()[0].payload.text, "arrived during the post");
});

test("every event carries a stable key, so a lost response cannot duplicate it", () => {
  const outbox = new DurableOutbox({ runId: "run-abc" });
  outbox.add("text", { text: "one" });
  outbox.add("text", { text: "two" });

  const first = outbox.peek();
  // The server committed the batch but the response never arrived, so the
  // runner retries the very same events.
  const retry = outbox.peek();

  assert.deepEqual(
    first.map((e) => e.key),
    retry.map((e) => e.key),
    "a retry must present the same keys or the server cannot dedupe",
  );
  assert.equal(first[0].key, eventKey("run-abc", 1));
  assert.equal(new Set(first.map((e) => e.key)).size, 2, "keys must be distinct within a run");
});

test("two runs cannot collide on a key", () => {
  assert.notEqual(eventKey("run-a", 1), eventKey("run-b", 1));
});

test("the buffer is bounded, and drops the middle rather than the outcome", () => {
  const outbox = new DurableOutbox({ runId: "run-1", maxBuffered: 10 });
  for (let i = 0; i < 40; i += 1) outbox.add("text", { text: `event-${i}` });

  assert.equal(outbox.size, 10, "an outage must not become unbounded memory");

  const texts = outbox.peek().map((e) => e.payload.text);
  assert.equal(texts[0], "event-0", "the start of the run says what was asked");
  assert.equal(texts[texts.length - 1], "event-39", "the end says how it finished");
  assert.ok(outbox.dropped > 0);
});

test("a dropped-event gap is reported rather than hidden", () => {
  const outbox = new DurableOutbox({ runId: "run-1", maxBuffered: 4 });
  assert.equal(outbox.dropNotice(), null, "no notice when nothing was dropped");

  for (let i = 0; i < 20; i += 1) outbox.add("text", { text: `e${i}` });
  const notice = outbox.dropNotice();
  assert.equal(notice?.kind, "error");
  assert.match(String(notice?.payload.message), /dropped/);
});

// --- Backoff -------------------------------------------------------------

test("backoff grows exponentially and is capped", () => {
  const noJitter = () => 1;
  const first = backoffDelayMs(1, { random: noJitter });
  const third = backoffDelayMs(3, { random: noJitter });
  const huge = backoffDelayMs(50, { random: noJitter });

  assert.ok(third > first, "later attempts must wait longer");
  assert.ok(huge <= 30_000, "and the wait must be capped");
});

test("backoff is jittered, so every runner does not return at the same instant", () => {
  // The failure mode without it: a backend restart fails every cloud runner at
  // the same moment, and a fixed schedule brings them all back together.
  const delays = new Set(
    Array.from({ length: 20 }, (_, i) => backoffDelayMs(5, { random: () => i / 20 })),
  );
  assert.ok(delays.size > 1, "a fixed schedule is a thundering herd");
});

test("a server's Retry-After outranks the runner's own schedule", () => {
  const delay = backoffDelayMs(1, { retryAfterSeconds: 12, random: () => 1 });
  assert.equal(delay, 12_000);
  // Still capped: a server asking for an hour must not stall the whole job.
  assert.equal(backoffDelayMs(1, { retryAfterSeconds: 3_600, random: () => 1 }), 30_000);
});

test("Retry-After is parsed as seconds or as an HTTP date", () => {
  const now = Date.UTC(2026, 7, 4, 12, 0, 0);
  assert.equal(parseRetryAfter("30", now), 30);
  assert.equal(parseRetryAfter(new Date(now + 45_000).toUTCString(), now), 45);
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter("not-a-date", now), null);
  // A date already past means "retry now", not a negative wait.
  assert.equal(parseRetryAfter(new Date(now - 60_000).toUTCString(), now), 0);
});

test("retryable failures are distinguished from permanent ones", () => {
  assert.equal(isRetryableStatus(null), true, "a network error is worth retrying");
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(502), true);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(408), true);

  // A malformed body, a revoked token or a deleted task will never succeed;
  // retrying forever keeps a dead runner hammering the backend.
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(404), false);
});
