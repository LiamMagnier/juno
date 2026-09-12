import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createFrameSequencer,
  replayStream,
  type GenerationLiveness,
  type ReplayEvent,
  type ReplayEventRow,
  type StreamReplayPort,
} from "@/lib/chat/stream-replay";

/*
 * The read side of a resumable stream, and the rule that makes replaying it
 * safe.
 *
 * The thing under test is a reconnect's honesty. A client hands back the last
 * seq it rendered and expects: nothing it has already seen, everything it has
 * not, an end when the turn ends, and — when the log cannot finish the job — to
 * be told so rather than left waiting. Getting the first of those wrong doubles
 * a delta in someone's transcript; getting the last wrong strands a turn in a
 * spinner that never resolves.
 */

const row = (seq: number, kind: string, payload = `frame-${seq}`): ReplayEventRow => ({ seq, kind, payload });

/** The reason a replay ended, or null if it did not end in an `end` event. */
function endReason(events: ReplayEvent[]): string | null {
  const last = events.at(-1);
  return last && last.type === "end" ? last.reason : null;
}

/** A port serving a fixed log, with liveness the test drives. */
function port(rows: ReplayEventRow[], liveness: () => GenerationLiveness): StreamReplayPort {
  return {
    eventsAfter: async (_id, after, limit) => rows.filter((r) => r.seq > after).slice(0, limit),
    liveness: async () => liveness(),
  };
}

/** Collect a replay under a clock the test advances by `sleep`. */
async function drain(
  replayPort: StreamReplayPort,
  options: Parameters<typeof replayStream>[1]
): Promise<ReplayEvent[]> {
  const events: ReplayEvent[] = [];
  for await (const event of replayStream(replayPort, options)) {
    events.push(event);
    if (events.length > 200) throw new Error("replay did not terminate");
  }
  return events;
}

/** A clock that only moves when the replay sleeps — no test waits on real time. */
function fakeClock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
  };
}

test("only frames after the client's cursor are replayed", async () => {
  const clock = fakeClock();
  const events = await drain(port([row(1, "meta"), row(2, "delta"), row(3, "delta"), row(4, "done")], () => "running"), {
    generationId: "gen_1",
    after: 2,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.deepEqual(
    events.filter((e) => e.type === "frame").map((e) => (e.type === "frame" ? e.seq : 0)),
    [3, 4]
  );
});

test("a terminal frame ends the tail immediately", async () => {
  const clock = fakeClock();
  // Rows after the `done` would be a bug upstream; the reader must stop at the
  // end of the turn regardless, because the client tears the stream down there.
  const events = await drain(port([row(1, "done"), row(2, "delta")], () => "running"), {
    generationId: "gen_1",
    after: 0,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.deepEqual(events, [
    { type: "frame", seq: 1, kind: "done", payload: "frame-1" },
    { type: "end", reason: "terminal" },
  ]);
});

test("an `error` frame is terminal too", async () => {
  const clock = fakeClock();
  const events = await drain(port([row(1, "error")], () => "running"), {
    generationId: "gen_1",
    after: 0,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(endReason(events), "terminal");
});

test("a running generation is waited on; frames that appear later still arrive", async () => {
  const clock = fakeClock();
  const rows: ReplayEventRow[] = [row(1, "delta")];
  let polls = 0;
  const late: StreamReplayPort = {
    eventsAfter: async (_id, after) => rows.filter((r) => r.seq > after),
    liveness: async () => {
      polls += 1;
      // The rest of the answer lands while the client is tailing.
      if (polls === 2) rows.push(row(2, "delta"), row(3, "done"));
      return "running";
    },
  };

  const events = await drain(late, { generationId: "gen_1", after: 0, now: clock.now, sleep: clock.sleep });
  assert.deepEqual(
    events.filter((e) => e.type === "frame").map((e) => (e.type === "frame" ? e.seq : 0)),
    [1, 2, 3]
  );
  assert.equal(endReason(events), "terminal");
});

test("a finished generation with no terminal frame ends in `refetch`, not silence", async () => {
  /*
   * The process died mid-answer, or the log was disabled by a failed write. The
   * client must be told to go read the conversation: waiting for a frame that
   * will never be written is how a turn ends up spinning forever.
   */
  const clock = fakeClock();
  const events = await drain(port([row(1, "delta")], () => "terminal"), {
    generationId: "gen_1",
    after: 0,
    now: clock.now,
    sleep: clock.sleep,
    terminalGraceMs: 1_000,
    pollMs: 400,
  });

  assert.deepEqual(events.at(-1), { type: "end", reason: "refetch" });
});

test("the terminal grace waits for a flush that is still landing", async () => {
  const clock = fakeClock();
  const rows: ReplayEventRow[] = [row(1, "delta")];
  let polls = 0;
  const flushing: StreamReplayPort = {
    eventsAfter: async (_id, after) => rows.filter((r) => r.seq > after),
    liveness: async () => {
      polls += 1;
      // The generation is over, but its last batch reaches the table a beat
      // later. Ending on the first "terminal" would lose the `done` frame.
      if (polls === 2) rows.push(row(2, "done"));
      return "terminal";
    },
  };

  const events = await drain(flushing, {
    generationId: "gen_1",
    after: 0,
    now: clock.now,
    sleep: clock.sleep,
    terminalGraceMs: 3_000,
    pollMs: 400,
  });

  assert.deepEqual(events.at(-1), { type: "end", reason: "terminal" });
});

test("a long silence still produces heartbeats", async () => {
  const clock = fakeClock();
  const events = await drain(port([], () => "running"), {
    generationId: "gen_1",
    after: 0,
    now: clock.now,
    sleep: clock.sleep,
    heartbeatMs: 1_000,
    pollMs: 400,
    maxTailMs: 5_000,
  });

  assert.ok(events.filter((e) => e.type === "heartbeat").length >= 3, "proxies need bytes to keep the socket open");
  assert.deepEqual(events.at(-1), { type: "end", reason: "timeout" });
});

test("an aborted request ends the tail at once", async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  controller.abort();
  const events = await drain(port([row(1, "delta")], () => "running"), {
    generationId: "gen_1",
    after: 0,
    now: clock.now,
    sleep: clock.sleep,
    signal: controller.signal,
  });
  assert.deepEqual(events, [{ type: "end", reason: "aborted" }]);
});

test("a full batch is drained before liveness is consulted", async () => {
  const clock = fakeClock();
  let livenessCalls = 0;
  const rows = Array.from({ length: 5 }, (_, i) => row(i + 1, i === 4 ? "done" : "delta"));
  const paged: StreamReplayPort = {
    eventsAfter: async (_id, after, limit) => rows.filter((r) => r.seq > after).slice(0, limit),
    liveness: async () => {
      livenessCalls += 1;
      return "running";
    },
  };

  const events = await drain(paged, {
    generationId: "gen_1",
    after: 0,
    now: clock.now,
    sleep: clock.sleep,
    batchLimit: 2,
  });

  assert.equal(
    events.filter((e) => e.type === "frame").length,
    5,
    "a backlog is served straight through, not one poll interval per page"
  );
  assert.equal(livenessCalls, 0);
});

// ---------------------------------------------------------------------------
// Idempotent application: the rule that lets a replay overlap the drop.
// ---------------------------------------------------------------------------

/** The client's accumulator, reduced to the only part a replay can corrupt. */
function transcript() {
  const sequencer = createFrameSequencer();
  let text = "";
  let done = false;
  return {
    apply(frame: { id?: number; type: string; text?: string }) {
      if (!sequencer.accept(frame.id)) return;
      if (frame.type === "delta") text += frame.text ?? "";
      if (frame.type === "done") done = true;
    },
    get text() {
      return text;
    },
    get done() {
      return done;
    },
    get lastSeq() {
      return sequencer.lastSeq;
    },
  };
}

test("a replay that overlaps the drop does not double the answer", () => {
  const acc = transcript();
  // The live stream delivered four frames and then dropped.
  acc.apply({ id: 1, type: "meta" });
  acc.apply({ id: 2, type: "delta", text: "Hello " });
  acc.apply({ id: 3, type: "delta", text: "there" });
  assert.equal(acc.lastSeq, 3);

  // The reconnect asks for `after=3` — but the server, or a retried reconnect,
  // hands back an overlapping window. Everything at or below 3 is already on
  // screen.
  for (const frame of [
    { id: 2, type: "delta", text: "Hello " },
    { id: 3, type: "delta", text: "there" },
    { id: 4, type: "delta", text: ", friend" },
    { id: 5, type: "done" },
  ]) {
    acc.apply(frame);
  }

  assert.equal(acc.text, "Hello there, friend");
  assert.equal(acc.done, true);
});

test("replaying the same window twice is a no-op the second time", () => {
  const acc = transcript();
  const window = [
    { id: 1, type: "delta", text: "a" },
    { id: 2, type: "delta", text: "b" },
  ];
  for (const frame of window) acc.apply(frame);
  for (const frame of window) acc.apply(frame);
  assert.equal(acc.text, "ab");
});

test("frames with no id always apply — they are not positions in the log", () => {
  const acc = transcript();
  acc.apply({ id: 4, type: "delta", text: "x" });
  // A `resume` notice or a heartbeat carries no id and must never be dropped
  // for looking like a rewind.
  acc.apply({ type: "delta", text: "y" });
  acc.apply({ type: "delta", text: "z" });
  assert.equal(acc.text, "xyz");
  assert.equal(acc.lastSeq, 4);
});

test("a reconnect resumes from the last seq the client actually applied", () => {
  const sequencer = createFrameSequencer(0);
  for (const id of [1, 2, 3]) sequencer.accept(id);
  // Out-of-order or stale rows must not rewind the cursor; the next request
  // would then ask for frames the transcript already has.
  sequencer.accept(2);
  assert.equal(sequencer.lastSeq, 3);
});

test("the client feeds replayed frames through the same applier as the live stream", () => {
  /*
   * Structural, because this is the property that makes every test above
   * meaningful on the client: the reconnect must not grow its own copy of the
   * frame handler. Two handlers is two chances to disagree about what a replay
   * means, and the symptom is a duplicated paragraph in someone's answer.
   */
  const hook = readFileSync(new URL("../src/hooks/use-chat.ts", import.meta.url), "utf8");
  assert.match(hook, /createFrameSequencer\(initialSeq\)/, "the applier is the thing that holds the cursor");
  assert.match(hook, /if \(!sequencer\.accept\(frame\.id\)\) return;/);
  assert.equal(
    hook.split("createStreamApplier = React.useCallback").length - 1,
    1,
    "there is exactly one applier factory"
  );
  assert.match(hook, /readChatStream\(res\.body, applier\.apply\)/, "the live stream uses it");
  assert.match(hook, /readChatStream\(res\.body, args\.applier\.apply\)/, "and so does the reconnect");
});

test("a dropped stream is offered a reconnect, never a regenerate", () => {
  /*
   * The bug this whole feature exists to kill: "Try again" on a turn that is
   * still being answered asks for a second answer and charges for it. Every
   * retry affordance goes through `regenerate`, so that is where the
   * interception has to be.
   */
  const hook = readFileSync(new URL("../src/hooks/use-chat.ts", import.meta.url), "utf8");
  const regenerate = hook.slice(hook.indexOf("const regenerate = React.useCallback"));
  const guard = regenerate.indexOf("if (reconnectRef.current) {");
  const firstRun = regenerate.indexOf("runGeneration(");
  assert.ok(guard > -1, "regenerate checks for a reconnectable turn");
  assert.ok(guard < firstRun, "and it does so before it can start a second generation");
});
