import test from "node:test";
import assert from "node:assert/strict";
import {
  UPSTREAM_CEILING_MS,
  UPSTREAM_HEADERS_TIMEOUT_MS,
  UPSTREAM_IDLE_TIMEOUT_MS,
  createUpstreamAbort,
  isUpstreamTimeout,
  readLimitedRequestBody,
  upstreamTimeoutKind,
  upstreamTimeoutsFor,
  type UpstreamTimers,
} from "@/lib/agent-proxy";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function streamRequest(chunks: string[]): Request {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request("https://chat.liams.dev/api/agent/openai/chat/completions", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

/**
 * A clock the test advances by hand, and that can say how many timers are
 * still armed — the only honest way to check nothing is left behind.
 */
class FakeTimers implements UpstreamTimers {
  private now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  set(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, callback });
    return id;
  }

  clear(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get pending(): number {
    return this.timers.size;
  }

  tick(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      let due: [number, { at: number; callback: () => void }] | null = null;
      for (const entry of this.timers) {
        if (entry[1].at <= until && (!due || entry[1].at < due[1].at)) due = entry;
      }
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = until;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const TIMEOUTS = { headersMs: 100, idleMs: 50, ceilingMs: 1_000 };

test("reads a streamed request body and preserves UTF-8", async () => {
  const result = await readLimitedRequestBody(streamRequest(["{\"text\":\"caf", "é\"}"]));
  assert.deepEqual(result, { ok: true, body: '{"text":"café"}' });
});

test("rejects a declared body before buffering it", async () => {
  const req = new Request("https://chat.liams.dev/api/agent/openai/chat/completions", {
    method: "POST",
    headers: { "content-length": "100" },
    body: "small",
  });
  assert.deepEqual(await readLimitedRequestBody(req, 10), { ok: false, reason: "too_large" });
});

test("rejects a streamed body that crosses the limit", async () => {
  const result = await readLimitedRequestBody(streamRequest(["1234", "5678", "9"]), 8);
  assert.deepEqual(result, { ok: false, reason: "too_large" });
});

test("the upstream call follows the client away, and that is not a timeout", () => {
  const timers = new FakeTimers();
  const parent = new AbortController();
  const upstream = createUpstreamAbort(parent.signal, TIMEOUTS, timers);
  parent.abort("client_closed");
  assert.equal(upstream.signal.aborted, true);
  assert.equal(upstream.signal.reason, "client_closed");
  assert.equal(isUpstreamTimeout(upstream.signal), false);
  // Aborting disarms everything; nothing waits out the ceiling.
  assert.equal(timers.pending, 0);
});

test("a client that is already gone aborts before any timer is armed", () => {
  const timers = new FakeTimers();
  const parent = new AbortController();
  parent.abort("gone");
  const upstream = createUpstreamAbort(parent.signal, TIMEOUTS, timers);
  assert.equal(upstream.signal.aborted, true);
  assert.equal(timers.pending, 0);
});

test("a provider that never sends headers is stopped by the headers deadline", () => {
  const timers = new FakeTimers();
  const upstream = createUpstreamAbort(new AbortController().signal, TIMEOUTS, timers);
  timers.tick(99);
  assert.equal(upstream.signal.aborted, false);
  timers.tick(1);
  assert.equal(upstreamTimeoutKind(upstream.signal), "headers");
  assert.equal(isUpstreamTimeout(upstream.signal), true);
});

test("headers disarm the headers deadline", () => {
  const timers = new FakeTimers();
  const upstream = createUpstreamAbort(new AbortController().signal, TIMEOUTS, timers);
  timers.tick(60);
  upstream.headersReceived();
  timers.tick(500);
  assert.equal(upstream.signal.aborted, false);
  upstream.cancel();
});

test("every chunk resets the idle deadline, so a busy stream outlives it many times over", async () => {
  const timers = new FakeTimers();
  const upstream = createUpstreamAbort(new AbortController().signal, TIMEOUTS, timers);
  upstream.headersReceived();
  // Twenty chunks 40ms apart: 800ms of streaming against a 50ms idle limit.
  for (let i = 0; i < 20; i++) {
    const chunk = deferred<number>();
    const read = upstream.read(() => chunk.promise);
    timers.tick(40);
    chunk.resolve(i);
    assert.equal(await read, i);
  }
  assert.equal(upstream.signal.aborted, false);

  // Then the provider goes quiet with a read waiting on it.
  void upstream.read(() => new Promise<never>(() => {}));
  timers.tick(49);
  assert.equal(upstream.signal.aborted, false);
  timers.tick(1);
  assert.equal(upstreamTimeoutKind(upstream.signal), "idle");
  assert.equal(timers.pending, 0);
});

test("the idle deadline only runs while a read waits on the provider", async () => {
  const timers = new FakeTimers();
  const upstream = createUpstreamAbort(new AbortController().signal, TIMEOUTS, timers);
  upstream.headersReceived();
  await upstream.read(async () => 1);
  // A client that stops pulling for longer than the idle limit is not the
  // provider going silent.
  timers.tick(400);
  assert.equal(upstream.signal.aborted, false);
  upstream.cancel();
});

test("the ceiling stops a stream that never stops producing", async () => {
  const timers = new FakeTimers();
  const upstream = createUpstreamAbort(
    new AbortController().signal,
    { headersMs: 100, idleMs: 50, ceilingMs: 200 },
    timers,
  );
  upstream.headersReceived();
  for (let i = 0; i < 4; i++) {
    const chunk = deferred<void>();
    const read = upstream.read(() => chunk.promise);
    timers.tick(40);
    chunk.resolve();
    await read;
  }
  assert.equal(upstream.signal.aborted, false);
  const chunk = deferred<void>();
  const read = upstream.read(() => chunk.promise);
  timers.tick(40);
  assert.equal(upstreamTimeoutKind(upstream.signal), "ceiling");
  chunk.resolve();
  await read;
  assert.equal(timers.pending, 0);
});

test("cancel leaves no timer and no client listener behind", async () => {
  const timers = new FakeTimers();
  const parent = new AbortController();
  const upstream = createUpstreamAbort(parent.signal, TIMEOUTS, timers);
  assert.equal(timers.pending, 2); // headers + ceiling
  upstream.headersReceived();
  assert.equal(timers.pending, 1);
  upstream.cancel();
  assert.equal(timers.pending, 0);
  // A read after the exchange is over must not re-arm anything.
  await upstream.read(async () => undefined);
  assert.equal(timers.pending, 0);
  // And a client leaving afterwards no longer reaches a finished call.
  parent.abort("late");
  assert.equal(upstream.signal.aborted, false);
});

test("real timers: a provider that never answers is stopped by the headers deadline", async () => {
  const upstream = createUpstreamAbort(new AbortController().signal, {
    headersMs: 15,
    idleMs: 15,
    ceilingMs: 60_000,
  });
  await sleep(35);
  assert.equal(upstreamTimeoutKind(upstream.signal), "headers");
  upstream.cancel();
});

test("the deadlines sit inside Node fetch's own 300s limits and the ceiling is generous", () => {
  const streamed = upstreamTimeoutsFor(true);
  assert.equal(streamed.headersMs, UPSTREAM_HEADERS_TIMEOUT_MS);
  assert.equal(streamed.idleMs, UPSTREAM_IDLE_TIMEOUT_MS);
  assert.equal(streamed.ceilingMs, UPSTREAM_CEILING_MS);
  // Above undici's headersTimeout/bodyTimeout, undici would fire first with an
  // opaque "terminated" rather than a timeout the proxy can name.
  assert.ok(UPSTREAM_HEADERS_TIMEOUT_MS < 300_000);
  assert.ok(UPSTREAM_IDLE_TIMEOUT_MS < 300_000);
  // The old fixed total was 240s; the ceiling is what replaces it, and it has
  // to let a long streamed turn finish.
  assert.ok(UPSTREAM_CEILING_MS >= 30 * 60_000);
  // Without streaming the headers ARE the answer, so they get the idle budget.
  assert.equal(upstreamTimeoutsFor(false).headersMs, UPSTREAM_IDLE_TIMEOUT_MS);
});
