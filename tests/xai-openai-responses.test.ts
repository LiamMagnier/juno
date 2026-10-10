import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_LIST, getModel, type ModelInfo } from "@/lib/models";
import { providerAdapterFor } from "@/lib/provider-routing";
import { toolFeesUsd } from "@/lib/pricing";
import {
  actionSourceList,
  hostedSearchCallBillable,
  xaiResponseCitations,
  xaiServerToolCounts,
} from "@/lib/hosted-web-search";
import type { LlmEvent, MessageForModel } from "@/types/llm";
import { createToolLoop } from "@/lib/tools/loop";
import { fakeTurnToolset } from "./fixtures/tool-loop";

/*
 * The Responses adapter's HOST, KEY and DIALECT for OpenAI and Grok, driven
 * through production's own path: `streamChat` (llm.ts) → the adapter switch →
 * `streamOpenAIResponses` with no transport → the real OpenAI SDK client. Only
 * `fetch` is replaced, so the URL, Authorization header and JSON body asserted
 * here are what would leave the server.
 *
 * Before 2026-10-04 the adapter built one client from OPENAI_API_KEY and
 * OPENAI_BASE_URL whatever the model, so every Grok turn ("xai-responses")
 * went to api.openai.com with the OpenAI key, and `webSearch` was ignored for
 * OpenAI and Grok alike (the parameter was `_webSearch`).
 */

process.env.OPENAI_API_KEY = "sk-test-openai";
process.env.XAI_API_KEY = "xai-test-key";
delete process.env.OPENAI_BASE_URL;
delete process.env.XAI_BASE_URL;
delete process.env.OPENAI_RESPONSES;

interface Sent {
  url: string;
  auth: string | null;
  body: Record<string, unknown>;
}
const sent: Sent[] = [];
let script: unknown[][] = [];

/** A Responses SSE stream: one `event:`/`data:` pair per event. */
function sse(events: unknown[]): Response {
  const body = events
    .map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// Installed before any SDK client exists: the SDK captures `fetch` when it builds one.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const headers = new Headers(init?.headers);
  sent.push({ url, auth: headers.get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) });
  const events = script.shift();
  assert.ok(events, `no scripted response for request ${sent.length}`);
  return sse(events);
}) as typeof fetch;

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const { streamChat } = req("../src/lib/llm") as typeof import("@/lib/llm");
const { streamOpenAIResponses } = req("../src/lib/openai-responses") as typeof import("@/lib/openai-responses");

const HISTORY: MessageForModel[] = [{ role: "USER", content: "What happened in the news today?", attachments: [] }];

function model(id: string): ModelInfo {
  const found = getModel(id);
  assert.ok(found, `${id} is in the catalog`);
  return found;
}

async function collect(gen: AsyncGenerator<LlmEvent>): Promise<LlmEvent[]> {
  const events: LlmEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

const completed = (extra: Record<string, unknown> = {}) => ({
  type: "response.completed",
  response: { id: "resp_1", usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 }, ...extra },
});
const delta = (text: string) => ({ type: "response.output_text.delta", delta: text });
const done = (item: Record<string, unknown>) => ({ type: "response.output_item.done", item });

function reset(rounds: unknown[][]) {
  sent.length = 0;
  script = rounds;
}

test("every Grok model in the catalog is routed to xai-responses, every GPT to openai-responses", () => {
  const grok = MODEL_LIST.filter((m) => m.provider === "xai" && m.modality === "chat");
  assert.ok(grok.length > 0);
  for (const m of grok) assert.equal(providerAdapterFor(m), "xai-responses", m.id);
  for (const m of MODEL_LIST.filter((x) => x.provider === "openai" && x.modality === "chat")) {
    assert.equal(providerAdapterFor(m), "openai-responses", m.id);
  }
});

test("a Grok turn through streamChat goes to api.x.ai with the xAI key, in xAI's dialect", async () => {
  reset([[delta("Hi"), completed()]]);
  const events = await collect(
    streamChat({ model: model("xai:grok-4.7"), system: "sys", history: HISTORY, maxTokens: 4_000, reasoningEffort: "high", cacheKey: "conv-1" }),
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.x.ai/v1/responses");
  assert.equal(sent[0].auth, "Bearer xai-test-key");
  const body = sent[0].body;
  assert.equal(body.model, "grok-4.7");
  assert.equal(body.store, false);
  assert.equal("instructions" in body, false, "xAI: the system prompt is an input message");
  assert.deepEqual((body.input as unknown[])[0], { role: "system", content: "sys" });
  assert.deepEqual(body.reasoning, { effort: "high" }, "no summary request on xAI");
  // xAI's Responses API routes a conversation to its cache by this body field
  // (docs.x.ai "Maximizing cache hits"); the other OpenAI fields stay OpenAI's.
  assert.equal(body.prompt_cache_key, "conv-1");
  assert.equal("prompt_cache_retention" in body, false);
  assert.equal("prompt_cache_options" in body, false);
  assert.equal("tools" in body, false, "no search unless the toggle is on");
  assert.equal(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join(""), "Hi");
});

test("Grok efforts are clamped to the model's ladder; a model without one gets none", async () => {
  reset([[completed()], [completed()]]);
  await collect(streamOpenAIResponses(model("xai:grok-4.5"), "sys", HISTORY, 4_000, undefined, "max"));
  await collect(streamOpenAIResponses(model("xai:grok-4.20-0309-non-reasoning"), "sys", HISTORY, 4_000, undefined, "high"));
  assert.deepEqual(sent[0].body.reasoning, { effort: "high" }, "grok-4.5 tops out at high");
  assert.equal("reasoning" in sent[1].body, false);
});

test("a Grok turn with web search on carries xAI's web_search; citations and counts come back", async () => {
  reset([
    [
      done({ id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", query: "news today" } }),
      delta("Here is the news."),
      done({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Here is the news.", annotations: [{ type: "url_citation", url: "https://x.ai/news", title: "1", start_index: 0, end_index: 4 }] }],
      }),
      completed({
        citations: ["https://x.ai/news", "https://example.com/story"],
        usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70, server_side_tool_usage_details: { web_search_calls: 2, x_search_calls: 0 } },
      }),
    ],
  ]);
  const events = await collect(
    streamChat({ model: model("xai:grok-4.7"), system: "sys", history: HISTORY, maxTokens: 4_000, webSearch: true }),
  );
  assert.equal(sent[0].url, "https://api.x.ai/v1/responses");
  assert.deepEqual(sent[0].body.tools, [{ type: "web_search" }]);
  assert.equal("tool_choice" in sent[0].body, false);
  const include = (sent[0].body.include ?? []) as string[];
  assert.equal(include.includes("web_search_call.action.sources"), false, "OpenAI's include is not sent to xAI");

  const urls = events
    .filter((e): e is Extract<LlmEvent, { type: "sources" }> => e.type === "sources")
    .flatMap((e) => e.sources.map((s) => s.url));
  assert.deepEqual(urls, ["https://x.ai/news", "https://example.com/story"], "each URL once");
  assert.ok(events.some((e) => e.type === "server_tool" && e.tool === "provider_web_search" && e.phase === "call"));
  const usage = events.find((e): e is Extract<LlmEvent, { type: "usage" }> => e.type === "usage");
  assert.equal(usage?.webSearchRequests, 2, "xAI's own reported count wins over counting call items");
  assert.equal(toolFeesUsd("xai", { webSearchRequests: 2 }), 0.01);
});

test("grok-4.20-multi-agent is sent no function tools", async () => {
  reset([[delta("ok"), completed()]]);
  await collect(
    streamOpenAIResponses(model("xai:grok-4.20-multi-agent-0309"), "sys", HISTORY, 4_000, undefined, undefined, true, createToolLoop(fakeTurnToolset())),
  );
  assert.deepEqual(sent[0].body.tools, [{ type: "web_search" }]);
  assert.equal("tool_choice" in sent[0].body, false);
});

test("an OpenAI turn still goes to api.openai.com with the OpenAI key", async () => {
  reset([[delta("Hi"), completed()]]);
  await collect(streamChat({ model: model("openai:gpt-5.5"), system: "sys", history: HISTORY, maxTokens: 4_000, reasoningEffort: "high" }));
  assert.equal(sent[0].url, "https://api.openai.com/v1/responses");
  assert.equal(sent[0].auth, "Bearer sk-test-openai");
  assert.equal(sent[0].body.model, "gpt-5.5");
  assert.deepEqual(sent[0].body.reasoning, { effort: "high", summary: "detailed" });
  assert.equal("tools" in sent[0].body, false);
});

test("an OpenAI turn with web search on carries hosted web_search, maps sources and bills per search call", async () => {
  reset([
    [
      done({
        id: "ws_a",
        type: "web_search_call",
        status: "completed",
        action: { type: "search", queries: ["news today"], sources: [{ type: "url", url: "https://a.test/1" }, { type: "url", url: "https://b.test/2" }] },
      }),
      done({ id: "ws_b", type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://a.test/1" } }),
      delta("Answer."),
      done({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Answer.", annotations: [{ type: "url_citation", url: "https://c.test/3", title: "C", start_index: 0, end_index: 6 }] }],
      }),
      completed(),
    ],
  ]);
  const events = await collect(
    streamChat({ model: model("openai:gpt-5.5"), system: "sys", history: HISTORY, maxTokens: 4_000, reasoningEffort: "medium", webSearch: true }),
  );
  assert.equal(sent[0].url, "https://api.openai.com/v1/responses");
  assert.deepEqual(sent[0].body.tools, [{ type: "web_search", search_context_size: "medium" }]);
  assert.deepEqual(sent[0].body.include, ["reasoning.encrypted_content", "web_search_call.action.sources"]);
  const sources = events
    .filter((e): e is Extract<LlmEvent, { type: "sources" }> => e.type === "sources")
    .flatMap((e) => e.sources.map((s) => [s.title, s.url]));
  assert.deepEqual(sources, [
    ["https://a.test/1", "https://a.test/1"],
    ["https://b.test/2", "https://b.test/2"],
    ["C", "https://c.test/3"],
  ]);
  const usage = events.find((e): e is Extract<LlmEvent, { type: "usage" }> => e.type === "usage");
  assert.equal(usage?.webSearchRequests, 1, "open_page is not a billed search");
});

test("hosted search is withheld where the model rejects it: gpt-5 at minimal, o1 (no native search)", async () => {
  reset([[completed()], [completed()], [completed()]]);
  await collect(streamOpenAIResponses(model("openai:gpt-5"), "sys", HISTORY, 4_000, undefined, "minimal", true));
  await collect(streamOpenAIResponses(model("openai:gpt-5"), "sys", HISTORY, 4_000, undefined, "low", true));
  await collect(streamOpenAIResponses(model("openai:o1"), "sys", HISTORY, 4_000, undefined, "high", true));
  assert.equal("tools" in sent[0].body, false);
  assert.deepEqual(sent[1].body.tools, [{ type: "web_search", search_context_size: "medium" }]);
  assert.equal("tools" in sent[2].body, false);
});

test("with function tools, hosted search rides beside them and the final round says none", async () => {
  const call = (id: string) => done({ type: "function_call", call_id: id, name: "lookup", arguments: '{"q":"x"}' });
  reset(Array.from({ length: 7 }, (_, i) => (i < 6 ? [call(`call_${i}`), completed()] : [delta("Done."), completed()])));
  await collect(
    streamOpenAIResponses(model("openai:gpt-5.5"), "sys", HISTORY, 4_000, undefined, "medium", true, createToolLoop(fakeTurnToolset())),
  );
  assert.equal(sent.length, 7);
  const names = (sent[0].body.tools as Array<{ type: string; name?: string }>).map((t) => t.name ?? t.type);
  assert.deepEqual(names, ["lookup", "slow_job", "web_search"]);
  assert.equal(sent[0].body.tool_choice, "auto");
  assert.equal(sent[6].body.tool_choice, "none");
});

test("hosted search helpers and fees", () => {
  assert.equal(hostedSearchCallBillable({ type: "web_search_call" }), true);
  assert.equal(hostedSearchCallBillable({ action: { type: "search" } }), true);
  assert.equal(hostedSearchCallBillable({ action: { type: "find_in_page" } }), false);
  assert.deepEqual(actionSourceList({ action: { sources: [{ url: "https://a.test" }, { type: "url" }, null] } }), [
    { title: "https://a.test", url: "https://a.test", snippet: "" },
  ]);
  assert.deepEqual(xaiResponseCitations({ citations: ["https://a.test", 3] }), [{ title: "https://a.test", url: "https://a.test", snippet: "" }]);
  assert.deepEqual(xaiServerToolCounts({ usage: { server_side_tool_usage_details: { web_search_calls: 3, x_search_calls: 1 } } }), { web: 3, x: 1 });
  assert.deepEqual(xaiServerToolCounts({ usage: {} }), { web: null, x: null });
  // OpenAI: $10 / 1k calls on reasoning models, $25 / 1k on gpt-4o / gpt-4.1.
  assert.equal(toolFeesUsd("openai", { webSearchRequests: 1_000 }, model("openai:gpt-5.5")), 10);
  assert.equal(toolFeesUsd("openai", { webSearchRequests: 1_000 }, model("openai:gpt-4o")), 25);
  assert.equal(toolFeesUsd("openai", { webSearchRequests: 1_000 }), 10);
  assert.equal(toolFeesUsd("xai", { webSearchRequests: 1_000 }), 5);
});
