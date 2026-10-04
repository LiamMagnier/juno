import test from "node:test";
import assert from "node:assert/strict";
import {
  compatCarriesLabSearch,
  labSearchRequest,
  labSearchSources,
  mimoSearchCalls,
  mimoSearchSources,
  zhipuSearchSources,
} from "@/lib/lab-web-search";
import { toolFeesUsd } from "@/lib/pricing";
import { foldCompatUsage, emptyCompatUsage } from "@/lib/openai-compat-round";
import { getModel } from "@/lib/models";
import { providerSearchAvailable } from "@/lib/model-tools";

test("each lab's documented search request shape", () => {
  // docs.z.ai chat-completion: a web_search tool, results returned for citing.
  assert.deepEqual(labSearchRequest("zhipu"), {
    tools: [{ type: "web_search", web_search: { enable: true, search_engine: "search_pro_jina", search_result: true } }],
    fields: {},
  });
  // mimo.mi.com web-search guide: a web_search tool; the model decides.
  assert.deepEqual(labSearchRequest("mimo"), { tools: [{ type: "web_search", max_keyword: 3, force_search: false }], fields: {} });
  // Model Studio web-search: enable_search on Chat Completions.
  assert.deepEqual(labSearchRequest("qwen"), { tools: [], fields: { enable_search: true } });
  // Kimi's $web_search retires 2026-10-20 and returns no sources: not carried.
  assert.equal(compatCarriesLabSearch("moonshot"), false);
  assert.deepEqual(labSearchRequest("moonshot"), { tools: [], fields: {} });
});

test("Z.ai's web_search results become sources", () => {
  const chunk = {
    choices: [{ index: 0, delta: { content: "x" } }],
    web_search: [
      { title: "Financial Morning Briefing", link: "https://www.sohu.com/a/1", content: "Summary text.", media: "Sohu", refer: "ref_1" },
      { title: "", link: "https://example.com/b", content: "" },
      { title: "no link", content: "dropped" },
    ],
  };
  assert.deepEqual(zhipuSearchSources(chunk), [
    { title: "Financial Morning Briefing", url: "https://www.sohu.com/a/1", snippet: "Summary text." },
    { title: "https://example.com/b", url: "https://example.com/b", snippet: "" },
  ]);
  assert.deepEqual(labSearchSources("zhipu", { choices: [] }), []);
});

test("MiMo's url_citation annotations become sources, from a delta or a message", () => {
  const annotation = {
    type: "url_citation",
    url: "https://www.weather.com.cn/weather/101200101.shtml",
    title: "Wuhan forecast",
    summary: "x".repeat(400),
    site_name: "weather.com.cn",
  };
  const fromDelta = mimoSearchSources({ choices: [{ index: 0, delta: { annotations: [annotation] } }] });
  assert.equal(fromDelta.length, 1);
  assert.equal(fromDelta[0].url, annotation.url);
  assert.equal(fromDelta[0].title, "Wuhan forecast");
  assert.ok(fromDelta[0].snippet.length <= 300, "snippets are trimmed");
  const fromMessage = labSearchSources("mimo", { choices: [{ index: 0, message: { annotations: [annotation, { type: "other", url: "https://x" }] } }] });
  assert.deepEqual(fromMessage.map((s) => s.url), [annotation.url]);
  // Qwen's compat transport returns no sources.
  assert.deepEqual(labSearchSources("qwen", { choices: [{ delta: { annotations: [annotation] } }] }), []);
});

test("MiMo's search calls are counted and billed; Z.ai and Qwen per use", () => {
  assert.equal(mimoSearchCalls({ web_search_usage: { tool_usage: 3, page_usage: 3 } }), 3);
  assert.equal(mimoSearchCalls({}), 0);
  const round = emptyCompatUsage();
  foldCompatUsage(round, { prompt_tokens: 10, completion_tokens: 2, web_search_usage: { tool_usage: 3 } });
  assert.equal(round.webSearchRequests, 3);
  assert.equal(toolFeesUsd("mimo", { webSearchRequests: 1000 }), 5);
  assert.equal(toolFeesUsd("zhipu", { webSearchRequests: 1 }), 0.01);
  assert.equal(toolFeesUsd("qwen", { webSearchRequests: 1000 }), 10);
});

test("the labs' searching models say so; the excepted Qwen rows do not", () => {
  for (const id of ["zhipu:glm-5.3", "zhipu:glm-5.3-flash", "mimo:mimo-v2.6-pro", "qwen:qwen3.8-max", "qwen:qwen3.7-flash"]) {
    const model = getModel(id)!;
    assert.ok(model, id);
    assert.equal(model.webSearch, true, id);
    assert.equal(providerSearchAvailable(model), true, id);
  }
  for (const id of ["qwen:qwen3-vl-plus", "qwen:qwq-plus", "moonshot:kimi-k3"]) {
    assert.equal(getModel(id)!.webSearch, false, id);
  }
});
