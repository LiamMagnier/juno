import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { getModel, MODEL_LIST, type ModelInfo } from "@/lib/models";
import { createToolLoop } from "@/lib/tools/loop";
import { fakeTurnToolset, scripted, sseResponse } from "./fixtures/tool-loop";
import type { LlmEvent, MessageForModel } from "@/types/llm";

// These are the production adapters imported by llm.ts, not llm/*-loop.ts.
// Only provider I/O is scripted. The real adapters, dispatcher and tool loop run.
const modules = Module as unknown as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const originalLoad = modules._load;
modules._load = function (name, parent, main) {
  return name === "server-only" ? {} : originalLoad.call(this, name, parent, main);
};
globalThis.fetch = async () => { throw new Error("production adapter test attempted network I/O"); };
const require = createRequire(import.meta.url);
const { streamAnthropic } = require("../src/lib/anthropic") as typeof import("@/lib/anthropic");
const { streamOpenAICompat } = require("../src/lib/openai-compat") as typeof import("@/lib/openai-compat");
const { streamOpenAIResponses } = require("../src/lib/openai-responses") as typeof import("@/lib/openai-responses");
const { streamGemini } = require("../src/lib/gemini") as typeof import("@/lib/gemini");

type Raw = Record<string, unknown>;
const history: MessageForModel[] = [{ role: "USER", content: "Look up question, then answer.", attachments: [] }];
function model(id: string): ModelInfo { const found = getModel(id); assert.ok(found, id); return found; }
function anthropicRound(tool: boolean, input = 100, output = 10, stop = tool ? "tool_use" : "end_turn"): Raw[] {
  return [
    { type: "message_start", message: { usage: { input_tokens: input } } },
    { type: "content_block_start", index: 0, content_block: tool ? { type: "tool_use", id: "call_lookup", name: "lookup", input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: '{"q":"question"}' } : { type: "text_delta", text: "Answer." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: output } },
  ];
}
function compatRound(tool: boolean, input = 100, output = 10): Raw[] {
  return [
    { choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, id: "call_lookup", type: "function", function: { name: "lookup", arguments: '{"q":"question"}' } }] } : { content: "Answer." }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] },
    { choices: [], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } },
  ];
}
function responsesRound(tool: boolean, input = 100, output = 10): Raw[] {
  return [
    tool ? { type: "response.output_item.done", item: { type: "function_call", id: "fc_lookup", call_id: "call_lookup", name: "lookup", arguments: '{"q":"question"}' } } : { type: "response.output_text.delta", delta: "Answer." },
    { type: "response.completed", response: { id: "response", status: "completed", usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } } },
  ];
}
function geminiRound(tool: boolean, input = 100, output = 10): Raw[] {
  return [{ candidates: [{ content: { role: "model", parts: [tool ? { functionCall: { id: "call_lookup", name: "lookup", args: { q: "question" } }, thoughtSignature: "signature" } : { text: "Answer." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: input, candidatesTokenCount: output, totalTokenCount: input + output } }];
}

for (const adapter of ["anthropic", "compat", "responses", "gemini"] as const) {
  test(`${adapter}: production loop reports cumulative usage before dispatch and round two`, async () => {
    const events: LlmEvent[] = [];
    const bodies: Raw[] = [];
    const toolset = fakeTurnToolset();
    const execute = toolset.execute;
    toolset.execute = async (...args) => {
      assert.ok(events.some((event) => event.type === "usage" && event.input === 100), "the budget guard sees round one's spend before a tool runs");
      return execute(...args);
    };
    const loop = createToolLoop(toolset, { maxRounds: 2 });
    const rounds = { anthropic: anthropicRound, compat: compatRound, responses: responsesRound, gemini: geminiRound }[adapter];
    const script = [rounds(true), rounds(false, 200, 20)];
    const next = (body: unknown): Raw[] => {
      if (bodies.length) assert.ok(events.some((event) => event.type === "usage" && event.input === 100), "usage precedes the next billable request");
      bodies.push(structuredClone(body) as Raw);
      const response = script.shift();
      assert.ok(response, "no unexpected billable request");
      return response;
    };
    const transport = { create: async (body: unknown) => scripted(next(body) as never[]) };
    const generator = adapter === "anthropic"
      ? streamAnthropic(model("anthropic:claude-haiku-4-5"), "System", history, 1000, undefined, undefined, false, loop, undefined, false, undefined, transport)
      : adapter === "compat"
        ? streamOpenAICompat(MODEL_LIST.find((row) => row.provider === "mistral" && row.modality === "chat")!, "System", history, 1000, undefined, undefined, false, loop, undefined, undefined, false, transport)
        : adapter === "responses"
          ? streamOpenAIResponses(model("openai:gpt-5.5"), "System", history, 1000, undefined, undefined, false, loop, undefined, undefined, false, false, transport)
          : streamGemini(model("google:gemini-3.8-flash"), "System", history, 1000, undefined, undefined, false, loop, undefined, undefined, { request: async ({ body }) => sseResponse(next(body)) });
    for await (const event of generator) events.push(event);
    assert.equal(bodies.length, 2);
    assert.equal(toolset.dispatched.length, 1);
    assert.ok(JSON.stringify(bodies[1]).includes("lookup:question"), "round two carries the actual tool result");
    const usage = events.filter((event) => event.type === "usage");
    assert.equal(usage[0].input, 100);
    assert.equal(usage.at(-1)?.input, 300);
    assert.equal(usage.at(-1)?.output, 30);
  });
}

test("Anthropic max_tokens closes the announced call as cancelled without executing it", async () => {
  const toolset = fakeTurnToolset();
  const events: LlmEvent[] = [];
  for await (const event of streamAnthropic(model("anthropic:claude-haiku-4-5"), "System", history, 1000, undefined, undefined, false, createToolLoop(toolset), undefined, false, undefined, { create: async () => scripted(anthropicRound(true, 100, 10, "max_tokens") as never[]) })) events.push(event);
  assert.equal(toolset.dispatched.length, 0);
  assert.equal(events.filter((event) => event.type === "tool" && event.phase === "result" && event.status === "cancelled").length, 1);
  assert.ok(events.some((event) => event.type === "finish" && event.reason === "length"));
});

test("a Stop during Gemini's continuation is rethrown rather than saved as a finished answer", async () => {
  const controller = new AbortController();
  const stopped = new DOMException("Stopped", "AbortError");
  let calls = 0;
  const events: LlmEvent[] = [];
  const transport = { request: async () => {
    if (calls++ === 0) return sseResponse([{ candidates: [{ content: { parts: [{ text: "The answer starts here and" }] }, finishReason: "MAX_TOKENS" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 990, totalTokenCount: 1100 } }]);
    controller.abort(stopped);
    throw stopped;
  } };
  await assert.rejects(async () => {
    for await (const event of streamGemini(model("google:gemini-3.8-flash"), "System", history, 1000, controller.signal, "high", false, undefined, undefined, undefined, transport)) events.push(event);
  }, (error) => error === stopped);
  assert.equal(calls, 2, "the stop happened inside a continuation");
  assert.equal(events.filter((event) => event.type === "finish").length, 0);
});
