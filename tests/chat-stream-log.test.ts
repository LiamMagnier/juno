import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createStreamLog,
  shouldLogStream,
  streamLogSource,
  type StreamLogRow,
} from "@/lib/chat/stream-log";
import { createSseSender } from "@/lib/chat-stream";
import type { StreamChunk } from "@/types/chat";

/*
 * The write side of a resumable stream.
 *
 * What is being pinned here is a set of promises the client half depends on and
 * cannot verify for itself: seq numbers are monotonic with no gaps, rows never
 * reach the database from the stream's critical path, the log stops rather than
 * growing without bound, and a failed write takes the WHOLE log down instead of
 * leaving a hole in it. A client that replays across a hole renders an answer
 * with a piece missing and believes it complete.
 */

/** A write port that records its batches and can be made to fail. */
function recordingWrite() {
  const batches: StreamLogRow[][] = [];
  let fail: Error | null = null;
  let inFlight = 0;
  let overlapped = false;
  let release: (() => void) | null = null;
  return {
    batches,
    get rows() {
      return batches.flat();
    },
    get overlapped() {
      return overlapped;
    },
    failWith(error: Error) {
      fail = error;
    },
    /** Hold the next write open until `release()` is called. */
    block() {
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release() {
      release?.();
      release = null;
    },
    write: async (rows: StreamLogRow[]) => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      batches.push(rows);
      if (release) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      if (fail) throw fail;
    },
  };
}

/** Manual clock for the flush timer, so no test waits on a real 250ms. */
function fakeTimer() {
  let pending: (() => void) | null = null;
  return {
    get armed() {
      return pending !== null;
    },
    fire() {
      const fn = pending;
      pending = null;
      fn?.();
    },
    schedule: (fn: () => void) => {
      pending = fn;
      return 1;
    },
    clearTimer: () => {
      pending = null;
    },
  };
}

const delta = (text: string): StreamChunk => ({ type: "delta", text });

test("frames buffer and go out in one batch, not one write per frame", async () => {
  const port = recordingWrite();
  const timer = fakeTimer();
  const log = createStreamLog({
    generationId: "gen_1",
    write: port.write,
    flushEvery: 4,
    schedule: timer.schedule,
    clearTimer: timer.clearTimer,
  });

  log.record(delta("a"));
  log.record(delta("b"));
  log.record(delta("c"));
  // Nothing has been written yet: under the batch size and the timer has not
  // fired. This is the property that keeps the log off the critical path.
  assert.equal(port.batches.length, 0);
  assert.ok(timer.armed);

  log.record(delta("d"));
  await log.flush();
  assert.equal(port.batches.length, 1);
  assert.equal(port.batches[0].length, 4);
});

test("the flush timer alone gets a short answer out", async () => {
  const port = recordingWrite();
  const timer = fakeTimer();
  const log = createStreamLog({
    generationId: "gen_1",
    write: port.write,
    flushEvery: 32,
    schedule: timer.schedule,
    clearTimer: timer.clearTimer,
  });

  log.record(delta("only"));
  assert.equal(port.batches.length, 0);
  timer.fire();
  await log.flush();
  assert.deepEqual(
    port.rows.map((row) => row.seq),
    [1]
  );
});

test("seq is monotonic and gapless across batches", async () => {
  const port = recordingWrite();
  const timer = fakeTimer();
  const log = createStreamLog({
    generationId: "gen_1",
    write: port.write,
    flushEvery: 2,
    schedule: timer.schedule,
    clearTimer: timer.clearTimer,
  });

  const handed: Array<number | null> = [];
  for (const text of ["a", "b", "c", "d", "e"]) handed.push(log.record(delta(text)));
  await log.close();

  assert.deepEqual(handed, [1, 2, 3, 4, 5]);
  assert.deepEqual(
    port.rows.map((row) => row.seq),
    [1, 2, 3, 4, 5]
  );
  assert.deepEqual(
    port.rows.map((row) => row.generationId),
    Array(5).fill("gen_1")
  );
  // The seq a frame was given is the SSE id the client hands back as `after`,
  // so the payload under that seq has to be that frame.
  assert.equal(JSON.parse(port.rows[2].payload).text, "c");
});

test("heartbeats are never logged — they carry no state to replay", async () => {
  const port = recordingWrite();
  const timer = fakeTimer();
  const log = createStreamLog({
    generationId: "gen_1",
    write: port.write,
    flushEvery: 1,
    schedule: timer.schedule,
    clearTimer: timer.clearTimer,
  });

  assert.equal(log.record({ type: "ping" }), null);
  assert.equal(log.record(delta("a")), 1);
  await log.close();
  assert.deepEqual(
    port.rows.map((row) => row.kind),
    ["delta"]
  );
});

test("the per-generation cap stops the log instead of filling the disk", async () => {
  const port = recordingWrite();
  const timer = fakeTimer();
  const disabled: string[] = [];
  const log = createStreamLog({
    generationId: "gen_1",
    write: port.write,
    flushEvery: 100,
    maxEvents: 3,
    onDisabled: (reason) => disabled.push(reason),
    schedule: timer.schedule,
    clearTimer: timer.clearTimer,
  });

  assert.deepEqual([log.record(delta("a")), log.record(delta("b")), log.record(delta("c"))], [1, 2, 3]);
  assert.equal(log.record(delta("d")), null);
  assert.equal(log.available, false);
  assert.equal(log.disabledReason, "cap");
  // Past the cap nothing more is recorded, and the client is told once.
  assert.equal(log.record(delta("e")), null);
  assert.deepEqual(disabled, ["cap"]);
});

test("a failed write disables the log — half a log is worse than none", async () => {
  const port = recordingWrite();
  const timer = fakeTimer();
  const disabled: Array<{ reason: string; message: string }> = [];
  const log = createStreamLog({
    generationId: "gen_1",
    write: port.write,
    flushEvery: 1,
    onDisabled: (reason, error) =>
      disabled.push({ reason, message: error instanceof Error ? error.message : String(error) }),
    schedule: timer.schedule,
    clearTimer: timer.clearTimer,
  });

  port.failWith(new Error("insert failed"));
  log.record(delta("a"));
  await log.flush();

  assert.equal(log.available, false);
  assert.equal(log.disabledReason, "write_failed");
  assert.deepEqual(disabled, [{ reason: "write_failed", message: "insert failed" }]);

  // And it stays down: a later frame is not recorded, so a replay can never
  // serve a log with a gap where the failed batch was.
  assert.equal(log.record(delta("b")), null);
  await log.close();
  assert.deepEqual(disabled.length, 1, "the failure is reported once, not once per frame");
});

test("a slow write cannot overlap the next flush", async () => {
  const port = recordingWrite();
  const timer = fakeTimer();
  const log = createStreamLog({
    generationId: "gen_1",
    write: port.write,
    flushEvery: 1,
    schedule: timer.schedule,
    clearTimer: timer.clearTimer,
  });

  void port.block();
  log.record(delta("a"));
  log.record(delta("b"));
  log.record(delta("c"));
  port.release();
  await log.close();

  assert.equal(port.overlapped, false);
  // Serialised writes are what keep the rows' unique (generationId, seq) from
  // racing, and what keeps the batches in seq order.
  assert.deepEqual(
    port.rows.map((row) => row.seq),
    [1, 2, 3]
  );
});

// ---------------------------------------------------------------------------
// The sender, which is where a frame's seq becomes its SSE id.
// ---------------------------------------------------------------------------

function fakeController() {
  const frames: string[] = [];
  return {
    frames,
    controller: {
      enqueue(bytes: Uint8Array) {
        frames.push(new TextDecoder().decode(bytes));
      },
    } as unknown as ReadableStreamDefaultController<Uint8Array>,
  };
}

function parse(frames: string[]): Array<{ id?: number; chunk: StreamChunk }> {
  return frames.map((frame) => {
    const idLine = /^id: (\d+)\n/.exec(frame);
    const data = frame.slice(idLine ? idLine[0].length : 0);
    return {
      ...(idLine ? { id: Number(idLine[1]) } : {}),
      chunk: JSON.parse(data.replace(/^data: /, "").trim()) as StreamChunk,
    };
  });
}

test("logged frames go out carrying their log position as the SSE id", async () => {
  const port = recordingWrite();
  const timer = fakeTimer();
  const log = createStreamLog({
    generationId: "gen_1",
    write: port.write,
    flushEvery: 10,
    schedule: timer.schedule,
    clearTimer: timer.clearTimer,
  });
  const { controller, frames } = fakeController();
  const sse = createSseSender(controller, { log });

  sse.send(delta("a"));
  sse.send({ type: "ping" });
  sse.send(delta("b"));
  await log.close();

  const sent = parse(frames);
  assert.deepEqual(
    sent.map((frame) => frame.id),
    // The heartbeat is not in the log, so it has no id to resume from.
    [1, undefined, 2]
  );
});

test("when the log dies mid-stream the client is told, once, and ids stop", async () => {
  const port = recordingWrite();
  const timer = fakeTimer();
  const log = createStreamLog({
    generationId: "gen_1",
    write: port.write,
    flushEvery: 1,
    schedule: timer.schedule,
    clearTimer: timer.clearTimer,
  });
  const { controller, frames } = fakeController();
  const sse = createSseSender(controller, { log });

  port.failWith(new Error("db down"));
  sse.send(delta("a"));
  await log.flush();
  sse.send(delta("b"));
  sse.send(delta("c"));

  const sent = parse(frames);
  assert.deepEqual(
    sent.map((frame) => frame.chunk.type),
    // The notice is inserted before the first frame that cannot be resumed
    // from, so the client learns the reconnect is off before it needs it.
    ["delta", "resume", "delta", "delta"]
  );
  assert.deepEqual(sent[1].chunk, { type: "resume", available: false });
  assert.deepEqual(
    sent.map((frame) => frame.id),
    [1, undefined, undefined, undefined]
  );
});

// ---------------------------------------------------------------------------
// The source guard: a private turn logs NOTHING.
// ---------------------------------------------------------------------------

test("private turns are not a logged source", () => {
  assert.equal(streamLogSource({ privateMode: true }), "private");
  assert.equal(shouldLogStream({ privateMode: true }), false);
  assert.equal(shouldLogStream({}), true);
  assert.equal(shouldLogStream({ privateMode: false }), true);
});

test("a sender with no log writes nothing and advertises no resume point", () => {
  const { controller, frames } = fakeController();
  const sse = createSseSender(controller);
  sse.send(delta("private text"));
  sse.sendActivity({ kind: "write", title: "Writing the private answer" });
  assert.equal(parse(frames).every((frame) => frame.id === undefined), true);
});

test("the chat route opens exactly one log, guarded, and never on the private path", () => {
  /*
   * A structural check, deliberately.
   *
   * The promise a private chat makes is that nothing about the turn is
   * persisted, and a logged `delta` is the answer's text — so the thing worth
   * asserting is not that some helper returns false, but that the private
   * branch of the route has no log to hand its sender in the first place. That
   * is a property of the wiring, and only the wiring can be asked about it.
   */
  const route = readFileSync(new URL("../src/app/api/chat/route.ts", import.meta.url), "utf8");

  assert.equal(route.split("createStreamLog(").length - 1, 1, "exactly one log is ever created");
  assert.match(route, /shouldLogStream\(input\)\s*\n\s*\? createStreamLog\(/, "and it is behind the source guard");

  // The private branch runs first and returns its own Response; the log is
  // created in the saved path below it.
  const privateSender = route.indexOf("const { send, sendActivity, activityLog } = createSseSender(controller);");
  const firstLogMention = route.indexOf("const streamLog");
  assert.ok(privateSender > 0, "the private path still builds a sender with no options");
  assert.ok(
    privateSender < firstLogMention,
    "no log exists anywhere in the private branch — it cannot be passed one by accident"
  );
  assert.equal(
    route.split("createSseSender(controller, { log: streamLog })").length - 1,
    1,
    "only the saved path's sender is given the log"
  );
});
