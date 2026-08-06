import test from "node:test";
import assert from "node:assert/strict";
import {
  createUpstreamAbort,
  isUpstreamTimeout,
  readLimitedRequestBody,
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

test("upstream abort follows the client and has a bounded timeout", async () => {
  const parent = new AbortController();
  const upstream = createUpstreamAbort(parent.signal, 15);
  parent.abort("client_closed");
  assert.equal(upstream.signal.aborted, true);
  assert.equal(isUpstreamTimeout(upstream.signal), false);
  upstream.cancel();

  const timed = createUpstreamAbort(new AbortController().signal, 15);
  await sleep(35);
  assert.equal(isUpstreamTimeout(timed.signal), true);
  timed.cancel();
});
