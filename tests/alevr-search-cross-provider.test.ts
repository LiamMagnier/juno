import assert from "node:assert/strict";
import test from "node:test";

import { anthropicLoop } from "@/lib/llm/anthropic-loop";
import { runCompatLoop, type CompatMessage } from "@/lib/llm/compat-loop";
import { createLoopController } from "@/lib/llm/loop";
import type { AdapterRequest, ProviderTransport } from "@/lib/llm/types";
import { MODELS, MODEL_LIST, type ModelInfo } from "@/lib/models";
import { toolCapabilitiesFor } from "@/lib/model-tools";
import { alevrBackends, type EngineRunner } from "@/lib/search/alevr/backends";
import { planTurnSearch } from "@/lib/search/alevr/policy";
import { MemorySearchStore } from "@/lib/search/alevr/store";
import { createAlevrSearchTurn } from "@/lib/search/alevr/turn";
import { createFindInPageSpec } from "@/lib/tools/specs/find-in-page";
import { createSearchNewsSpec } from "@/lib/tools/specs/search-news";
import { createWebFetchSpec } from "@/lib/tools/specs/web-fetch";
import { createWebSearchSpec, type WebSearchBackend } from "@/lib/tools/specs/web-search";
import { specChatToolset } from "@/lib/tools/toolset";
import type { WebFetchBackend } from "@/lib/tools/specs/web-fetch";
import { UserWebCounters } from "@/lib/web/limits";
import { fetchPageForChat } from "@/lib/web/fetch-page";
import { chatWebSearch } from "@/lib/web/search";
import type { ExtractOutcome } from "@/lib/web/extract";
import type { LlmEvent } from "@/types/llm";
import type Anthropic from "@anthropic-ai/sdk";

/*
 * "Same tools across providers" (BRIEF §15, REALITY_AUDIT P1 row 4), proven
 * through the real tool loops: Anthropic's adapter (Claude, whose provider
 * HAS a native search, here left off because Alevr Search is primary) and
 * the OpenAI-compatible adapter (DeepSeek, whose provider has NONE), each
 * driven by a scripted transport, each handed the same Alevr Search toolset
 * and the same dispatcher with a broker port. The model in each script
 * searches, opens the top result and finds a passage in it.
 *
 * Asserted: the two providers receive identical tool names and schemas and no
 * provider search tool; every call goes through the broker port; both get the
 * same results; the second provider's identical search is served from the
 * query cache (no backend, no cost) and its page from the page cache (no
 * request) — one stack, whichever model asks. Backends are mocked; nothing
 * leaves the process.
 */

const CLAUDE = MODELS["anthropic:claude-opus-5-5"];
const DEEPSEEK = MODEL_LIST.find((m) => m.id === "deepseek:deepseek-flash")!;
const ENV = { SERPER_API_KEY: "test" };
const PAGE_URL = "https://www.enova.example/heat-pump-grants";
const PAGE_TEXT = `${"Enova supports energy efficiency in Norwegian homes. ".repeat(40)}\nThe heat pump grant covers up to 25 percent of the installation cost, capped at NOK 15,000.\n${"Applications are made online. ".repeat(40)}`;

function stack() {
  const store = new MemorySearchStore();
  const engineCalls: string[] = [];
  const runner: EngineRunner = async (engine, query) => {
    engineCalls.push(`${engine}:${query.vertical}:${query.query}`);
    return {
      status: "ok",
      results: [
        { title: "Heat pump grants — Enova", url: PAGE_URL, snippet: "Grants for air-to-water heat pumps.", engine },
        { title: "Heat pumps explained", url: "https://explainer.example/heat-pumps", snippet: "How heat pumps work.", engine },
      ],
    };
  };
  const backends = alevrBackends({ env: ENV, runner });
  const pageFetches: string[] = [];
  const extract = async (url: string): Promise<ExtractOutcome> => {
    pageFetches.push(url);
    return {
      ok: true,
      page: { title: "Heat pump grants", text: PAGE_TEXT, links: [], finalUrl: url, hops: [url], contentType: "html", totalChars: PAGE_TEXT.length, cache: { cacheControl: "max-age=3600" } },
    };
  };
  const search: WebSearchBackend = (input, ctx) => chatWebSearch(input, ctx, { env: ENV, backends, store });
  const fetchPage: WebFetchBackend = (input, ctx) => fetchPageForChat(input, ctx, { ownHosts: new Set(), extract, pageStore: store });
  return { store, engineCalls, pageFetches, specs: [createWebSearchSpec({ search }), createSearchNewsSpec({ search }), createWebFetchSpec({ fetchPage }), createFindInPageSpec({ fetchPage })] };
}

function turnFor(model: ModelInfo, shared: ReturnType<typeof stack>) {
  const plan = planTurnSearch({ webRequested: true, model, alevrAvailable: true, voice: false, private: false });
  assert.deepEqual(plan, { alevr: true, native: false }, `${model.id}: Alevr Search, provider search off`);
  const turn = createAlevrSearchTurn({
    userId: "u1",
    conversationId: `c-${model.provider}`,
    private: false,
    effort: "medium",
    voice: false,
    userTexts: ["What does the Norwegian heat pump grant cover?"],
    specs: shared.specs,
    history: { userTexts: async () => [], assistantSources: async () => [] },
    userCounters: new UserWebCounters(),
  });
  const authorized: Array<{ toolName: unknown; connectorId: unknown }> = [];
  const batch = {
    toolContext: { userId: "u1", conversationId: `c-${model.provider}`, projectId: null, generationId: `g-${model.provider}` },
    cache: new Map(),
    fees: {},
    seenCallIds: new Set<string>(),
    ports: {
      authorizeExternalAction: async (request: Record<string, unknown>) => {
        authorized.push({ toolName: request.toolName, connectorId: request.connectorId });
        return { kind: "authorized" as const, receiptId: null };
      },
      completeExternalAction: async () => undefined,
      recordToolInvocation: null,
      settleToolInvocation: null,
      resolvedPolicy: null,
    },
  } as unknown as NonNullable<AdapterRequest["batch"]>;
  return { turn, toolset: specChatToolset(turn.specs), batch, authorized, webSearch: plan.native };
}

function scripted(responses: unknown[][]) {
  const bodies: Array<Record<string, unknown>> = [];
  const transport: ProviderTransport = {
    async *request(body) {
      bodies.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
      const next = responses.shift();
      if (!next) throw new Error("the loop sent a request the script did not expect");
      for (const event of next) yield event;
    },
  };
  return { transport, bodies };
}

const CALLS = [
  { name: "web_search", json: JSON.stringify({ query: "Norway heat pump grant" }) },
  { name: "web_fetch", json: JSON.stringify({ url: PAGE_URL }) },
  { name: "find_in_page", json: JSON.stringify({ url: PAGE_URL, query: "heat pump grant covers" }) },
];
const ANSWER = "The grant covers up to 25 percent, capped at NOK 15,000 ([Enova](https://www.enova.example/heat-pump-grants)).";

// ── Anthropic's stream shapes ──
const aStart = { type: "message_start", message: { usage: { input_tokens: 50 } } };
function aToolUse(i: number) {
  return [
    aStart,
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${i}`, name: CALLS[i].name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: CALLS[i].json } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } },
  ];
}
const aText = [
  aStart,
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ANSWER } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } },
];

// ── Chat Completions shapes ──
function cToolCall(i: number) {
  return [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${i}`, function: { name: CALLS[i].name, arguments: CALLS[i].json } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 50, completion_tokens: 10 } },
  ];
}
const cText = [
  { choices: [{ delta: { content: ANSWER } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 80, completion_tokens: 20 } },
];

function toolResults(events: LlmEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const event of events) {
    if (event.type === "tool" && event.phase === "result") out.set(event.name, event.result);
  }
  return out;
}

test("Claude (native search available, unused) and DeepSeek (no native search) run the same Alevr Search tools through one stack", async () => {
  assert.equal(CLAUDE.webSearch, true);
  assert.equal(DEEPSEEK.webSearch, false);
  assert.ok(toolCapabilitiesFor(DEEPSEEK).supported);
  const shared = stack();

  // ── Anthropic ──
  const claude = turnFor(CLAUDE, shared);
  const a = scripted([aToolUse(0), aToolUse(1), aToolUse(2), aText]);
  const aEvents: LlmEvent[] = [];
  const aReq: AdapterRequest = {
    model: CLAUDE,
    system: "You are Alevr.",
    history: [],
    maxTokens: 2_000,
    webSearch: claude.webSearch,
    toolset: claude.toolset,
    batch: claude.batch,
    loop: createLoopController({ budget: 10 }),
  };
  const userA: Anthropic.MessageParam[] = [{ role: "user", content: "What does the Norwegian heat pump grant cover?" }];
  for await (const event of anthropicLoop(aReq, { transport: a.transport, messages: userA, zdr: false })) aEvents.push(event);

  // ── OpenAI-compatible ──
  const deepseek = turnFor(DEEPSEEK, shared);
  const c = scripted([cToolCall(0), cToolCall(1), cToolCall(2), cText]);
  const cEvents: LlmEvent[] = [];
  const cReq: AdapterRequest = {
    model: DEEPSEEK,
    system: "You are Alevr.",
    history: [],
    maxTokens: 2_000,
    webSearch: deepseek.webSearch,
    toolset: deepseek.toolset,
    batch: deepseek.batch,
    loop: createLoopController({ budget: 10 }),
  };
  const messages: CompatMessage[] = [
    { role: "system", content: "You are Alevr." },
    { role: "user", content: "What does the Norwegian heat pump grant cover?" },
  ];
  for await (const event of runCompatLoop({ req: cReq, messages, transport: c.transport })) cEvents.push(event);

  // 1. The same tools, with the same schemas, reached both providers — and no provider search.
  const aTools = (a.bodies[0].tools as Array<{ name: string; input_schema: unknown; type?: string }>);
  const cTools = (c.bodies[0].tools as Array<{ type: string; function: { name: string; parameters: unknown } }>);
  assert.deepEqual(aTools.map((t) => t.name), ["web_search", "search_news", "web_fetch", "find_in_page"]);
  assert.deepEqual(cTools.map((t) => t.function.name), aTools.map((t) => t.name));
  aTools.forEach((tool, i) => assert.deepEqual(tool.input_schema, cTools[i].function.parameters, tool.name));
  assert.ok(!aTools.some((t) => typeof t.type === "string" && t.type.startsWith("web_search_")), "no Anthropic server search tool");
  assert.ok(!cTools.some((t) => t.type !== "function"), "no lab search tool on Chat Completions");

  // 2. Every call went through the broker port, as a juno_runtime read.
  for (const run of [claude, deepseek]) {
    assert.deepEqual(run.authorized.map((x) => x.toolName), ["web_search", "web_fetch", "find_in_page"]);
    assert.ok(run.authorized.every((x) => x.connectorId === "juno_runtime"));
  }

  // 3. Same results; the second provider was served from the caches.
  const aResults = toolResults(aEvents);
  const cResults = toolResults(cEvents);
  assert.match(aResults.get("web_search") ?? "", /Heat pump grants — Enova/);
  assert.match(cResults.get("web_search") ?? "", /Heat pump grants — Enova/);
  assert.match(aResults.get("find_in_page") ?? "", /covers up to 25 percent/);
  assert.match(cResults.get("find_in_page") ?? "", /covers up to 25 percent/);
  assert.equal(shared.engineCalls.length, 1, "one discovery call for both providers");
  assert.equal(shared.pageFetches.length, 1, "one page fetch for both providers");
  assert.deepEqual(shared.store.calls.map((call) => [call.servedBy, call.costMicroUsd]), [["discovery", 1_000], ["query_cache", 0]]);

  // 4. Both answered, and each turn queued its sources for the route.
  assert.ok(aEvents.some((e) => e.type === "text" && e.text.includes("25 percent")));
  assert.ok(cEvents.some((e) => e.type === "text" && e.text.includes("25 percent")));
  for (const run of [claude, deepseek]) {
    const urls = run.turn.drainSources().flatMap((batch) => batch.sources.map((s) => s.url));
    assert.ok(urls.includes(PAGE_URL), "the read page is a source");
  }
});
