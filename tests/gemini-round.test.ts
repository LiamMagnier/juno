import test from "node:test";
import assert from "node:assert/strict";
import {
  appendGeminiToolRound,
  applyGeminiChunk,
  emptyGeminiRound,
  extractGeminiSseEvents,
  foldGeminiUsage,
} from "@/lib/gemini-round";
import type { GeminiContent } from "@/lib/gemini-core";
import type { ClientSource } from "@/types/chat";

/*
 * The Gemini RESPONSE, asserted without a credential.
 *
 * These feed recorded-shape SSE frames through the round reader. The
 * thought-signature case is a deterministic reproduction of a production 400:
 * Gemini 3 requires the signature it issued on a functionCall part to come back
 * verbatim in history, and the adapter could not even represent the field.
 */

const usage = (over: Record<string, number> = {}) => ({
  promptTokenCount: 1000,
  candidatesTokenCount: 200,
  thoughtsTokenCount: 5000,
  totalTokenCount: 6200,
  ...over,
});

function feed(payloads: unknown[], sources = new Map<string, ClientSource>()) {
  const state = emptyGeminiRound();
  for (const payload of payloads) applyGeminiChunk(state, JSON.stringify(payload), sources);
  return { state, sources };
}

test("a thought signature survives the round and is replayed verbatim", () => {
  const { state } = feed([
    {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: "browser_agent", args: { q: "juno" } }, thoughtSignature: "SIG-123" }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: usage(),
    },
  ]);

  assert.equal(state.functionCalls.length, 1);
  assert.deepEqual(state.assistantParts, [
    { functionCall: { name: "browser_agent", args: { q: "juno" } }, thoughtSignature: "SIG-123" },
  ]);

  const contents: GeminiContent[] = [{ role: "user", parts: [{ text: "search for juno" }] }];
  appendGeminiToolRound(contents, state.assistantParts, [{ name: "browser_agent", response: { result: "ok" } }]);
  assert.equal(contents.length, 3);
  const replayed = contents[1];
  assert.equal(replayed.role, "model");
  assert.deepEqual(replayed.parts[0], {
    functionCall: { name: "browser_agent", args: { q: "juno" } },
    thoughtSignature: "SIG-123",
  });
  assert.deepEqual(contents[2], {
    role: "user",
    parts: [{ functionResponse: { name: "browser_agent", response: { result: "ok" } } }],
  });
});

test("a signature is never invented for, or copied onto, a part that lacks one", () => {
  // On parallel calls only some parts carry a signature. Google validates the
  // token against the part it issued it for, so synthesising one fails exactly
  // the way dropping one does.
  const { state } = feed([
    {
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: "a", args: {} }, thoughtSignature: "SIG-A" },
              { functionCall: { name: "b", args: {} } },
            ],
          },
        },
      ],
    },
  ]);
  assert.deepEqual(state.assistantParts, [
    { functionCall: { name: "a", args: {} }, thoughtSignature: "SIG-A" },
    { functionCall: { name: "b", args: {} } },
  ]);
  assert.equal("thoughtSignature" in state.assistantParts[1], false);
  assert.deepEqual(state.functionCalls.map((c) => c.name), ["a", "b"]);
});

test("thought parts stream as reasoning, keep their signature, and stay in order", () => {
  const { state } = feed([
    { candidates: [{ content: { parts: [{ text: "thinking…", thought: true, thoughtSignature: "SIG-T" }] } }] },
    { candidates: [{ content: { parts: [{ text: "Hello" }] } }, ] },
  ]);
  assert.deepEqual(state.events, [
    { type: "reasoning", text: "thinking…" },
    { type: "text", text: "Hello" },
  ]);
  assert.deepEqual(state.assistantParts, [
    { thought: true, text: "thinking…", thoughtSignature: "SIG-T" },
    { text: "Hello" },
  ]);
});

test("grounding chunks become sources once per URL, and the search widget is seen", () => {
  const sources = new Map<string, ClientSource>();
  const { state } = feed(
    [
      {
        candidates: [
          {
            groundingMetadata: {
              groundingChunks: [
                { web: { uri: "https://example.com/a", title: "A" } },
                { web: { uri: "https://example.com/a", title: "A again" } },
                { web: { uri: "https://example.com/b" } },
              ],
              searchEntryPoint: { renderedContent: "<div>Search suggestions</div>" },
            },
          },
        ],
      },
    ],
    sources,
  );
  assert.deepEqual([...sources.keys()], ["https://example.com/a", "https://example.com/b"]);
  assert.equal(sources.get("https://example.com/b")?.title, "https://example.com/b");
  assert.equal(state.searchEntryPoint, "<div>Search suggestions</div>");
});

test("usage takes the maximum within a round, so a partial frame cannot erase it", () => {
  // Gemini repeats CUMULATIVE counters on every frame; a final frame reporting
  // only some of them used to overwrite the rest with whatever it carried.
  const { state } = feed([
    { candidates: [{ content: { parts: [{ text: "hi" }] } }], usageMetadata: usage() },
    { candidates: [{ finishReason: "STOP" }], usageMetadata: { candidatesTokenCount: 210, totalTokenCount: 6210 } },
  ]);
  assert.equal(state.sawUsage, true);
  assert.deepEqual(state.usage, { input: 1000, output: 210, cached: 0, thoughts: 5000, total: 6210 });
  assert.equal(state.finishReason, "STOP");
});

test("foldGeminiUsage reads every field under the name Google sends", () => {
  const totals = { input: 0, output: 0, cached: 0, thoughts: 0, total: 0 };
  foldGeminiUsage(totals, {
    promptTokenCount: 12,
    candidatesTokenCount: 34,
    cachedContentTokenCount: 5,
    thoughtsTokenCount: 6,
    totalTokenCount: 57,
  });
  assert.deepEqual(totals, { input: 12, output: 34, cached: 5, thoughts: 6, total: 57 });
  foldGeminiUsage(totals, undefined);
  assert.deepEqual(totals, { input: 12, output: 34, cached: 5, thoughts: 6, total: 57 });
});

test("an empty or unparseable stream never counts as a signal", () => {
  const state = emptyGeminiRound();
  applyGeminiChunk(state, "{ not json", new Map());
  applyGeminiChunk(state, JSON.stringify({}), new Map());
  assert.equal(state.sawSignal, false);
  assert.equal(state.finishReason, null);
});

test("SSE frames split across network chunks are parsed once, whole", () => {
  const first = extractGeminiSseEvents('data: {"a":1}\ndata: {"b":');
  assert.deepEqual(first.payloads, ['{"a":1}']);
  assert.equal(first.rest, 'data: {"b":');
  const second = extractGeminiSseEvents(`${first.rest}2}\n\n`);
  assert.deepEqual(second.payloads, ['{"b":2}']);
  assert.equal(second.rest, "");
});
