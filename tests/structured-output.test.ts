import test from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";

import type { GeminiContent } from "@/lib/gemini-core";
import { anthropicLoop, structuredTool } from "@/lib/llm/anthropic-loop";
import { geminiLoop } from "@/lib/llm/gemini-loop";
import { STRUCTURED_BUDGET, createLoopController } from "@/lib/llm/loop";
import { legacyChatToolset } from "@/lib/llm/tool-round";
import type { AdapterRequest, ProviderTransport } from "@/lib/llm/types";
import { MODELS } from "@/lib/models";
import type { PortableSchema } from "@/lib/tools/types";
import type { LlmEvent } from "@/types/llm";

/*
 * `responseSchema`: structured output for a tool-less call (SPEC §5.0), which
 * the research planner uses (§9.5). Each adapter maps it its own way and every
 * one streams the answer as JSON text, so the caller parses one shape:
 *
 * - Anthropic: the schema as ONE tool under `tool_choice: auto` — never a forced
 *   choice, which is a 400 on Fable 5.1 and Opus 5.5 — plus validate-and-retry;
 * - Gemini: `responseJsonSchema` with `responseMimeType: "application/json"`.
 *
 * The Responses (`text.format`) and compat (`json_object`) mappings belong to
 * their adapters' lane and are asserted beside them.
 */

const PLAN: PortableSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "A short title." },
    questions: { type: "array", description: "The questions.", items: { type: "string", description: "One question." } },
  },
  required: ["title", "questions"],
};
const NAME = "research_plan";

type Ev = Record<string, unknown>;

function scripted<T>(responses: T[][], encode: (event: T) => unknown = (e) => e) {
  const bodies: Array<Record<string, unknown>> = [];
  const transport: ProviderTransport = {
    async *request(body) {
      bodies.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      for (const event of next) yield encode(event);
    },
  };
  return { transport, bodies };
}

const ofType = <T extends LlmEvent["type"]>(events: LlmEvent[], type: T) =>
  events.filter((e): e is Extract<LlmEvent, { type: T }> => e.type === type);

// ── Anthropic ─────────────────────────────────────────────────────────────────

const OPUS = MODELS["anthropic:claude-opus-5-5"];

function toolCall(json: string): Ev[] {
  return [
    { type: "message_start", message: { usage: { input_tokens: 50 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_s", name: NAME, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
  ];
}

function prose(text: string): Ev[] {
  return [
    { type: "message_start", message: { usage: { input_tokens: 50 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } },
  ];
}

function anthropicRequest(over: Partial<AdapterRequest> = {}): AdapterRequest {
  return {
    model: OPUS,
    system: "Plan the research.",
    history: [],
    maxTokens: 2048,
    webSearch: false,
    loop: createLoopController({ budget: STRUCTURED_BUDGET }),
    responseSchema: { name: NAME, schema: PLAN },
    ...over,
  };
}

async function runAnthropic(req: AdapterRequest, responses: Ev[][]) {
  const { transport, bodies } = scripted(responses);
  const events: LlmEvent[] = [];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: "Plan: juno history" }];
  for await (const event of anthropicLoop(req, { transport, messages })) events.push(event);
  assert.equal(responses.length, 0, "every scripted response was requested");
  return { events, bodies };
}

const VALID = JSON.stringify({ title: "Juno", questions: ["When?", "Who?"] });

test("Anthropic: the schema is one tool under tool_choice auto, never a forced choice", async () => {
  const { bodies, events } = await runAnthropic(anthropicRequest(), [toolCall(VALID)]);
  assert.deepEqual(bodies[0].tools, [structuredTool(NAME, PLAN)]);
  assert.deepEqual(bodies[0].tool_choice, { type: "auto" });
  const tool = (bodies[0].tools as Array<Record<string, unknown>>)[0];
  assert.equal(tool.name, NAME);
  assert.deepEqual(tool.input_schema, PLAN);
  assert.match(String(tool.description), new RegExp(NAME));
  // The arguments ARE the answer, streamed on as JSON text.
  assert.deepEqual(ofType(events, "text").map((t) => JSON.parse(t.text)), [JSON.parse(VALID)]);
  assert.deepEqual(ofType(events, "finish").map((f) => f.reason), ["stop"]);
  assert.equal(ofType(events, "tool").length, 0, "the structured tool is not a tool call the reader sees");
});

test("Anthropic: a structured call carries no other tool, even when the turn had some", async () => {
  const toolset = legacyChatToolset({
    tools: [{ type: "function", function: { name: "github__x", parameters: { type: "object", properties: {} } } }],
    labelFor: () => "GitHub",
    accessFor: () => "read",
    execute: async () => ({ text: "", body: "", ok: true }),
    close: async () => undefined,
  });
  const { bodies } = await runAnthropic(anthropicRequest({ toolset, webSearch: true }), [toolCall(VALID)]);
  assert.deepEqual((bodies[0].tools as Array<{ name: string }>).map((t) => t.name), [NAME]);
});

test("Anthropic: arguments that miss the schema get one corrective tool_result, then the retry", async () => {
  const { bodies, events } = await runAnthropic(anthropicRequest(), [toolCall('{"title":"Juno"}'), toolCall(VALID)]);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].tool_choice, { type: "auto" }, "still auto on the retry");
  const followUp = (bodies[1].messages as Array<{ role: string; content: unknown }>).at(-1);
  assert.equal(followUp?.role, "user");
  const [block] = followUp?.content as Array<{ type: string; tool_use_id: string; is_error: boolean; content: string }>;
  assert.equal(block.type, "tool_result");
  assert.equal(block.tool_use_id, "toolu_s");
  assert.equal(block.is_error, true);
  assert.match(block.content, /"questions" is required/);
  assert.deepEqual(ofType(events, "text").map((t) => JSON.parse(t.text)), [JSON.parse(VALID)]);
});

test("Anthropic: prose instead of a call gets one nudge; prose that is itself fitting JSON is accepted", async () => {
  const nudged = await runAnthropic(anthropicRequest(), [prose("Sure! Here is a plan."), toolCall(VALID)]);
  const nudge = (nudged.bodies[1].messages as Array<{ role: string; content: unknown }>).at(-1);
  assert.equal(nudge?.role, "user");
  assert.match(String(nudge?.content), new RegExp(`Call the ${NAME} tool`));
  assert.deepEqual(ofType(nudged.events, "text").map((t) => JSON.parse(t.text)), [JSON.parse(VALID)]);

  const fenced = await runAnthropic(anthropicRequest(), [prose("```json\n" + VALID + "\n```")]);
  assert.deepEqual(ofType(fenced.events, "text").map((t) => JSON.parse(t.text)), [JSON.parse(VALID)]);
});

test("Anthropic: with no request left, whatever came back is handed on for the caller to judge", async () => {
  const { events } = await runAnthropic(anthropicRequest({ loop: createLoopController({ budget: 1 }) }), [toolCall('{"title":"Juno"}')]);
  assert.deepEqual(ofType(events, "text").map((t) => t.text), ['{"title":"Juno"}']);
});

// ── Gemini ────────────────────────────────────────────────────────────────────

const FLASH = MODELS["google:gemini-3.8-flash"];

async function runGemini(req: AdapterRequest, responses: Ev[][]) {
  const { transport, bodies } = scripted(responses, (payload) => JSON.stringify(payload));
  const events: LlmEvent[] = [];
  const contents: GeminiContent[] = [{ role: "user", parts: [{ text: "Plan: juno history" }] }];
  const { info, warn } = console;
  console.info = () => undefined;
  console.warn = () => undefined;
  try {
    for await (const event of geminiLoop(req, {
      transport,
      contents,
      context: { modelId: FLASH.id, providerModel: FLASH.providerModel, endpoint: "test" },
    })) {
      events.push(event);
    }
  } finally {
    console.info = info;
    console.warn = warn;
  }
  return { events, bodies };
}

test("Gemini: the schema is responseJsonSchema with an application/json reply, and nothing else rides along", async () => {
  const toolset = legacyChatToolset({
    tools: [{ type: "function", function: { name: "github__x", parameters: { type: "object", properties: {} } } }],
    labelFor: () => "GitHub",
    accessFor: () => "read",
    execute: async () => ({ text: "", body: "", ok: true }),
    close: async () => undefined,
  });
  const { bodies, events } = await runGemini(
    { ...anthropicRequest({ model: FLASH, toolset, webSearch: true }) },
    [
      [
        {
          candidates: [{ content: { role: "model", parts: [{ text: VALID }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 },
        },
      ],
    ],
  );
  const config = bodies[0].generationConfig as Record<string, unknown>;
  assert.equal(config.responseMimeType, "application/json");
  assert.deepEqual(config.responseJsonSchema, PLAN);
  assert.equal("tools" in bodies[0], false, "no functions and no grounding on a structured call");
  assert.deepEqual(ofType(events, "text").map((t) => JSON.parse(t.text)), [JSON.parse(VALID)]);
});
