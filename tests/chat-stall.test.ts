import test, { type TestContext } from "node:test";
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

test("a stream that keeps producing never fires", (t: TestContext) => {
  let fired = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const wd = createStallWatchdog(() => fired++, 40, 1_000);
  for (let i = 0; i < 6; i++) {
    t.mock.timers.tick(15);
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

test("a pending approval pauses the idle clock; resume() after the result re-arms it", (t: TestContext) => {
  /*
   * While `toolset.execute` blocks on a person answering an approval card, the
   * generator yields nothing and nothing touches the watchdog — so a 200s
   * deliberation used to be reported as "Model stopped responding". Paused,
   * the clock does not run; the approval receipt's own TTL bounds the wait.
   */
  let fired = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const wd = createStallWatchdog(() => fired++, 20, 1_000);
  wd.touch(); // the model streamed, then reached for a connector tool
  wd.pause(); // the call went `awaiting_approval`: one active call
  assert.equal(wd.paused, true);
  t.mock.timers.tick(200_000);
  assert.equal(fired, 0, "a person taking 200s to decide is not a stalled provider");
  assert.equal(wd.stalled, false);

  wd.touch(); // the tool result event arrives (approved or refused)…
  assert.equal(wd.paused, true, "…and an event alone does not end the pause (INV-33)");
  wd.resume(); // …the turn stream's active count fell to 0
  assert.equal(wd.paused, false);
  t.mock.timers.tick(25);
  assert.equal(fired, 1, "silence AFTER the result is a stall again");
  wd.stop();
});

test("a paused watchdog stays paused through touch() (INV-33)", (t: TestContext) => {
  let fired = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const wd = createStallWatchdog(() => fired++, 20, 1_000);
  wd.touch();
  wd.pause();
  for (let i = 0; i < 5; i++) {
    wd.touch();
    t.mock.timers.tick(100);
  }
  assert.equal(wd.paused, true);
  assert.equal(fired, 0, "no touch re-armed the clock");
  wd.resume();
  t.mock.timers.tick(25);
  assert.equal(fired, 1);
  wd.stop();
});

test("a 130 s run_code whose status events touch the watchdog completes without a stall (RC-1, RC-9)", (t: TestContext) => {
  /*
   * The route touches the watchdog on every provider event and pauses or
   * resumes it on the turn stream's active-call count. A `run_code` is allowed
   * 130 s, past the 120 s idle window; its `queued` and `running` status events
   * arrive at the start and then nothing does until the result.
   */
  let fired = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const wd = createStallWatchdog(() => fired++); // the production windows
  let active = 0;
  const onToolActivityChange = (next: number) => {
    active = next;
    if (active > 0) wd.pause();
    else wd.resume();
  };

  wd.touch(); // `tool` call
  t.mock.timers.tick(5);
  wd.touch(); // `round_end`
  wd.touch(); // status `queued`
  wd.touch(); // status `running`…
  onToolActivityChange(1); // …which makes the call active
  t.mock.timers.tick(130_000);
  wd.touch(); // the result
  onToolActivityChange(0);
  assert.equal(fired, 0, "the tool ran inside its own timeout; the provider never stalled");
  assert.equal(wd.stalled, false);

  t.mock.timers.tick(PROVIDER_IDLE_TIMEOUT_MS - 1);
  wd.touch(); // the model's next text
  assert.equal(fired, 0);
  t.mock.timers.tick(PROVIDER_IDLE_TIMEOUT_MS + 1);
  assert.equal(fired, 1, "provider silence after the tool is still caught");
  wd.stop();
});

test("resume() re-arms without an event, and pause is inert once stopped or stalled", (t: TestContext) => {
  let fired = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const wd = createStallWatchdog(() => fired++, 20, 1_000);
  wd.touch();
  wd.pause();
  wd.resume();
  assert.equal(wd.paused, false);
  t.mock.timers.tick(25);
  assert.equal(fired, 1);

  // Stalled: pausing must not hide the verdict.
  wd.pause();
  assert.equal(wd.paused, false);
  assert.equal(wd.stalled, true);

  const done = createStallWatchdog(() => fired++, 20, 1_000);
  done.stop();
  done.pause();
  done.resume();
  t.mock.timers.tick(50);
  assert.equal(fired, 1, "a stopped watchdog cannot be revived through pause/resume");
});

/*
 * V5 (TOOL_RUNTIME_DESIGN §7 L1): a 130-second tool call that emits progress
 * frames completes without tripping the stall watchdog. The real windows, the
 * real tracker the route uses, and the dispatcher's event shapes, on fake
 * timers: 10 s of streaming, the call runs 130 s with a progress frame every
 * 10 s, then the answer streams. Before the hold, 130 s of tool time inside a
 * 120 s idle window was reported as a model that stopped responding.
 */
test("a 130 s tool call with progress frames completes without a stall", async (t: TestContext) => {
  const { trackToolActivity } = await import("@/lib/chat-stall");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fired = 0;
  const wd = createStallWatchdog(() => fired++);
  const tools = trackToolActivity(wd);
  const event = (e: { type: string; phase?: string; status?: string; callId?: string }) => {
    wd.touch();
    tools.observe(e);
  };

  event({ type: "text" });
  t.mock.timers.tick(10_000);
  event({ type: "tool", phase: "call", callId: "c1" });
  event({ type: "tool", phase: "status", status: "queued", callId: "c1" });
  event({ type: "tool", phase: "status", status: "running", callId: "c1" });
  assert.equal(wd.held, true);
  for (let s = 0; s < 130; s += 10) {
    t.mock.timers.tick(10_000);
    event({ type: "tool", phase: "progress", callId: "c1" });
    assert.equal(wd.held, true, "a progress frame never releases the hold");
  }
  event({ type: "tool", phase: "result", callId: "c1" });
  assert.equal(wd.held, false);
  t.mock.timers.tick(5_000);
  event({ type: "text" });
  assert.equal(fired, 0, "130 s of tool time is not provider silence");
  assert.equal(wd.stalled, false);

  // The idle window is back once the call settled: real silence still stalls.
  t.mock.timers.tick(PROVIDER_IDLE_TIMEOUT_MS + 1);
  assert.equal(fired, 1);
  wd.stop();
});

test("the hold alone covers a silent run; without it the same silence stalls", async (t: TestContext) => {
  const { trackToolActivity } = await import("@/lib/chat-stall");
  t.mock.timers.enable({ apis: ["setTimeout"] });

  let held = 0;
  const withHold = createStallWatchdog(() => held++);
  const tracker = trackToolActivity(withHold);
  withHold.touch();
  tracker.observe({ type: "tool", phase: "status", status: "running", callId: "x" });
  t.mock.timers.tick(130_000);
  assert.equal(held, 0, "no progress at all, still no stall while the call runs");
  tracker.observe({ type: "tool", phase: "result", callId: "x" });
  withHold.stop();

  let unheld = 0;
  const without = createStallWatchdog(() => unheld++);
  without.touch();
  t.mock.timers.tick(130_000);
  assert.equal(unheld, 1, "the control: 130 s of silence with no running call is a stall");
  without.stop();
});

test("parallel calls each hold; the clock restarts only when the last one settles", async (t: TestContext) => {
  const { trackToolActivity } = await import("@/lib/chat-stall");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fired = 0;
  const wd = createStallWatchdog(() => fired++, 1_000, 5_000);
  const tracker = trackToolActivity(wd);
  wd.touch();
  tracker.observe({ type: "tool", phase: "status", status: "running", callId: "a" });
  tracker.observe({ type: "tool", phase: "status", status: "running", callId: "b" });
  tracker.observe({ type: "tool", phase: "status", status: "running", callId: "b" });
  assert.equal(tracker.active, 2);
  tracker.observe({ type: "tool", phase: "result", callId: "a" });
  t.mock.timers.tick(10_000);
  assert.equal(fired, 0, "b still runs");
  tracker.observe({ type: "tool", phase: "result", callId: "b" });
  t.mock.timers.tick(1_001);
  assert.equal(fired, 1);
  tracker.releaseAll();
  wd.stop();
});

test("an approval pause and a tool hold do not undo each other", (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fired = 0;
  const wd = createStallWatchdog(() => fired++, 1_000, 5_000);
  wd.touch();
  const release = wd.hold();
  wd.pause();
  wd.touch(); // a result arriving clears the approval pause...
  t.mock.timers.tick(10_000);
  assert.equal(fired, 0, "...but the hold keeps the clock off");
  release();
  t.mock.timers.tick(1_001);
  assert.equal(fired, 1);
  wd.stop();
});

/*
 * L1 review. The route touches the watchdog for EVERY event, and the
 * dispatcher's `awaiting_approval` act is an event — the next one after the
 * broker's callback paused the clock. `touch()` clears a pause, so a person
 * deciding for longer than the idle window had the turn killed as a stalled
 * model. The approval wait now holds the clock, exactly as a running call does.
 */
test("a person deciding longer than the idle window does not stall the turn", async (t: TestContext) => {
  const { trackToolActivity } = await import("@/lib/chat-stall");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fired = 0;
  const wd = createStallWatchdog(() => fired++);
  const tools = trackToolActivity(wd);
  // The route's order: touch, then observe. The broker's callback pauses first.
  const event = (e: { type: string; phase?: string; status?: string; callId?: string }) => {
    wd.touch();
    tools.observe(e);
  };
  event({ type: "text" });
  event({ type: "tool", phase: "call", callId: "c1" });
  event({ type: "tool", phase: "status", status: "queued", callId: "c1" });
  wd.pause(); // requestApproval
  event({ type: "tool", phase: "status", status: "awaiting_approval", callId: "c1" });
  t.mock.timers.tick(PROVIDER_IDLE_TIMEOUT_MS * 3);
  assert.equal(fired, 0, "minutes of deliberation are not provider silence");
  event({ type: "tool", phase: "status", status: "running", callId: "c1" });
  assert.equal(tools.active, 1, "the same hold carries on into the run");
  t.mock.timers.tick(PROVIDER_IDLE_TIMEOUT_MS * 2);
  assert.equal(fired, 0);
  event({ type: "tool", phase: "result", callId: "c1" });
  assert.equal(wd.held, false);
  t.mock.timers.tick(PROVIDER_IDLE_TIMEOUT_MS + 1);
  assert.equal(fired, 1, "real silence after the result still stalls");
  wd.stop();
});

test("a refused approval releases its hold at the result", async (t: TestContext) => {
  const { trackToolActivity } = await import("@/lib/chat-stall");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fired = 0;
  const wd = createStallWatchdog(() => fired++, 1_000, 5_000);
  const tools = trackToolActivity(wd);
  wd.touch();
  tools.observe({ type: "tool", phase: "status", status: "awaiting_approval", callId: "a" });
  tools.observe({ type: "tool", phase: "status", status: "awaiting_approval", callId: "b" });
  tools.observe({ type: "tool", phase: "result", callId: "a" });
  t.mock.timers.tick(10_000);
  assert.equal(fired, 0, "b is still waiting on a person");
  tools.observe({ type: "tool", phase: "result", callId: "b" });
  t.mock.timers.tick(1_001);
  assert.equal(fired, 1);
  wd.stop();
});
