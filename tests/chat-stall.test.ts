import test from "node:test";
import assert from "node:assert/strict";
import { createStallWatchdog, PROVIDER_IDLE_TIMEOUT_MS } from "@/lib/chat-stall";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("fires when the stream goes quiet", async () => {
  let fired = 0;
  const wd = createStallWatchdog(() => fired++, 20);
  await sleep(50);
  assert.equal(fired, 1);
  assert.equal(wd.stalled, true);
  wd.stop();
});

test("a stream that keeps producing never fires", async () => {
  let fired = 0;
  const wd = createStallWatchdog(() => fired++, 40);
  for (let i = 0; i < 6; i++) {
    await sleep(15);
    wd.touch();
  }
  assert.equal(fired, 0, "touching within the window must keep resetting the clock");
  assert.equal(wd.stalled, false);
  wd.stop();
});

test("fires once, not once per tick", async () => {
  let fired = 0;
  const wd = createStallWatchdog(() => fired++, 20);
  await sleep(90);
  assert.equal(fired, 1);
  wd.stop();
});

test("touch after a stall does not re-arm", async () => {
  // A late event arriving after the abort must not restart a generation that
  // has already been reported as failed.
  let fired = 0;
  const wd = createStallWatchdog(() => fired++, 20);
  await sleep(45);
  assert.equal(wd.stalled, true);
  wd.touch();
  await sleep(45);
  assert.equal(fired, 1);
  wd.stop();
});

test("stop() prevents a fire", async () => {
  let fired = 0;
  const wd = createStallWatchdog(() => fired++, 25);
  wd.stop();
  await sleep(60);
  assert.equal(fired, 0, "a completed generation must not be aborted by its own watchdog");
});

test("stop() is idempotent and safe after firing", async () => {
  const wd = createStallWatchdog(() => {}, 15);
  await sleep(35);
  assert.doesNotThrow(() => {
    wd.stop();
    wd.stop();
  });
});

test("the default window is generous enough for a slow reasoning model", () => {
  // Extended thinking can emit nothing for a long stretch between blocks; the
  // window has to clear that comfortably or this becomes a source of false
  // failures on exactly the slowest, most expensive turns.
  assert.ok(PROVIDER_IDLE_TIMEOUT_MS >= 60_000);
  // ...but well inside undici's ~300s body timeout, so Juno reports the stall
  // itself rather than surfacing a transport error.
  assert.ok(PROVIDER_IDLE_TIMEOUT_MS < 300_000);
});
