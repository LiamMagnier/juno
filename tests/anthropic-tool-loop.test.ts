import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";

import { anthropicLoop, anthropicTools, anthropicWebSearchTool } from "@/lib/llm/anthropic-loop";
import { FINAL_ROUND_NOTE, createLoopController, providerSearchCapFor } from "@/lib/llm/loop";
import { legacyChatToolset, type ToolRoundRunner } from "@/lib/llm/tool-round";
import type { AdapterRequest, ProviderTransport } from "@/lib/llm/types";
import type { McpToolset } from "@/lib/mcp";
import { MODELS, type ModelInfo } from "@/lib/models";
import type { BatchResult, ToolCallInput } from "@/lib/tools/dispatch";
import { wrapUntrusted } from "@/lib/untrusted-content";
import type { LlmEvent } from "@/types/llm";

/*
 * The Anthropic tool loop driven end to end through a scripted transport
 * (SPEC §5.0, §5.1, §13 harness rule 2). Each test scripts the provider's raw
 * stream events per request, runs the loop, and asserts on two things: the
 * events the route would see, and the request bodies Anthropic would receive —
 * which is where a mistake is a 400 in production and nothing locally.
 */

type Ev = Record<string, unknown>;

const OPUS = MODELS["anthropic:claude-opus-5-5"];
const HAIKU = MODELS["anthropic:claude-haiku-4-5"];

function scripted(responses: Ev[][]) {
  const bodies: Array<Record<string, unknown>> = [];
  const transport: ProviderTransport = {
    async *request(body) {
      // A snapshot: the loop keeps appending to the same messages array.
      bodies.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
      const next = responses.shift();
      if (!next) throw new Error("the loop sent a request the script did not expect");
      for (const event of next) yield event;
    },
  };
  return { transport, bodies };
}

// ── Raw stream events ─────────────────────────────────────────────────────────

const messageStart = (input = 100): Ev => ({ type: "message_start", message: { usage: { input_tokens: input } } });
const start = (index: number, block: Ev): Ev => ({ type: "content_block_start", index, content_block: block });
const textDelta = (index: number, text: string): Ev => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
const jsonDelta = (index: number, partial: string): Ev => ({
  type: "content_block_delta",
  index,
  delta: { type: "input_json_delta", partial_json: partial },
});
const stop = (index: number): Ev => ({ type: "content_block_stop", index });
const messageDelta = (stopReason: string, output = 10, extra: Ev = {}): Ev => ({
  type: "message_delta",
  delta: { stop_reason: stopReason },
  usage: { output_tokens: output, ...extra },
});

function textResponse(text: string, input = 100): Ev[] {
  return [messageStart(input), start(0, { type: "text", text: "" }), textDelta(0, text), stop(0), messageDelta("end_turn")];
}

function toolUseResponse(uses: Array<{ id: string; name: string; json: string }>, opts: { lead?: string; input?: number } = {}): Ev[] {
  const events: Ev[] = [messageStart(opts.input ?? 100)];
  let index = 0;
  if (opts.lead) {
    events.push(start(index, { type: "text", text: "" }), textDelta(index, opts.lead), stop(index));
    index += 1;
  }
  for (const use of uses) {
    events.push(start(index, { type: "tool_use", id: use.id, name: use.name, input: {} }), jsonDelta(index, use.json), stop(index));
    index += 1;
  }
  events.push(messageDelta("tool_use"));
  return events;
}

// ── The turn around the loop ──────────────────────────────────────────────────

function githubToolset(): McpToolset {
  return {
    tools: [
      {
        type: "function",
        function: {
          name: "github__list_issues",
          description: "List issues",
          parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
        },
      },
      { type: "function", function: { name: "github__close_issue", description: "Close one", parameters: { type: "object", properties: {} } } },
    ],
    labelFor: () => "GitHub",
    accessFor: () => "read",
    execute: async () => {
      throw new Error("the scripted runner stands in for execution");
    },
    close: async () => undefined,
  };
}

interface RunnerCall {
  calls: ToolCallInput[];
  nextIsFinal: boolean;
}

/**
 * A runner that answers every call with `answer(call)` and records what it was
 * handed. Before the final request it appends the final-round note to the last
 * result, as the dispatcher does (SPEC §4.6), so a test can see where it lands.
 */
function fakeRunner(answer: (call: ToolCallInput) => Partial<BatchResult> = () => ({})) {
  const seen: RunnerCall[] = [];
  const runner: ToolRoundRunner = async function* (calls, _signal, nextIsFinal) {
    seen.push({ calls: [...calls], nextIsFinal });
    const results: BatchResult[] = [];
    for (const call of calls) {
      yield { type: "tool", phase: "status", callId: call.callId, status: "running" };
      const body = `result of ${call.name}`;
      results.push({
        callId: call.callId,
        name: call.name,
        ...(call.providerCallId ? { providerCallId: call.providerCallId } : {}),
        text: wrapUntrusted("GitHub", body),
        isError: false,
        status: "succeeded",
        images: [],
        ...answer(call),
      } as BatchResult);
    }
    const lastResult = results.at(-1);
    if (nextIsFinal && lastResult) lastResult.text = `${lastResult.text}\n\n${FINAL_ROUND_NOTE}`;
    return results;
  };
  return { runner, seen };
}

function request(over: Partial<AdapterRequest> & { budget?: number } = {}): AdapterRequest {
  const { budget, ...rest } = over;
  return {
    model: OPUS,
    system: "You are Juno.",
    history: [],
    maxTokens: 4096,
    webSearch: false,
    toolset: legacyChatToolset(githubToolset()),
    loop: createLoopController({ budget: budget ?? 10 }),
    ...rest,
  };
}

const USER: Anthropic.MessageParam[] = [{ role: "user", content: "What is open on juno?" }];

async function run(req: AdapterRequest, responses: Ev[][], runTools?: ToolRoundRunner | null, zdr = false) {
  const { transport, bodies } = scripted(responses);
  const events: LlmEvent[] = [];
  for await (const event of anthropicLoop(req, {
    transport,
    messages: structuredClone(USER),
    zdr,
    ...(runTools === undefined ? {} : { runTools }),
  })) {
    events.push(event);
  }
  assert.equal(responses.length, 0, "every scripted response was requested");
  return { events, bodies };
}

type Msg = { role: string; content: unknown };
/**
 * The request's messages without the conversation prompt-cache marker, which
 * rides on whichever block is newest (src/lib/anthropic-cache.ts, pinned by
 * tests/anthropic-cache-breakpoint.test.ts). `markerOf` reads it back.
 */
const messagesOf = (body: Record<string, unknown>) =>
  (body.messages as Msg[]).map((message) =>
    typeof message.content === "string"
      ? message
      : {
          ...message,
          content: (message.content as Array<Record<string, unknown>>).map(({ cache_control: _marker, ...block }) => block),
        },
  ) as Msg[];
const markerOf = (body: Record<string, unknown>) => {
  const raw = body.messages as Array<{ content: unknown }>;
  const content = raw[raw.length - 1]?.content;
  return Array.isArray(content) ? (content[content.length - 1] as { cache_control?: unknown }).cache_control : undefined;
};
const last = <T>(list: T[]): T => list[list.length - 1];
const ofType = <T extends LlmEvent["type"]>(events: LlmEvent[], type: T) =>
  events.filter((e): e is Extract<LlmEvent, { type: T }> => e.type === type);

test("the loop module is free of server-only", () => {
  assert.doesNotMatch(readFileSync("src/lib/llm/anthropic-loop.ts", "utf8"), /^import "server-only";/m);
  assert.doesNotMatch(readFileSync("src/lib/anthropic-round.ts", "utf8"), /^import "server-only";/m);
});

test("a tool round: raw arguments to the runner, one tool_result message back, the envelope to the model", async () => {
  const { runner, seen } = fakeRunner();
  const { events, bodies } = await run(
    request(),
    [
      toolUseResponse([{ id: "toolu_1", name: "github__list_issues", json: '{"repo":"juno"}' }], { lead: "Let me look." }),
      textResponse("Two issues are open."),
    ],
    runner,
  );

  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].tool_choice, { type: "auto" });
  const tools = bodies[0].tools as Array<Record<string, unknown>>;
  assert.deepEqual(tools.map((t) => t.name), ["github__list_issues", "github__close_issue"]);
  assert.ok(last(tools).cache_control, "one breakpoint on the last tool caches the whole array");

  // The runner saw the call with its provider id, round, index and RAW text.
  assert.deepEqual(seen[0].calls, [
    { name: "github__list_issues", callId: "toolu_1", providerCallId: "toolu_1", round: 0, index: 0, argsText: '{"repo":"juno"}' },
  ]);
  assert.equal(seen[0].nextIsFinal, false);

  // One user message of tool_result blocks and nothing else, answering the provider id.
  const followUp = last(messagesOf(bodies[1]));
  assert.equal(followUp.role, "user");
  // The conversation cache marker moved onto the newest tool result, so the
  // next round reads this one's prefix from cache.
  assert.deepEqual(markerOf(bodies[1]), { type: "ephemeral" });
  assert.deepEqual(followUp.content, [
    { type: "tool_result", tool_use_id: "toolu_1", content: wrapUntrusted("GitHub", "result of github__list_issues") },
  ]);
  const replayed = messagesOf(bodies[1]).at(-2);
  assert.equal(replayed?.role, "assistant");
  assert.deepEqual(
    (replayed?.content as Array<{ type: string }>).map((b) => b.type),
    ["text", "tool_use"],
  );

  // The step structure the route reads.
  const texts = ofType(events, "text");
  assert.deepEqual(texts.map((t) => [t.round, t.text]), [
    [0, "Let me look."],
    [1, "Two issues are open."],
  ]);
  assert.deepEqual(ofType(events, "round_end"), [
    { type: "round_end", round: 0, tools: 1, serverTools: 0, final: false, stop: "tool_use" },
    { type: "round_end", round: 1, tools: 0, serverTools: 0, final: false, stop: "end_turn" },
  ]);
  const call = ofType(events, "tool").find((e) => e.phase === "call");
  assert.deepEqual(call, { type: "tool", server: "GitHub", name: "github__list_issues", phase: "call", callId: "toolu_1", round: 0, index: 0 });
  const finalUsage = last(events);
  assert.ok(finalUsage.type === "usage");
  assert.deepEqual([finalUsage.input, finalUsage.output, finalUsage.round, finalUsage.fast], [200, 20, 1, false]);
  assert.deepEqual(ofType(events, "finish"), [{ type: "finish", reason: "stop", raw: "end_turn" }]);
});

test("usage is yielded after every request, cumulative and stamped with its round (SPEC §4.7)", async () => {
  const { runner } = fakeRunner();
  const { events } = await run(
    request(),
    [toolUseResponse([{ id: "toolu_1", name: "github__list_issues", json: "{}" }], { input: 1000 }), textResponse("Done.", 1500)],
    runner,
  );
  const usage = ofType(events, "usage");
  assert.deepEqual(
    usage.map((u) => [u.round, u.input, u.output]),
    [
      [0, 1000, 10],
      [1, 2500, 20],
      [1, 2500, 20],
    ],
  );
});

test("a failed call goes back with is_error (RC-14)", async () => {
  const { runner } = fakeRunner(() => ({ isError: true, errorCode: "tool_error", text: "The repository was not found." }));
  const { bodies } = await run(
    request(),
    [toolUseResponse([{ id: "toolu_1", name: "github__list_issues", json: '{"repo":"nope"}' }]), textResponse("It does not exist.")],
    runner,
  );
  assert.deepEqual(last(messagesOf(bodies[1])).content, [
    { type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "The repository was not found." },
  ]);
});

test("invalid tool JSON reaches the dispatcher as its raw text, never as {} (RC-14)", async () => {
  const { runner, seen } = fakeRunner(() => ({ isError: true, errorCode: "invalid_args", text: "The arguments were not valid JSON." }));
  const { bodies } = await run(
    request(),
    [toolUseResponse([{ id: "toolu_1", name: "github__list_issues", json: '{"repo":' }]), textResponse("Sorry.")],
    runner,
  );
  assert.equal(seen[0].calls[0].argsText, '{"repo":');
  // The REPLAYED block still needs an object, so only it degrades to {}.
  const replayed = messagesOf(bodies[1]).at(-2)?.content as Array<{ type: string; input?: unknown }>;
  assert.deepEqual(replayed.find((b) => b.type === "tool_use")?.input, {});
});

test("the final request keeps its tools and sets tool_choice none; the last result carries the note", async () => {
  // Budget 2: one request that may call tools, then the tools-off one.
  const { runner, seen } = fakeRunner();
  const { bodies, events } = await run(
    request({ budget: 2 }),
    [
      toolUseResponse([
        { id: "toolu_1", name: "github__list_issues", json: "{}" },
        { id: "toolu_2", name: "github__list_issues", json: "{}" },
      ]),
      textResponse("From what I have: two."),
    ],
    runner,
  );
  assert.equal(seen[0].nextIsFinal, true, "the runner is told the next request is the last");
  assert.deepEqual(bodies[1].tool_choice, { type: "none" });
  assert.deepEqual(bodies[1].tools, bodies[0].tools, "the tools array never changes within a turn");
  assert.equal(ofType(events, "round_end")[1].final, true);
  // The note rides INSIDE the last tool_result, exactly as the runner wrote
  // it; the follow-up holds the results and nothing else (SPEC §4.6).
  const body = wrapUntrusted("GitHub", "result of github__list_issues");
  assert.deepEqual(last(messagesOf(bodies[1])), {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: body },
      { type: "tool_result", tool_use_id: "toolu_2", content: `${body}\n\n${FINAL_ROUND_NOTE}` },
    ],
  });
});

test("a final request that still ends in tool_use closes those rows and finishes length", async () => {
  const { runner, seen } = fakeRunner();
  const { events } = await run(
    request({ budget: 1 }),
    [toolUseResponse([{ id: "toolu_9", name: "github__list_issues", json: "{}" }])],
    runner,
  );
  assert.equal(seen.length, 0, "nothing is dispatched from the tools-off request");
  const result = ofType(events, "tool").find((e) => e.phase === "result");
  assert.ok(result && result.phase === "result");
  assert.equal(result.callId, "toolu_9");
  assert.equal(result.status, "cancelled");
  assert.deepEqual(ofType(events, "round_end")[0], { type: "round_end", round: 0, tools: 0, serverTools: 0, final: true, stop: "tool_use" });
  assert.deepEqual(ofType(events, "finish"), [{ type: "finish", reason: "length", raw: "max_tokens" }]);
});

test("a response cut off by max_tokens mid-call never runs the call (SPEC §5.1 item 5)", async () => {
  const { runner, seen } = fakeRunner();
  const { events } = await run(
    request(),
    [
      [
        messageStart(),
        start(0, { type: "tool_use", id: "toolu_cut", name: "github__close_issue", input: {} }),
        jsonDelta(0, '{"issue":'),
        messageDelta("max_tokens"),
      ],
    ],
    runner,
  );
  assert.equal(seen.length, 0);
  const result = ofType(events, "tool").find((e) => e.phase === "result");
  assert.ok(result && result.phase === "result");
  assert.equal(result.status, "cancelled");
  assert.equal(result.args, '{"issue":');
  assert.deepEqual(ofType(events, "finish"), [{ type: "finish", reason: "length", raw: "max_tokens" }]);
});

test("a provider search inside a response is its own step, with its query streamed (SPEC §5.1 items 1-2)", async () => {
  const { events, bodies } = await run(
    request({ webSearch: true, toolset: undefined }),
    [
      [
        messageStart(),
        start(0, { type: "text", text: "" }),
        textDelta(0, "Let me check."),
        stop(0),
        start(1, { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} }),
        jsonDelta(1, '{"query":"juno rel'),
        jsonDelta(1, 'ease date"}'),
        stop(1),
        start(2, {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: [
            { type: "web_search_result", url: "https://a.example/juno", title: "Juno ships" },
            { type: "web_search_result", url: "https://b.example/juno", title: "" },
          ],
        }),
        stop(2),
        start(3, { type: "text", text: "" }),
        textDelta(3, "It shipped in May."),
        stop(3),
        messageDelta("end_turn", 20, { server_tool_use: { web_search_requests: 1 } }),
      ],
    ],
    null,
  );

  assert.deepEqual(
    events.filter((e) => e.type !== "usage" && e.type !== "finish"),
    [
      { type: "text", text: "Let me check.", round: 0 },
      { type: "server_tool", phase: "call", tool: "provider_web_search", callId: "srvtoolu_1", round: 0, query: "juno release date" },
      { type: "server_tool", phase: "result", tool: "provider_web_search", callId: "srvtoolu_1", round: 0, results: 2, ok: true },
      {
        type: "sources",
        sources: [
          { title: "Juno ships", url: "https://a.example/juno", snippet: "" },
          { title: "https://b.example/juno", url: "https://b.example/juno", snippet: "" },
        ],
        origin: "provider_search",
      },
      // The search ended the step it interrupted; neither step's text is commentary.
      { type: "round_end", round: 0, tools: 0, serverTools: 1, final: false, stop: null },
      { type: "text", text: "It shipped in May.", round: 1 },
      { type: "round_end", round: 1, tools: 0, serverTools: 0, final: false, stop: "end_turn" },
    ],
  );
  assert.equal(ofType(events, "usage").at(-1)?.webSearchRequests, 1);
  assert.equal(bodies.length, 1);
});

test("a failed provider search reports ok: false", async () => {
  const { events } = await run(
    request({ webSearch: true, toolset: undefined }),
    [
      [
        messageStart(),
        start(0, { type: "server_tool_use", id: "srvtoolu_2", name: "web_search", input: {} }),
        jsonDelta(0, '{"query":"x"}'),
        stop(0),
        start(1, { type: "web_search_tool_result", tool_use_id: "srvtoolu_2", content: { type: "web_search_tool_result_error", error_code: "unavailable" } }),
        stop(1),
        start(2, { type: "text", text: "" }),
        textDelta(2, "Search is down."),
        stop(2),
        messageDelta("end_turn"),
      ],
    ],
    null,
  );
  const result = ofType(events, "server_tool").find((e) => e.phase === "result");
  assert.deepEqual(result, { type: "server_tool", phase: "result", tool: "provider_web_search", callId: "srvtoolu_2", round: 0, results: 0, ok: false });
  // No text before the search: the search opened the step, so nothing closes early.
  assert.equal(ofType(events, "round_end").length, 1);
});

test("pause_turn is continued with the paused content — its search input intact — and counts as a request", async () => {
  const req = request({ webSearch: true, toolset: undefined, budget: 7 });
  const { bodies, events } = await run(
    req,
    [
      [
        messageStart(),
        start(0, { type: "server_tool_use", id: "srvtoolu_3", name: "web_search", input: {} }),
        jsonDelta(0, '{"query":"long research"}'),
        stop(0),
        messageDelta("pause_turn"),
      ],
      textResponse("Here is what I found."),
    ],
    null,
  );
  assert.equal(req.loop.requests, 2);
  const resent = last(messagesOf(bodies[1]));
  assert.equal(resent.role, "assistant", "no tool_result and no user text after a pause");
  assert.deepEqual(resent.content, [{ type: "server_tool_use", id: "srvtoolu_3", name: "web_search", input: { query: "long research" } }]);
  assert.deepEqual(ofType(events, "round_end").map((r) => [r.round, r.stop]), [
    [0, "pause_turn"],
    [1, "end_turn"],
  ]);
});

test("a search a pause_turn cut off gets its result in the continuation, paired with its call (SPEC §4.1)", async () => {
  const { events } = await run(
    request({ webSearch: true, toolset: undefined, budget: 7 }),
    [
      [
        messageStart(),
        start(0, { type: "text", text: "" }),
        textDelta(0, "Searching."),
        stop(0),
        start(1, { type: "server_tool_use", id: "srvtoolu_3", name: "web_search", input: {} }),
        jsonDelta(1, '{"query":"long research"}'),
        stop(1),
        messageDelta("pause_turn"),
      ],
      [
        messageStart(),
        // The paused search ran on the provider's side; its result opens the continuation.
        start(0, { type: "web_search_tool_result", tool_use_id: "srvtoolu_3", content: [] }),
        stop(0),
        start(1, { type: "text", text: "" }),
        textDelta(1, "Nothing turned up."),
        stop(1),
        messageDelta("end_turn"),
      ],
    ],
    null,
  );
  // A result event even with no hits: the route counts it against the turn's
  // search cap and closes the provider-search row with it.
  assert.deepEqual(
    ofType(events, "server_tool").map((e) => [e.phase, e.callId, e.round]),
    [
      ["call", "srvtoolu_3", 0],
      ["result", "srvtoolu_3", 0],
    ],
  );
  const result = ofType(events, "server_tool").find((e) => e.phase === "result");
  assert.deepEqual(result, { type: "server_tool", phase: "result", tool: "provider_web_search", callId: "srvtoolu_3", round: 0, results: 0, ok: true });
  // The step the search was made in was already closed by the pause: no
  // mid-response split in the continuation.
  assert.deepEqual(ofType(events, "round_end").map((r) => [r.round, r.stop]), [
    [0, "pause_turn"],
    [1, "end_turn"],
  ]);
});

test("the budget running out mid-pause finishes length rather than claiming an answer", async () => {
  const { events } = await run(
    request({ webSearch: true, toolset: undefined, budget: 1 }),
    [
      [
        messageStart(),
        start(0, { type: "server_tool_use", id: "srvtoolu_4", name: "web_search", input: {} }),
        jsonDelta(0, '{"query":"q"}'),
        stop(0),
        messageDelta("pause_turn"),
      ],
    ],
    null,
  );
  assert.deepEqual(ofType(events, "finish"), [{ type: "finish", reason: "length", raw: "max_tokens" }]);
});

test("dynamic filtering's nested server blocks are replayed, never surfaced (SPEC §5.1 item 9)", async () => {
  const { runner } = fakeRunner();
  const { events, bodies } = await run(
    request({ webSearch: true }),
    [
      [
        messageStart(),
        start(0, { type: "server_tool_use", id: "srvtoolu_5", name: "web_search", input: {} }),
        jsonDelta(0, '{"query":"q"}'),
        stop(0),
        start(1, { type: "server_tool_use", id: "srvtoolu_6", name: "web_fetch", input: {}, caller: { type: "code_execution" } }),
        jsonDelta(1, '{"url":"https://a.example"}'),
        stop(1),
        start(2, { type: "code_execution_tool_result", tool_use_id: "srvtoolu_6", content: { stdout: "ok" } }),
        stop(2),
        start(3, { type: "tool_use", id: "toolu_7", name: "github__list_issues", input: {} }),
        jsonDelta(3, "{}"),
        stop(3),
        messageDelta("tool_use"),
      ],
      textResponse("Done."),
    ],
    runner,
  );
  const calls = ofType(events, "server_tool").filter((e) => e.phase === "call");
  assert.deepEqual(calls.map((c) => c.callId), ["srvtoolu_5"]);
  const replayed = messagesOf(bodies[1]).at(-2)?.content as Array<{ type: string }>;
  assert.deepEqual(replayed.map((b) => b.type), ["server_tool_use", "server_tool_use", "code_execution_tool_result", "tool_use"]);
  // A mixed batch: the follow-up is tool_result blocks ONLY (SPEC §5.1 item 7).
  const followUp = last(messagesOf(bodies[1])).content as Array<{ type: string }>;
  assert.deepEqual(followUp.map((b) => b.type), ["tool_result"]);
  assert.deepEqual(ofType(events, "round_end")[0], { type: "round_end", round: 0, tools: 1, serverTools: 1, final: false, stop: "tool_use" });
});

test("web search: the 2026 version where the record says so, the basic one on Haiku (SPEC §5.1 item 6)", () => {
  const cap = providerSearchCapFor(10);
  assert.deepEqual(anthropicWebSearchTool(OPUS, cap, false), { type: "web_search_20260318", name: "web_search", max_uses: 6 });
  assert.deepEqual(anthropicWebSearchTool(MODELS["anthropic:claude-fable-5-1"], cap, false).type, "web_search_20260318");
  assert.deepEqual(anthropicWebSearchTool(MODELS["anthropic:claude-sonnet-5"], cap, false).type, "web_search_20260318");
  assert.deepEqual(anthropicWebSearchTool(HAIKU, cap, false), { type: "web_search_20250305", name: "web_search", max_uses: 6 });
  // Zero data retention restricts the 2026 version's callers; the basic one has none.
  assert.deepEqual(anthropicWebSearchTool(OPUS, cap, true), {
    type: "web_search_20260318",
    name: "web_search",
    max_uses: 6,
    allowed_callers: ["direct"],
  });
  assert.equal("allowed_callers" in anthropicWebSearchTool(HAIKU, cap, true), false);
  // A model nobody listed gets the lab's basic version.
  const unknown: ModelInfo = { ...OPUS, id: "anthropic:claude-next", providerModel: "claude-next" };
  assert.equal(anthropicWebSearchTool(unknown, cap, false).type, "web_search_20250305");
});

test("max_uses is the turn's search cap on every request, not the round budget", async () => {
  const { runner } = fakeRunner();
  const req = request({ webSearch: true, budget: 24 });
  const { bodies } = await run(
    req,
    [toolUseResponse([{ id: "toolu_1", name: "github__list_issues", json: "{}" }]), textResponse("ok")],
    runner,
  );
  const searchOf = (body: Record<string, unknown>) => (body.tools as Array<Record<string, unknown>>)[0];
  assert.equal(searchOf(bodies[0]).max_uses, 16);
  assert.deepEqual(searchOf(bodies[1]), searchOf(bodies[0]));
  // Server search first, then the client tools.
  assert.deepEqual(
    anthropicTools({ model: OPUS, tools: githubToolset().tools, webSearch: true, maxUses: 3, zdr: false }).map((t) => t.name),
    ["web_search", "github__list_issues", "github__close_issue"],
  );
});

test("a tool-less, search-less call sends no tools and no tool_choice", async () => {
  const { bodies, events } = await run(request({ toolset: undefined, budget: 1 }), [textResponse("Hi.")], null);
  assert.equal("tools" in bodies[0], false);
  assert.equal("tool_choice" in bodies[0], false);
  assert.deepEqual(ofType(events, "round_end"), [{ type: "round_end", round: 0, tools: 0, serverTools: 0, final: true, stop: "end_turn" }]);
});

test("call ids already used this generation are suffixed before anyone sees them (SPEC §4.3)", async () => {
  const { runner, seen } = fakeRunner();
  const seenCallIds = new Set(["toolu_1"]);
  const req = request({ batch: { seenCallIds } as unknown as AdapterRequest["batch"] });
  const { events, bodies } = await run(
    req,
    [toolUseResponse([{ id: "toolu_1", name: "github__list_issues", json: "{}" }]), textResponse("ok")],
    runner,
  );
  assert.equal(seen[0].calls[0].callId, "toolu_1#0.0");
  assert.equal(seen[0].calls[0].providerCallId, "toolu_1");
  const call = ofType(events, "tool").find((e) => e.phase === "call");
  assert.ok(call && call.phase === "call");
  assert.equal(call.callId, "toolu_1#0.0");
  assert.equal(call.providerCallId, "toolu_1");
  // The PROVIDER id is what goes back on the wire.
  assert.equal((last(messagesOf(bodies[1])).content as Array<{ tool_use_id: string }>)[0].tool_use_id, "toolu_1");
});

test("two calls in one round run as one batch and come back in call order", async () => {
  const { runner, seen } = fakeRunner();
  const { bodies } = await run(
    request(),
    [
      toolUseResponse([
        { id: "toolu_a", name: "github__list_issues", json: '{"repo":"a"}' },
        { id: "toolu_b", name: "github__list_issues", json: '{"repo":"b"}' },
      ]),
      textResponse("ok"),
    ],
    runner,
  );
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].calls.map((c) => [c.callId, c.index]), [
    ["toolu_a", 0],
    ["toolu_b", 1],
  ]);
  assert.deepEqual((last(messagesOf(bodies[1])).content as Array<{ tool_use_id: string }>).map((b) => b.tool_use_id), ["toolu_a", "toolu_b"]);
});

test("a consumer that stops reading early closes the provider request", async () => {
  let closed = false;
  let pulled = 0;
  const transport: ProviderTransport = {
    async *request() {
      try {
        for (const event of textResponse("One. Two. Three.")) {
          pulled += 1;
          yield event;
        }
      } finally {
        closed = true;
      }
    },
  };
  const loop = anthropicLoop(request({ toolset: undefined, budget: 1 }), { transport, messages: structuredClone(USER) });
  for await (const event of loop) {
    if (event.type === "text") break;
  }
  assert.equal(closed, true, "the transport's stream was returned, not left generating");
  assert.ok(pulled < textResponse("x").length, "and it was not read to the end");
});
