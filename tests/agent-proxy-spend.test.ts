import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  UsageMeter,
  createUpstreamAbort,
  hasRepeatedKey,
  inspectAgentRequest,
  promptTextChars,
  providerWire,
  relayUpstreamBody,
  upstreamTimeoutKind,
  usageMeterFor,
  type AgentRequest,
  type MeteredUsage,
  type ProviderWire,
  type ProxyUsage,
  type RelayOutcome,
  type UpstreamTimers,
} from "@/lib/agent-proxy";
import { estimateGenerationCostUsd } from "@/lib/pricing";
import { resolveModel } from "@/lib/models";

/*
 * The proxy bills Juno Code from the provider's own usage as the response
 * streams past. These pin the things that can go wrong with that: reading the
 * wrong number (or none) out of a provider format, altering what the client
 * receives, billing an exchange zero times or twice, and forwarding a request
 * the proxy reads differently from the provider.
 */

const encoder = new TextEncoder();

/** Encode, then cut at every `size` bytes — through multi-byte characters too. */
function splitBytes(text: string, size: number): Uint8Array[] {
  const bytes = encoder.encode(text);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
  return chunks;
}

function metered(
  wire: ProviderWire,
  format: "sse" | "json",
  text: string,
  size: number,
  fast = false,
  promptChars = 0,
): MeteredUsage | null {
  const m = new UsageMeter(wire, format, fast, promptChars);
  for (const chunk of splitBytes(text, size)) m.observe(chunk);
  return m.finish();
}

/** The usage the provider reported; an estimate here fails the test. */
function meter(wire: ProviderWire, format: "sse" | "json", text: string, size: number, fast = false) {
  const result = metered(wire, format, text, size, fast);
  assert.equal(result?.estimated ?? false, false, "expected the provider's own usage, not the floor");
  return result?.usage ?? null;
}

/** An accepted request, or the test fails with the refusal. */
function accepted(wire: ProviderWire, raw: string): AgentRequest {
  const checked = inspectAgentRequest(wire, raw);
  assert.ok(checked.ok, checked.ok ? "" : `refused: ${checked.error}`);
  return checked.request;
}

function refused(wire: ProviderWire, raw: string): string {
  const checked = inspectAgentRequest(wire, raw);
  assert.equal(checked.ok, false, `expected a refusal for ${raw.slice(0, 120)}`);
  return checked.ok ? "" : checked.error;
}

/** What `recordSpend` would charge for this usage, in USD. */
function priced(model: string, usage: ProxyUsage): number {
  const info = resolveModel(model);
  assert.ok(info, `unknown model ${model}`);
  return estimateGenerationCostUsd(info, usage).costUsd;
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

test("Chat Completions: a stream that never reports usage is billed at the character floor, not free", () => {
  // A host that ignores include_usage, or a stream cut before its last chunk.
  const stream = sse([
    [null, { service_tier: "priority", choices: [{ index: 0, delta: { content: "Hello" } }], usage: null }],
    [null, { choices: [{ index: 0, delta: { reasoning_content: "why" } }], usage: null }],
    [null, "[DONE]"],
  ]);
  const result = metered("openai-chat", "sse", stream, 5, false, 8000);
  assert.deepEqual(result, {
    estimated: true,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      promptChars: 8000,
      completionChars: "Hello".length,
      reasoningChars: "why".length,
      // The served tier still decides the rate.
      fastMode: true,
    },
  });
});

test("the floor is the request's text and what streamed, priced at the model's own rates", () => {
  const usage = metered("openai-chat", "sse", sse([[null, { choices: [{ index: 0, delta: { content: "x".repeat(400) } }] }]]), 64, false, 40_000)!.usage;
  const info = resolveModel("openai:gpt-6-sol")!;
  const billed = estimateGenerationCostUsd(info, usage);
  // Four characters a token, as the chat route bills a partial generation.
  assert.equal(billed.promptTokens, 10_000);
  assert.equal(billed.completionTokens, 100);
  assert.ok(billed.costUsd > 0);
  assert.equal(billed.costUsd, estimateGenerationCostUsd(info, { promptTokens: 10_000, completionTokens: 100 }).costUsd);
});

test("reported usage never carries the prompt floor, so a fully cached prompt is not billed twice", () => {
  // Anthropic's input_tokens excludes cache reads and can be 0; the prompt
  // floor would then be filled in as fresh input on top of the cache read.
  const stream = sse([
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 0, cache_read_input_tokens: 90_000, output_tokens: 1 } } }],
    ["message_delta", { type: "message_delta", usage: { output_tokens: 50 } }],
  ]);
  const result = metered("anthropic", "sse", stream, 16, false, 360_000);
  assert.equal(result?.estimated, false);
  assert.equal(result?.usage.promptChars, undefined);
  assert.equal(result?.usage.cacheRead, 90_000);
});

test("an Anthropic stream cut before message_start is billed at the floor", () => {
  const result = metered("anthropic", "sse", "event: message_start\ndata: {\"type\":\"message_st", 7, true, 2_000);
  assert.equal(result?.estimated, true);
  assert.equal(result?.usage.promptChars, 2_000);
  assert.equal(result?.usage.fastMode, true);
});

test("a Responses stream cut before response.completed is billed at the floor", () => {
  const cut = sse([
    ["response.created", { type: "response.created", response: { object: "response", status: "in_progress", usage: null } }],
    ["response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", delta: "Plan" }],
    ["response.output_text.delta", { type: "response.output_text.delta", delta: "Answer" }],
  ]);
  const result = metered("openai-responses", "sse", cut, 11, false, 3_000);
  assert.deepEqual(result, {
    estimated: true,
    usage: { promptTokens: 0, completionTokens: 0, promptChars: 3_000, completionChars: 6, reasoningChars: 4, fastMode: false },
  });
});

test("a provider that refuses in-band before producing anything is not billed; one that fails after output is", () => {
  const refusedEarly = sse([[null, { error: { message: "content filtered", code: "1301" } }]]);
  assert.equal(metered("openai-chat", "sse", refusedEarly, 9, false, 5_000), null);
  const anthropicError = sse([["error", { type: "error", error: { type: "overloaded_error" } }]]);
  assert.equal(metered("anthropic", "sse", anthropicError, 9, false, 5_000), null);
  const failed = sse([["response.failed", { type: "response.failed", response: { object: "response", status: "failed", usage: null } }]]);
  assert.equal(metered("openai-responses", "sse", failed, 9, false, 5_000), null);

  const failedLate = sse([
    [null, { choices: [{ index: 0, delta: { content: "partial answer" } }] }],
    [null, { error: { message: "upstream reset" } }],
  ]);
  const late = metered("openai-chat", "sse", failedLate, 9, false, 5_000);
  assert.equal(late?.estimated, true);
  assert.equal(late?.usage.completionChars, "partial answer".length);
});

test("Chat Completions: every host's spelling of streamed text and reasoning counts toward the floor, once", () => {
  const stream = sse([
    [null, { choices: [{ index: 0, delta: { content: [{ type: "text", text: "ab" }, { type: "thinking", thinking: "cde" }] } }] }],
    [null, { choices: [{ index: 0, delta: { thought: "fgh" } }] }],
    [null, { choices: [{ index: 0, delta: { reasoning_details: [{ text: "ij" }, { text: "k" }] } }] }],
    // Both spellings of the same text: counted once, in the Mac decoder's order.
    [null, { choices: [{ index: 0, delta: { reasoning_content: "lmno", reasoning: "lmno" } }] }],
    [null, { choices: [{ index: 0, delta: { refusal: "no" } }] }],
  ]);
  const usage = metered("openai-chat", "sse", stream, 13, false, 1)!.usage;
  assert.equal(usage.completionChars, 2 + 2);
  assert.equal(usage.reasoningChars, 3 + 3 + 3 + 4);
});

test("answerComplete: a JSON answer always, a Chat stream once every choice has finished, nothing else", () => {
  assert.equal(new UsageMeter("anthropic", "json", false).answerComplete, true);
  assert.equal(new UsageMeter("anthropic", "sse", false).answerComplete, false);

  const chat = new UsageMeter("openai-chat", "sse", false);
  assert.equal(chat.answerComplete, false);
  chat.observe(encoder.encode(sse([[null, { choices: [{ index: 0, delta: { content: "a" } }, { index: 1, delta: { content: "b" } }] }]])));
  assert.equal(chat.answerComplete, false);
  chat.observe(encoder.encode(sse([[null, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]])));
  // Choice 1 is still generating.
  assert.equal(chat.answerComplete, false);
  chat.observe(encoder.encode(sse([[null, { choices: [{ index: 1, delta: {}, finish_reason: "length" }] }]])));
  assert.equal(chat.answerComplete, true);

  const responses = new UsageMeter("openai-responses", "sse", false);
  responses.observe(encoder.encode(RESPONSES_STREAM));
  assert.equal(responses.answerComplete, false);
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
  const result = m.finish();
  assert.equal(result?.estimated, false);
  assert.equal(result?.usage.promptTokens, 5);
  assert.equal(result?.usage.completionTokens, 6);
  // finish() is idempotent and the meter ignores anything after it.
  m.observe(encoder.encode('data: {"usage":{"prompt_tokens":999}}\n\n'));
  assert.deepEqual(m.finish(), result);
});

test("a meter is only made for a successful model response", () => {
  const request = { fastRequested: false, promptChars: 100 };
  const sseHeaders = new Headers({ "content-type": "text/event-stream; charset=utf-8" });
  const sseMeter = usageMeterFor("anthropic", { ok: true, headers: sseHeaders }, request);
  assert.equal(sseMeter?.format, "sse");
  const jsonMeter = usageMeterFor("openai-chat", { ok: true, headers: new Headers({ "content-type": "application/json" }) }, request);
  assert.equal(jsonMeter?.format, "json");
  // The request's text rides along for the floor.
  assert.equal(jsonMeter?.finish()?.usage.promptChars, 100);
  assert.equal(usageMeterFor("anthropic", { ok: false, headers: sseHeaders }, request), null);
  assert.equal(usageMeterFor("anthropic", { ok: true, headers: new Headers({ "content-type": "text/html" }) }, request), null);
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
  const request = accepted("openai-chat", raw);
  const sent = JSON.parse(request.body);
  assert.deepEqual(sent.stream_options, { include_usage: true });
  // Everything else is what the client sent.
  assert.deepEqual({ ...sent, stream_options: undefined }, { ...JSON.parse(raw), stream_options: undefined });
  assert.equal(request.model, "glm-5.2");
  assert.equal(request.streamed, true);
});

test("an explicit include_usage:false is overridden, other stream options kept", () => {
  const raw = JSON.stringify({ model: "gpt-6-sol", stream: true, stream_options: { include_usage: false, include_obfuscation: false } });
  const sent = JSON.parse(accepted("openai-chat", raw).body);
  assert.deepEqual(sent.stream_options, { include_usage: true, include_obfuscation: false });
});

test("every other body is forwarded byte for byte", () => {
  // Deliberately odd formatting: re-serialising would change it.
  const already = '{ "model":"gpt-6-sol",  "stream":true, "stream_options":{"include_usage":true}, "temperature":1.0 }';
  assert.equal(accepted("openai-chat", already).body, already);

  const unstreamed = '{"model":"gpt-6-sol","stream":false, "temperature":1.0}';
  assert.equal(accepted("openai-chat", unstreamed).body, unstreamed);
  const absent = '{"model":"gpt-6-sol", "temperature":1.0}';
  assert.equal(accepted("openai-chat", absent).streamed, false);

  const anthropic = '{"model":"claude-opus-5-5","stream":true,"speed":"fast", "max_tokens":1.0e3}';
  const a = accepted("anthropic", anthropic);
  assert.equal(a.body, anthropic);
  assert.equal(a.fastRequested, true);
  assert.equal(a.model, "claude-opus-5-5");

  const responses = '{"model":"gpt-6-sol-pro","stream":true,"service_tier":"priority","background":false,"store":false}';
  const r = accepted("openai-responses", responses);
  assert.equal(r.body, responses);
  assert.equal(r.fastRequested, true);
});

test("a body the proxy cannot read exactly as the provider will is refused, not forwarded", () => {
  // JSON.parse rejects these; a lax host (Python's json accepts NaN) would not.
  refused("openai-chat", '{"model": "x", "stream": tru');
  refused("openai-chat", '{"model":"glm-5.2","stream":true,"temperature":NaN}');
  refused("openai-chat", '[{"model":"glm-5.2","stream":true}]');
  refused("anthropic", '"just a string"');
  refused("anthropic", "");

  // A truthy `stream` that is not the boolean true would stream unmetered
  // from a host that coerces it, with no include_usage switched on.
  for (const stream of ["1", '"true"', "null", "{}", "0"]) {
    const error = refused("openai-chat", `{"model":"glm-5.2","stream":${stream},"messages":[]}`);
    assert.match(error, /stream/);
  }

  // No model, or not one: billing would price `<provider>:unknown`.
  for (const model of ['""', '"   "', "42", "null", '["gpt-6-sol"]', JSON.stringify("m".repeat(201))]) {
    const error = refused("openai-chat", `{"model":${model},"stream":true}`);
    assert.match(error, /model/);
  }
  refused("anthropic", '{"stream":true,"messages":[]}');
});

test("a key named twice is refused wherever it is, escaped spellings included", () => {
  // JSON.parse keeps the last model; a host that keeps the first serves another.
  refused("openai-chat", '{"model":"gpt-6-nano","model":"gpt-6-astra","stream":true}');
  refused("openai-chat", '{"model":"gpt-6-sol","stream":true,"stream":false}');
  refused("openai-chat", '{"model":"gpt-6-sol","mod\\u0065l":"gpt-6-astra","stream":true}');
  refused("openai-chat", '{"model":"gpt-6-sol","stream":true,"stream_options":{"include_usage":false,"include_usage":true}}');
  refused("anthropic", '{"model":"claude-opus-5-5","messages":[{"role":"user","content":[{"type":"text","text":"a","text":"b"}]}]}');
});

test("hasRepeatedKey reads keys, not text that looks like keys", () => {
  assert.equal(hasRepeatedKey('{"a":1,"b":{"a":2},"c":[{"a":3},{"a":4}]}'), false);
  assert.equal(hasRepeatedKey('{"a":"\\"a\\":1,","b":"{\\"a\\"","c":"\\\\","d":"}]["}'), false);
  assert.equal(hasRepeatedKey('{"text":"{\\"model\\":1, \\"model\\":2}","model":"x"}'), false);
  assert.equal(hasRepeatedKey('{"a":[1,{"b":1,"b":2}]}'), true);
  assert.equal(hasRepeatedKey('{"a":{},"a":{}}'), true);
  assert.equal(hasRepeatedKey('{"\\\\":1,"\\u005c":2}'), true);
  assert.equal(hasRepeatedKey("[]"), false);
});

test("Responses: background, stored responses and conversations are refused", () => {
  const base = { model: "gpt-6-astra", stream: true, store: false, input: [{ role: "user", content: "hi" }] };
  // Comes back `queued` with no usage while OpenAI runs the whole generation.
  for (const background of [true, "true", 1, null, {}]) {
    const error = refused("openai-responses", JSON.stringify({ ...base, background, reasoning: { effort: "xhigh" } }));
    assert.match(error, /[Bb]ackground/);
  }
  refused("openai-responses", JSON.stringify({ ...base, stream: false, background: true }));
  refused("openai-responses", JSON.stringify({ ...base, previous_response_id: "resp_abc" }));
  refused("openai-responses", JSON.stringify({ ...base, conversation: "conv_abc" }));
  refused("openai-responses", JSON.stringify({ ...base, conversation: { id: "conv_abc" } }));
  accepted("openai-responses", JSON.stringify({ ...base, background: false, previous_response_id: null }));
  // The other wires have no such thing, and are not second-guessed.
  accepted("openai-chat", JSON.stringify({ model: "glm-5.2", stream: true, background: true }));
});

test("the bodies Juno's own clients send are all accepted", () => {
  // BackendCodeModelClient's three builders, and agent-core's two adapters.
  accepted(
    "anthropic",
    JSON.stringify({
      model: "claude-opus-5-5",
      max_tokens: 128000,
      system: [{ type: "text", text: "You are Juno Code.", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "Fix the bug." }] }],
      stream: true,
      thinking: { type: "adaptive" },
      tools: [{ name: "read_file", description: "Read a file.", input_schema: { type: "object", properties: {} } }],
    }),
  );
  accepted(
    "openai-chat",
    JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "system", content: "You are Juno Code." }, { role: "user", content: "Fix the bug." }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 128000,
      tools: [{ type: "function", function: { name: "read_file", description: "Read.", parameters: { type: "object" } } }],
    }),
  );
  accepted(
    "openai-responses",
    JSON.stringify({
      model: "gpt-6-sol-pro",
      instructions: "You are Juno Code.",
      input: [{ role: "user", content: [{ type: "input_text", text: "Fix the bug." }] }],
      stream: true,
      store: false,
      max_output_tokens: 128000,
      reasoning: { effort: "high", summary: "detailed" },
    }),
  );
});

test("the prompt floor counts the text the model reads, and not image, file or opaque bytes", () => {
  const image = "iVBORw0KGgo".repeat(10_000);
  const anthropic = {
    model: "claude-opus-5-5",
    system: [{ type: "text", text: "SYSTEM" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: image } }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature: "S".repeat(5_000) },
          { type: "redacted_thinking", data: "R".repeat(5_000) },
          { type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "FILE CONTENTS" }] },
    ],
    tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" } }],
    max_tokens: 1000,
  };
  const count = promptTextChars("anthropic", anthropic);
  const text = ["SYSTEM", "look", "hmm", "a.ts", "FILE CONTENTS", "Read a file"].join("").length;
  // Plus the short structural strings (types, roles, ids, names, media type),
  // which the provider tokenises too; never the image or the opaque blobs.
  assert.ok(count >= text, `${count} >= ${text}`);
  assert.ok(count < text + 200, `${count} < ${text + 200}`);
  assert.equal(accepted("anthropic", JSON.stringify(anthropic)).promptChars, count);

  const chat = {
    model: "glm-5.2",
    messages: [
      { role: "user", content: [{ type: "text", text: "describe" }, { type: "image_url", image_url: { url: `data:image/png;base64,${image}` } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "run", arguments: '{"cmd":"ls"}' } }] },
    ],
  };
  assert.ok(promptTextChars("openai-chat", chat) < 200);

  const responses = {
    model: "gpt-6-sol-pro",
    instructions: "INSTR",
    input: [
      { role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${image}` }, { type: "input_file", file_data: image }] },
      { type: "reasoning", encrypted_content: "E".repeat(5_000) },
      { type: "function_call_output", call_id: "c1", output: "OUTPUT" },
    ],
  };
  assert.ok(promptTextChars("openai-responses", responses) < 200);
  // Fields outside the prompt (the model id, sampling settings) are not text the model reads.
  assert.equal(promptTextChars("openai-chat", { model: "m".repeat(150), messages: [] }), 0);
});

test("the prompt floor has no depth limit to hide text under", () => {
  const depth = 20_000;
  const nested = "[".repeat(depth) + JSON.stringify("T".repeat(1000)) + "]".repeat(depth);
  const raw = `{"model":"glm-5.2","stream":false,"messages":[{"role":"user","content":${nested}}]}`;
  const request = accepted("openai-chat", raw);
  assert.ok(request.promptChars >= 1000);
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
  billed: Array<MeteredUsage | null>;
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
  options: {
    idleMs?: number;
    parent?: AbortSignal;
    followsSignal?: boolean;
    format?: "sse" | "json";
    promptChars?: number;
  } = {},
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
  const m = new UsageMeter(wire, options.format ?? "sse", false, options.promptChars ?? 0);
  const endings: RelayOutcome[] = [];
  const billed: Array<MeteredUsage | null> = [];
  const stream = relayUpstreamBody({
    body: upstream,
    abort,
    observe: (chunk) => m.observe(chunk),
    answerComplete: () => m.answerComplete,
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
  assert.deepEqual(h.billed, [{ usage: ANTHROPIC_EXPECTED, estimated: false }]);
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
  assert.equal(h.billed[0]?.estimated, false);
  const usage = h.billed[0]?.usage;
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
    { parent: parent.signal, promptChars: 1200 },
  );
  const reader = h.stream.getReader();
  await reader.read();
  await tick();
  parent.abort("client_closed");
  await tick();
  // The request signal alone closes the client's side too: nothing waits on it.
  await assert.rejects(() => reader.read());
  await reader.cancel("client_closed").catch(() => undefined);
  assert.deepEqual(h.endings, ["cancelled"]);
  // OpenAI sends usage last, so a stream cut before it is billed at the floor.
  assert.equal(h.billed.length, 1);
  assert.equal(h.billed[0]?.estimated, true);
  assert.equal(h.billed[0]?.usage.promptChars, 1200);
  assert.equal(h.abort.signal.aborted, true);
  assert.equal(h.timers.pending, 0);
});

test("hanging up just before OpenAI's usage chunk no longer makes a call free", async () => {
  // The reviewer's case: a large prompt, an answer the client reads, then a
  // long tool call it hangs up on before the final usage chunk.
  const prompt = "Explain the whole codebase. ".repeat(4_000);
  const raw = JSON.stringify({ model: "gpt-6-sol", stream: true, messages: [{ role: "user", content: prompt }] });
  const request = accepted("openai-chat", raw);
  assert.equal(request.promptChars, prompt.length + "user".length);

  const answer = sse([[null, { choices: [{ index: 0, delta: { content: "A".repeat(2_000) } }] }]]);
  const toolStart = sse([[null, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "pad", arguments: '{"x":"' } }] } }] }]]);
  const h = harness(
    "openai-chat",
    (controller) => {
      controller.enqueue(encoder.encode(answer));
      controller.enqueue(encoder.encode(toolStart));
      // ...and the model goes on writing filler for as long as it is allowed.
    },
    // A body that ignores the fetch signal, so the cancel itself is seen arriving.
    { promptChars: request.promptChars, followsSignal: false },
  );
  const reader = h.stream.getReader();
  await reader.read();
  await reader.read();
  await tick();
  await reader.cancel("client_closed");
  await tick();

  assert.deepEqual(h.endings, ["cancelled"]);
  // Mid-generation, so the provider is stopped rather than drained.
  assert.equal(h.abort.signal.aborted, true);
  assert.equal(h.upstreamCancelled(), true);
  const billed = h.billed[0];
  assert.equal(billed?.estimated, true);
  assert.equal(billed?.usage.promptChars, request.promptChars);
  assert.equal(billed?.usage.completionChars, 2_000 + '{"x":"'.length);
  assert.ok(priced("openai:gpt-6-sol", billed!.usage) > 0);
  assert.equal(h.timers.pending, 0);
});

test("a non-streamed answer the client stops reading is read to its end and billed exactly", async () => {
  const body = JSON.stringify({
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "Z".repeat(5_000) } }],
    // Usage comes last, which is what a client that hangs up early would skip.
    usage: { prompt_tokens: 9_000, completion_tokens: 1_500, total_tokens: 10_500 },
  });
  const head = encoder.encode(body.slice(0, 3_000));
  const rest = encoder.encode(body.slice(3_000));
  const h = harness(
    "openai-chat",
    (controller) => {
      controller.enqueue(head);
      setTimeout(() => {
        controller.enqueue(rest);
        controller.close();
      }, 20);
    },
    { format: "json", promptChars: 36_000 },
  );
  const reader = h.stream.getReader();
  const first = await reader.read();
  assert.equal(first.value?.byteLength, head.byteLength);
  await tick(); // the relay's next read is now waiting on the provider
  await reader.cancel("client_closed");
  assert.deepEqual(h.endings, []);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(h.endings, ["cancelled"]);
  // The read in flight when the client left was taken over, not lost or
  // counted twice: the meter saw the whole body, usage and all.
  assert.deepEqual(h.billed, [
    {
      estimated: false,
      usage: {
        promptTokens: 9_000,
        completionTokens: 1_500,
        reasoningTokens: undefined,
        totalTokens: 10_500,
        cacheRead: undefined,
        cacheWrite: undefined,
        completionChars: undefined,
        reasoningChars: undefined,
        fastMode: false,
      },
    },
  ]);
  // The answer was already paid for; reading it cost nothing, and nothing was aborted.
  assert.equal(h.abort.signal.aborted, false);
  assert.equal(h.upstreamCancelled(), false);
  assert.equal(h.timers.pending, 0);
});

test("a Chat stream left after its finish_reason is read on for the usage chunk", async () => {
  const done = encoder.encode(
    sse([
      [null, { choices: [{ index: 0, delta: { content: "All done." } }] }],
      [null, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }],
    ]),
  );
  const usage = encoder.encode(
    sse([
      [null, { choices: [], usage: { prompt_tokens: 700, completion_tokens: 40, total_tokens: 740, completion_tokens_details: { reasoning_tokens: 30 } } }],
      [null, "[DONE]"],
    ]),
  );
  const parent = new AbortController();
  const h = harness(
    "openai-chat",
    (controller) => {
      controller.enqueue(done);
      setTimeout(() => {
        controller.enqueue(usage);
        controller.close();
      }, 20);
    },
    { parent: parent.signal, promptChars: 2_800 },
  );
  const reader = h.stream.getReader();
  await reader.read();
  await tick();
  // The request signal reports it first this time; same decision.
  parent.abort("client_closed");
  await reader.cancel("client_closed").catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(h.endings, ["cancelled"]);
  assert.equal(h.billed[0]?.estimated, false);
  // The hidden reasoning is in the bill, which the floor could never have seen.
  assert.equal(h.billed[0]?.usage.reasoningTokens, 30);
  assert.equal(h.billed[0]?.usage.promptTokens, 700);
  assert.equal(h.abort.signal.aborted, false);
  assert.equal(h.timers.pending, 0);
});

test("reading the rest after the client leaves is still bounded by the idle deadline", async () => {
  const h = harness(
    "anthropic",
    (controller) => controller.enqueue(encoder.encode('{"type":"message","content":[{"type":"text","text":"half')),
    { format: "json", idleMs: 25, promptChars: 4_000 },
  );
  const reader = h.stream.getReader();
  await reader.read();
  await tick();
  await reader.cancel("client_closed");
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(h.endings, ["cancelled"]);
  assert.equal(upstreamTimeoutKind(h.abort.signal), "idle");
  // The provider never finished the body, so the floor is what is billed.
  assert.equal(h.billed[0]?.estimated, true);
  assert.equal(h.billed[0]?.usage.promptChars, 4_000);
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
  assert.equal(h.billed[0]?.usage.promptTokens, 5000);
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
  assert.equal(h.billed[0]?.usage.promptTokens, 77);
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
  assert.deepEqual(h.billed, [{ usage: CHAT_EXPECTED, estimated: false }]);
});

// ---------------------------------------------------------------------------
// Who bills
// ---------------------------------------------------------------------------

test("the proxy is the one writer of Code spend for the calls it forwards", () => {
  const route = readFileSync(new URL("../src/app/api/agent/[...path]/route.ts", import.meta.url), "utf8");
  assert.match(route, /recordSpend\(\{ userId, model: spendModel, kind: "code", source, \.\.\.metered\.usage \}\)/);
  assert.match(route, /relayUpstreamBody\(/);
  assert.match(route, /answerComplete: meter \? \(\) => meter\.answerComplete : undefined/);
  // A body the proxy would read differently from the provider never leaves.
  assert.match(route, /if \(!checked\.ok\) return NextResponse\.json\(\{ error: checked\.error \}, \{ status: 400 \}\);/);
  assert.ok(route.indexOf("inspectAgentRequest(") < route.indexOf("await fetch(target"));
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
