import test from "node:test";
import assert from "node:assert/strict";
import { GenerationAccumulator } from "@/lib/chat/stream-accumulator";
import type { ClientSource } from "@/types/chat";
import type { LlmEvent } from "@/types/llm";

/*
 * Characterisation tests for the provider-stream stage.
 *
 * The route folded provider events into turn state twice — once on the private
 * path and once on the saved one — in two copies that had already drifted.
 * These pin the behaviour both copies had, so the single implementation can be
 * checked against it rather than against a reading of either.
 */

const source = (url: string, title = url): ClientSource => ({ title, url, snippet: "" });

test("text accumulates and reports the first delta exactly once", () => {
  const acc = new GenerationAccumulator();
  const first = acc.apply({ type: "text", text: "Hel" });
  const second = acc.apply({ type: "text", text: "lo" });

  assert.equal(first.kind === "text" && first.startedWriting, true);
  assert.equal(second.kind === "text" && second.startedWriting, false);
  assert.equal(acc.text, "Hello");
  assert.equal(acc.providerOutputChars, 5);
});

test("an empty text delta still opens the writing phase", () => {
  // The route's flag flipped on the first `text` event regardless of length,
  // and the "Writing the answer" activity is what tells the user the model has
  // stopped thinking. Gating it on non-empty content would hide that moment
  // for a provider whose first chunk is a lone token boundary.
  const acc = new GenerationAccumulator();
  const effect = acc.apply({ type: "text", text: "" });
  assert.equal(effect.kind === "text" && effect.startedWriting, true);
});

test("reasoning without part boundaries stays flat, and parts stay empty", () => {
  // "No steps" is a fact the pipeline carries, not something the UI guesses.
  const acc = new GenerationAccumulator();
  acc.apply({ type: "reasoning", text: "think " });
  acc.apply({ type: "reasoning", text: "harder" });

  assert.equal(acc.reasoning, "think harder");
  assert.deepEqual(acc.reasoningParts, []);
});

test("reasoning with part boundaries builds the parts as they arrive", () => {
  const acc = new GenerationAccumulator();
  acc.apply({ type: "reasoning", text: "one", part: 0 });
  acc.apply({ type: "reasoning", text: "two", part: 1 });
  acc.apply({ type: "reasoning", text: "!", part: 1 });

  assert.deepEqual(acc.reasoningParts, ["one", "two!"]);
  // The flat text keeps a blank line at each boundary, so the disclosure that
  // renders it reads as paragraphs rather than one run-on sentence.
  assert.equal(acc.reasoning, "one\n\ntwo!");
});

test("sources are deduplicated by url and published as a whole list", () => {
  // Citations are numbered positionally, so the list is republished entire
  // rather than as a delta — the numbering has to stay stable.
  const acc = new GenerationAccumulator();
  const first = acc.apply({ type: "sources", sources: [source("https://a"), source("https://b")] });
  const second = acc.apply({ type: "sources", sources: [source("https://b"), source("https://c")] });

  assert.equal(first.kind === "sources" && first.added.length, 2);
  assert.equal(second.kind === "sources" && second.added.length, 1);
  assert.deepEqual(acc.sources.map((s) => s.url), ["https://a", "https://b", "https://c"]);
});

test("a source with no url is dropped rather than counted", () => {
  const acc = new GenerationAccumulator();
  const effect = acc.apply({ type: "sources", sources: [{ title: "x", url: "", snippet: "" }] });
  assert.equal(effect.kind === "sources" && effect.added.length, 0);
  assert.equal(acc.sources.length, 0);
});

test("seeded research sources are not re-added when the model cites them back", () => {
  // Deep research resolves its whole corpus up front and the report cites it
  // by number. A provider that then streams the same url must not append a
  // duplicate and shift every citation after it.
  const acc = new GenerationAccumulator();
  acc.seedSources([source("https://a"), source("https://b")]);
  const effect = acc.apply({ type: "sources", sources: [source("https://a")] });

  assert.equal(effect.kind === "sources" && effect.added.length, 0);
  assert.deepEqual(acc.sources.map((s) => s.url), ["https://a", "https://b"]);
});

test("only tool calls surface; tool results are folded in silently", () => {
  const acc = new GenerationAccumulator();
  const call = acc.apply({ type: "tool", server: "github", name: "search", phase: "call" });
  const result = acc.apply({ type: "tool", server: "github", name: "search", phase: "result" });

  assert.equal(call.kind, "tool_call");
  assert.equal(result.kind, "none");
});

test("usage merges across events and exposes the counters spend recording wants", () => {
  const acc = new GenerationAccumulator();
  acc.apply({ type: "usage", input: 100, cacheRead: 40 });
  acc.apply({ type: "usage", output: 20, reasoning: 5, total: 125 });

  const tokens = acc.tokens;
  assert.equal(tokens.promptTokens, 100);
  assert.equal(tokens.completionTokens, 20);
  assert.equal(tokens.reasoningTokens, 5);
  assert.equal(tokens.totalTokens, 125);
  assert.equal(tokens.cacheReadTokens, 40);
});

test("served speed starts as requested and is corrected by the provider", () => {
  // A fast request that the adapter served at standard speed must be billed at
  // standard rates; the request is an intent, the usage stream is the fact.
  const acc = new GenerationAccumulator({ requestedFastMode: true });
  assert.equal(acc.servedFast, true);
  acc.apply({ type: "usage", fast: false });
  assert.equal(acc.servedFast, false);
});

test("a usage event that says nothing about speed leaves the requested value alone", () => {
  const acc = new GenerationAccumulator({ requestedFastMode: true });
  acc.apply({ type: "usage", input: 10 });
  assert.equal(acc.servedFast, true);
});

test("the finish reason is captured and defaults to stop", () => {
  const acc = new GenerationAccumulator();
  assert.equal(acc.finishReason, "stop");
  acc.apply({ type: "finish", reason: "length" });
  assert.equal(acc.finishReason, "length");
});

test("replacing the text for a canvas edit does not change what the model is billed for", () => {
  // On a canvas edit the model emits a patch and the message shows the whole
  // rebuilt artifact. Billing the rebuilt text inflates the receipt the user
  // sees — this is the bug the two counters exist to keep apart.
  const acc = new GenerationAccumulator();
  acc.apply({ type: "text", text: "@@ patch @@" });
  const emitted = acc.providerOutputChars;
  acc.replaceText("the entire rebuilt artifact, far longer than the patch");

  assert.equal(acc.providerOutputChars, emitted);
  assert.equal(acc.rawUsage({ promptChars: 0 }).completionChars, emitted);
});

test("hasOutput is what decides whether a stopped turn is worth saving", () => {
  const acc = new GenerationAccumulator();
  assert.equal(acc.hasOutput, false);
  acc.apply({ type: "reasoning", text: "thought" });
  // Reasoning alone counts: a turn stopped mid-thought still has something the
  // user watched arrive.
  assert.equal(acc.hasOutput, true);
});

test("an unrecognised event is ignored rather than throwing", () => {
  const acc = new GenerationAccumulator();
  const effect = acc.apply({ type: "something-new" } as unknown as LlmEvent);
  assert.equal(effect.kind, "none");
});
