import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  UsageMeter,
  createUpstreamAbort,
  inspectAgentRequest,
  providerWire,
  relayUpstreamBody,
  upstreamTimeoutKind,
  usageMeterFor,
  type ProviderWire,
  type ProxyUsage,
  type RelayOutcome,
  type UpstreamTimers,
} from "@/lib/agent-proxy";

/*
 * The proxy bills Juno Code from the provider's own usage as the response
 * streams past. These pin the three things that can go wrong with that: reading
 * the wrong number (or none) out of a provider format, altering what the client
 * receives, and billing an exchange zero times or twice.
 */

const encoder = new TextEncoder();

/** Encode, then cut at every `size` bytes — through multi-byte characters too. */
function splitBytes(text: string, size: number): Uint8Array[] {
  const bytes = encoder.encode(text);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
  return chunks;
}

function meter(wire: ProviderWire, format: "sse" | "json", text: string, size: number, fast = false) {
  const m = new UsageMeter(wire, format, fast);
  for (const chunk of splitBytes(text, size)) m.observe(chunk);
  return m.finish();
}

function sse(events: Array<[string | null, unknown]>, newline = "\n"): string {
  return events
    .map(([name, data]) => {
      const lines = name ? [`event: ${name}`] : [];
      lines.push(`data: ${typeof data === "string" ? data : JSON.stringify(data)}`);
      return lines.join(newline) + newline + newline;
    })
    .join("");
}

const ANTHROPIC_STREAM = sse([
  [
    "message_start",
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        usage: {
          input_tokens: 12,
          cache_creation_input_tokens: 3000,
          cache_read_input_tokens: 45000,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3000 },
          output_tokens: 1,
        },
      },
    },
  ],
  ["ping", { type: "ping" }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think" } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Héllo wörld ✓ 日本" } }],
  ["content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"path\":" } }],
  // A late delta that carries ONLY output must not wipe input and cache.
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 842 } }],
  ["message_stop", { type: "message_stop" }],
]);

const ANTHROPIC_EXPECTED: ProxyUsage = {
  promptTokens: 12,
  completionTokens: 842,
  reasoningTokens: undefined,
  cacheRead: 45000,
  cacheWrite: 3000,
  cacheWrite5m: undefined,
  cacheWrite1h: 3000,
  webSearchRequests: undefined,
  completionChars: "Héllo wörld ✓ 日本".length + "{\"path\":".length,
  reasoningChars: "Let me think".length,
  fastMode: false,
};

const CHAT_STREAM = sse([
  [null, { id: "c1", object: "chat.completion.chunk", service_tier: "priority", choices: [{ index: 0, delta: { role: "assistant", content: "Hi" } }], usage: null }],
  [null, { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { reasoning_content: "hmm" } }], usage: null }],
  [null, { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"a\":1}" } }] } }], usage: null }],
  [null, { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: null }],
  [
    null,
    {
      id: "c1",
      object: "chat.completion.chunk",
      service_tier: "priority",
      choices: [],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 300,
        total_tokens: 1500,
        prompt_tokens_details: { cached_tokens: 1024 },
        completion_tokens_details: { reasoning_tokens: 200 },
      },
    },
  ],
  [null, "[DONE]"],
]);

const CHAT_EXPECTED: ProxyUsage = {
  promptTokens: 1200,
  completionTokens: 300,
  reasoningTokens: 200,
  totalTokens: 1500,
  cacheRead: 1024,
  cacheWrite: undefined,
  completionChars: "Hi".length + "{\"a\":1}".length,
  reasoningChars: "hmm".length,
  fastMode: true,
};

const RESPONSES_STREAM = sse([
  ["response.created", { type: "response.created", response: { id: "r1", object: "response", status: "in_progress", usage: null } }],
  ["response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", delta: "Thinking…" }],
  ["response.output_text.delta", { type: "response.output_text.delta", delta: "Done." }],
  [
    "response.completed",
    {
      type: "response.completed",
      response: {
        id: "r1",
        object: "response",
        status: "completed",
        service_tier: "default",
        output: [{ type: "web_search_call" }, { type: "reasoning" }, { type: "message" }],
        usage: {
          input_tokens: 5000,
          input_tokens_details: { cached_tokens: 4096 },
          output_tokens: 900,
          output_tokens_details: { reasoning_tokens: 700 },
          total_tokens: 5900,
        },
      },
    },
  ],
]);

const RESPONSES_EXPECTED: ProxyUsage = {
  promptTokens: 5000,
  completionTokens: 900,
  reasoningTokens: 700,
  totalTokens: 5900,
  cacheRead: 4096,
  cacheWrite: undefined,
  webSearchRequests: 1,
  completionChars: "Done.".length,
  reasoningChars: "Thinking…".length,
  // Priority was asked for (below) and the provider says it served default:
  // what it served is what is billed.
  fastMode: false,
};

// ---------------------------------------------------------------------------
// Reading usage
// ---------------------------------------------------------------------------

test("Anthropic: input and cache from message_start, output from message_delta, at every split", () => {
  for (const size of [1, 2, 3, 5, 7, 13, 64, 4096]) {
    assert.deepEqual(meter("anthropic", "sse", ANTHROPIC_STREAM, size), ANTHROPIC_EXPECTED, `split ${size}`);
  }
});

test("CRLF line endings, including a CR and its LF in different chunks", () => {
  const crlf = ANTHROPIC_STREAM.replace(/\n/g, "\r\n");
  for (const size of [1, 2, 3, 64]) {
    assert.deepEqual(meter("anthropic", "sse", crlf, size), ANTHROPIC_EXPECTED, `split ${size}`);
  }
});

test("Anthropic fast mode: the provider's reported speed outranks the request", () => {
  const stream = sse([
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1, speed: "standard" } } }],
    ["message_delta", { type: "message_delta", usage: { output_tokens: 5 } }],
  ]);
  assert.equal(meter("anthropic", "sse", stream, 16, true)?.fastMode, false);
  const unreported = sse([["message_delta", { type: "message_delta", usage: { input_tokens: 10, output_tokens: 5 } }]]);
  assert.equal(meter("anthropic", "sse", unreported, 16, true)?.fastMode, true);
  assert.equal(meter("anthropic", "sse", unreported, 16, false)?.fastMode, false);
});

test("Chat Completions: the final usage chunk, cached and reasoning tokens, and the served tier", () => {
  for (const size of [1, 3, 17, 4096]) {
    assert.deepEqual(meter("openai-chat", "sse", CHAT_STREAM, size), CHAT_EXPECTED, `split ${size}`);
  }
});

test("Chat Completions: DeepSeek's cache-hit dialect prices as a cache read", () => {
  const stream = sse([
    [null, { choices: [], usage: { prompt_tokens: 900, completion_tokens: 10, total_tokens: 910, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 100 } }],
    [null, "[DONE]"],
  ]);
  const usage = meter("openai-chat", "sse", stream, 8);
  assert.equal(usage?.cacheRead, 800);
  // A miss is the uncached remainder of prompt_tokens, not a write.
  assert.equal(usage?.cacheWrite, undefined);
});

test("Chat Completions: a stream with no usage chunk bills nothing rather than guessing", () => {
  const stream = sse([
    [null, { choices: [{ index: 0, delta: { content: "Hello" } }], usage: null }],
    [null, "[DONE]"],
  ]);
  assert.equal(meter("openai-chat", "sse", stream, 5), null);
});

test("Responses: response.completed carries the call's usage", () => {
  for (const size of [1, 4, 33, 4096]) {
    assert.deepEqual(meter("openai-responses", "sse", RESPONSES_STREAM, size, true), RESPONSES_EXPECTED, `split ${size}`);
  }
});

test("Responses: an incomplete response is billed too", () => {
  const stream = sse([
    [
      "response.incomplete",
      {
        type: "response.incomplete",
        response: { object: "response", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 100, output_tokens: 4000, total_tokens: 4100 } },
      },
    ],
  ]);
  const usage = meter("openai-responses", "sse", stream, 9);
  assert.equal(usage?.promptTokens, 100);
  assert.equal(usage?.completionTokens, 4000);
});

test("non-streamed JSON bodies, for each provider format", () => {
  const anthropic = JSON.stringify({
    id: "msg",
    type: "message",
    content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 },
  });
  const a = meter("anthropic", "json", anthropic, 6);
  assert.equal(a?.promptTokens, 10);
  assert.equal(a?.completionTokens, 20);
  assert.equal(a?.cacheRead, 5);
  assert.equal(a?.cacheWrite, 7);

  const chat = JSON.stringify({
    object: "chat.completion",
    service_tier: "default",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
    usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48, prompt_tokens_details: { cached_tokens: 32 } },
  });
  const c = meter("openai-chat", "json", chat, 6);
  assert.equal(c?.promptTokens, 40);
  assert.equal(c?.cacheRead, 32);
  assert.equal(c?.fastMode, false);

  const responses = JSON.stringify({
    object: "response",
    service_tier: "priority",
    output: [],
    usage: { input_tokens: 70, output_tokens: 30, total_tokens: 100, input_tokens_details: { cache_write_tokens: 50 } },
  });
  const r = meter("openai-responses", "json", responses, 6);
  assert.equal(r?.promptTokens, 70);
  assert.equal(r?.cacheWrite, 50);
  assert.equal(r?.fastMode, true);
});

test("an event the stream ends without a blank line after is still read", () => {
  const stream = `data: ${JSON.stringify({ type: "message_delta", usage: { input_tokens: 3, output_tokens: 4 } })}`;
  assert.equal(meter("anthropic", "sse", stream, 5)?.completionTokens, 4);
});

test("comments, unknown fields, multi-line data and garbage never throw", () => {
  const m = new UsageMeter("openai-chat", "sse", false);
  const text =
    ": keep-alive\n\nretry: 1000\nid: 7\ndata: {not json}\n\n" +
    // One JSON object split over two data lines, which the spec joins with \n.
    'data: {"choices":[],\ndata: "usage":{"prompt_tokens":5,"completion_tokens":6,"total_tokens":11}}\n\n';
  for (const chunk of splitBytes(text, 3)) m.observe(chunk);
  m.observe(new Uint8Array([0xff, 0xfe, 0x00, 0x0a, 0x0a]));
  const usage = m.finish();
  assert.equal(usage?.promptTokens, 5);
  assert.equal(usage?.completionTokens, 6);
  // finish() is idempotent and the meter ignores anything after it.
  m.observe(encoder.encode('data: {"usage":{"prompt_tokens":999}}\n\n'));
  assert.deepEqual(m.finish(), usage);
});

test("a meter is only made for a successful model response", () => {
  const sseHeaders = new Headers({ "content-type": "text/event-stream; charset=utf-8" });
  assert.ok(usageMeterFor("anthropic", { ok: true, headers: sseHeaders }, false));
  assert.ok(usageMeterFor("openai-chat", { ok: true, headers: new Headers({ "content-type": "application/json" }) }, false));
  assert.equal(usageMeterFor("anthropic", { ok: false, headers: sseHeaders }, false), null);
  assert.equal(usageMeterFor("anthropic", { ok: true, headers: new Headers({ "content-type": "text/html" }) }, false), null);
});

// ---------------------------------------------------------------------------
// The request body
// ---------------------------------------------------------------------------

test("each allowed path maps to its wire format", () => {
  assert.equal(providerWire("anthropic", "v1/messages"), "anthropic");
  assert.equal(providerWire("openai", "chat/completions"), "openai-chat");
  assert.equal(providerWire("openai", "responses"), "openai-responses");
  assert.equal(providerWire("anthropic", "chat/completions"), null);
});

test("include_usage is switched on for a streamed Chat Completions call that lacks it", () => {
  const raw = JSON.stringify({ model: "glm-5.2", stream: true, messages: [{ role: "user", content: "hi" }], max_tokens: 64 });
  const request = inspectAgentRequest("openai-chat", raw);
  const sent = JSON.parse(request.body);
  assert.deepEqual(sent.stream_options, { include_usage: true });
  // Everything else is what the client sent.
  assert.deepEqual({ ...sent, stream_options: undefined }, { ...JSON.parse(raw), stream_options: undefined });
  assert.equal(request.model, "glm-5.2");
  assert.equal(request.streamed, true);
});

test("an explicit include_usage:false is overridden, other stream options kept", () => {
  const raw = JSON.stringify({ model: "gpt-6-sol", stream: true, stream_options: { include_usage: false, include_obfuscation: false } });
  const sent = JSON.parse(inspectAgentRequest("openai-chat", raw).body);
  assert.deepEqual(sent.stream_options, { include_usage: true, include_obfuscation: false });
});

test("every other body is forwarded byte for byte", () => {
  // Deliberately odd formatting: re-serialising would change it.
  const already = '{ "model":"gpt-6-sol",  "stream":true, "stream_options":{"include_usage":true}, "temperature":1.0 }';
  assert.equal(inspectAgentRequest("openai-chat", already).body, already);

  const unstreamed = '{"model":"gpt-6-sol","stream":false, "temperature":1.0}';
  assert.equal(inspectAgentRequest("openai-chat", unstreamed).body, unstreamed);

  const anthropic = '{"model":"claude-opus-5-5","stream":true,"speed":"fast", "max_tokens":1.0e3}';
  const a = inspectAgentRequest("anthropic", anthropic);
  assert.equal(a.body, anthropic);
  assert.equal(a.fastRequested, true);
  assert.equal(a.model, "claude-opus-5-5");

  const responses = '{"model":"gpt-6-sol-pro","stream":true,"service_tier":"priority"}';
  const r = inspectAgentRequest("openai-responses", responses);
  assert.equal(r.body, responses);
  assert.equal(r.fastRequested, true);

  const broken = '{"model": "x", "stream": tru';
  const b = inspectAgentRequest("openai-chat", broken);
  assert.equal(b.body, broken);
  assert.equal(b.model, null);
});

// ---------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------

/** Real timers, counted, so a test can prove none outlives the exchange. */
function countingTimers(): UpstreamTimers & { readonly pending: number } {
  const live = new Set<unknown>();
  return {
    set(callback, ms) {
      const handle = setTimeout(() => {
        live.delete(handle);
        callback();
      }, ms);
      live.add(handle);
      return handle;
    },
    clear(handle) {
      live.delete(handle);
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    get pending() {
      return live.size;
    },
  };
}

interface Harness {
  stream: ReadableStream<Uint8Array>;
  endings: RelayOutcome[];
  billed: Array<ProxyUsage | null>;
  abort: ReturnType<typeof createUpstreamAbort>;
  timers: ReturnType<typeof countingTimers>;
  upstreamCancelled: () => boolean;
}

/**
 * The route's wiring, minus the fetch: an upstream body the test scripts, the
 * deadlines, a meter, and an onEnd that "bills" into an array.
 */
function harness(
  wire: ProviderWire,
  script: (controller: ReadableStreamDefaultController<Uint8Array>, signal: AbortSignal) => void,
  options: { idleMs?: number; parent?: AbortSignal; followsSignal?: boolean } = {},
): Harness {
  const timers = countingTimers();
  const abort = createUpstreamAbort(
    options.parent ?? new AbortController().signal,
    { headersMs: 5_000, idleMs: options.idleMs ?? 5_000, ceilingMs: 60_000 },
    timers,
  );
  abort.headersReceived();
  let cancelled = false;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Like undici: aborting the fetch errors the body it is reading.
      if (options.followsSignal !== false) {
        abort.signal.addEventListener("abort", () => {
          try {
            controller.error(abort.signal.reason);
          } catch {
            // already closed
          }
        });
      }
      script(controller, abort.signal);
    },
    cancel() {
      cancelled = true;
    },
  });
  const m = new UsageMeter(wire, "sse", false);
  const endings: RelayOutcome[] = [];
  const billed: Array<ProxyUsage | null> = [];
  const stream = relayUpstreamBody({
    body: upstream,
    abort,
    observe: (chunk) => m.observe(chunk),
    onEnd: (outcome) => {
      endings.push(outcome);
      billed.push(m.finish());
    },
  });
  return { stream, endings, billed, abort, timers, upstreamCancelled: () => cancelled };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("the client receives the provider's bytes unchanged, and the call is billed once", async () => {
  const chunks = splitBytes(ANTHROPIC_STREAM, 7);
  const h = harness("anthropic", (controller) => {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  });
  const received = await readAll(h.stream);
  assert.deepEqual(received, encoder.encode(ANTHROPIC_STREAM));
  assert.deepEqual(h.endings, ["completed"]);
  assert.deepEqual(h.billed, [ANTHROPIC_EXPECTED]);
  assert.equal(h.timers.pending, 0);
  // Nothing after the ending can bill it again.
  await h.stream.cancel("late").catch(() => undefined);
  assert.equal(h.endings.length, 1);
});

test("a client that leaves mid-stream is billed what the provider reported, once, and the provider is stopped", async () => {
  const start = encoder.encode(
    sse([["message_start", { type: "message_start", message: { usage: { input_tokens: 2000, cache_read_input_tokens: 500, output_tokens: 1 } } }]]),
  );
  const delta = encoder.encode(
    sse([["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x".repeat(400) } }]]),
  );
  const parent = new AbortController();
  const h = harness(
    "anthropic",
    (controller) => {
      controller.enqueue(start);
      controller.enqueue(delta);
      // ...and then the provider keeps generating for nobody, until stopped.
    },
    { parent: parent.signal },
  );
  const reader = h.stream.getReader();
  await reader.read();
  await reader.read();
  await tick(); // the relay is now waiting on the provider
  // Next.js cancels the body AND aborts req.signal when the socket closes;
  // both paths firing must still bill exactly once.
  await reader.cancel("client_closed");
  parent.abort("client_closed");
  await tick();

  assert.deepEqual(h.endings, ["cancelled"]);
  assert.equal(h.billed.length, 1);
  const usage = h.billed[0];
  assert.equal(usage?.promptTokens, 2000);
  assert.equal(usage?.cacheRead, 500);
  // No final count arrived, so the streamed text is the output floor.
  assert.equal(usage?.completionChars, 400);
  assert.equal(h.abort.signal.aborted, true);
  assert.equal(h.timers.pending, 0);
});

test("leaving cancels the provider's body through the reader that holds its lock", async () => {
  // The old relay called `upstream.body.cancel()` while its own reader held the
  // lock; that rejects, the rejection was swallowed, and the provider went on
  // generating for nobody. A body that ignores the fetch signal proves the
  // cancel itself now arrives.
  const h = harness(
    "anthropic",
    (controller) => controller.enqueue(encoder.encode(ANTHROPIC_STREAM.slice(0, 30))),
    { followsSignal: false },
  );
  const reader = h.stream.getReader();
  await reader.read();
  await tick();
  await reader.cancel("client_closed");
  await tick();
  assert.equal(h.upstreamCancelled(), true);
  assert.deepEqual(h.endings, ["cancelled"]);
  assert.equal(h.timers.pending, 0);
});

test("the client abort arriving first is the same single ending", async () => {
  const parent = new AbortController();
  const h = harness(
    "openai-chat",
    (controller) => controller.enqueue(encoder.encode(CHAT_STREAM.slice(0, 40))),
    { parent: parent.signal },
  );
  const reader = h.stream.getReader();
  await reader.read();
  await tick();
  parent.abort("client_closed");
  await tick();
  await reader.cancel("client_closed").catch(() => undefined);
  assert.deepEqual(h.endings, ["cancelled"]);
  // OpenAI sends usage last: a stream cut before it is not billed on a guess.
  assert.deepEqual(h.billed, [null]);
  assert.equal(h.timers.pending, 0);
});

test("a provider that errors mid-stream ends once, billed for what it reported", async () => {
  const h = harness("openai-responses", (controller) => {
    controller.enqueue(encoder.encode(RESPONSES_STREAM));
    // Later, not at once: erroring a stream discards what is still queued.
    setTimeout(() => controller.error(new Error("socket hang up")), 10);
  });
  const reader = h.stream.getReader();
  await reader.read();
  await assert.rejects(async () => {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  });
  assert.deepEqual(h.endings, ["failed"]);
  assert.equal(h.billed[0]?.promptTokens, 5000);
  assert.equal(h.timers.pending, 0);
});

test("a provider that goes silent mid-stream is cut by the idle deadline, not by the clock", async () => {
  const h = harness(
    "anthropic",
    (controller) => {
      controller.enqueue(
        encoder.encode(sse([["message_start", { type: "message_start", message: { usage: { input_tokens: 77, output_tokens: 1 } } }]])),
      );
    },
    { idleMs: 25 },
  );
  const reader = h.stream.getReader();
  await reader.read();
  await assert.rejects(() => reader.read());
  assert.equal(upstreamTimeoutKind(h.abort.signal), "idle");
  assert.deepEqual(h.endings, ["failed"]);
  assert.equal(h.billed[0]?.promptTokens, 77);
  assert.equal(h.timers.pending, 0);
});

test("a stream that keeps talking outlives the idle deadline many times over", async () => {
  const pieces = splitBytes(CHAT_STREAM, 50);
  const h = harness(
    "openai-chat",
    (controller) => {
      let i = 0;
      const next = () => {
        if (i < pieces.length) {
          controller.enqueue(pieces[i++]);
          setTimeout(next, 8);
        } else {
          controller.close();
        }
      };
      next();
    },
    { idleMs: 30 },
  );
  const received = await readAll(h.stream);
  // Far longer in total than the 30ms idle limit, and never cut.
  assert.ok(pieces.length * 8 > 90);
  assert.deepEqual(received, encoder.encode(CHAT_STREAM));
  assert.deepEqual(h.endings, ["completed"]);
  assert.deepEqual(h.billed, [CHAT_EXPECTED]);
});

// ---------------------------------------------------------------------------
// Who bills
// ---------------------------------------------------------------------------

test("the proxy is the one writer of Code spend for the calls it forwards", () => {
  const route = readFileSync(new URL("../src/app/api/agent/[...path]/route.ts", import.meta.url), "utf8");
  assert.match(route, /recordSpend\(\{ userId, model: spendModel, kind: "code", source, \.\.\.usage \}\)/);
  assert.match(route, /relayUpstreamBody\(/);
  assert.match(route, /upstreamTimeoutsFor\(request\.streamed\)/);
  // The fixed total is gone, and so is the Vercel-only directive that implied one.
  assert.doesNotMatch(route, /UPSTREAM_TIMEOUT_MS/);
  assert.doesNotMatch(route, /export const maxDuration/);
  // The existing gates are untouched.
  assert.match(route, /checkBudget\(user\.id, plan\)/);
  assert.match(route, /checkUsageWindows\(user\.id, plan\)/);
  assert.match(route, /rateLimit\(\{ key: `agent:\$\{user\.id\}`, limit: 120, windowSec: 60 \}\)/);

  // `/api/agent/usage` settles a turn whose calls the proxy already billed, so
  // a ledger row there would charge them twice.
  const usage = readFileSync(new URL("../src/app/api/agent/usage/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(usage, /recordSpend\(/);
  assert.match(usage, /recordTokens\(/);
});
