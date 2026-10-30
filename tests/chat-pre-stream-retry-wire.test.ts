import Module, { createRequire } from "node:module";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import type { ModelInfo } from "@/lib/models";
import type { MessageForModel } from "@/types/llm";

/*
 * WHERE A REJECTION COMES FROM, AGAINST THE REAL SDKs (health discovery, gap 2).
 *
 * The one retry before the first byte (src/lib/chat/turn/pre-stream-retry.ts)
 * may only ask again when the provider refused the request itself: the
 * adapter's await on opening its first request threw (`markRequestRejected`).
 * A provider that answered 200 and began streaming has accepted the request
 * and started billing it, even when the socket then drops before the adapter
 * passes a single event on: Anthropic keeps `message_start` (with its input
 * usage) to itself, and the Responses adapter yields nothing for
 * `response.created`. That case must never be retried.
 *
 * Driven through the REAL `streamChat`, the real adapters and the real
 * @anthropic-ai/sdk and openai clients, against a local HTTP server standing
 * in for each provider. No provider is called and no key is used: the keys
 * below are placeholders, and fetch refuses any host but 127.0.0.1.
 */

const modules = Module as unknown as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const originalLoad = modules._load;
modules._load = function (name, parent, main) {
  return name === "server-only" ? {} : originalLoad.call(this, name, parent, main);
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith("http://127.0.0.1:")) throw new Error(`pre-stream retry wire test attempted network I/O to ${url}`);
  return realFetch(input, init);
}) as typeof fetch;

type Behaviour =
  /** HTTP 200 and the wire's opening events, then the socket is destroyed mid-body. */
  | { kind: "accept-then-reset" }
  /** An error status instead of a stream. */
  | { kind: "status"; status: number; body: unknown; headers?: Record<string, string> }
  /** The socket is closed before any response headers. */
  | { kind: "drop" };

const queue: Behaviour[] = [];
const hits: string[] = [];

function sse(event: string | null, data: unknown): string {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

/** The opening a provider sends once it has accepted the request. */
function opening(url: string): string {
  if (url.includes("/messages")) {
    return (
      sse("message_start", {
        type: "message_start",
        message: {
          id: "msg_wire",
          type: "message",
          role: "assistant",
          model: "wire",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12345, output_tokens: 1 },
        },
      }) + sse("ping", { type: "ping" })
    );
  }
  if (url.includes("/responses")) {
    const response = { id: "resp_wire", object: "response", status: "in_progress", output: [], usage: null };
    return (
      sse("response.created", { type: "response.created", sequence_number: 0, response }) +
      sse("response.in_progress", { type: "response.in_progress", sequence_number: 1, response }) +
      sse("response.output_item.added", {
        type: "response.output_item.added",
        sequence_number: 2,
        output_index: 0,
        item: { id: "rs_wire", type: "reasoning", summary: [] },
      })
    );
  }
  if (url.includes("streamGenerateContent")) {
    // A frame with no candidate text yet: accepted, nothing to pass on.
    return sse(null, { usageMetadata: { promptTokenCount: 12345 }, modelVersion: "wire" });
  }
  return sse(null, {
    id: "chatcmpl_wire",
    object: "chat.completion.chunk",
    created: 1,
    model: "wire",
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  });
}

const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    hits.push(`${req.method} ${(req.url ?? "").split("?")[0]}`);
    const behaviour = queue.shift() ?? { kind: "status", status: 500, body: { error: { message: "unscripted request" } } };
    if (behaviour.kind === "drop") {
      req.socket.destroy();
      return;
    }
    if (behaviour.kind === "status") {
      res.writeHead(behaviour.status, { "content-type": "application/json", ...(behaviour.headers ?? {}) });
      res.end(JSON.stringify(behaviour.body));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(opening(req.url ?? ""));
    setTimeout(() => req.socket.destroy(), 40);
  });
});

let streamChat: typeof import("@/lib/llm").streamChat;
let retry: typeof import("@/lib/chat/turn/pre-stream-retry");
let marks: typeof import("@/lib/provider-error");
const models: Record<"anthropic" | "anthropicFast" | "responses" | "compat" | "gemini", ModelInfo> = {} as never;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: "wire-test-placeholder",
    ANTHROPIC_BASE_URL: origin,
    OPENAI_API_KEY: "wire-test-placeholder",
    OPENAI_BASE_URL: `${origin}/v1`,
    DEEPSEEK_API_KEY: "wire-test-placeholder",
    DEEPSEEK_BASE_URL: `${origin}/v1`,
    GOOGLE_API_KEY: "wire-test-placeholder",
    GOOGLE_BASE_URL: `${origin}/v1beta`,
  });
  const require = createRequire(import.meta.url);
  ({ streamChat } = require("../src/lib/llm") as typeof import("@/lib/llm"));
  retry = require("../src/lib/chat/turn/pre-stream-retry") as typeof import("@/lib/chat/turn/pre-stream-retry");
  marks = require("../src/lib/provider-error") as typeof import("@/lib/provider-error");
  const { MODEL_LIST, getModel } = require("../src/lib/models") as typeof import("@/lib/models");
  const { providerAdapterFor } = require("../src/lib/provider-routing") as typeof import("@/lib/provider-routing");
  const chat = MODEL_LIST.filter((m) => m.modality === "chat" && !m.comingSoon);
  const pick = (test: (m: ModelInfo) => boolean, label: string) => {
    const found = chat.find(test);
    assert.ok(found, `a catalogue model for ${label}`);
    return found;
  };
  models.anthropic = pick((m) => providerAdapterFor(m) === "anthropic-native", "anthropic-native");
  models.anthropicFast = getModel("anthropic:claude-opus-5-5") ?? pick((m) => m.provider === "anthropic" && /opus-(4-8|5-5)/.test(m.providerModel), "anthropic fast mode");
  models.responses = pick((m) => m.provider === "openai" && providerAdapterFor(m) === "openai-responses", "openai-responses");
  models.compat = pick((m) => m.provider === "deepseek" && providerAdapterFor(m) === "openai-compatible", "openai-compatible");
  models.gemini = pick((m) => providerAdapterFor(m) === "gemini-native", "gemini-native");
});

after(() => {
  server.close();
  modules._load = originalLoad;
  globalThis.fetch = realFetch;
});

const HISTORY: MessageForModel[] = [{ role: "USER", content: "Hello?", attachments: [] }];

/** One model call as the turn makes it: counted, drained, and the error kept. */
async function attempt(model: ModelInfo, options: { fastMode?: boolean } = {}) {
  const counted = retry.countingStream(
    streamChat({ model, system: "wire test", history: HISTORY, maxTokens: 256, attempt: 1, fastMode: options.fastMode })
  );
  let error: unknown = null;
  try {
    for await (const event of counted.stream) void event;
  } catch (caught) {
    error = caught;
  }
  return { error, received: counted.received() };
}

function plan(error: unknown, received: number, auto: boolean) {
  return retry.planPreStreamRetry({
    err: error,
    attempt: 1,
    received: { events: received, output: false },
    cancelled: false,
    auto,
    tunables: { enabled: true, maxWaitMs: 8000 },
    random: () => 0.5,
  });
}

const WIRES = ["anthropic", "responses", "compat", "gemini"] as const;

test("a provider that answered 200 and began streaming, then dropped the socket: one request, never asked again", async () => {
  for (const wire of WIRES) {
    hits.length = 0;
    queue.push({ kind: "accept-then-reset" });
    const { error, received } = await attempt(models[wire]);
    assert.ok(error, `${wire}: the dropped stream fails the call`);
    assert.equal(received, 0, `${wire}: the adapter passed nothing on (the case the event count alone cannot see)`);
    assert.equal(marks.isModelCallError(error), true, `${wire}: streamChat marks it as the model call's`);
    assert.equal(marks.requestRejection(error), null, `${wire}: not a rejection: the provider had accepted the request`);
    for (const auto of [false, true]) {
      const verdict = plan(error, received, auto);
      assert.equal(verdict.retry, false, `${wire} (auto ${auto})`);
      if (!verdict.retry) assert.equal(verdict.why, "not_rejection", `${wire} (auto ${auto})`);
    }
    assert.equal(hits.length, 1, `${wire}: exactly one provider request`);
  }
});

test("a status instead of a stream is a rejection of the first request: a 429 with its wait is retried once", async () => {
  for (const wire of ["anthropic", "responses", "compat"] as const) {
    hits.length = 0;
    queue.push({
      kind: "status",
      status: 429,
      headers: { "retry-after": "1" },
      body: wire === "anthropic" ? { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } } : { error: { message: "Rate limit reached", type: "requests" } },
    });
    const { error, received } = await attempt(models[wire]);
    assert.equal(received, 0);
    assert.deepEqual(marks.requestRejection(error), { adapterRetried: false }, `${wire}: marked where the request was opened`);
    const verdict = plan(error, received, false);
    assert.ok(verdict.retry, `${wire}: retried`);
    if (verdict.retry) {
      assert.equal(verdict.class, "rate_limit");
      assert.equal(verdict.retryAfterMs, 1000, `${wire}: the provider's wait`);
      assert.equal(verdict.sameModel?.delayMs, 1125);
    }
    assert.equal(hits.length, 1, `${wire}: the SDK did not replay it (maxRetries 0)`);
  }
  // Gemini's own network layer retries its transient faults; a status it does
  // not retry is marked the same way.
  hits.length = 0;
  queue.push({ kind: "status", status: 403, body: { error: { code: 403, message: "Permission denied", status: "PERMISSION_DENIED" } } });
  const gemini = await attempt(models.gemini);
  assert.ok(marks.requestRejection(gemini.error), "gemini: marked where the request was opened");
  assert.equal(hits.length, 1);
});

test("a socket closed before any response headers is a failed connection: retried", async () => {
  for (const wire of ["anthropic", "responses", "compat"] as const) {
    hits.length = 0;
    queue.push({ kind: "drop" });
    const { error, received } = await attempt(models[wire]);
    assert.ok(marks.requestRejection(error), `${wire}: thrown by the request's opening`);
    const verdict = plan(error, received, false);
    assert.ok(verdict.retry && verdict.class === "network" && verdict.sameModel, `${wire}: ${JSON.stringify(verdict)}`);
    assert.equal(hits.length, 1);
  }
});

test("a lab's safety refusal sent as a 403 is never moved to another lab under Auto", async () => {
  hits.length = 0;
  // xAI-style body: `error` is a bare string, which the openai SDK quotes into the message.
  queue.push({
    kind: "status",
    status: 403,
    body: { code: "The caller does not have permission to execute the specified operation", error: "Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_BIO" },
  });
  const { error, received } = await attempt(models.compat);
  assert.ok(marks.requestRejection(error));
  assert.equal(marks.classifyProviderError(error).class, "auth", "the classifier alone would call it an account fault");
  assert.deepEqual(plan(error, received, true), { retry: false, why: "class", class: "content_filter" });
  assert.equal(hits.length, 1);
});

test("Anthropic's in-adapter fast-mode fallback counts as the same model's second ask", async () => {
  hits.length = 0;
  queue.push(
    { kind: "status", status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "Fast mode is not available for this organization" } } },
    { kind: "status", status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } } },
  );
  const { error, received } = await attempt(models.anthropicFast, { fastMode: true });
  assert.equal(hits.length, 2, "fast, then the adapter's own standard-speed fallback");
  assert.deepEqual(marks.requestRejection(error), { adapterRetried: true });
  assert.deepEqual(plan(error, received, false), { retry: false, why: "class", class: "rate_limit" }, "no third request to the same model");
  const auto = plan(error, received, true);
  assert.ok(auto.retry && auto.sameModel === null && auto.nextModel, "Auto may still ask its next candidate once");
});
