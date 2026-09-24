import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { createLoopController, FINAL_ROUND_NOTE } from "@/lib/llm/loop";
import { legacyToolRunner } from "@/lib/llm/openai-shared";
import { runResponsesLoop, type ResponsesDialect, type ResponsesInputItem } from "@/lib/llm/responses-loop";
import type { AdapterRequest, ProviderTransport } from "@/lib/llm/types";
import type { McpToolset, ToolExecution } from "@/lib/mcp";
import { MODEL_LIST, resolveModel, type ModelInfo } from "@/lib/models";
import { providerAdapterFor } from "@/lib/provider-routing";
import type { BatchResult, executeToolBatch, ToolCallInput } from "@/lib/tools/dispatch";
import type { ChatToolset } from "@/lib/tools/types";
import type { LlmEvent } from "@/types/llm";

/*
 * The Responses tool loop — every OpenAI model and Grok on xAI's Responses
 * surface (SPEC §5.2, §5.5) — driven offline through its transport seam
 * (SPEC §5.0, §13 harness rule 2). Each scripted response is the event
 * sequence the SDK yields; each recorded body is what the provider received.
 */

// ── Fakes ───────────────────────────────────────────────────────────────────

function model(id: string): ModelInfo {
  const resolved = resolveModel(id);
  assert.ok(resolved, `${id} resolves`);
  return resolved;
}

function scripted(responses: unknown[][]) {
  const bodies: Array<Record<string, unknown>> = [];
  let next = 0;
  const transport: ProviderTransport = {
    async *request(body) {
      bodies.push(structuredClone(body) as Record<string, unknown>);
      const events = responses[next++];
      if (!events) throw new Error("the script has no response left");
      for (const event of events) yield event;
    },
  };
  return { transport, bodies };
}

function fakeToolset(names: string[]): ChatToolset {
  return {
    tools: names.map((name) => ({
      type: "function" as const,
      function: { name, description: `the ${name} tool`, parameters: { type: "object", properties: {} } },
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

interface Outcome {
  text: string;
  isError?: boolean;
  images?: BatchResult["images"];
}

/** Stands in for `executeToolBatch`: records what it was handed, answers from a table. */
function fakeDispatch(outcomes: Record<string, Outcome>) {
  const batches: ToolCallInput[][] = [];
  const finals: boolean[] = [];
  const dispatch: typeof executeToolBatch = async function* (calls, _signal, ctx) {
    batches.push([...calls]);
    finals.push(ctx.nextIsFinal);
    const results: BatchResult[] = [];
    for (const call of calls) {
      const outcome = outcomes[call.name] ?? { text: "ok" };
      yield {
        type: "tool",
        phase: "result",
        server: ctx.toolset.labelFor(call.name),
        name: call.name,
        callId: call.callId,
        round: call.round,
        index: call.index,
        result: outcome.text,
        ok: !outcome.isError,
        status: outcome.isError ? "failed" : "succeeded",
      };
      results.push({
        callId: call.callId,
        name: call.name,
        ...(call.providerCallId === undefined ? {} : { providerCallId: call.providerCallId }),
        text: outcome.text,
        isError: !!outcome.isError,
        images: outcome.images ?? [],
      });
    }
    return results;
  };
  return { dispatch, batches, finals };
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

const USER: ResponsesInputItem[] = [{ role: "user", content: [{ type: "input_text", text: "hi" }] }];

async function run(
  req: AdapterRequest,
  responses: unknown[][],
  opts: { dialect?: ResponsesDialect; dispatch?: typeof executeToolBatch; legacyToolset?: McpToolset } = {},
) {
  const { transport, bodies } = scripted(responses);
  const events: LlmEvent[] = [];
  for await (const event of runResponsesLoop({
    req,
    dialect: opts.dialect ?? (req.model.provider === "xai" ? "xai" : "openai"),
    history: USER,
    transport,
    dispatch: opts.dispatch,
    legacyToolset: opts.legacyToolset,
  })) {
    events.push(event);
  }
  return { events, bodies };
}

// ── Stream events ───────────────────────────────────────────────────────────

function message(id: string, text: string, phase?: string) {
  const item = { type: "message", id, role: "assistant", status: "completed", ...(phase ? { phase } : {}) };
  return [
    { type: "response.output_item.added", item: { ...item, content: [] } },
    { type: "response.output_text.delta", item_id: id, delta: text },
    { type: "response.output_item.done", item: { ...item, content: [{ type: "output_text", text, annotations: [] }] } },
  ];
}

function reasoning(id: string, summary: string) {
  return [
    { type: "response.output_item.added", item: { type: "reasoning", id } },
    { type: "response.reasoning_summary_part.added", item_id: id },
    { type: "response.reasoning_summary_text.delta", item_id: id, delta: summary },
    {
      type: "response.output_item.done",
      item: { type: "reasoning", id, encrypted_content: `enc-${id}`, summary: [{ type: "summary_text", text: summary }] },
    },
  ];
}

function functionCall(callId: string, name: string, args: string) {
  return [
    { type: "response.output_item.added", item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: "" } },
    {
      type: "response.output_item.done",
      item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: args, status: "completed" },
    },
  ];
}

function webSearch(id: string, query: string, urls: string[]) {
  return [
    { type: "response.output_item.added", item: { type: "web_search_call", id, status: "in_progress" } },
    {
      type: "response.output_item.done",
      item: {
        type: "web_search_call",
        id,
        status: "completed",
        action: { type: "search", query, sources: urls.map((url) => ({ type: "url", url })) },
      },
    },
  ];
}

function completed(input: number, output: number, extra: Record<string, unknown> = {}) {
  return { type: "response.completed", response: { usage: { input_tokens: input, output_tokens: output, total_tokens: input + output }, ...extra } };
}

const of = <T extends LlmEvent["type"]>(events: LlmEvent[], type: T) =>
  events.filter((event): event is Extract<LlmEvent, { type: T }> => event.type === type);

// ── Tests ───────────────────────────────────────────────────────────────────

test("the loop has no server-only module in its static graph", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/llm/responses-loop.ts"), "utf8");
  assert.doesNotMatch(source, /^import "server-only";/m);
  const staticImports = source.split("\n").filter((line) => /^import (?!type )/.test(line)).join("\n");
  assert.doesNotMatch(staticImports, /@\/lib\/(llm|mcp|openai-responses|storage|prisma)"/);
});

test("every OpenAI model is routed to Responses, and OPENAI_RESPONSES=0 keeps today's routing", () => {
  const openai = MODEL_LIST.filter((m) => m.provider === "openai" && m.modality === "chat");
  assert.ok(openai.length > 10);
  for (const m of openai) assert.equal(providerAdapterFor(m), "openai-responses", m.id);

  const saved = process.env.OPENAI_RESPONSES;
  process.env.OPENAI_RESPONSES = "0";
  try {
    assert.equal(providerAdapterFor(model("openai:gpt-6-sol")), "openai-compatible");
    // The Responses-only snapshots and Pro mode have no other route.
    assert.equal(providerAdapterFor(model("openai:gpt-5.5-pro")), "openai-responses");
    assert.equal(providerAdapterFor(model("openai:gpt-6-sol"), true), "openai-responses");
  } finally {
    if (saved === undefined) delete process.env.OPENAI_RESPONSES;
    else process.env.OPENAI_RESPONSES = saved;
  }
});

test("a tool round: the call_id reaches the dispatcher, args stay raw, every item is replayed in order", async () => {
  const { dispatch, batches } = fakeDispatch({ search_chats: { text: "found 2 chats" } });
  const req = request(model("openai:gpt-6-sol"), { toolset: fakeToolset(["search_chats"]), batch, reasoningEffort: "medium" });
  const { events, bodies } = await run(
    req,
    [
      [
        ...reasoning("rs_1", "Looking it up."),
        ...message("msg_1", "Let me check.", "commentary"),
        ...functionCall("call_abc", "search_chats", '{"query": "tax'),
        completed(100, 20),
      ],
      [...message("msg_2", "Here it is.", "final_answer"), completed(150, 10)],
    ],
    { dispatch },
  );

  // RC-13: the provider's call_id is the call's id end to end. RC-14: the
  // malformed JSON reaches the dispatcher as the provider sent it.
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], [
    { name: "search_chats", round: 0, index: 0, argsText: '{"query": "tax', callId: "call_abc", providerCallId: "call_abc" },
  ]);
  const call = of(events, "tool").find((event) => event.phase === "call");
  assert.ok(call && call.phase === "call");
  assert.equal(call.callId, "call_abc");
  assert.equal(call.args, '{"query": "tax');
  assert.equal(call.round, 0);
  assert.equal(call.index, 0);

  // H6: the second request replays the first one's output verbatim and in
  // wire order — reasoning (encrypted), the message with its phase, the call —
  // then the output for the call.
  const input = bodies[1].input as Array<Record<string, unknown>>;
  const tail = input.slice(-4);
  assert.deepEqual(tail.map((item) => item.type), ["reasoning", "message", "function_call", "function_call_output"]);
  assert.equal(tail[0].encrypted_content, "enc-rs_1");
  assert.equal(tail[1].phase, "commentary");
  assert.deepEqual(tail[3], { type: "function_call_output", call_id: "call_abc", output: "found 2 chats" });
  // The first request is not changed by what the loop appends afterwards.
  assert.equal((bodies[0].input as unknown[]).length, 2);
});

test("usage is yielded after every request, cumulative, with its round", async () => {
  const { dispatch } = fakeDispatch({});
  const req = request(model("openai:gpt-6-luna"), { toolset: fakeToolset(["calculate"]), batch });
  const { events } = await run(
    req,
    [
      [...functionCall("call_1", "calculate", "{}"), completed(100, 20)],
      [...message("msg_1", "4"), completed(130, 5)],
    ],
    { dispatch },
  );
  const usage = of(events, "usage");
  assert.deepEqual(
    usage.map((u) => [u.round, u.input, u.output]),
    [[0, 100, 20], [1, 230, 25]],
  );
  // Each request's usage precedes its round_end, and the answer round ends the loop.
  const rounds = of(events, "round_end");
  assert.deepEqual(rounds.map((r) => [r.round, r.tools, r.final]), [[0, 1, false], [1, 0, false]]);
  assert.deepEqual(events.at(-1), { type: "finish", reason: "stop", raw: "stop" });
});

test("a failed result goes back as `Error: …`, since Responses has no is_error", async () => {
  const { dispatch } = fakeDispatch({ web_fetch: { text: "Timed out after 20 s.", isError: true } });
  const req = request(model("openai:gpt-6-sol"), { toolset: fakeToolset(["web_fetch"]), batch });
  const { bodies } = await run(
    req,
    [[...functionCall("call_f", "web_fetch", '{"url":"https://x.test"}'), completed(10, 1)], [...message("m", "Sorry."), completed(10, 1)]],
    { dispatch },
  );
  const output = (bodies[1].input as Array<Record<string, unknown>>).at(-1);
  assert.deepEqual(output, { type: "function_call_output", call_id: "call_f", output: "Error: Timed out after 20 s." });
});

test("phase is read per output item: a commentary item and a final_answer item in one round", async () => {
  const { events } = await run(request(model("openai:gpt-5.5")), [
    [...message("msg_a", "First I will think.", "commentary"), ...message("msg_b", "The answer is 4.", "final_answer"), completed(5, 5)],
  ]);
  assert.deepEqual(
    of(events, "text").map((t) => [t.text, t.phase, t.round]),
    [["First I will think.", "commentary", 0], ["The answer is 4.", "answer", 0]],
  );
});

test("include carries encrypted reasoning only for reasoning models, and hosted search asks for its sources", async () => {
  const plain = await run(request(model("openai:gpt-4o")), [[...message("m", "hi"), completed(1, 1)]]);
  assert.equal("include" in plain.bodies[0], false, "non-reasoning models reject reasoning.encrypted_content");
  assert.equal("reasoning" in plain.bodies[0], false);

  const searching = await run(request(model("openai:gpt-4o"), { webSearch: true }), [[...message("m", "hi"), completed(1, 1)]]);
  assert.deepEqual(searching.bodies[0].include, ["web_search_call.action.sources"]);
  assert.deepEqual(searching.bodies[0].tools, [{ type: "web_search", search_context_size: "medium" }]);
  assert.equal("tool_choice" in searching.bodies[0], false, "hosted search alone sets no tool_choice");

  const thinking = await run(request(model("openai:gpt-6-sol"), { webSearch: true, reasoningEffort: "high" }), [
    [...message("m", "hi"), completed(1, 1)],
  ]);
  assert.deepEqual(thinking.bodies[0].include, ["reasoning.encrypted_content", "web_search_call.action.sources"]);
  assert.deepEqual(thinking.bodies[0].reasoning, { effort: "high", summary: "detailed" });
  assert.equal(thinking.bodies[0].store, false);
});

test("hosted search at minimal is left off where the model rejects it (the original gpt-5)", async () => {
  const minimal = await run(request(model("openai:gpt-5"), { webSearch: true, reasoningEffort: "minimal" }), [
    [...message("m", "hi"), completed(1, 1)],
  ]);
  assert.equal("tools" in minimal.bodies[0], false);
  const low = await run(request(model("openai:gpt-5"), { webSearch: true, reasoningEffort: "low" }), [
    [...message("m", "hi"), completed(1, 1)],
  ]);
  assert.deepEqual(low.bodies[0].tools, [{ type: "web_search", search_context_size: "medium" }]);
});

test("a hosted search is reported, never dispatched, and a search after text starts a new step", async () => {
  const { dispatch, batches } = fakeDispatch({});
  const req = request(model("openai:gpt-6-sol"), { webSearch: true, toolset: fakeToolset(["calculate"]), batch });
  const { events } = await run(
    req,
    [
      [
        ...message("m1", "Checking the news."),
        ...webSearch("ws_1", "juno release", ["https://a.test/1", "https://b.test/2"]),
        ...message("m2", "It shipped."),
        completed(40, 8),
      ],
    ],
    { dispatch },
  );
  assert.equal(batches.length, 0);
  const server = of(events, "server_tool");
  assert.deepEqual(server, [
    { type: "server_tool", phase: "call", tool: "provider_web_search", callId: "ws_1", round: 0, query: "juno release" },
    { type: "server_tool", phase: "result", tool: "provider_web_search", callId: "ws_1", round: 0, results: 2, ok: true },
  ]);
  const sources = of(events, "sources");
  assert.equal(sources.length, 1);
  assert.equal(sources[0].origin, "provider_search");
  assert.deepEqual(sources[0].sources.map((s) => s.url), ["https://a.test/1", "https://b.test/2"]);
  assert.deepEqual(
    of(events, "round_end").map((r) => [r.round, r.tools, r.serverTools]),
    [[0, 0, 1], [1, 0, 0]],
    "the text before the search and the text after it are two steps",
  );
  assert.deepEqual(of(events, "text").map((t) => t.round), [0, 1]);
  assert.equal(of(events, "usage").at(-1)?.webSearchRequests, 1);
});

test("the final request keeps the tools and sets tool_choice none; the note rides the last result", async () => {
  const { dispatch, finals } = fakeDispatch({});
  const req = request(model("openai:gpt-6-sol"), {
    toolset: fakeToolset(["calculate"]),
    batch,
    loop: createLoopController({ budget: 2 }),
  });
  const { bodies, events } = await run(
    req,
    [[...functionCall("call_1", "calculate", "{}"), completed(1, 1)], [...message("m", "Done."), completed(1, 1)]],
    { dispatch },
  );
  assert.equal(bodies[0].tool_choice, "auto");
  assert.equal(bodies[1].tool_choice, "none");
  assert.equal((bodies[1].tools as unknown[]).length, 1, "the tools stay, so the cache and preserved thinking do");
  assert.deepEqual(finals, [true], "the batch before the tools-off request is told it is the last");
  assert.deepEqual(of(events, "round_end").map((r) => r.final), [false, true]);
});

test("a tools-off request that still calls a tool finishes length, and the call is cancelled, not run", async () => {
  const { dispatch, batches } = fakeDispatch({});
  const req = request(model("openai:gpt-6-sol"), { toolset: fakeToolset(["calculate"]), batch, loop: createLoopController({ budget: 1 }) });
  const { events } = await run(req, [[...functionCall("call_1", "calculate", "{}"), completed(1, 1)]], { dispatch });
  assert.equal(batches.length, 0);
  const result = of(events, "tool").find((event) => event.phase === "result");
  assert.ok(result && result.phase === "result");
  assert.equal(result.status, "cancelled");
  assert.deepEqual(events.at(-1), { type: "finish", reason: "length", raw: "length" });
});

test("a response cut at max_output_tokens never runs its calls", async () => {
  const { dispatch, batches } = fakeDispatch({});
  const req = request(model("openai:gpt-6-sol"), { toolset: fakeToolset(["calculate"]), batch });
  const { events } = await run(
    req,
    [[
      ...functionCall("call_1", "calculate", '{"expr":"1+'),
      { type: "response.incomplete", response: { usage: { input_tokens: 1, output_tokens: 1 }, incomplete_details: { reason: "max_output_tokens" } } },
    ]],
    { dispatch },
  );
  assert.equal(batches.length, 0);
  assert.deepEqual(events.at(-1), { type: "finish", reason: "length", raw: "length" });
});

test("tool images ride on the output as input_image parts; there is no extra user turn", async () => {
  const image = { mimeType: "image/png", base64: "AAAA", label: "crop" };
  const { dispatch } = fakeDispatch({ inspect_image: { text: "a crop", images: [image] } });
  const req = request(model("openai:gpt-6-sol"), { toolset: fakeToolset(["inspect_image"]), batch });
  const { bodies } = await run(
    req,
    [[...functionCall("call_i", "inspect_image", "{}"), completed(1, 1)], [...message("m", "A plate."), completed(1, 1)]],
    { dispatch },
  );
  const input = bodies[1].input as Array<Record<string, unknown>>;
  assert.deepEqual(input.at(-1), {
    type: "function_call_output",
    call_id: "call_i",
    output: [
      { type: "input_text", text: "a crop" },
      { type: "input_image", detail: "high", image_url: "data:image/png;base64,AAAA" },
    ],
  });
  assert.equal(input.filter((item) => item.role === "user").length, 1, "only the person's own turn");
});

test("xAI: web_search only — never search_parameters, never x_search — with store:false and max_turns", async () => {
  const { dispatch } = fakeDispatch({});
  const req = request(model("xai:grok-4.7"), {
    webSearch: true,
    reasoningEffort: "high",
    toolset: fakeToolset(["calculate"]),
    batch,
    loop: createLoopController({ budget: 10 }),
  });
  const { bodies, events } = await run(
    req,
    [
      [...message("m1", "Let me add.", "commentary"), ...functionCall("call_x", "calculate", "{}"), completed(10, 2)],
      [
        ...webSearch("ws_x", "grok news", []),
        ...message("m2", "Done."),
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1, server_side_tool_usage: { SERVER_SIDE_TOOL_WEB_SEARCH: 2 } }, citations: ["https://x.ai/news"] } },
      ],
    ],
    { dispatch },
  );
  for (const body of bodies) {
    assert.equal("search_parameters" in body, false, "Live Search answers 410");
    assert.equal(body.store, false);
    const tools = body.tools as Array<{ type: string }>;
    assert.deepEqual(tools.map((t) => t.type), ["function", "web_search"]);
    assert.deepEqual(tools.at(-1), { type: "web_search" });
    assert.equal("prompt_cache_key" in body, false);
    assert.deepEqual(body.reasoning, { effort: "high" });
  }
  assert.equal(bodies[0].max_turns, 10);
  assert.equal(bodies[1].max_turns, 9, "bounded by what is left of the turn's budget");
  // The system prompt travels as an input message, and xAI has no phase.
  const input = bodies[1].input as Array<Record<string, unknown>>;
  assert.equal(input[0].role, "system");
  const replayed = input.find((item) => item.type === "message");
  assert.ok(replayed);
  assert.equal("phase" in replayed, false);
  // No phase on xAI's text either, and search is billed from its own counter.
  assert.equal(of(events, "text").every((t) => t.phase === undefined), true);
  assert.equal(of(events, "usage").at(-1)?.webSearchRequests, 2);
  assert.deepEqual(of(events, "sources").at(-1)?.sources.map((s) => s.url), ["https://x.ai/news"]);
});

test("Grok 4.20 Multi-Agent takes no function tools, whatever the caller passed", async () => {
  const { dispatch } = fakeDispatch({});
  const req = request(model("xai:grok-4.20-multi-agent-0309"), { webSearch: true, toolset: fakeToolset(["calculate"]), batch });
  const { bodies } = await run(req, [[...message("m", "hi"), completed(1, 1)]], { dispatch });
  assert.deepEqual(bodies[0].tools, [{ type: "web_search" }]);
  assert.equal("tool_choice" in bodies[0], false);
});

test("the deprecated McpToolset path reports malformed arguments instead of running them as {}", async () => {
  const executed: Array<{ name: string; args: Record<string, unknown>; callId?: string }> = [];
  const toolset: McpToolset = {
    tools: fakeToolset(["lookup"]).tools,
    labelFor: () => "Lookup",
    accessFor: () => "read",
    async execute(name, args, _signal, callId): Promise<ToolExecution> {
      executed.push({ name, args, callId });
      return { text: "result text", body: "result body", ok: true };
    },
    close: async () => undefined,
  };
  const loop = createLoopController({ budget: 2 });
  loop.beginRequest();
  const runner = legacyToolRunner(toolset, loop);
  const events: LlmEvent[] = [];
  const iterator = runner(
    [
      { name: "lookup", callId: "c1", providerCallId: "c1", round: 0, index: 0, argsText: '{"q":' },
      { name: "lookup", callId: "c2", providerCallId: "c2", round: 0, index: 1, argsText: '{"q":"juno"}' },
    ],
    new AbortController().signal,
  );
  let step = await iterator.next();
  while (!step.done) {
    events.push(step.value);
    step = await iterator.next();
  }
  const results = step.value;
  assert.deepEqual(executed, [{ name: "lookup", args: { q: "juno" }, callId: "c2" }], "only the valid call ran, with its id");
  assert.equal(results[0].isError, true);
  assert.equal(results[0].errorCode, "invalid_args");
  assert.match(results[0].text, /not valid JSON/);
  // The request that follows is the tools-off one, so the last result says so.
  assert.equal(results[1].text, `result text\n\n${FINAL_ROUND_NOTE}`);
  assert.deepEqual(
    events.filter((e) => e.type === "tool" && e.phase === "result").map((e) => e.type === "tool" && e.phase === "result" && e.status),
    ["failed", "succeeded"],
  );
});
