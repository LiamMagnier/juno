import test from "node:test";
import assert from "node:assert/strict";

/*
 * The order a run's transcript is written in.
 *
 * `appendEvents` does not take a sequence number from its caller. It increments
 * the run row's `lastSeq` inside a transaction and stamps whatever it reads, so
 * an event's `seq` records *when its write ran* — and `seq` is the only thing
 * the transcript is ordered by and the only cursor a client resumes from.
 *
 * The cloud runner's `emit` is async, and the session's `onEvent` callback is
 * synchronous, so it called `emit` with `void`: fire-and-forget writes, racing.
 * A real run put "Finished — failed" ahead of the `assistant_message` that
 * preceded it by seconds.
 *
 * That is not only ugly. A client polls with `seq > cursor`, so an event that
 * lands with a lower seq than one already delivered is filtered out on every
 * later poll — silently and permanently missing.
 *
 * These tests model the append chain rather than importing the runner, which
 * needs a database and a live provider. What they pin is the property the fix
 * relies on: writes queue in call order even when callers do not await, one
 * failed write does not stop the rest, and the flush drains everything.
 */

/** The chaining `emit` in `scripts/work-runner.ts`, reduced to its ordering. */
function makeEmitter(write: (kind: string) => Promise<void>) {
  let tail: Promise<void> = Promise.resolve();
  const emit = (kind: string): Promise<void> => {
    const queued = tail.then(() => write(kind).then(
      () => undefined,
      () => undefined,
    ));
    tail = queued.catch(() => undefined);
    return queued;
  };
  return { emit, flush: () => tail };
}

test("un-awaited emits are still written in call order", async () => {
  const written: string[] = [];
  // Deliberately inverted latency: the first write is the slowest. Without a
  // chain this is exactly the interleaving that put the terminal event first.
  const delays: Record<string, number> = {
    assistant_message: 30,
    validation_result: 10,
    run_finished: 0,
  };
  const { emit, flush } = makeEmitter(async (kind) => {
    await new Promise((resolve) => setTimeout(resolve, delays[kind] ?? 0));
    written.push(kind);
  });

  // `void`, exactly as the session's synchronous `onEvent` callback does it.
  void emit("assistant_message");
  void emit("validation_result");
  void emit("run_finished");
  await flush();

  assert.deepEqual(written, ["assistant_message", "validation_result", "run_finished"]);
});

test("a failed write does not stop the events after it", async () => {
  const written: string[] = [];
  const { emit, flush } = makeEmitter(async (kind) => {
    if (kind === "tool_started") throw new Error("append failed");
    written.push(kind);
  });

  void emit("run_started");
  void emit("tool_started");
  void emit("run_finished");
  await flush();

  // The transcript is worth less than the work: a gap is acceptable, a run
  // whose every later event is swallowed is not.
  assert.deepEqual(written, ["run_started", "run_finished"]);
});

test("awaiting one emit drains everything queued before it", async () => {
  const written: string[] = [];
  const { emit } = makeEmitter(async (kind) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    written.push(kind);
  });

  void emit("run_started");
  void emit("assistant_message");
  // This is why the terminal path needs no explicit flush of its own when it
  // does emit: each append chains on the last.
  await emit("run_finished");

  assert.deepEqual(written, ["run_started", "assistant_message", "run_finished"]);
});

test("the flush resolves even when nothing was emitted", async () => {
  const { flush } = makeEmitter(async () => {});
  await flush();
});
