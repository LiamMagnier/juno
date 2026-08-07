import test from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import {
  addAnthropicUsage,
  emptyAnthropicUsage,
  foldAnthropicUsage,
  readAnthropicRound,
  safeToolInput,
} from "@/lib/anthropic-round";
import type { LlmEvent } from "@/types/llm";

/*
 * Anthropic's connector path was rewritten: connectors used to be handed to
 * Claude as native `mcp_servers`, which meant Claude called them server-side and
 * Juno never saw the individual call — no approval could be required. They are
 * now ordinary client tools driven by a tool loop here, which means this adapter
 * is suddenly responsible for rebuilding the assistant turn and replaying it.
 *
 * That reassembly is the part with teeth. A dropped thinking signature or a
 * reordered block does not look like a bug locally: it is a 400 from Anthropic,
 * or a tool call that silently never happens, in production only. These tests
 * feed hand-written stream events through the reader so the shape is pinned.
 */

type Ev = Anthropic.RawMessageStreamEvent;

async function* streamOf(events: Ev[]): AsyncIterable<Ev> {
  for (const e of events) yield e;
}

/** Drain the reader, collecting the events it yields and the round it returns. */
async function readAll(events: Ev[], labelFor?: (n: string) => string) {
  const yielded: LlmEvent[] = [];
  const gen = readAnthropicRound(streamOf(events), { labelFor, seen: new Set<string>() });
  for (;;) {
    const step = await gen.next();
    if (step.done) return { yielded, round: step.value };
    yielded.push(step.value);
  }
}

const start = (index: number, block: unknown): Ev =>
  ({ type: "content_block_start", index, content_block: block }) as unknown as Ev;
const delta = (index: number, d: unknown): Ev =>
  ({ type: "content_block_delta", index, delta: d }) as unknown as Ev;
const stop = (index: number): Ev => ({ type: "content_block_stop", index }) as unknown as Ev;
const messageDelta = (stopReason: string | null, usage?: unknown): Ev =>
  ({ type: "message_delta", delta: { stop_reason: stopReason }, usage: usage ?? {} }) as unknown as Ev;

test("a text-only round returns one text block and streams its deltas", async () => {
  const { yielded, round } = await readAll([
    { type: "message_start", message: { usage: { input_tokens: 10 } } } as unknown as Ev,
    start(0, { type: "text" }),
    delta(0, { type: "text_delta", text: "Hel" }),
    delta(0, { type: "text_delta", text: "lo" }),
    stop(0),
    messageDelta("end_turn", { output_tokens: 3 }),
  ]);

  assert.deepEqual(
    yielded.filter((e) => e.type === "text"),
    [
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
    ]
  );
  assert.equal(round.stopReason, "end_turn");
  assert.deepEqual(round.blocks, [{ type: "text", text: "Hello" }]);
  assert.deepEqual(round.toolUses, []);
});

test("a thinking block keeps its signature and stays ahead of the tool_use it precedes", async () => {
  // The ordering assertion is the point. Anthropic verifies the signature over
  // the thinking block in the replayed turn, and a tool_use that arrives before
  // the thinking it came from is not the turn the model produced.
  const { round } = await readAll([
    start(0, { type: "thinking" }),
    delta(0, { type: "thinking_delta", thinking: "I should look this up." }),
    delta(0, { type: "signature_delta", signature: "sig-abc" }),
    stop(0),
    start(1, { type: "tool_use", id: "toolu_1", name: "github__list_issues" }),
    delta(1, { type: "input_json_delta", partial_json: '{"repo":' }),
    delta(1, { type: "input_json_delta", partial_json: '"juno"}' }),
    stop(1),
    messageDelta("tool_use"),
  ]);

  assert.deepEqual(round.blocks, [
    { type: "thinking", thinking: "I should look this up.", signature: "sig-abc" },
    { type: "tool_use", id: "toolu_1", name: "github__list_issues", input: { repo: "juno" } },
  ]);
  assert.equal(round.blocks[0].type, "thinking", "thinking must precede the tool_use it reasoned toward");
  assert.deepEqual(round.toolUses, [{ id: "toolu_1", name: "github__list_issues", json: '{"repo":"juno"}' }]);
  assert.equal(round.stopReason, "tool_use");
});

test("redacted_thinking is echoed back untouched", async () => {
  const redacted = { type: "redacted_thinking", data: "opaque-blob" };
  const { round } = await readAll([start(0, redacted), stop(0), messageDelta("end_turn")]);
  assert.deepEqual(round.blocks, [redacted]);
});

test("interleaved block indices do not bleed into each other", async () => {
  // Anthropic may open a second block before the first stops. Accumulating into
  // a single "current block" would concatenate two different tool calls' JSON
  // into one and send arguments the model never wrote.
  const { round } = await readAll([
    start(0, { type: "tool_use", id: "a", name: "t_one" }),
    start(1, { type: "tool_use", id: "b", name: "t_two" }),
    delta(0, { type: "input_json_delta", partial_json: '{"x":1}' }),
    delta(1, { type: "input_json_delta", partial_json: '{"y":2}' }),
    stop(1),
    stop(0),
    messageDelta("tool_use"),
  ]);

  const byId = Object.fromEntries(round.toolUses.map((t) => [t.id, t.json]));
  assert.deepEqual(byId, { a: '{"x":1}', b: '{"y":2}' });
  // Wire order is close order, which is what the API replays.
  assert.deepEqual(
    round.blocks.map((b) => (b as { id?: string }).id),
    ["b", "a"]
  );
});

test("every tool_use yields a call event, labelled through the toolset", async () => {
  const { yielded } = await readAll(
    [
      start(0, { type: "tool_use", id: "a", name: "github__create_issue" }),
      stop(0),
      messageDelta("tool_use"),
    ],
    (n) => (n.startsWith("github") ? "GitHub" : "?")
  );
  assert.deepEqual(yielded, [
    { type: "tool", server: "GitHub", name: "github__create_issue", phase: "call" },
  ]);
});

test("web search results are announced once per URL", async () => {
  const seen = new Set<string>();
  const page = { type: "web_search_result", url: "https://example.com/a", title: "A" };
  const events: Ev[] = [start(0, { type: "web_search_tool_result", content: [page] }), stop(0), messageDelta("end_turn")];

  const first: LlmEvent[] = [];
  const g1 = readAnthropicRound(streamOf(events), { seen });
  for (;;) {
    const s = await g1.next();
    if (s.done) break;
    first.push(s.value);
  }
  const second: LlmEvent[] = [];
  const g2 = readAnthropicRound(streamOf(events), { seen });
  for (;;) {
    const s = await g2.next();
    if (s.done) break;
    second.push(s.value);
  }

  assert.equal(first.filter((e) => e.type === "sources").length, 1);
  // `seen` is shared across rounds of one turn, so round two must not re-announce.
  assert.equal(second.filter((e) => e.type === "sources").length, 0);
});

test("malformed tool JSON degrades to empty arguments rather than throwing", async () => {
  const { round } = await readAll([
    start(0, { type: "tool_use", id: "a", name: "t" }),
    delta(0, { type: "input_json_delta", partial_json: '{"truncated":' }),
    stop(0),
    messageDelta("tool_use"),
  ]);
  assert.deepEqual((round.blocks[0] as { input: unknown }).input, {});
});

test("safeToolInput only accepts JSON objects", () => {
  assert.deepEqual(safeToolInput('{"a":1}'), { a: 1 });
  assert.deepEqual(safeToolInput(""), {});
  assert.deepEqual(safeToolInput("   "), {});
  assert.deepEqual(safeToolInput("not json"), {});
  // An array or a bare scalar is valid JSON but not an argument object; letting
  // either through would hand the broker something it cannot classify by key.
  assert.deepEqual(safeToolInput("[1,2]"), {});
  assert.deepEqual(safeToolInput("null"), {});
  assert.deepEqual(safeToolInput('"a string"'), {});
});

test("usage takes the maximum WITHIN a round so a partial delta cannot erase input", () => {
  const round = emptyAnthropicUsage();
  foldAnthropicUsage(round, { input_tokens: 1000, cache_read_input_tokens: 400 });
  // A later delta reporting only output must not zero the input/cache already seen.
  foldAnthropicUsage(round, { output_tokens: 50 });
  assert.equal(round.input, 1000);
  assert.equal(round.cacheRead, 400);
  assert.equal(round.output, 50);
});

test("usage SUMS across rounds, because each tool round is a separately billed request", () => {
  // The regression this pins: a six-round connector turn re-sends the whole
  // conversation each time. Carrying the max across rounds — correct when this
  // adapter only ever made one request — would bill it as a single round.
  const total = emptyAnthropicUsage();
  const roundOne = emptyAnthropicUsage();
  foldAnthropicUsage(roundOne, { input_tokens: 1000, output_tokens: 20 });
  addAnthropicUsage(total, roundOne);

  const roundTwo = emptyAnthropicUsage();
  foldAnthropicUsage(roundTwo, { input_tokens: 1200, output_tokens: 30 });
  addAnthropicUsage(total, roundTwo);

  assert.equal(total.input, 2200, "input must be the sum, not the larger round");
  assert.equal(total.output, 50);
});

test("split cache TTL counters beat the aggregate, and never double-count it", () => {
  const round = emptyAnthropicUsage();
  foldAnthropicUsage(round, {
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 700 },
    cache_creation_input_tokens: 800,
  });
  assert.equal(round.cacheWrite5m, 100);
  assert.equal(round.cacheWrite1h, 700);
  assert.equal(round.cacheWrite, 800, "the split total, not split + aggregate");
});

test("a reported standard speed survives to the caller", () => {
  const round = emptyAnthropicUsage();
  foldAnthropicUsage(round, { speed: "standard" });
  const total = emptyAnthropicUsage();
  addAnthropicUsage(total, round);
  // streamAnthropic bills the premium rate only when servedFast AND this is not
  // "standard", so losing it here would over-bill a downgraded turn.
  assert.equal(total.speed, "standard");
});
