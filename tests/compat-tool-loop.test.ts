import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { compatReasoningFields, runCompatLoop, type CompatMessage } from "@/lib/llm/compat-loop";
import { createLoopController } from "@/lib/llm/loop";
import type { AdapterRequest, ProviderTransport } from "@/lib/llm/types";
import { resolveModel, type ModelInfo } from "@/lib/models";
import type { BatchResult, executeToolBatch, ToolCallInput } from "@/lib/tools/dispatch";
import type { ChatToolset } from "@/lib/tools/types";
import type { LlmEvent } from "@/types/llm";

/*
 * The OpenAI-compatible tool loop (SPEC §5.4), driven offline through its
 * transport seam (SPEC §5.0, §13 harness rule 2). Each scripted response is
 * the chunk sequence a Chat Completions stream yields; each recorded body is
 * what the host received.
 */

// ── Fakes ───────────────────────────────────────────────────────────────────

function model(id: string, over: Partial<ModelInfo> = {}): ModelInfo {
  const resolved = resolveModel(id);
  assert.ok(resolved, `${id} resolves`);
  return { ...resolved, ...over };
}

function scripted(responses: unknown[][]) {
  const bodies: Array<Record<string, unknown>> = [];
  let next = 0;
  const transport: ProviderTransport = {
    async *request(body) {
      bodies.push(structuredClone(body) as Record<string, unknown>);
      const chunks = responses[next++];
      if (!chunks) throw new Error("the script has no response left");
      for (const chunk of chunks) yield chunk;
    },
  };
  return { transport, bodies };
}

function fakeToolset(names: string[]): ChatToolset {
  return {
    tools: names.map((name) => ({
      type: "function" as const,
      function: { name, description: `the ${name} tool`, parameters: { type: "object", properties: {} } },
      annotations: { readOnlyHint: true },
    })),
    labelFor: (name) => `Label ${name}`,
    accessFor: () => "read",
    execute: async () => {
      throw new Error("the fake dispatcher runs every call");
    },
    close: async () => undefined,
    resolve: () => undefined,
    connectors: [],
  };
}

const batch = {
  toolContext: {},
  cache: new Map(),
  fees: {},
  seenCallIds: new Set<string>(),
  ports: {
    authorizeExternalAction: null,
    completeExternalAction: null,
    recordToolInvocation: null,
    settleToolInvocation: null,
    resolvedPolicy: null,
  },
} as unknown as NonNullable<AdapterRequest["batch"]>;

function fakeDispatch(outcomes: Record<string, { text: string; isError?: boolean; images?: BatchResult["images"] }> = {}) {
  const batches: ToolCallInput[][] = [];
  const dispatch: typeof executeToolBatch = async function* (calls) {
    batches.push([...calls]);
    const results: BatchResult[] = [];
    for (const call of calls) {
      const outcome = outcomes[call.name] ?? { text: "ok" };
      yield { type: "tool", phase: "status", callId: call.callId, status: "running" };
      results.push({
        callId: call.callId,
        name: call.name,
        ...(call.providerCallId === undefined ? {} : { providerCallId: call.providerCallId }),
        text: outcome.text,
        isError: !!outcome.isError,
        status: outcome.isError ? "failed" : "succeeded",
        images: outcome.images ?? [],
      });
    }
    return results;
  };
  return { dispatch, batches };
}

function request(m: ModelInfo, over: Partial<AdapterRequest> = {}): AdapterRequest {
  return {
    model: m,
    system: "You are Juno.",
    history: [],
    maxTokens: 4_000,
    webSearch: false,
    loop: createLoopController({ budget: 10 }),
    ...over,
  };
}

const MESSAGES: CompatMessage[] = [
  { role: "system", content: "You are Juno." },
  { role: "user", content: "hi" },
];

async function run(req: AdapterRequest, responses: unknown[][], dispatch?: typeof executeToolBatch) {
  const { transport, bodies } = scripted(responses);
  const events: LlmEvent[] = [];
  for await (const event of runCompatLoop({ req, messages: MESSAGES, transport, dispatch })) events.push(event);
  return { events, bodies };
}

// ── Chunks ──────────────────────────────────────────────────────────────────

const text = (content: string) => ({ choices: [{ delta: { content } }] });
const thinking = (reasoning_content: string) => ({ choices: [{ delta: { reasoning_content } }] });
const call = (index: number, name: string, args: string, id?: string) => ({
  choices: [{ delta: { tool_calls: [{ index, ...(id ? { id } : {}), function: { name, arguments: args } }] } }],
});
const finish = (reason: string, usage?: Record<string, number>) => ({
  choices: [{ delta: {}, finish_reason: reason }],
  ...(usage ? { usage } : {}),
});

const of = <T extends LlmEvent["type"]>(events: LlmEvent[], type: T) =>
  events.filter((event): event is Extract<LlmEvent, { type: T }> => event.type === type);

// ── Tests ───────────────────────────────────────────────────────────────────

test("the loop has no server-only module in its static graph", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/llm/compat-loop.ts"), "utf8");
  assert.doesNotMatch(source, /^import "server-only";/m);
  const staticImports = source.split("\n").filter((line) => /^import (?!type )/.test(line)).join("\n");
  assert.doesNotMatch(staticImports, /@\/lib\/(llm|mcp|openai-compat|storage|prisma)"/);
});

test("a streamed call with no id gets jc_<round>_<index>, and that id goes back on the wire", async () => {
  const { dispatch, batches } = fakeDispatch({ calculate: { text: "4" } });
  const req = request(model("qwen:qwen3.8-max"), { toolset: fakeToolset(["calculate"]), batch });
  const { bodies, events } = await run(
    req,
    [
      [call(0, "calculate", '{"expr":"2+2"}'), finish("tool_calls", { prompt_tokens: 10, completion_tokens: 3 })],
      [text("4."), finish("stop", { prompt_tokens: 20, completion_tokens: 1 })],
    ],
    dispatch,
  );
  assert.deepEqual(batches[0], [{ name: "calculate", round: 0, index: 0, argsText: '{"expr":"2+2"}', callId: "jc_0_0" }]);
  const messages = bodies[1].messages as Array<Record<string, unknown>>;
  const assistant = messages.at(-2)!;
  assert.equal((assistant.tool_calls as Array<{ id: string }>)[0].id, "jc_0_0");
  assert.deepEqual(messages.at(-1), { role: "tool", tool_call_id: "jc_0_0", content: "4" });
  const announced = of(events, "tool").find((event) => event.phase === "call");
  assert.ok(announced && announced.phase === "call");
  assert.equal(announced.callId, "jc_0_0");
  assert.equal("providerCallId" in announced, false);
});

test("the host's own id is kept, and malformed arguments reach the dispatcher raw (RC-14)", async () => {
  const { dispatch, batches } = fakeDispatch();
  const req = request(model("deepseek:deepseek-v4-pro"), { toolset: fakeToolset(["lookup"]), batch });
  await run(
    req,
    [[call(0, "lookup", '{"q": ', "call_7"), finish("tool_calls")], [text("ok"), finish("stop")]],
    dispatch,
  );
  assert.deepEqual(batches[0], [
    { name: "lookup", round: 0, index: 0, argsText: '{"q": ', callId: "call_7", providerCallId: "call_7" },
  ]);
});

test("usage comes after every request, cumulative and with its round; text and thinking carry theirs", async () => {
  const { dispatch } = fakeDispatch();
  const req = request(model("deepseek:deepseek-v4-pro"), { toolset: fakeToolset(["lookup"]), batch, reasoningEffort: "high" });
  const { events } = await run(
    req,
    [
      [thinking("Need data."), text("Looking."), call(0, "lookup", "{}", "c1"), finish("tool_calls", { prompt_tokens: 100, completion_tokens: 10 })],
      [thinking("Got it."), text("Done."), finish("stop", { prompt_tokens: 150, completion_tokens: 5 })],
    ],
    dispatch,
  );
  assert.deepEqual(of(events, "usage").map((u) => [u.round, u.input, u.output]), [[0, 100, 10], [1, 250, 15]]);
  assert.deepEqual(of(events, "text").map((t) => [t.text, t.round]), [["Looking.", 0], ["Done.", 1]]);
  assert.deepEqual(of(events, "reasoning").map((r) => [r.text, r.round]), [["Need data.", 0], ["Got it.", 1]]);
  assert.deepEqual(of(events, "round_end").map((r) => [r.round, r.tools, r.final]), [[0, 1, false], [1, 0, false]]);
  assert.deepEqual(events.at(-1), { type: "finish", reason: "stop", raw: "stop" });
});

test("the final request: tool_choice none where the host takes it, no tools where it does not", async () => {
  const cases: Array<[string, "tool_choice_none" | "omit_tools"]> = [
    ["deepseek:deepseek-v4-pro", "tool_choice_none"],
    ["moonshot:kimi-k3", "tool_choice_none"],
    ["mistral:mistral-large-latest", "tool_choice_none"],
    ["qwen:qwen3.8-max", "tool_choice_none"],
    ["zhipu:glm-5.3", "omit_tools"],
    ["minimax:MiniMax-M3", "omit_tools"],
    ["meta:muse-spark-1.3", "omit_tools"],
    ["mimo:mimo-v2.6-pro", "omit_tools"],
  ];
  for (const [id, mechanism] of cases) {
    const { dispatch } = fakeDispatch();
    const req = request(model(id), { toolset: fakeToolset(["lookup"]), batch, loop: createLoopController({ budget: 2 }) });
    const { bodies } = await run(req, [[call(0, "lookup", "{}", "c1"), finish("tool_calls")], [text("ok"), finish("stop")]], dispatch);
    assert.equal(bodies[0].tool_choice, "auto", id);
    if (mechanism === "tool_choice_none") {
      assert.equal(bodies[1].tool_choice, "none", id);
      assert.equal((bodies[1].tools as unknown[]).length, 1, `${id} keeps its tools`);
    } else {
      assert.equal("tools" in bodies[1], false, `${id} gets no tools`);
      assert.equal("tool_choice" in bodies[1], false, `${id} gets no tool_choice`);
    }
    for (const body of bodies) assert.notEqual(body.tool_choice, "required", id);
  }
});

test("the wire tools carry only the provider's shape", async () => {
  const { bodies } = await run(request(model("mistral:mistral-large-latest"), { toolset: fakeToolset(["lookup"]), batch }), [
    [text("hi"), finish("stop")],
  ]);
  assert.deepEqual(bodies[0].tools, [
    { type: "function", function: { name: "lookup", description: "the lookup tool", parameters: { type: "object", properties: {} } } },
  ]);
});

test("Qwen is asked for parallel calls; nobody else is", async () => {
  const qwen = await run(request(model("qwen:qwen3.8-max"), { toolset: fakeToolset(["lookup"]), batch }), [[text("hi"), finish("stop")]]);
  assert.equal(qwen.bodies[0].parallel_tool_calls, true);
  const kimi = await run(request(model("moonshot:kimi-k3"), { toolset: fakeToolset(["lookup"]), batch }), [[text("hi"), finish("stop")]]);
  assert.equal("parallel_tool_calls" in kimi.bodies[0], false);
});

test("results go back one tool message per call in order, then pictures in one user turn", async () => {
  const image = { mimeType: "image/png", base64: "AAAA", label: "crop" };
  const { dispatch } = fakeDispatch({ inspect_image: { text: "a crop", images: [image] }, lookup: { text: "nope", isError: true } });
  const req = request(model("moonshot:kimi-k3"), { toolset: fakeToolset(["inspect_image", "lookup"]), batch });
  const { bodies } = await run(
    req,
    [
      [call(0, "inspect_image", "{}", "a"), call(1, "lookup", "{}", "b"), finish("tool_calls")],
      [text("ok"), finish("stop")],
    ],
    dispatch,
  );
  const messages = (bodies[1].messages as Array<Record<string, unknown>>).slice(-3);
  assert.deepEqual(messages.map((m) => m.role), ["tool", "tool", "user"]);
  assert.deepEqual(messages[0], { role: "tool", tool_call_id: "a", content: "a crop" });
  // Chat Completions has no is_error either.
  assert.deepEqual(messages[1], { role: "tool", tool_call_id: "b", content: "Error: nope" });
  const parts = messages[2].content as Array<Record<string, unknown>>;
  assert.equal(parts[0].type, "text");
  assert.deepEqual(parts[1], { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
});

test("Mistral never gets a user message after a tool message: its pictures are named in the result", async () => {
  const image = { mimeType: "image/png", base64: "AAAA" };
  const { dispatch } = fakeDispatch({ inspect_image: { text: "a crop", images: [image] } });
  const req = request(model("mistral:mistral-medium-latest"), { toolset: fakeToolset(["inspect_image"]), batch });
  const { bodies } = await run(req, [[call(0, "inspect_image", "{}", "a"), finish("tool_calls")], [text("ok"), finish("stop")]], dispatch);
  const messages = bodies[1].messages as Array<Record<string, unknown>>;
  assert.equal(messages.at(-1)?.role, "tool");
  assert.match(String(messages.at(-1)?.content), /^a crop\n\n\[1 image\(s\) from this tool could not be shown to you here/);
});

test("a request that ran out of room never runs its calls", async () => {
  const { dispatch, batches } = fakeDispatch();
  const req = request(model("deepseek:deepseek-v4-pro"), { toolset: fakeToolset(["lookup"]), batch });
  const { events } = await run(req, [[call(0, "lookup", '{"q":"ju', "c1"), finish("length")]], dispatch);
  assert.equal(batches.length, 0);
  const result = of(events, "tool").find((event) => event.phase === "result");
  assert.ok(result && result.phase === "result");
  assert.equal(result.status, "cancelled");
  assert.deepEqual(events.at(-1), { type: "finish", reason: "length", raw: "length" });
});

test("Grok on this path never sends Live Search, and the header is the transport's", async () => {
  const { bodies } = await run(request(model("xai:grok-4.1-fast"), { webSearch: true, cacheKey: "conv-1" }), [[text("hi"), finish("stop")]]);
  assert.equal("search_parameters" in bodies[0], false, "Live Search answers 410");
  assert.equal("prompt_cache_key" in bodies[0], false);
});

test("Meta takes function names with at most one dot; a call comes back under the toolset's name", async () => {
  const { dispatch, batches } = fakeDispatch();
  const req = request(model("meta:muse-spark-1.3"), { toolset: fakeToolset(["a.b.c"]), batch });
  const { bodies } = await run(req, [[call(0, "a.b_c", "{}", "m1"), finish("tool_calls")], [text("ok"), finish("stop")]], dispatch);
  assert.equal((bodies[0].tools as Array<{ function: { name: string } }>)[0].function.name, "a.b_c");
  assert.equal(batches[0][0].name, "a.b.c");
  const assistant = (bodies[1].messages as Array<Record<string, unknown>>).at(-2)!;
  assert.equal((assistant.tool_calls as Array<{ function: { name: string } }>)[0].function.name, "a.b_c");
});

test("the catalog fixes reach the wire: DeepSeek Instant, GLM-5.3 effort, Kimi and MiniMax", () => {
  // DeepSeek V4 and V4.1 Flash think by default; Instant must SAY none.
  assert.deepEqual(compatReasoningFields(model("deepseek:deepseek-flash"), undefined), { reasoning_effort: "none" });
  assert.deepEqual(compatReasoningFields(model("deepseek:deepseek-v4-pro"), "max"), { reasoning_effort: "max" });
  // GLM-5.3 always thinks: the effort enum, never `thinking: disabled`.
  for (const effort of ["low", "high", "max"] as const) {
    assert.deepEqual(compatReasoningFields(model("zhipu:glm-5.3"), effort), { reasoning_effort: effort });
  }
  assert.deepEqual(compatReasoningFields(model("zhipu:glm-5.3"), undefined), {});
  // The on/off GLMs keep their toggle.
  assert.deepEqual(compatReasoningFields(model("zhipu:glm-4.7"), undefined), { thinking: { type: "disabled" } });
  // Kimi K2.7 rejects `disabled`, so it is never sent; K3 takes the enum.
  assert.deepEqual(compatReasoningFields(model("moonshot:kimi-k2.7-code"), undefined), {});
  assert.deepEqual(compatReasoningFields(model("moonshot:kimi-k3"), "high"), { reasoning_effort: "high" });
  assert.deepEqual(compatReasoningFields(model("minimax:MiniMax-M3"), "high"), { thinking: { type: "adaptive" }, reasoning_split: true });
  // A non-reasoning Mistral is never sent the parameter it rejects.
  assert.deepEqual(compatReasoningFields(model("mistral:mistral-large-latest"), undefined), {});
});

test("dynamic context lands just before the newest user turn, never ahead of the cached prefix", async () => {
  const { bodies } = await run(request(model("deepseek:deepseek-v4-pro"), { dynamicContext: "Today is Thursday." }), [
    [text("hi"), finish("stop")],
  ]);
  assert.deepEqual(bodies[0].messages, [
    { role: "system", content: "You are Juno." },
    { role: "system", content: "Today is Thursday." },
    { role: "user", content: "hi" },
  ]);
});
