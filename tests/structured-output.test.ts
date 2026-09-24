import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { runCompatLoop } from "@/lib/llm/compat-loop";
import { createLoopController } from "@/lib/llm/loop";
import { runResponsesLoop } from "@/lib/llm/responses-loop";
import type { AdapterRequest, ProviderTransport } from "@/lib/llm/types";
import { resolveModel, type ModelInfo } from "@/lib/models";
import type { LlmEvent } from "@/types/llm";

/*
 * `responseSchema` (SPEC §5.0): structured output for a tool-less call — the
 * research planner — mapped per adapter. This file pins the Responses and
 * OpenAI-compatible mappings (lane 3b); the Anthropic (one tool, `auto`, never
 * a forced choice) and Gemini (`responseJsonSchema`) mappings belong beside
 * them from lane 3a.
 */

const SCHEMA = {
  name: "research_plan",
  schema: {
    type: "object",
    properties: { questions: { type: "array", items: { type: "string" } } },
    required: ["questions"],
  },
} as unknown as NonNullable<AdapterRequest["responseSchema"]>;

function model(id: string): ModelInfo {
  const resolved = resolveModel(id);
  assert.ok(resolved, `${id} resolves`);
  return resolved;
}

function request(m: ModelInfo): AdapterRequest {
  return {
    model: m,
    system: "Plan the research.",
    history: [],
    maxTokens: 2_000,
    webSearch: false,
    responseSchema: SCHEMA,
    loop: createLoopController({ budget: 1 }),
  };
}

function recorder(events: unknown[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const transport: ProviderTransport = {
    async *request(body) {
      bodies.push(structuredClone(body) as Record<string, unknown>);
      for (const event of events) yield event;
    },
  };
  return { bodies, transport };
}

async function drain(stream: AsyncGenerator<LlmEvent>): Promise<LlmEvent[]> {
  const events: LlmEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("both loops under test have no server-only import (SPEC §13 rule 1)", () => {
  for (const file of ["src/lib/llm/responses-loop.ts", "src/lib/llm/compat-loop.ts"]) {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    assert.doesNotMatch(source, /^import "server-only";/m, file);
  }
});

test("Responses: text.format carries the JSON schema, not strict", async () => {
  const json = '{"questions":["a"]}';
  const { bodies, transport } = recorder([
    { type: "response.output_text.delta", item_id: "m", delta: json },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]);
  const events = await drain(
    runResponsesLoop({
      req: request(model("openai:gpt-6-luna")),
      dialect: "openai",
      history: [{ role: "user", content: [{ type: "input_text", text: "topic" }] }],
      transport,
    }),
  );
  assert.deepEqual(bodies[0].text, {
    format: { type: "json_schema", name: "research_plan", schema: SCHEMA.schema, strict: false },
  });
  assert.equal("tools" in bodies[0], false);
  assert.equal(events.filter((e) => e.type === "text").map((e) => e.type === "text" && e.text).join(""), json);
});

test("xAI Responses takes the same text.format", async () => {
  const { bodies, transport } = recorder([{ type: "response.completed", response: { usage: {} } }]);
  await drain(runResponsesLoop({ req: request(model("xai:grok-4.7")), dialect: "xai", history: [], transport }));
  assert.equal((bodies[0].text as { format: { type: string } }).format.type, "json_schema");
});

test("compat: JSON mode plus the schema stated in the conversation, never a named tool choice", async () => {
  for (const id of ["deepseek:deepseek-v4-pro", "moonshot:kimi-k3", "zhipu:glm-5.3", "qwen:qwen3.8-max"]) {
    const { bodies, transport } = recorder([{ choices: [{ delta: { content: "{}" }, finish_reason: "stop" }] }]);
    await drain(
      runCompatLoop({
        req: request(model(id)),
        messages: [
          { role: "system", content: "Plan the research." },
          { role: "user", content: "topic" },
        ],
        transport,
      }),
    );
    const body = bodies[0];
    assert.deepEqual(body.response_format, { type: "json_object" }, id);
    assert.equal("tool_choice" in body, false, `${id}: a named choice 400s on Kimi and DeepSeek thinking`);
    assert.equal("tools" in body, false, id);
    // Several hosts refuse JSON mode unless the conversation says "JSON";
    // the note sits just before the newest user turn, after the cached prefix.
    const messages = body.messages as Array<{ role: string; content: string }>;
    assert.equal(messages[0].content, "Plan the research.", id);
    assert.equal(messages.at(-1)?.role, "user", id);
    const note = messages.at(-2)!;
    assert.equal(note.role, "system", id);
    assert.match(note.content, /JSON/);
    assert.match(note.content, /"research_plan"/);
    assert.ok(note.content.includes(JSON.stringify(SCHEMA.schema)), `${id}: the schema itself is stated`);
  }
});
