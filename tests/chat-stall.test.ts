import test from "node:test";
import assert from "node:assert/strict";
import {
  createStallWatchdog,
  PROVIDER_IDLE_TIMEOUT_MS,
  PROVIDER_STARTUP_TIMEOUT_MS,
  stallDetail,
  stallMessageFor,
} from "@/lib/chat-stall";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/*
 * The watchdog runs TWO windows: a longer one until the provider's first event,
 * and the idle window between events after that. Tests that care about the idle
 * window therefore have to touch() first, or they are measuring startup.
 */

test("fires when the stream goes quiet", async () => {
  let fired = 0;
  const wd = createStallWatchdog(() => fired++, 20, 1_000);
  wd.touch(); // first event arrived; now the idle window applies
  await sleep(50);
  assert.equal(fired, 1);
  assert.equal(wd.stalled, true);
  wd.stop();
});

test("a stream that keeps producing never fires", async () => {
  let fired = 0;
  const wd = createStallWatchdog(() => fired++, 40, 1_000);
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
  const wd = createStallWatchdog(() => fired++, 20, 1_000);
  wd.touch();
  await sleep(90);
  assert.equal(fired, 1);
  wd.stop();
});

test("touch after a stall does not re-arm", async () => {
  // A late event arriving after the abort must not restart a generation that
  // has already been reported as failed.
  let fired = 0;
  const wd = createStallWatchdog(() => fired++, 20, 1_000);
  wd.touch();
  await sleep(45);
  assert.equal(wd.stalled, true);
  wd.touch();
  await sleep(45);
  assert.equal(fired, 1);
  wd.stop();
});

test("stop() prevents a fire", async () => {
  let fired = 0;
  const wd = createStallWatchdog(() => fired++, 25, 25);
  wd.stop();
  await sleep(60);
  assert.equal(fired, 0, "a completed generation must not be aborted by its own watchdog");
});

test("stop() is idempotent and safe after firing", async () => {
  const wd = createStallWatchdog(() => {}, 15, 15);
  await sleep(35);
  assert.doesNotThrow(() => {
    wd.stop();
    wd.stop();
  });
});

test("setup and time-to-first-token get the longer window", async () => {
  /*
   * Nothing can touch the watchdog before the generator yields, so connecting to
   * MCP servers, downloading image attachments and the provider's own time to
   * first token all count as idle. Several providers also stream nothing at all
   * while reasoning — Google sends no reasoning_content over the OpenAI-compat
   * path — so silence before the first token says nothing about whether the
   * request is healthy.
   *
   * Sharing one window with the idle timeout killed those turns mid-flight and
   * told the user the model had stopped responding.
   */
  let fired = 0;
  const wd = createStallWatchdog(() => fired++, 20, 200);
  await sleep(60); // well past the idle window, still inside startup
  assert.equal(fired, 0, "a slow first token is not a stall");
  assert.equal(wd.startedStreaming, false);

  wd.touch(); // first token
  assert.equal(wd.startedStreaming, true);
  await sleep(60); // now the short idle window governs
  assert.equal(fired, 1, "silence after the first event is a stall");
  wd.stop();
});

test("a provider that never answers is still cut off", async () => {
  // The startup grace is longer, not unbounded.
  let fired = 0;
  const wd = createStallWatchdog(() => fired++, 1_000, 30);
  await sleep(70);
  assert.equal(fired, 1);
  assert.equal(wd.stalled, true);
  wd.stop();
});

test("the reported reason matches the window that fired", () => {
  // "Nothing MORE arrived" is wrong when nothing arrived at all, and the
  // operator line must not quote a 120s gap that never existed.
  const started = { startedStreaming: true };
  const never = { startedStreaming: false };

  assert.match(stallMessageFor(started), /stopped responding/);
  assert.match(stallMessageFor(never), /never started responding/);
  assert.notEqual(stallMessageFor(started), stallMessageFor(never));

  assert.match(stallDetail("Anthropic", started), /Anthropic.*120s/);
  assert.match(stallDetail("Google", never), /Google.*300s/);
});

test("the default windows are generous enough for a slow reasoning model", () => {
  // Extended thinking can emit nothing for a long stretch between blocks; the
  // window has to clear that comfortably or this becomes a source of false
  // failures on exactly the slowest, most expensive turns.
  assert.ok(PROVIDER_IDLE_TIMEOUT_MS >= 60_000);
  // ...but well inside undici's ~300s body timeout, so Juno reports the stall
  // itself rather than surfacing a transport error.
  assert.ok(PROVIDER_IDLE_TIMEOUT_MS < 300_000);
  // Startup covers request setup plus time to first token, so it has to be the
  // longer of the two.
  assert.ok(PROVIDER_STARTUP_TIMEOUT_MS > PROVIDER_IDLE_TIMEOUT_MS);
});
