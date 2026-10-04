import { test } from "node:test";
import assert from "node:assert/strict";
import { geminiDeclarationForFunction } from "../src/lib/gemini-core";

// Production 400 (2026-10-04): a connector schema carrying `x-mcp-header` went
// out on `parameters`, which rejects unknown keys, and failed every Gemini turn.
test("connector schemas with vendor keys go to parametersJsonSchema, sanitized", () => {
  const tools = [
      {
        type: "function",
        function: {
          name: "connector__list_events",
          description: "List events",
          parameters: {
            type: "object",
            properties: {
              from: { type: "string", description: "Start", "x-mcp-header": "X-From" },
              to: { type: "string", description: "End" },
            },
            required: ["from"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search",
          parameters: { type: "object", properties: { q: { type: "string", description: "Query" } }, required: ["q"] },
        },
      },
  ];

  const [connector, portable] = tools.map((t) => geminiDeclarationForFunction(t.function));
  assert.equal(connector.parameters, undefined);
  assert.ok(!JSON.stringify(connector.parametersJsonSchema).includes("x-mcp-header"));
  assert.deepEqual((connector.parametersJsonSchema as { required: string[] }).required, ["from"]);
  assert.ok(portable.parameters);
  assert.equal(portable.parametersJsonSchema, undefined);
});
