import test from "node:test";
import assert from "node:assert/strict";
import { createSseSender, encodeChunk, readChatStream } from "@/lib/chat-stream";
import type { StreamChunk } from "@/types/chat";

/** Minimal stand-in for the ReadableStream controller the route passes in. */
function fakeController(opts: { throwOnEnqueue?: boolean } = {}) {
  const frames: Uint8Array[] = [];
  return {
    frames,
    controller: {
      enqueue(chunk: Uint8Array) {
        if (opts.throwOnEnqueue) throw new TypeError("Controller is already closed");
        frames.push(chunk);
      },
    } as unknown as ReadableStreamDefaultController<Uint8Array>,
  };
}

function decode(frames: Uint8Array[]): StreamChunk[] {
  const text = new TextDecoder().decode(
    frames.reduce((acc, f) => {
      const out = new Uint8Array(acc.length + f.length);
      out.set(acc);
      out.set(f, acc.length);
      return out;
    }, new Uint8Array())
  );
  return text
    .split("\n\n")
    .filter((f) => f.startsWith("data:"))
    .map((f) => JSON.parse(f.slice(5).trim()) as StreamChunk);
}

test("chunks go out as well-formed SSE frames", () => {
  const { controller, frames } = fakeController();
  const sse = createSseSender(controller);
  sse.send({ type: "delta", text: "hello" } as StreamChunk);
  assert.equal(frames.length, 1);
  assert.deepEqual(decode(frames), [{ type: "delta", text: "hello" }]);
});

test("a disconnected client never throws into the generation", () => {
  // Load-bearing. Generation is bound to a generation-scoped AbortController,
  // not the request signal, so a user who navigates away still gets their
  // answer persisted. A throwing enqueue would undo that.
  const { controller } = fakeController({ throwOnEnqueue: true });
  const sse = createSseSender(controller);
  assert.doesNotThrow(() => sse.send({ type: "delta", text: "x" } as StreamChunk));
  assert.doesNotThrow(() => sse.sendActivity({ kind: "done", title: "Finished" }));
});

test("activity events are logged in order and streamed as they happen", () => {
  const { controller, frames } = fakeController();
  const sse = createSseSender(controller);
  sse.sendActivity({ kind: "context", title: "Reading context" });
  sse.sendActivity({ kind: "model", title: "Selected model" });

  assert.equal(sse.activityLog.length, 2);
  assert.deepEqual(sse.activityLog.map((e) => e.title), ["Reading context", "Selected model"]);

  const chunks = decode(frames);
  assert.equal(chunks.length, 2, "each activity is also streamed to the client");
  assert.equal(chunks[0].type, "activity");
});

test("activity ids are unique within a generation", () => {
  // They are persisted onto the message and used as React keys; a collision
  // silently drops an entry from the rendered timeline.
  const { controller } = fakeController();
  const sse = createSseSender(controller);
  for (let i = 0; i < 50; i++) sse.sendActivity({ kind: "tool", title: `t${i}` });
  const ids = new Set(sse.activityLog.map((e) => e.id));
  assert.equal(ids.size, 50);
});

test("the logged entry is the same object that was streamed", () => {
  const { controller, frames } = fakeController();
  const sse = createSseSender(controller);
  const returned = sse.sendActivity({ kind: "warning", title: "Careful" });
  const streamed = decode(frames)[0] as { type: string; event: { id: string } };
  assert.equal(streamed.event.id, returned.id);
  assert.equal(sse.activityLog[0].id, returned.id);
});

test("two senders do not share state", () => {
  const a = createSseSender(fakeController().controller);
  const b = createSseSender(fakeController().controller);
  a.sendActivity({ kind: "done", title: "A" });
  assert.equal(a.activityLog.length, 1);
  assert.equal(b.activityLog.length, 0, "each generation gets its own log");
});

test("what is written is what readChatStream reads back", async () => {
  const { controller, frames } = fakeController();
  const sse = createSseSender(controller);
  sse.send({ type: "delta", text: "part one" } as StreamChunk);
  sse.send({ type: "delta", text: "part two" } as StreamChunk);
  sse.sendActivity({ kind: "done", title: "Finished" });

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(f);
      c.close();
    },
  });

  const seen: StreamChunk[] = [];
  await readChatStream(body, (chunk) => seen.push(chunk));
  assert.equal(seen.length, 3);
  assert.equal(seen[0].type, "delta");
  assert.equal(seen[2].type, "activity");
});

test("a chunk containing newlines cannot split its own frame", () => {
  // JSON escapes them; if it did not, one message would arrive as several
  // truncated frames.
  const { controller, frames } = fakeController();
  createSseSender(controller).send({ type: "delta", text: "a\n\nb" } as StreamChunk);
  const raw = new TextDecoder().decode(frames[0]);
  assert.equal(raw.split("\n\n").filter(Boolean).length, 1);
  assert.deepEqual(decode(frames), [{ type: "delta", text: "a\n\nb" }]);
});

test("encodeChunk stays the single frame format", () => {
  const raw = new TextDecoder().decode(encodeChunk({ type: "ping" } as StreamChunk));
  assert.ok(raw.startsWith("data: "));
  assert.ok(raw.endsWith("\n\n"));
});
