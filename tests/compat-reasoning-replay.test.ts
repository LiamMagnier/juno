import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  compatHistoryAssistantMessage,
  compatToolCallMessage,
  runCompatLoop,
  type CompatMessage,
} from "@/lib/llm/compat-loop";
import { createLoopController } from "@/lib/llm/loop";
import type { AdapterRequest, ProviderTransport } from "@/lib/llm/types";
import { toolCapabilitiesFor } from "@/lib/model-tools";
import { resolveModel, type ModelInfo } from "@/lib/models";
import type { BatchResult, executeToolBatch } from "@/lib/tools/dispatch";
import type { ChatToolset } from "@/lib/tools/types";

/*
 * What a compat host needs back from a round's thinking (SPEC §5.4 item 1,
 * RC-5, H4). DeepSeek answers a tool round whose assistant message lacks
 * `reasoning_content` with a 400; GLM, MiniMax, Qwen and Mistral's thinking
 * models do better with it; Meta redacts reasoning and has nothing to send.
 * The rule is the capability record's `replay` and `replayField`.
 */

function model(id: string, over: Partial<ModelInfo> = {}): ModelInfo {
  const resolved = resolveModel(id);
  assert.ok(resolved, `${id} resolves`);
  return { ...resolved, ...over };
}

const CALLS = [{ id: "c1", name: "lookup", args: '{"q":"x"}' }];

test("the replay rules live in a module with no server-only import (SPEC §13 rule 1)", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/llm/compat-loop.ts"), "utf8");
  assert.doesNotMatch(source, /^import "server-only";/m);
});

test("must (DeepSeek, MiMo, Kimi): the field is always there, even empty", () => {
  for (const id of ["deepseek:deepseek-v4-pro", "mimo:mimo-v2.6-pro", "moonshot:kimi-k3"]) {
    const caps = toolCapabilitiesFor(model(id));
    assert.equal(caps.replay, "must", id);
    const withThinking = compatToolCallMessage(caps, "Looking.", { text: "Need x." }, CALLS);
    assert.equal(withThinking.reasoning_content, "Need x.", id);
    const without = compatToolCallMessage(caps, "", { text: "" }, CALLS);
    assert.equal(without.reasoning_content, "", `${id}: a missing field is the 400, an empty one is not`);
    assert.equal(without.content, null);
  }
});

test("should (GLM, Qwen): attached when the round thought, left off when it did not", () => {
  for (const id of ["zhipu:glm-5.3", "qwen:qwen3.8-max"]) {
    const caps = toolCapabilitiesFor(model(id));
    assert.equal(caps.replay, "should", id);
    assert.equal(compatToolCallMessage(caps, "", { text: "Thinking." }, CALLS).reasoning_content, "Thinking.", id);
    assert.equal("reasoning_content" in compatToolCallMessage(caps, "", { text: "" }, CALLS), false, id);
  }
});

test("MiniMax gets its reasoning_details back in the shape it sent them", () => {
  const caps = toolCapabilitiesFor(model("minimax:MiniMax-M3"));
  assert.equal(caps.replayField, "reasoning_details");
  const message = compatToolCallMessage(caps, "", { text: "Plan.", detailShape: { id: "rd_1", format: "MiniMax-response-v1", index: 0 } }, CALLS);
  assert.deepEqual(message.reasoning_details, [
    { id: "rd_1", format: "MiniMax-response-v1", index: 0, type: "reasoning.text", text: "Plan." },
  ]);
});

test("Mistral's thinking models get the typed thinking chunk back", () => {
  const caps = toolCapabilitiesFor(model("mistral:mistral-medium-latest"));
  assert.equal(caps.replayField, "thinkchunk");
  const message = compatToolCallMessage(caps, "Checking.", { text: "Hmm." }, CALLS);
  assert.deepEqual(message.content, [
    { type: "thinking", thinking: [{ type: "text", text: "Hmm." }] },
    { type: "text", text: "Checking." },
  ]);
});

test("think tags go back inline, where the host wrote them", () => {
  const message = compatToolCallMessage({ replay: "should", replayField: "think_tags" }, "Answer.", { text: "Why." }, CALLS);
  assert.equal(message.content, "<think>Why.</think>Answer.");
});

test("none (Meta, Mistral Large): nothing is attached", () => {
  for (const id of ["meta:muse-spark-1.3", "mistral:mistral-large-latest"]) {
    const message = compatToolCallMessage(toolCapabilitiesFor(model(id)), "x", { text: "private" }, CALLS);
    assert.deepEqual(Object.keys(message).sort(), ["content", "role", "tool_calls"], id);
  }
});

test("DeepSeek's history: its own turns carry their reasoning, a foreign lab's turns an empty one, only with tools", () => {
  const deepseek = model("deepseek:deepseek-v4-pro");
  const own = { content: "Earlier answer.", reasoning: "Earlier thought.", model: "deepseek:deepseek-flash" };
  const foreign = { content: "Claude's answer.", reasoning: "Claude's thought.", model: "anthropic:claude-opus-5-5" };
  const unknown = { content: "Old row.", reasoning: null, model: null };
  assert.deepEqual(compatHistoryAssistantMessage(own, deepseek, true), {
    role: "assistant", content: "Earlier answer.", reasoning_content: "Earlier thought.",
  });
  assert.deepEqual(compatHistoryAssistantMessage(foreign, deepseek, true), {
    role: "assistant", content: "Claude's answer.", reasoning_content: "",
  });
  assert.equal(compatHistoryAssistantMessage(unknown, deepseek, true).reasoning_content, "");
  // Without tools the rule does not apply, and nothing is sent.
  assert.deepEqual(compatHistoryAssistantMessage(own, deepseek, false), { role: "assistant", content: "Earlier answer." });
  // Kimi and MiMo are `must` in-turn only.
  assert.equal("reasoning_content" in compatHistoryAssistantMessage(own, model("moonshot:kimi-k3"), true), false);
  // An empty row still says something.
  assert.equal(compatHistoryAssistantMessage({ content: "" }, deepseek, false).content, "(no content)");
});

test("end to end: a DeepSeek tool round replays the thinking it streamed", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const script = [
    [
      { choices: [{ delta: { reasoning_content: "Need " } }] },
      { choices: [{ delta: { reasoning_content: "data." } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "{}" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ],
    [{ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }],
  ];
  let next = 0;
  const transport: ProviderTransport = {
    async *request(body) {
      bodies.push(structuredClone(body) as Record<string, unknown>);
      for (const chunk of script[next++]) yield chunk;
    },
  };
  const toolset: ChatToolset = {
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    labelFor: () => "Lookup",
    accessFor: () => "read",
    execute: async () => ({ text: "x", body: "x", ok: true }),
    close: async () => undefined,
    resolve: () => undefined,
    connectors: [],
  };
  const dispatch: typeof executeToolBatch = async function* (calls) {
    yield* [];
    return calls.map((c): BatchResult => ({ callId: c.callId, name: c.name, providerCallId: c.providerCallId, text: "42", isError: false, images: [] }));
  };
  const req: AdapterRequest = {
    model: model("deepseek:deepseek-v4-pro"),
    system: "s",
    history: [],
    maxTokens: 1_000,
    webSearch: false,
    reasoningEffort: "high",
    toolset,
    batch: { seenCallIds: new Set<string>() } as unknown as AdapterRequest["batch"],
    loop: createLoopController({ budget: 10 }),
  };
  const messages: CompatMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "q" }];
  for await (const _event of runCompatLoop({ req, messages, transport, dispatch })) void _event;
  const replayed = (bodies[1].messages as Array<Record<string, unknown>>).at(-2)!;
  assert.equal(replayed.role, "assistant");
  assert.equal(replayed.reasoning_content, "Need data.");
  assert.equal(bodies[1].tool_choice, "auto");
});
