import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { GeminiContent } from "@/lib/gemini-core";
import { GeminiProviderError, type GeminiRequestContext } from "@/lib/gemini-network";
import { geminiLoop, geminiToolResponses } from "@/lib/llm/gemini-loop";
import { FINAL_ROUND_NOTE, createLoopController } from "@/lib/llm/loop";
import { legacyChatToolset, type ToolRoundRunner } from "@/lib/llm/tool-round";
import type { AdapterRequest, ProviderTransport } from "@/lib/llm/types";
import type { McpToolset } from "@/lib/mcp";
import { MODELS } from "@/lib/models";
import type { BatchResult, ToolCallInput } from "@/lib/tools/dispatch";
import type { ChatToolset, ResolvedTool } from "@/lib/tools/types";
import { wrapUntrusted } from "@/lib/untrusted-content";
import type { LlmEvent } from "@/types/llm";

/*
 * The Gemini tool loop driven end to end through a scripted transport (SPEC
 * §5.0, §5.3, §13 harness rule 2). The transport yields the decoded SSE
 * payloads Google would send; the tests assert on the events the route sees and
 * on the request bodies Google receives — the functionResponse shape above all,
 * which is where RC-7 (the model reading a web page's text outside the
 * untrusted envelope) and RC-13 (responses unpaired from their calls) lived.
 */

const FLASH = MODELS["google:gemini-3.8-flash"];
const PRO_25 = MODELS["google:gemini-2.5-pro"];

const CONTEXT: GeminiRequestContext = { modelId: FLASH.id, providerModel: FLASH.providerModel, endpoint: "test" };

type Script = Array<Array<Record<string, unknown>> | Error>;

function scripted(responses: Script) {
  const bodies: Array<Record<string, unknown>> = [];
  const transport: ProviderTransport = {
    async *request(body) {
      bodies.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
      const next = responses.shift();
      if (!next) throw new Error("the loop sent a request the script did not expect");
      if (next instanceof Error) throw next;
      for (const payload of next) yield JSON.stringify(payload);
    },
  };
  return { transport, bodies };
}

// ── Payloads ──────────────────────────────────────────────────────────────────

const usage = (output = 20, extra: Record<string, number> = {}) => ({
  promptTokenCount: 100,
  candidatesTokenCount: output,
  totalTokenCount: 100 + output,
  ...extra,
});

function frame(parts: Array<Record<string, unknown>>, finishReason?: string, extra: Record<string, unknown> = {}) {
  return {
    candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}), ...extra }],
    ...(finishReason ? { usageMetadata: usage() } : {}),
  };
}

const answer = (text: string, finishReason = "STOP") => [frame([{ text }], finishReason)];
const calling = (calls: Array<{ id?: string; name: string; args: Record<string, unknown> }>) => [
  frame(
    calls.map((call, i) => ({ functionCall: { ...(call.id ? { id: call.id } : {}), name: call.name, args: call.args }, ...(i === 0 ? { thoughtSignature: "SIG" } : {}) })),
    "STOP",
  ),
];

// ── The turn around the loop ──────────────────────────────────────────────────

function connectorToolset(): McpToolset {
  return {
    tools: [
      {
        type: "function",
        function: {
          name: "github__list_issues",
          description: "List issues",
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: { repo: { type: "string" }, state: { const: "open" } },
            required: ["repo"],
            additionalProperties: false,
          },
        },
      },
    ],
    labelFor: () => "GitHub",
    accessFor: () => "read",
    execute: async () => {
      throw new Error("the scripted runner stands in for execution");
    },
    close: async () => undefined,
  };
}

/** A toolset carrying one Juno spec (portable schema) beside the connector tool. */
function mixedToolset(): ChatToolset {
  const base = legacyChatToolset(connectorToolset());
  const fetchTool: ResolvedTool = {
    name: "web_fetch",
    canonical: "web_fetch",
    origin: "juno",
    title: "Read a page",
    risk: "read",
    parallelSafe: true,
    timeoutMs: 20_000,
    dedupe: true,
    present: () => ({}),
  };
  return {
    ...base,
    tools: [
      ...base.tools,
      {
        type: "function",
        function: {
          name: "web_fetch",
          description: "Read one page.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "The page." },
              mode: { type: "string", description: "How.", enum: ["text", "outline"] },
            },
            required: ["url"],
          },
        },
      },
    ],
    labelFor: (name) => (name === "web_fetch" ? "Web" : base.labelFor(name)),
    resolve: (name) => (name === "web_fetch" ? fetchTool : base.resolve(name)),
  };
}

interface RunnerCall {
  calls: ToolCallInput[];
  nextIsFinal: boolean;
}

/** Before the final request it appends the final-round note to the last result, as the dispatcher does (SPEC §4.6). */
function fakeRunner(answerFor: (call: ToolCallInput) => Partial<BatchResult> = () => ({})) {
  const seen: RunnerCall[] = [];
  const runner: ToolRoundRunner = async function* (calls, _signal, nextIsFinal) {
    seen.push({ calls: [...calls], nextIsFinal });
    const results: BatchResult[] = [];
    for (const call of calls) {
      yield { type: "tool", phase: "status", callId: call.callId, status: "running" };
      results.push({
        callId: call.callId,
        name: call.name,
        ...(call.providerCallId ? { providerCallId: call.providerCallId } : {}),
        text: wrapUntrusted("GitHub", `body of ${call.name}`),
        isError: false,
        images: [],
        ...answerFor(call),
      });
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
    model: FLASH,
    system: "You are Juno.",
    history: [],
    maxTokens: 4096,
    webSearch: false,
    toolset: legacyChatToolset(connectorToolset()),
    loop: createLoopController({ budget: budget ?? 10 }),
    ...rest,
  };
}

const USER: GeminiContent[] = [{ role: "user", parts: [{ text: "What is open on juno?" }] }];

async function run(req: AdapterRequest, responses: Script, runTools?: ToolRoundRunner | null) {
  const { transport, bodies } = scripted(responses);
  const events: LlmEvent[] = [];
  const quiet = silenceConsole();
  try {
    for await (const event of geminiLoop(req, {
      transport,
      contents: structuredClone(USER),
      context: CONTEXT,
      ...(runTools === undefined ? {} : { runTools }),
    })) {
      events.push(event);
    }
  } finally {
    quiet();
  }
  assert.equal(responses.length, 0, "every scripted response was requested");
  return { events, bodies };
}

/** The loop logs one operator line per turn; keep test output readable. */
function silenceConsole(): () => void {
  const { info, warn } = console;
  console.info = () => undefined;
  console.warn = () => undefined;
  return () => {
    console.info = info;
    console.warn = warn;
  };
}

type Content = { role: string; parts: Array<Record<string, unknown>> };
const contentsOf = (body: Record<string, unknown>) => body.contents as Content[];
const last = <T>(list: T[]): T => list[list.length - 1];
const ofType = <T extends LlmEvent["type"]>(events: LlmEvent[], type: T) =>
  events.filter((e): e is Extract<LlmEvent, { type: T }> => e.type === type);

test("the loop module is free of server-only", () => {
  assert.doesNotMatch(readFileSync("src/lib/llm/gemini-loop.ts", "utf8"), /^import "server-only";/m);
  assert.doesNotMatch(readFileSync("src/lib/gemini-core.ts", "utf8"), /^import "server-only";/m);
});

test("a tool round: the call id echoed, the ENVELOPED text as response.result (RC-7, RC-13)", async () => {
  const { runner, seen } = fakeRunner();
  const { events, bodies } = await run(
    request(),
    [calling([{ id: "fc-1", name: "github__list_issues", args: { repo: "juno" } }]), answer("Two are open.")],
    runner,
  );

  assert.deepEqual(seen[0].calls, [
    { name: "github__list_issues", callId: "fc-1", providerCallId: "fc-1", round: 0, index: 0, argsText: '{"repo":"juno"}' },
  ]);
  assert.equal(seen[0].nextIsFinal, false);

  const contents = contentsOf(bodies[1]);
  // The model turn replayed unchanged, id and signature included…
  assert.deepEqual(contents.at(-2), {
    role: "model",
    parts: [{ functionCall: { id: "fc-1", name: "github__list_issues", args: { repo: "juno" } }, thoughtSignature: "SIG" }],
  });
  // …then one user turn of functionResponse parts, answering by id, with the
  // text the dispatcher wrapped for the model — not the panel's stripped body.
  assert.deepEqual(last(contents), {
    role: "user",
    parts: [
      {
        functionResponse: {
          id: "fc-1",
          name: "github__list_issues",
          response: { result: wrapUntrusted("GitHub", "body of github__list_issues") },
        },
      },
    ],
  });
  assert.equal("toolConfig" in bodies[0], false, "Google's default AUTO on a request that may call tools");

  assert.deepEqual(
    events.filter((e) => e.type === "tool" || e.type === "round_end").map((e) => (e.type === "round_end" ? `end:${e.round}:${e.tools}` : `${e.phase}`)),
    ["call", "end:0:1", "status", "end:1:0"],
  );
  const call = ofType(events, "tool").find((e) => e.phase === "call");
  assert.deepEqual(call, {
    type: "tool",
    phase: "call",
    server: "GitHub",
    name: "github__list_issues",
    callId: "fc-1",
    round: 0,
    index: 0,
    args: '{"repo":"juno"}',
  });
  assert.deepEqual(ofType(events, "text"), [{ type: "text", text: "Two are open.", round: 1 }]);
  assert.deepEqual(ofType(events, "finish").map((f) => f.reason), ["stop"]);
});

test("a failure goes back as response.error with its code, never as a result (SPEC §5.3 item 3)", async () => {
  const { runner } = fakeRunner(() => ({ isError: true, errorCode: "timeout", text: "Timed out after 60 s." }));
  const { bodies } = await run(
    request(),
    [calling([{ id: "fc-1", name: "github__list_issues", args: {} }]), answer("It timed out.")],
    runner,
  );
  const response = (last(contentsOf(bodies[1])).parts[0].functionResponse as { response: Record<string, unknown> }).response;
  assert.deepEqual(response, { error: { code: "timeout", message: "Timed out after 60 s." } });
  assert.equal("result" in response, false);
});

test("a call Gemini sent without an id gets jc_<round>_<index>, and no id goes back", async () => {
  const { runner, seen } = fakeRunner();
  const { bodies } = await run(request(), [calling([{ name: "github__list_issues", args: {} }]), answer("ok")], runner);
  assert.equal(seen[0].calls[0].callId, "jc_0_0");
  assert.equal("providerCallId" in seen[0].calls[0], false);
  const fr = last(contentsOf(bodies[1])).parts[0].functionResponse as Record<string, unknown>;
  assert.equal("id" in fr, false);
});

test("the final request keeps its declarations under mode NONE, and the runner is told it is last", async () => {
  const { runner, seen } = fakeRunner();
  const { bodies, events } = await run(
    request({ budget: 2 }),
    [
      calling([
        { id: "fc-1", name: "github__list_issues", args: {} },
        { id: "fc-2", name: "github__list_issues", args: {} },
      ]),
      answer("From what I have."),
    ],
    runner,
  );
  assert.equal(seen[0].nextIsFinal, true, "the runner is told the next request is the last");
  assert.deepEqual(bodies[1].tools, bodies[0].tools);
  assert.deepEqual(bodies[1].toolConfig, { functionCallingConfig: { mode: "NONE" } });
  assert.equal(last(ofType(events, "round_end")).final, true);
  // The note rides INSIDE the last functionResponse, exactly as the runner
  // wrote it; the follow-up turn holds the responses and nothing else (SPEC §4.6).
  const body = wrapUntrusted("GitHub", "body of github__list_issues");
  assert.deepEqual(last(contentsOf(bodies[1])), {
    role: "user",
    parts: [
      { functionResponse: { id: "fc-1", name: "github__list_issues", response: { result: body } } },
      { functionResponse: { id: "fc-2", name: "github__list_issues", response: { result: `${body}\n\n${FINAL_ROUND_NOTE}` } } },
    ],
  });
});

test("a rejected mode NONE falls back to withholding the declarations, grounding kept (probe P2)", async () => {
  const { runner } = fakeRunner();
  const rejected = new GeminiProviderError({ httpStatus: 400, googleStatus: "INVALID_ARGUMENT", message: "bad toolConfig", context: CONTEXT });
  const { bodies, events } = await run(
    request({ budget: 2, webSearch: true }),
    [calling([{ id: "fc-1", name: "github__list_issues", args: {} }]), rejected, answer("ok")],
    runner,
  );
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies[1].toolConfig, { functionCallingConfig: { mode: "NONE" } });
  assert.deepEqual(bodies[2].tools, [{ google_search: {} }]);
  assert.equal("toolConfig" in bodies[2], false);
  assert.deepEqual(ofType(events, "text").map((t) => t.text), ["ok"]);
});

test("a final request that still asks for tools finishes length, nothing dispatched", async () => {
  const { runner, seen } = fakeRunner();
  const { events } = await run(request({ budget: 1 }), [calling([{ id: "fc-9", name: "github__list_issues", args: {} }])], runner);
  assert.equal(seen.length, 0);
  assert.deepEqual(ofType(events, "finish").map((f) => f.reason), ["length"]);
  assert.equal(ofType(events, "tool").length, 0, "no row was announced for a call that never ran");
});

test("Juno's own tools declare `parameters`; connector schemas go sanitized to `parametersJsonSchema`", async () => {
  const { bodies } = await run(request({ toolset: mixedToolset(), budget: 1 }), [answer("ok")], fakeRunner().runner);
  const declarations = (bodies[0].tools as Array<{ functionDeclarations?: Array<Record<string, unknown>> }>)[0].functionDeclarations;
  assert.ok(declarations);
  const [connector, juno] = declarations;
  assert.equal("parameters" in connector, false, "never both fields on one declaration");
  assert.deepEqual(connector.parametersJsonSchema, {
    type: "object",
    properties: { repo: { type: "string" }, state: { enum: ["open"] } },
    required: ["repo"],
    additionalProperties: false,
  });
  assert.equal("parametersJsonSchema" in juno, false);
  assert.deepEqual(juno.parameters, {
    type: "object",
    properties: {
      url: { type: "string", description: "The page." },
      mode: { type: "string", description: "How.", enum: ["text", "outline"], format: "enum" },
    },
    required: ["url"],
  });
});

test("before Gemini 3 the functions are kept and google_search is not sent beside them", async () => {
  const { bodies } = await run(request({ model: PRO_25, webSearch: true, budget: 1 }), [answer("ok")], fakeRunner().runner);
  const tools = bodies[0].tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.ok("functionDeclarations" in tools[0]);
  // And on Gemini 3 both ride together.
  const { bodies: three } = await run(request({ webSearch: true, budget: 1 }), [answer("ok")], fakeRunner().runner);
  assert.deepEqual((three[0].tools as Array<Record<string, unknown>>).map((t) => Object.keys(t)[0]), ["functionDeclarations", "google_search"]);
});

test("grounding: one provider-search pair per query, sources from grounding, the widget on the record", async () => {
  const grounded = {
    candidates: [
      {
        content: { role: "model", parts: [{ text: "Juno shipped in May." }] },
        finishReason: "STOP",
        groundingMetadata: {
          webSearchQueries: ["juno release", "juno may"],
          groundingChunks: [{ web: { uri: "https://a.example/juno", title: "Juno ships" } }],
          searchEntryPoint: { renderedContent: "<div>chips</div>" },
        },
      },
    ],
    usageMetadata: usage(),
  };
  const { events, bodies } = await run(request({ webSearch: true, toolset: undefined, budget: 1 }), [[grounded]], null);
  assert.deepEqual(bodies[0].tools, [{ google_search: {} }]);
  assert.deepEqual(ofType(events, "server_tool"), [
    { type: "server_tool", phase: "call", tool: "provider_web_search", callId: "ps_0_0", round: 0, query: "juno release" },
    { type: "server_tool", phase: "result", tool: "provider_web_search", callId: "ps_0_0", round: 0, ok: true },
    { type: "server_tool", phase: "call", tool: "provider_web_search", callId: "ps_0_1", round: 0, query: "juno may" },
    {
      type: "server_tool",
      phase: "result",
      tool: "provider_web_search",
      callId: "ps_0_1",
      round: 0,
      ok: true,
      web: { engine: "gemini", searchSuggestionsHtml: "<div>chips</div>" },
    },
  ]);
  assert.deepEqual(ofType(events, "sources"), [
    { type: "sources", sources: [{ title: "Juno ships", url: "https://a.example/juno", snippet: "" }], origin: "provider_grounding" },
  ]);
  assert.deepEqual(ofType(events, "round_end"), [{ type: "round_end", round: 0, tools: 0, serverTools: 2, final: true, stop: "STOP" }]);
  assert.equal(last(ofType(events, "usage")).groundingQueries, 2);
});

test("usage is yielded after every request, cumulative and stamped with its round", async () => {
  const { runner } = fakeRunner();
  const { events } = await run(
    request(),
    [calling([{ id: "fc-1", name: "github__list_issues", args: {} }]), answer("ok")],
    runner,
  );
  assert.deepEqual(
    ofType(events, "usage").map((u) => [u.round, u.input, u.output]),
    [
      [0, 100, 20],
      [1, 200, 40],
    ],
  );
});

test("MALFORMED_FUNCTION_CALL resends the same request once (SPEC §5.3 item 8)", async () => {
  const { runner } = fakeRunner();
  const req = request();
  const { bodies, events } = await run(
    req,
    [[frame([], "MALFORMED_FUNCTION_CALL")], answer("Here it is.")],
    runner,
  );
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].contents, bodies[0].contents, "the same request, not a new round");
  assert.equal(req.loop.requests, 2, "and it spends the budget");
  assert.deepEqual(ofType(events, "finish").map((f) => f.reason), ["stop"]);
});

test("a second MALFORMED_FUNCTION_CALL ends the turn as unknown", async () => {
  const { events } = await run(
    request(),
    [[frame([], "MALFORMED_FUNCTION_CALL")], [frame([], "MALFORMED_FUNCTION_CALL")]],
    fakeRunner().runner,
  );
  assert.deepEqual(ofType(events, "finish").map((f) => [f.reason, f.raw]), [["unknown", "MALFORMED_FUNCTION_CALL"]]);
});

test("UNEXPECTED_TOOL_CALL and TOO_MANY_TOOL_CALLS finish length, not unknown", async () => {
  for (const reason of ["UNEXPECTED_TOOL_CALL", "TOO_MANY_TOOL_CALLS"]) {
    const { events } = await run(request({ budget: 1 }), [[frame([{ text: "Partly." }], reason)]], fakeRunner().runner);
    assert.deepEqual(ofType(events, "finish").map((f) => f.reason), ["length"], reason);
  }
});

test("a tool-budget finish is never resumed as a cut-off answer, however much it thought", async () => {
  for (const reason of ["UNEXPECTED_TOOL_CALL", "TOO_MANY_TOOL_CALLS"]) {
    // Thinking at 90% of the ceiling: exactly the share that makes a MAX_TOKENS
    // finish a thinking-starved answer the loop resumes.
    const thoughtHeavy = {
      candidates: [{ content: { role: "model", parts: [{ text: "Partly." }] }, finishReason: reason }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 900, totalTokenCount: 1050 },
    };
    const { events, bodies } = await run(request({ budget: 10, maxTokens: 1000 }), [[thoughtHeavy]], fakeRunner().runner);
    assert.equal(bodies.length, 1, `${reason}: one request, no continuation`);
    const [finish] = ofType(events, "finish");
    assert.deepEqual([finish.reason, finish.raw], ["length", reason]);
    assert.equal(finish.note, undefined, `${reason}: the thinking level is not blamed for a tool stop`);
  }
});

const STARVED = (text: string) => [
  {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "MAX_TOKENS" }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100, thoughtsTokenCount: 900, totalTokenCount: 1100 },
  },
];

test("a tool-less turn's continuation needs no round of the budget and reports no cut", async () => {
  const req = request({ toolset: undefined, budget: 1, maxTokens: 1000 });
  const { bodies, events } = await run(req, [STARVED("The first half, and"), answer(" the second half.")], null);
  assert.equal(bodies.length, 2, "the thinking-starved answer is finished by a continuation");
  assert.equal(req.loop.finalReason, null, "a one-request loop was not cut short");
  assert.deepEqual(ofType(events, "text").map((t) => [t.round, t.text]), [
    [0, "The first half, and"],
    [0, " the second half."],
  ]);
  assert.deepEqual(ofType(events, "finish").map((f) => f.reason), ["stop"]);
});

test("a tool turn's continuation shares the loop budget (SPEC §4.1)", async () => {
  const { runner } = fakeRunner();
  const req = request({ budget: 2, maxTokens: 1000 });
  const { bodies, events } = await run(
    req,
    [calling([{ id: "fc-1", name: "github__list_issues", args: {} }]), STARVED("Cut off here, and")],
    runner,
  );
  assert.equal(bodies.length, 2, "no fresh allowance once the budget is spent");
  assert.deepEqual(ofType(events, "finish").map((f) => f.reason), ["length"]);
});

test("pictures ride in the function response on Gemini 3 and in a separate turn before it", () => {
  const call: ToolCallInput = { name: "inspect_image", callId: "fc-1", providerCallId: "fc-1", round: 0, index: 0, argsText: "{}" };
  const result: BatchResult = {
    callId: "fc-1",
    name: "inspect_image",
    providerCallId: "fc-1",
    text: "A chart.",
    isError: false,
    images: [{ mimeType: "image/png", base64: "AAAA" }],
  };
  const three = geminiToolResponses([call], [result], { vision: true, gemini3: true });
  assert.deepEqual(three.responses, [
    { id: "fc-1", name: "inspect_image", response: { result: "A chart." }, parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }] },
  ]);
  assert.equal(three.images, undefined);

  const older = geminiToolResponses([call], [result], { vision: true, gemini3: false });
  assert.deepEqual(older.responses, [{ id: "fc-1", name: "inspect_image", response: { result: "A chart." } }]);
  assert.deepEqual(older.images?.parts, [{ inlineData: { mimeType: "image/png", data: "AAAA" } }]);
  assert.ok(older.images?.intro);
});

test("a consumer that stops reading early closes the provider request", async () => {
  let closed = false;
  let pulled = 0;
  const frames = [frame([{ text: "One." }]), frame([{ text: " Two." }]), frame([{ text: " Three." }], "STOP")];
  const transport: ProviderTransport = {
    async *request() {
      try {
        for (const payload of frames) {
          pulled += 1;
          yield JSON.stringify(payload);
        }
      } finally {
        closed = true;
      }
    },
  };
  const loop = geminiLoop(request({ toolset: undefined, budget: 1 }), { transport, contents: structuredClone(USER), context: CONTEXT });
  for await (const event of loop) {
    if (event.type === "text") break;
  }
  assert.equal(closed, true, "the transport's stream was returned, not left generating");
  assert.ok(pulled < frames.length, "and it was not read to the end");
});
