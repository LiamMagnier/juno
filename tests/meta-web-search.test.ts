import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import { createToolLoop } from "@/lib/tools/loop";
import { getModel, type ModelInfo } from "@/lib/models";
import { providerAdapterFor, providerSearchServed } from "@/lib/provider-routing";
import { providerReceivesDocumentBytes } from "@/lib/attachment-bytes";
import { toolFeesUsd } from "@/lib/pricing";
import { searchToolLabel } from "@/lib/chat-responses";
import {
  metaBillableQueries,
  metaSearchResultSources,
  urlCitationSources,
} from "@/lib/meta-web-search";
import type { LlmEvent, MessageForModel } from "@/types/llm";
import { fakeTurnToolset, scripted } from "./fixtures/tool-loop";

/*
 * Meta's `web_search` for Muse Spark (dev.meta.ai/docs/search-grounding,
 * read 2026-10-04): Responses API only, so a Meta turn with web search on is
 * routed to Meta's /v1/responses and every other Meta turn stays on Chat
 * Completions. The adapter is driven offline through its transport seam.
 */

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const { streamOpenAIResponses } = req("../src/lib/openai-responses") as typeof import("@/lib/openai-responses");

type RespEvent = OpenAI.Responses.ResponseStreamEvent;
const HISTORY: MessageForModel[] = [{ role: "USER", content: "Who won the most recent Formula 1 race?", attachments: [] }];

function model(id: string): ModelInfo {
  const found = getModel(id);
  assert.ok(found, `${id} is in the catalog`);
  return found;
}

function transportFor(rounds: RespEvent[][]) {
  const requests: Array<Record<string, unknown>> = [];
  return {
    requests,
    transport: {
      async create(params: OpenAI.Responses.ResponseCreateParamsStreaming, options: { signal?: AbortSignal }) {
        requests.push(structuredClone(params) as unknown as Record<string, unknown>);
        const round = rounds[requests.length - 1];
        assert.ok(round, `no scripted round ${requests.length}`);
        return scripted(round, options.signal);
      },
    },
  };
}

const done = (item: Record<string, unknown>) => ({ type: "response.output_item.done", item }) as unknown as RespEvent;
const delta = (text: string) => ({ type: "response.output_text.delta", delta: text }) as unknown as RespEvent;
const completed = () =>
  ({ type: "response.completed", response: { usage: { input_tokens: 69, output_tokens: 163, total_tokens: 232 } } }) as unknown as RespEvent;

const ANSWER = "Leclerc won the British Grand Prix.";
/** The docs' example shapes: a search call with its opt-in results, then a cited answer. */
const SEARCH_ROUND: RespEvent[] = [
  done({ type: "reasoning", id: "rs_1", encrypted_content: "enc" }),
  done({
    id: "ws_789",
    type: "web_search_call",
    status: "completed",
    action: { type: "search", query: "latest F1 race winner", queries: ["latest F1 race winner"] },
    results: [
      {
        type: "text_result",
        title: "2026 British Grand Prix",
        url: "https://en.wikipedia.org/wiki/2026_British_Grand_Prix",
        snippet: "Leclerc took his ninth Formula One victory...",
      },
    ],
  }),
  delta(ANSWER),
  done({
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text: ANSWER,
        annotations: [
          { type: "url_citation", url: "https://en.wikipedia.org/wiki/2026_British_Grand_Prix", title: "2026 British Grand Prix", start_index: 0, end_index: 7 },
          { type: "url_citation", url: "https://www.formula1.com/en/results", title: "Results", start_index: 12, end_index: 34 },
        ],
      },
    ],
  }),
  completed(),
];

async function collect(gen: AsyncGenerator<LlmEvent>): Promise<LlmEvent[]> {
  const events: LlmEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

test("a Meta turn goes to Meta's Responses API only when web search is on", () => {
  const spark = model("meta:muse-spark-1.3");
  assert.equal(providerAdapterFor(spark), "openai-compatible", "no search: Chat Completions, as before");
  assert.equal(providerAdapterFor(spark, false, { webSearch: false }), "openai-compatible");
  assert.equal(providerAdapterFor(spark, false, { webSearch: true }), "meta-responses");
  for (const id of ["meta:muse-spark-1.3-contributor", "meta:muse-spark-1.2", "meta:muse-spark-1.2-contributor", "meta:muse-spark-1.1"]) {
    assert.equal(providerAdapterFor(model(id), false, { webSearch: true }), "meta-responses", id);
    assert.equal(model(id).webSearch, true, `${id}: the composer offers the toggle`);
    assert.equal(providerSearchServed(model(id)), true, id);
  }
  // Muse Image searches on its own and has no tool to add.
  assert.equal(model("meta:muse-image-1.0").webSearch, false);
  // Other labs are unaffected by the flag.
  assert.equal(providerAdapterFor({ provider: "deepseek" }, false, { webSearch: true }), "openai-compatible");
  assert.equal(providerAdapterFor({ provider: "openai" }, false, { webSearch: true }), "openai-responses");
  // The route was told Meta reads no PDF bytes; that stays true.
  assert.equal(providerReceivesDocumentBytes(spark), false);
  assert.equal(searchToolLabel("meta"), "Meta web search");
});

test("the request carries Meta's web_search tool, its results include, and no tool_choice", async () => {
  const { requests, transport } = transportFor([SEARCH_ROUND]);
  const events = await collect(
    streamOpenAIResponses(model("meta:muse-spark-1.3"), "sys", HISTORY, 4_000, undefined, "high", true, undefined, undefined, "conv-1", false, false, transport),
  );
  assert.equal(requests.length, 1);
  const body = requests[0];
  assert.equal(body.model, "muse-spark-1.3");
  assert.equal(body.instructions, "sys");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.deepEqual(body.tools, [{ type: "web_search" }]);
  assert.deepEqual(body.include, ["reasoning.encrypted_content", "web_search_call.results"]);
  assert.deepEqual(body.reasoning, { effort: "high" }, "no summary: Meta keeps reasoning private");
  assert.equal("tool_choice" in body, false, "Meta's ToolChoiceParam is 'auto' only");
  assert.equal("prompt_cache_key" in body, false, "OpenAI cache fields stay OpenAI's");
  assert.equal("service_tier" in body, false);

  // The search row, then the sources: results first (with snippets), then the
  // citation the results did not already list, each URL once.
  const server = events.filter((e) => e.type === "server_tool");
  assert.deepEqual(server, [
    { type: "server_tool", phase: "call", tool: "provider_web_search", callId: "ws_789", round: 0, query: "latest F1 race winner" },
    { type: "server_tool", phase: "result", tool: "provider_web_search", callId: "ws_789", round: 0, results: 1, ok: true },
  ]);
  const sources = events.filter((e): e is Extract<LlmEvent, { type: "sources" }> => e.type === "sources");
  assert.deepEqual(
    sources.map((s) => [s.origin, s.sources.map((x) => [x.title, x.url, x.snippet])]),
    [
      ["provider_search", [["2026 British Grand Prix", "https://en.wikipedia.org/wiki/2026_British_Grand_Prix", "Leclerc took his ninth Formula One victory..."]]],
      ["provider_search", [["Results", "https://www.formula1.com/en/results", "the British Grand Prix"]]],
    ],
  );
  assert.equal(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join(""), ANSWER);

  // One search query, billed at $2.50 / 1k.
  const usage = events.find((e): e is Extract<LlmEvent, { type: "usage" }> => e.type === "usage");
  assert.ok(usage);
  assert.equal(usage.webSearchRequests, 1);
  assert.equal(usage.input, 69);
  assert.equal(toolFeesUsd("meta", { webSearchRequests: 1 }), 0.0025);
  assert.equal(toolFeesUsd("meta", { webSearchRequests: 1_000 }), 2.5);
});

test("with function tools: the final round drops them, reasoning replays with a summary, web_search stays", async () => {
  const call = done({ type: "function_call", call_id: "call_a", name: "lookup", arguments: '{"q":"alpha"}' });
  const rounds: RespEvent[][] = [
    [done({ type: "reasoning", id: "rs_1", encrypted_content: "enc" }), call, completed()],
    [delta("Done."), completed()],
  ];
  const toolset = fakeTurnToolset();
  const { requests, transport } = transportFor(rounds);
  await collect(
    streamOpenAIResponses(model("meta:muse-spark-1.3"), "sys", HISTORY, 4_000, undefined, undefined, true, createToolLoop(toolset), undefined, undefined, false, false, transport),
  );
  assert.equal(requests.length, 2);
  const first = requests[0].tools as Array<{ type: string; name?: string }>;
  assert.deepEqual(first.map((t) => t.name ?? t.type), ["lookup", "slow_job", "web_search"]);
  assert.equal("tool_choice" in requests[0], false);
  const input = requests[1].input as Array<Record<string, unknown>>;
  const reasoning = input.find((item) => item.type === "reasoning");
  assert.deepEqual(reasoning, { type: "reasoning", id: "rs_1", encrypted_content: "enc", summary: [] });
});

test("the forced-answer round sends web_search alone and no tool_choice", async () => {
  const call = (id: string) => done({ type: "function_call", call_id: id, name: "lookup", arguments: '{"q":"x"}' });
  const rounds: RespEvent[][] = Array.from({ length: 7 }, (_, i) => (i < 6 ? [call(`call_${i}`), completed()] : [delta("Done."), completed()]));
  const { requests, transport } = transportFor(rounds);
  await collect(
    streamOpenAIResponses(model("meta:muse-spark-1.3"), "sys", HISTORY, 4_000, undefined, undefined, true, createToolLoop(fakeTurnToolset()), undefined, undefined, false, false, transport),
  );
  assert.equal(requests.length, 7);
  assert.deepEqual(requests[6].tools, [{ type: "web_search" }]);
  assert.equal("tool_choice" in requests[6], false);
});

test("OpenAI requests through the same adapter are unchanged by Meta's dialect", async () => {
  const { requests, transport } = transportFor([[delta("Hi"), completed()]]);
  await collect(
    streamOpenAIResponses(model("openai:gpt-5.5-pro"), "sys", HISTORY, 4_000, undefined, undefined, true, undefined, undefined, undefined, false, false, transport),
  );
  // OpenAI's own hosted search (hosted-web-search.ts), not Meta's shape or include.
  assert.deepEqual(requests[0].tools, [{ type: "web_search", search_context_size: "medium" }]);
  assert.deepEqual(requests[0].include, ["reasoning.encrypted_content", "web_search_call.action.sources"]);
});

test("citation and query mapping", () => {
  assert.equal(metaBillableQueries({ type: "web_search_call" }), 1, "no action: one search ran");
  assert.equal(metaBillableQueries({ action: { type: "search", queries: ["a", "b", ""] } }), 2);
  assert.equal(metaBillableQueries({ action: { type: "search", query: "a" } }), 1);
  assert.equal(metaBillableQueries({ action: { type: "open_page", url: "https://x.test" } }), 0);
  assert.equal(metaBillableQueries({ action: { type: "find_in_page", url: "https://x.test", pattern: "p" } }), 0);
  assert.deepEqual(metaSearchResultSources({ results: [{ url: "https://a.test" }, { title: "no url" }, null] }), [
    { title: "https://a.test", url: "https://a.test", snippet: "" },
  ]);
  assert.deepEqual(
    urlCitationSources({
      content: [
        { type: "output_text", text: "abc", annotations: [{ type: "url_citation", url: "https://b.test", start_index: 5, end_index: 9 }, { type: "file_citation" }] },
      ],
    }),
    [{ title: "https://b.test", url: "https://b.test", snippet: "" }],
    "an out-of-range span is no snippet; a non-URL annotation is skipped",
  );
});
