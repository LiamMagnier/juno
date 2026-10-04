import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { createToolLoop } from "@/lib/tools/loop";
import { getModel, type ModelInfo } from "@/lib/models";
import type { LlmEvent, MessageForModel } from "@/types/llm";
import { fakeTurnToolset, scripted, sseResponse, type FakeToolset } from "./fixtures/tool-loop";

/*
 * V5/V6 acceptance for the tool contract, offline, for all four adapters
 * (TOOL_RUNTIME_DESIGN §7 L1): each adapter is driven end to end through its
 * transport seam with a scripted provider stream, and the requests it sends
 * back are inspected. Per adapter:
 *
 *   - parallel calls in one response are all dispatched and answered in call
 *     order, in ONE follow-up, each paired with the provider's own id;
 *   - invalid JSON and schema violations come back as error results and the
 *     executor is never reached; an unknown tool name is refused;
 *   - Stop mid-batch answers every outstanding call `cancelled`;
 *   - the Alevr call id is stable across a replayed round;
 *   - Gemini sends `functionResponse.id` when (and only when) the model gave one.
 *
 * The adapters are `server-only`; the marker is stubbed so the real modules
 * run, and no SDK client or API key is ever constructed (the transport is).
 */

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const { streamAnthropic } = req("../src/lib/anthropic") as typeof import("@/lib/anthropic");
const { streamOpenAICompat } = req("../src/lib/openai-compat") as typeof import("@/lib/openai-compat");
const { streamOpenAIResponses } = req("../src/lib/openai-responses") as typeof import("@/lib/openai-responses");
const { streamGemini } = req("../src/lib/gemini") as typeof import("@/lib/gemini");

const HISTORY: MessageForModel[] = [{ role: "USER", content: "Look these up.", attachments: [] }];

function model(id: string): ModelInfo {
  const found = getModel(id);
  assert.ok(found, `${id} is in the catalog`);
  return found;
}

async function collect(gen: AsyncGenerator<LlmEvent>): Promise<{ events: LlmEvent[]; error: unknown }> {
  const events: LlmEvent[] = [];
  try {
    for await (const event of gen) events.push(event);
    return { events, error: null };
  } catch (error) {
    return { events, error };
  }
}

const toolResults = (events: LlmEvent[]) =>
  events.filter((e): e is Extract<LlmEvent, { type: "tool"; phase: "result" }> => e.type === "tool" && e.phase === "result");
const toolCalls = (events: LlmEvent[]) =>
  events.filter((e): e is Extract<LlmEvent, { type: "tool"; phase: "call" }> => e.type === "tool" && e.phase === "call");

/** Snapshot of a request body as it was sent (the adapters keep mutating their arrays). */
const snapshot = <T>(value: T): T => structuredClone(value);

function assertValidationOutcomes(toolset: FakeToolset, events: LlmEvent[]) {
  // Only the two valid lookups ran; the malformed, invalid and unknown calls never reached an executor.
  assert.deepEqual(
    toolset.dispatched.map((d) => [d.name, d.args.q]),
    [
      ["lookup", "alpha"],
      ["lookup", "beta"],
    ],
  );
  const results = toolResults(events);
  assert.equal(results.length, 5, "every call is answered");
  const byCode = results.map((r) => (r.ok ? "ok" : r.error?.code));
  assert.deepEqual(byCode, ["ok", "ok", "invalid_args", "invalid_args", "unknown_tool"]);
}

// ── Anthropic ────────────────────────────────────────────────────────────────

type AnthropicEvent = Anthropic.RawMessageStreamEvent;

const aStart = (input = 10): AnthropicEvent =>
  ({ type: "message_start", message: { usage: { input_tokens: input, output_tokens: 1 } } }) as unknown as AnthropicEvent;
const aToolUse = (index: number, id: string, name: string, json: string): AnthropicEvent[] => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } } as unknown as AnthropicEvent,
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json } } as unknown as AnthropicEvent,
  { type: "content_block_stop", index } as unknown as AnthropicEvent,
];
const aText = (index: number, text: string): AnthropicEvent[] => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } } as unknown as AnthropicEvent,
  { type: "content_block_delta", index, delta: { type: "text_delta", text } } as unknown as AnthropicEvent,
  { type: "content_block_stop", index } as unknown as AnthropicEvent,
];
const aStop = (reason: string): AnthropicEvent =>
  ({ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 5 } }) as unknown as AnthropicEvent;

function anthropicTransport(rounds: AnthropicEvent[][]) {
  const requests: Anthropic.Messages.MessageCreateParamsStreaming[] = [];
  return {
    requests,
    transport: {
      async create(params: Anthropic.Messages.MessageCreateParamsStreaming, options: { signal?: AbortSignal }) {
        requests.push(snapshot(params));
        const round = rounds[requests.length - 1];
        assert.ok(round, `no scripted round ${requests.length}`);
        return scripted(round, options.signal);
      },
    },
  };
}

const ANTHROPIC_TOOL_ROUND: AnthropicEvent[] = [
  aStart(),
  ...aToolUse(0, "toolu_a", "lookup", '{"q":"alpha"}'),
  ...aToolUse(1, "toolu_b", "lookup", '{"q":"beta"}'),
  ...aToolUse(2, "toolu_c", "lookup", '{"q": "unterminated'),
  ...aToolUse(3, "toolu_d", "lookup", '{"q": 42}'),
  ...aToolUse(4, "toolu_e", "rm_rf", "{}"),
  aStop("tool_use"),
];
const ANTHROPIC_ANSWER: AnthropicEvent[] = [aStart(30), ...aText(0, "Done."), aStop("end_turn")];

test("Anthropic: parallel calls, errors as results, provider ids echoed with is_error", async () => {
  const toolset = fakeTurnToolset();
  const { requests, transport } = anthropicTransport([ANTHROPIC_TOOL_ROUND, ANTHROPIC_ANSWER]);
  const { events, error } = await collect(
    streamAnthropic(model("claude-sonnet-5"), "sys", HISTORY, 4_000, undefined, undefined, false, createToolLoop(toolset), undefined, false, undefined, transport),
  );
  assert.equal(error, null);
  assertValidationOutcomes(toolset, events);
  assert.equal(requests.length, 2);
  const followUp = requests[1].messages.at(-1)!;
  assert.equal(followUp.role, "user");
  const blocks = followUp.content as Anthropic.Messages.ToolResultBlockParam[];
  assert.deepEqual(
    blocks.map((b) => [b.type, b.tool_use_id, b.is_error ?? false]),
    [
      ["tool_result", "toolu_a", false],
      ["tool_result", "toolu_b", false],
      ["tool_result", "toolu_c", true],
      ["tool_result", "toolu_d", true],
      ["tool_result", "toolu_e", true],
    ],
  );
  assert.match(String(blocks[2].content), /not valid JSON/);
  assert.match(String(blocks[3].content), /"q" must be a string/);
  assert.match(String(blocks[4].content), /There is no tool named "rm_rf"/);
  assert.equal(blocks[0].content, "lookup:alpha");
  // The Alevr id is the provider id here (unique), and the executor saw it.
  assert.deepEqual(toolset.dispatched.map((d) => d.callId), ["toolu_a", "toolu_b"]);
  assert.ok(events.some((e) => e.type === "text" && e.text === "Done."));
});

test("Anthropic: Stop mid-batch answers every outstanding call 'cancelled'", async () => {
  const controller = new AbortController();
  const toolset = fakeTurnToolset({ onRunning: () => setTimeout(() => controller.abort(), 5) });
  const { transport } = anthropicTransport([
    [aStart(), ...aToolUse(0, "toolu_1", "slow_job", '{"q":"one"}'), ...aToolUse(1, "toolu_2", "slow_job", '{"q":"two"}'), aStop("tool_use")],
  ]);
  const { events, error } = await collect(
    streamAnthropic(model("claude-sonnet-5"), "sys", HISTORY, 4_000, controller.signal, undefined, false, createToolLoop(toolset), undefined, false, undefined, transport),
  );
  assert.ok(error, "the turn ends in the abort");
  const results = toolResults(events);
  assert.deepEqual(results.map((r) => [r.callId, r.status]), [
    ["toolu_1", "cancelled"],
    ["toolu_2", "cancelled"],
  ]);
  assert.equal(toolset.dispatched.length, 1, "the second job never started");
});

test("Anthropic: the Alevr call id is stable across a replayed round", async () => {
  const ids: string[][] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const toolset = fakeTurnToolset();
    const { transport } = anthropicTransport([ANTHROPIC_TOOL_ROUND, ANTHROPIC_ANSWER]);
    const { events } = await collect(
      streamAnthropic(model("claude-sonnet-5"), "sys", HISTORY, 4_000, undefined, undefined, false, createToolLoop(toolset), undefined, false, undefined, transport),
    );
    ids.push(toolCalls(events).map((c) => c.callId));
  }
  assert.deepEqual(ids[0], ["toolu_a", "toolu_b", "toolu_c", "toolu_d", "toolu_e"]);
  assert.deepEqual(ids[0], ids[1]);
});

// ── OpenAI-compatible ────────────────────────────────────────────────────────

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;
const cDelta = (delta: Record<string, unknown>, finish: string | null = null): Chunk =>
  ({ choices: [{ index: 0, delta, finish_reason: finish }] }) as unknown as Chunk;
const cCall = (index: number, id: string | undefined, name: string, args: string): Chunk =>
  cDelta({ tool_calls: [{ index, ...(id ? { id } : {}), function: { name, arguments: args } }] });

function compatTransport(rounds: Chunk[][]) {
  const requests: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming[] = [];
  return {
    requests,
    transport: {
      async create(params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, options: { signal?: AbortSignal }) {
        requests.push(snapshot(params));
        const round = rounds[requests.length - 1];
        assert.ok(round, `no scripted round ${requests.length}`);
        return scripted(round, options.signal);
      },
    },
  };
}

const COMPAT_TOOL_ROUND: Chunk[] = [
  cCall(0, "functions.lookup:0", "lookup", '{"q":"alpha"}'),
  cCall(1, "functions.lookup:1", "lookup", '{"q":"beta"}'),
  cCall(2, "functions.lookup:2", "lookup", "{oops"),
  cCall(3, "functions.lookup:3", "lookup", '{"query":"gamma"}'),
  cCall(4, "functions.rm_rf:4", "rm_rf", "{}"),
  cDelta({}, "tool_calls"),
];
const COMPAT_ANSWER: Chunk[] = [cDelta({ content: "Done." }), cDelta({}, "stop")];

test("OpenAI-compatible: parallel calls, errors as results, one tool message per call in order", async () => {
  const toolset = fakeTurnToolset();
  const { requests, transport } = compatTransport([COMPAT_TOOL_ROUND, COMPAT_ANSWER]);
  const { events, error } = await collect(
    streamOpenAICompat(model("kimi-k3"), "sys", HISTORY, 4_000, undefined, undefined, false, createToolLoop(toolset), undefined, undefined, false, transport),
  );
  assert.equal(error, null);
  assertValidationOutcomes(toolset, events);
  const sent = requests[1].messages as Array<{ role: string; tool_call_id?: string; content?: unknown; tool_calls?: Array<{ id: string }> }>;
  const assistant = sent.find((m) => m.role === "assistant" && m.tool_calls)!;
  assert.deepEqual(assistant.tool_calls!.map((c) => c.id), [
    "functions.lookup:0",
    "functions.lookup:1",
    "functions.lookup:2",
    "functions.lookup:3",
    "functions.rm_rf:4",
  ]);
  const toolMessages = sent.filter((m) => m.role === "tool");
  assert.deepEqual(toolMessages.map((m) => m.tool_call_id), assistant.tool_calls!.map((c) => c.id));
  assert.equal(toolMessages[0].content, "lookup:alpha");
  assert.match(String(toolMessages[2].content), /not valid JSON/);
  assert.match(String(toolMessages[3].content), /"query" is not a parameter/);
  // Tool messages immediately follow the assistant message, nothing between.
  const at = sent.indexOf(assistant);
  assert.deepEqual(sent.slice(at + 1, at + 6).map((m) => m.role), ["tool", "tool", "tool", "tool", "tool"]);
});

test("OpenAI-compatible: a call streamed with no id gets a stable synthesized one, used on the wire", async () => {
  const ids: string[][] = [];
  const wire: string[][] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const toolset = fakeTurnToolset();
    const { requests, transport } = compatTransport([
      [cCall(0, undefined, "lookup", '{"q":"alpha"}'), cCall(1, undefined, "lookup", '{"q":"beta"}'), cDelta({}, "tool_calls")],
      COMPAT_ANSWER,
    ]);
    await collect(
      streamOpenAICompat(model("kimi-k3"), "sys", HISTORY, 4_000, undefined, undefined, false, createToolLoop(toolset), undefined, undefined, false, transport),
    );
    ids.push(toolset.dispatched.map((d) => d.callId ?? ""));
    const sent = requests[1].messages as Array<{ role: string; tool_call_id?: string }>;
    wire.push(sent.filter((m) => m.role === "tool").map((m) => m.tool_call_id ?? ""));
  }
  assert.deepEqual(ids[0], ["jc_0_0", "jc_0_1"], "dispatched, not dropped, with a stable id");
  assert.deepEqual(ids[0], ids[1]);
  assert.deepEqual(wire[0], ["jc_0_0", "jc_0_1"]);
});

test("OpenAI-compatible: Stop mid-batch answers every outstanding call 'cancelled'", async () => {
  const controller = new AbortController();
  const toolset = fakeTurnToolset({ onRunning: () => setTimeout(() => controller.abort(), 5) });
  const { transport } = compatTransport([
    [cCall(0, "call_1", "slow_job", '{"q":"one"}'), cCall(1, "call_2", "lookup", '{"q":"two"}'), cDelta({}, "tool_calls")],
  ]);
  const { events, error } = await collect(
    streamOpenAICompat(model("kimi-k3"), "sys", HISTORY, 4_000, controller.signal, undefined, false, createToolLoop(toolset), undefined, undefined, false, transport),
  );
  assert.ok(error);
  assert.deepEqual(toolResults(events).map((r) => [r.callId, r.status]), [
    ["call_1", "cancelled"],
    ["call_2", "cancelled"],
  ]);
});

// ── OpenAI Responses ─────────────────────────────────────────────────────────

type RespEvent = OpenAI.Responses.ResponseStreamEvent;
const rCall = (callId: string, name: string, args: string): RespEvent =>
  ({ type: "response.output_item.done", item: { type: "function_call", call_id: callId, name, arguments: args } }) as unknown as RespEvent;
const rDone = (): RespEvent =>
  ({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 5 } } }) as unknown as RespEvent;
const rText = (text: string): RespEvent => ({ type: "response.output_text.delta", delta: text }) as unknown as RespEvent;

function responsesTransport(rounds: RespEvent[][]) {
  const requests: OpenAI.Responses.ResponseCreateParamsStreaming[] = [];
  return {
    requests,
    transport: {
      async create(params: OpenAI.Responses.ResponseCreateParamsStreaming, options: { signal?: AbortSignal }) {
        requests.push(snapshot(params));
        const round = rounds[requests.length - 1];
        assert.ok(round, `no scripted round ${requests.length}`);
        return scripted(round, options.signal);
      },
    },
  };
}

const RESPONSES_TOOL_ROUND: RespEvent[] = [
  rCall("call_a", "lookup", '{"q":"alpha"}'),
  rCall("call_b", "lookup", '{"q":"beta"}'),
  rCall("call_c", "lookup", "not json"),
  rCall("call_d", "lookup", "{}"),
  rCall("call_e", "rm_rf", "{}"),
  rDone(),
];

test("OpenAI Responses: parallel calls, errors as results, function_call_output per call_id in order", async () => {
  const toolset = fakeTurnToolset();
  const { requests, transport } = responsesTransport([RESPONSES_TOOL_ROUND, [rText("Done."), rDone()]]);
  const { events, error } = await collect(
    streamOpenAIResponses(model("gpt-5.5-pro"), "sys", HISTORY, 4_000, undefined, undefined, false, createToolLoop(toolset), undefined, undefined, false, false, transport),
  );
  assert.equal(error, null);
  assertValidationOutcomes(toolset, events);
  const input = requests[1].input as Array<{ type?: string; call_id?: string; output?: string }>;
  const outputs = input.filter((item) => item.type === "function_call_output");
  assert.deepEqual(outputs.map((o) => o.call_id), ["call_a", "call_b", "call_c", "call_d", "call_e"]);
  assert.equal(outputs[0].output, "lookup:alpha");
  assert.match(String(outputs[2].output), /not valid JSON/);
  assert.match(String(outputs[3].output), /"q" is required/);
  assert.match(String(outputs[4].output), /no tool named "rm_rf"/);
  // The calls are replayed before their outputs.
  const firstOutput = input.findIndex((item) => item.type === "function_call_output");
  assert.equal(input.filter((item, i) => item.type === "function_call" && i < firstOutput).length, 5);
});

test("OpenAI Responses: Stop mid-batch answers every outstanding call 'cancelled'", async () => {
  const controller = new AbortController();
  const toolset = fakeTurnToolset({ onRunning: () => setTimeout(() => controller.abort(), 5) });
  const { transport } = responsesTransport([[rCall("call_1", "slow_job", '{"q":"one"}'), rCall("call_2", "slow_job", "{}"), rDone()]]);
  const { events, error } = await collect(
    streamOpenAIResponses(model("gpt-5.5-pro"), "sys", HISTORY, 4_000, controller.signal, undefined, false, createToolLoop(toolset), undefined, undefined, false, false, transport),
  );
  assert.ok(error);
  assert.deepEqual(toolResults(events).map((r) => [r.callId, r.status]), [
    ["call_1", "cancelled"],
    ["call_2", "cancelled"],
  ]);
});

test("OpenAI Responses: the Alevr call id is stable across a replayed round", async () => {
  const ids: string[][] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const toolset = fakeTurnToolset();
    const { transport } = responsesTransport([RESPONSES_TOOL_ROUND, [rText("Done."), rDone()]]);
    await collect(
      streamOpenAIResponses(model("gpt-5.5-pro"), "sys", HISTORY, 4_000, undefined, undefined, false, createToolLoop(toolset), undefined, undefined, false, false, transport),
    );
    ids.push(toolset.dispatched.map((d) => d.callId ?? ""));
  }
  assert.deepEqual(ids[0], ["call_a", "call_b"]);
  assert.deepEqual(ids[0], ids[1]);
});

// ── Gemini ───────────────────────────────────────────────────────────────────

const gCalls = (calls: Array<{ name: string; args: Record<string, unknown>; id?: string }>) => ({
  candidates: [{ content: { role: "model", parts: calls.map((c) => ({ functionCall: { name: c.name, args: c.args, ...(c.id ? { id: c.id } : {}) } })) }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 },
});
const gAnswer = {
  candidates: [{ content: { role: "model", parts: [{ text: "Done." }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, totalTokenCount: 12 },
};

function geminiTransport(rounds: unknown[][]) {
  const requests: Array<{ contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> }> = [];
  return {
    requests,
    transport: {
      async request(input: { body: unknown; signal?: AbortSignal }) {
        requests.push(snapshot(input.body) as (typeof requests)[number]);
        const round = rounds[requests.length - 1];
        assert.ok(round, `no scripted round ${requests.length}`);
        if (input.signal?.aborted) throw input.signal.reason;
        return sseResponse(round);
      },
    },
  };
}

test("Gemini: parallel calls, errors under `error`, functionResponse.id echoed only when given", async () => {
  const toolset = fakeTurnToolset();
  const { requests, transport } = geminiTransport([
    [
      gCalls([
        { name: "lookup", args: { q: "alpha" }, id: "fc_a" },
        { name: "lookup", args: { q: "beta" } },
        { name: "lookup", args: {} },
        { name: "lookup", args: { q: ["x"] }, id: "fc_d" },
        { name: "rm_rf", args: {} },
      ]),
    ],
    [gAnswer],
  ]);
  const { events, error } = await collect(
    streamGemini(model("gemini-3.8-flash"), "sys", HISTORY, 4_000, undefined, undefined, false, createToolLoop(toolset), undefined, undefined, transport),
  );
  assert.equal(error, null);
  // Gemini sends args as an object, so "invalid JSON" cannot happen; a schema
  // violation can, and both kinds of failure stay unrun.
  assert.deepEqual(toolset.dispatched.map((d) => [d.name, d.args.q, d.callId]), [
    ["lookup", "alpha", "fc_a"],
    ["lookup", "beta", "jc_0_1"],
  ]);
  const results = toolResults(events);
  assert.deepEqual(results.map((r) => (r.ok ? "ok" : r.error?.code)), ["ok", "ok", "invalid_args", "invalid_args", "unknown_tool"]);

  const sent = requests[1].contents;
  const responseTurn = sent.find((c) => c.role === "user" && c.parts.some((p) => "functionResponse" in p))!;
  const responses = responseTurn.parts.map((p) => p.functionResponse as { name: string; id?: string; response: Record<string, unknown> });
  assert.deepEqual(responses.map((r) => r.id ?? null), ["fc_a", null, null, "fc_d", null]);
  assert.deepEqual(responses[0].response, { result: "lookup:alpha" });
  assert.match(String(responses[2].response.error), /"q" is required/);
  assert.match(String(responses[3].response.error), /"q" must be a string/);
  assert.equal(responses[3].response.result, undefined);
  // The model turn replayed with its own ids intact.
  const modelTurn = sent.find((c) => c.role === "model" && c.parts.some((p) => "functionCall" in p))!;
  assert.deepEqual(modelTurn.parts.map((p) => (p.functionCall as { id?: string }).id ?? null), ["fc_a", null, null, "fc_d", null]);
});

test("Gemini: an id-less call keeps the same Alevr id on a replayed round (no random id)", async () => {
  const ids: string[][] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const toolset = fakeTurnToolset();
    const { transport } = geminiTransport([[gCalls([{ name: "lookup", args: { q: "alpha" } }, { name: "lookup", args: { q: "beta" } }])], [gAnswer]]);
    await collect(
      streamGemini(model("gemini-3.8-flash"), "sys", HISTORY, 4_000, undefined, undefined, false, createToolLoop(toolset), undefined, undefined, transport),
    );
    ids.push(toolset.dispatched.map((d) => d.callId ?? ""));
  }
  assert.deepEqual(ids[0], ["jc_0_0", "jc_0_1"]);
  assert.deepEqual(ids[0], ids[1]);
});

test("Gemini: Stop mid-batch answers every outstanding call 'cancelled'", async () => {
  const controller = new AbortController();
  const toolset = fakeTurnToolset({ onRunning: () => setTimeout(() => controller.abort(), 5) });
  const { transport } = geminiTransport([[gCalls([{ name: "slow_job", args: { q: "one" }, id: "fc_1" }, { name: "slow_job", args: { q: "two" } }])]]);
  const { events, error } = await collect(
    streamGemini(model("gemini-3.8-flash"), "sys", HISTORY, 4_000, controller.signal, undefined, false, createToolLoop(toolset), undefined, undefined, transport),
  );
  assert.ok(error);
  assert.deepEqual(toolResults(events).map((r) => [r.callId, r.status]), [
    ["fc_1", "cancelled"],
    ["jc_0_1", "cancelled"],
  ]);
});

test("OpenAI-compatible: each lab's thinking control goes out in its documented spelling", async () => {
  // One plain answer per request; only the request body matters here.
  const send = async (id: string, effort: string | undefined) => {
    const { requests, transport } = compatTransport([COMPAT_ANSWER]);
    const { error } = await collect(
      streamOpenAICompat(model(id), "sys", HISTORY, 4_000, undefined, effort as never, false, undefined, undefined, undefined, false, transport),
    );
    assert.equal(error, null, id);
    return requests[0] as unknown as Record<string, unknown>;
  };

  // Qwen3.8 is hybrid and takes reasoning_effort, never with a thinking_budget
  // ("Setting both will cause an error"); Instant is enable_thinking:false.
  const qwen = await send("qwen:qwen3.8-max", "xhigh");
  assert.equal(qwen.enable_thinking, true);
  assert.equal(qwen.reasoning_effort, "xhigh");
  assert.equal(qwen.thinking_budget, undefined);
  const qwenInstant = await send("qwen:qwen3.8-flash", undefined);
  assert.equal(qwenInstant.enable_thinking, false);
  assert.equal(qwenInstant.reasoning_effort, undefined);
  // Older Qwen3 lines keep the numeric budget.
  const qwen37 = await send("qwen:qwen3.7-plus", "medium");
  assert.equal(qwen37.thinking_budget, 8192);
  assert.equal(qwen37.reasoning_effort, undefined);

  // GLM-5.3 always thinks: the effort enum, and never thinking "disabled".
  const glm = await send("zhipu:glm-5.3", "low");
  assert.equal(glm.reasoning_effort, "low");
  assert.deepEqual(glm.thinking, { type: "enabled" });
  const glmBare = await send("zhipu:glm-5.3", undefined);
  assert.deepEqual(glmBare.thinking, { type: "enabled" });

  // DeepSeek thinks at high by default, so Instant has to be sent.
  const ds = await send("deepseek:deepseek-flash", undefined);
  assert.deepEqual(ds.thinking, { type: "disabled" });
  assert.equal(ds.reasoning_effort, undefined);
  const dsLow = await send("deepseek:deepseek-v4-pro", "low");
  assert.equal(dsLow.reasoning_effort, "low");
  assert.equal(dsLow.thinking, undefined);
});

test("OpenAI-compatible: the labs' own web search goes out as documented and its sources come back", async () => {
  const run = async (id: string, rounds: Chunk[][], webSearch: boolean) => {
    const { requests, transport } = compatTransport(rounds);
    const { events, error } = await collect(
      streamOpenAICompat(model(id), "sys", HISTORY, 4_000, undefined, undefined, webSearch, undefined, undefined, undefined, false, transport),
    );
    assert.equal(error, null, id);
    return { body: requests[0] as unknown as Record<string, unknown>, events };
  };
  const sourcesOf = (events: LlmEvent[]) =>
    events.flatMap((e) => (e.type === "sources" ? e.sources.map((s) => s.url) : []));
  const usageOf = (events: LlmEvent[]) => events.find((e) => e.type === "usage") as { webSearchRequests?: number } | undefined;

  // Z.ai: a web_search tool; results arrive top-level on a chunk; one use billed.
  const glm = await run(
    "zhipu:glm-5.3",
    [[
      { web_search: [{ title: "A", link: "https://a.example/1", content: "alpha" }], choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] } as unknown as Chunk,
      cDelta({}, "stop"),
    ]],
    true,
  );
  assert.deepEqual(glm.body.tools, [{ type: "web_search", web_search: { enable: true, search_engine: "search_pro_jina", search_result: true } }]);
  assert.deepEqual(sourcesOf(glm.events), ["https://a.example/1"]);
  assert.equal(usageOf(glm.events)?.webSearchRequests, 1);

  // MiMo: a web_search tool; url_citation annotations on the first packet; tool_usage billed.
  const mimo = await run(
    "mimo:mimo-v2.6-flash",
    [[
      cDelta({ annotations: [{ type: "url_citation", url: "https://b.example/2", title: "B", summary: "beta" }] }),
      cDelta({ content: "Answer." }, "stop"),
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, web_search_usage: { tool_usage: 2, page_usage: 2 } } } as unknown as Chunk,
    ]],
    true,
  );
  assert.deepEqual(mimo.body.tools, [{ type: "web_search", max_keyword: 3, force_search: false }]);
  assert.deepEqual(sourcesOf(mimo.events), ["https://b.example/2"]);
  assert.equal(usageOf(mimo.events)?.webSearchRequests, 2);

  // Qwen: enable_search on the request, nothing else.
  const qwen = await run("qwen:qwen3.8-flash", [COMPAT_ANSWER], true);
  assert.equal(qwen.body.enable_search, true);
  assert.equal(qwen.body.tools, undefined);

  // Toggle off: none of it is sent.
  const off = await run("zhipu:glm-5.3", [COMPAT_ANSWER], false);
  assert.equal(off.body.tools, undefined);
  const qwenOff = await run("qwen:qwen3.8-flash", [COMPAT_ANSWER], false);
  assert.equal(qwenOff.body.enable_search, undefined);
});
