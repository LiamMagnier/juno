import test from "node:test";
import assert from "node:assert/strict";
import {
  beginDrain,
  DRAINING_RESPONSE,
  isDraining,
  resetDrainForTests,
  SHUTDOWN_GRACE_MS,
  SHUTDOWN_TEARDOWN_MS,
  waitForInFlight,
} from "@/lib/shutdown";
import { sweepAbandonedReceipts, type AbandonedReceipt, type ReceiptSweepPort } from "@/lib/chat/receipt-sweep";

/*
 * Every deploy and every max_memory_restart used to SIGTERM a process with no
 * handler: Next exited at once, every live SSE stream died charged, and no
 * refund path ran. These pin the pure halves of the fix — the drain state and
 * wait loop the signal handler drives, and the boot-time sweep that refunds
 * what a killed process left behind.
 */

test("the drain is entered once; a second attempt reports it was already under way", () => {
  resetDrainForTests();
  assert.equal(isDraining(), false);
  assert.equal(beginDrain(), true);
  assert.equal(isDraining(), true);
  assert.equal(beginDrain(), false, "a second signal must not run the drain twice");
  resetDrainForTests();
  assert.equal(isDraining(), false);
});

test("the draining response tells the client to retry, not that it failed", () => {
  assert.equal(DRAINING_RESPONSE.code, "SERVER_DRAINING");
  assert.equal(DRAINING_RESPONSE.retryable, true);
});

test("grace plus teardown fit inside the deploy's wait and PM2's kill_timeout", () => {
  // deploy.sh polls ~60s for the replacement to come online; kill_timeout is
  // 120s. Blow either and a restart during a long answer rolls the deploy back.
  assert.ok(SHUTDOWN_GRACE_MS + SHUTDOWN_TEARDOWN_MS < 60_000);
  assert.ok(SHUTDOWN_GRACE_MS + SHUTDOWN_TEARDOWN_MS < 120_000);
});

/** A fake clock the wait loop can be driven with. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

test("waitForInFlight returns as soon as nothing is in flight", async () => {
  const clock = fakeClock();
  let inFlight = 3;
  const result = await waitForInFlight(
    () => inFlight,
    {
      deadlineMs: 20_000,
      pollMs: 250,
      now: clock.now,
      sleep: async (ms) => {
        await clock.sleep(ms);
        inFlight -= 1; // one generation finishes per poll
      },
    }
  );
  assert.deepEqual(result, { drained: true, remaining: 0 });
  assert.equal(clock.now(), 750, "three polls, then done — not the whole deadline");
});

test("waitForInFlight gives up at the deadline and reports what is still running", async () => {
  const clock = fakeClock();
  const result = await waitForInFlight(() => 2, {
    deadlineMs: 1_000,
    pollMs: 300,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.deepEqual(result, { drained: false, remaining: 2 });
  assert.equal(clock.now(), 1_000, "the last sleep is clipped to the deadline, never past it");
});

function fakePort(rows: AbandonedReceipt[], options: { flips?: Set<string>; failRefundFor?: string } = {}) {
  const calls = { markFailed: [] as string[], refunded: [] as string[], released: [] as string[] };
  const port: ReceiptSweepPort = {
    listAbandoned: async (limit) => rows.slice(0, limit),
    markFailed: async (receipt) => {
      calls.markFailed.push(receipt.id);
      return options.flips ? options.flips.has(receipt.id) : true;
    },
    refundMessage: async (userId) => {
      if (options.failRefundFor === userId) throw new Error("usage row locked");
      calls.refunded.push(userId);
    },
    releaseReservation: async (_userId, generationId) => {
      calls.released.push(generationId);
      return true;
    },
  };
  return { port, calls };
}

const receipts: AbandonedReceipt[] = [
  { id: "r1", userId: "u1", generationId: "g1" },
  { id: "r2", userId: "u2", generationId: "g2" },
];

test("the sweep refunds and releases exactly the receipts it flipped", async () => {
  const { port, calls } = fakePort(receipts);
  const result = await sweepAbandonedReceipts(port);
  assert.deepEqual(result, { scanned: 2, failed: 2, refunded: 2, released: 2, errors: 0 });
  assert.deepEqual(calls.refunded, ["u1", "u2"]);
  assert.deepEqual(calls.released, ["g1", "g2"]);
});

test("a receipt someone else flipped first is not refunded again", async () => {
  // Two backends booting together, or a boot racing the lazy lease expiry:
  // the conditional transition is the lock, and only its winner refunds.
  const { port, calls } = fakePort(receipts, { flips: new Set(["r2"]) });
  const result = await sweepAbandonedReceipts(port);
  assert.equal(result.failed, 1);
  assert.deepEqual(calls.refunded, ["u2"]);
  assert.deepEqual(calls.released, ["g2"]);
});

test("a refund that throws is counted, reported, and does not stop the sweep", async () => {
  const { port, calls } = fakePort(receipts, { failRefundFor: "u1" });
  const seen: string[] = [];
  const result = await sweepAbandonedReceipts(port, { onError: (receipt) => seen.push(receipt.generationId) });
  assert.deepEqual(seen, ["g1"]);
  assert.equal(result.errors, 1);
  assert.deepEqual(calls.refunded, ["u2"]);
  // The row was already failed before the refund ran, so a retry cannot
  // charge twice — that is why the error is reported rather than retried.
  assert.deepEqual(calls.markFailed, ["r1", "r2"]);
});

test("the sweep honours its limit", async () => {
  const { port, calls } = fakePort(receipts);
  const result = await sweepAbandonedReceipts(port, { limit: 1 });
  assert.equal(result.scanned, 1);
  assert.deepEqual(calls.markFailed, ["r1"]);
});
