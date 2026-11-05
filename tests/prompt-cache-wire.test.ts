import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { createToolLoop } from "@/lib/tools/loop";
import { getModel, type ModelInfo } from "@/lib/models";
import { appendVolatileTail } from "@/lib/chat/turn-context-tail";
import { createRequestMeter, type ProviderRequestRecord } from "@/lib/llm/request-meter";
import { createPrefixTracker } from "@/lib/llm/prefix-diagnostic";
import type { LlmEvent, MessageForModel, PromptCacheMode } from "@/types/llm";
import { fakeTurnToolset, scripted } from "./fixtures/tool-loop";
import { createOpenAICacheSim, simCostUsd, type SimRequest } from "./fixtures/openai-cache-sim";

/*
 * Prompt caching, checked on the SERIALIZED request bodies the production
 * adapters send (src/lib/anthropic.ts, openai-responses.ts, openai-compat.ts),
 * across tool-loop rounds and across turns of one conversation:
 *
 *  - tool schemas go out in the same order and the same bytes every request;
 *  - the system tiers and the history the previous request cached are a byte
 *    prefix of the next request (markers stripped: the marker moves by design);
 *  - per-request context (the date, the volatile tail) sits after the cache
 *    breakpoint, and never inside a prefix a later request has to match;
 *  - breakpoints stay within the provider's limit and move to the newest block
 *    each tool round;
 *  - one-off calls ("none") pay for no explicit cache write;
 *  - a model or reasoning change is reported as the reason the prefix changed.
 *
 * The adapters are `server-only`; the marker is stubbed so the real modules run.
 */

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const { streamAnthropic } = req("../src/lib/anthropic") as typeof import("@/lib/anthropic");
const { streamOpenAIResponses } = req("../src/lib/openai-responses") as typeof import("@/lib/openai-responses");
const { streamOpenAICompat } = req("../src/lib/openai-compat") as typeof import("@/lib/openai-compat");

function model(id: string): ModelInfo {
  const found = getModel(id);
  assert.ok(found, `${id} is in the catalog`);
  return found;
}

async function drain(gen: AsyncGenerator<LlmEvent>): Promise<LlmEvent[]> {
  const events: LlmEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

const user = (content: string): MessageForModel => ({ role: "USER", content, attachments: [] });
const assistant = (content: string): MessageForModel => ({ role: "ASSISTANT", content, attachments: [] });

const STABLE = "You are Alevr. ".repeat(40);
const SYSTEM = `${STABLE}\n\nThis user prefers short answers.`;
const DATE = "Today is Wednesday, October 14, 2026.";

/** Strip cache markers, the way a prefix comparison must (the marker moves every request). */
const unmarked = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (key, v) => (key === "cache_control" || key === "prompt_cache_breakpoint" ? undefined : v)));

function recorder() {
  const records: ProviderRequestRecord[] = [];
  const tracker = createPrefixTracker();
  let clock = 1_000;
  const meter = (m: ModelInfo, cacheKey = "conv-1", role = "chat") =>
    createRequestMeter({ model: m, role, cacheKey }, { sink: (r) => records.push(r), tracker, now: () => (clock += 10) });
  return { records, meter };
}

// ── Anthropic ────────────────────────────────────────────────────────────────

type AEvent = Anthropic.RawMessageStreamEvent;
const aStart = (usage: Record<string, unknown>): AEvent =>
  ({ type: "message_start", message: { usage: { output_tokens: 1, ...usage } } }) as unknown as AEvent;
const aText = (index: number, text: string): AEvent[] => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } } as unknown as AEvent,
  { type: "content_block_delta", index, delta: { type: "text_delta", text } } as unknown as AEvent,
  { type: "content_block_stop", index } as unknown as AEvent,
];
const aToolUse = (index: number, id: string, json: string): AEvent[] => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id, name: "lookup", input: {} } } as unknown as AEvent,
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json } } as unknown as AEvent,
  { type: "content_block_stop", index } as unknown as AEvent,
];
const aStop = (reason: string, output = 20): AEvent =>
  ({ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: output } }) as unknown as AEvent;

function anthropicTransport(rounds: AEvent[][]) {
  const requests: Anthropic.Messages.MessageCreateParamsStreaming[] = [];
  return {
    requests,
    transport: {
      async create(params: Anthropic.Messages.MessageCreateParamsStreaming, options: { signal?: AbortSignal }) {
        requests.push(structuredClone(params));
        const round = rounds[requests.length - 1];
        assert.ok(round, `no scripted round ${requests.length}`);
        return scripted(round, options.signal);
      },
    },
  };
}

type Marked = { message: number; block: number };

/** Where the conversation breakpoint sits, and how many breakpoints the request carries in all. */
function anthropicMarkers(body: Anthropic.Messages.MessageCreateParamsStreaming): { conversation: Marked[]; total: number } {
  let total = 0;
  for (const tool of (body.tools ?? []) as Array<{ cache_control?: unknown }>) if (tool.cache_control) total++;
  for (const block of (body.system ?? []) as Array<{ cache_control?: unknown }>) if (block.cache_control) total++;
  const conversation: Marked[] = [];
  body.messages.forEach((message, m) => {
    if (typeof message.content === "string") return;
    message.content.forEach((block, b) => {
      if ((block as { cache_control?: unknown }).cache_control) conversation.push({ message: m, block: b });
    });
  });
  return { conversation, total: total + conversation.length };
}

const asBlocks = (message: Anthropic.MessageParam) =>
  typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;

/** The previous request's cached prefix (up to its conversation marker) is a byte prefix of `next`. */
function assertAnthropicPrefixHolds(
  previous: Anthropic.Messages.MessageCreateParamsStreaming,
  next: Anthropic.Messages.MessageCreateParamsStreaming,
  label: string
) {
  assert.deepEqual(unmarked(next.tools), unmarked(previous.tools), `${label}: tools are byte-identical`);
  const cachedSystem = (previous.system as Anthropic.TextBlockParam[]).filter((b) => b.cache_control);
  assert.deepEqual(
    unmarked((next.system as Anthropic.TextBlockParam[]).slice(0, cachedSystem.length)),
    unmarked(cachedSystem),
    `${label}: cached system tiers are byte-identical`
  );
  const [marker] = anthropicMarkers(previous).conversation;
  assert.ok(marker, `${label}: the previous request had a conversation marker`);
  for (let m = 0; m < marker.message; m++) {
    assert.deepEqual(unmarked(asBlocks(next.messages[m])), unmarked(asBlocks(previous.messages[m])), `${label}: message ${m}`);
    assert.equal(next.messages[m].role, previous.messages[m].role);
  }
  assert.deepEqual(
    unmarked(asBlocks(next.messages[marker.message]).slice(0, marker.block + 1)),
    unmarked(asBlocks(previous.messages[marker.message]).slice(0, marker.block + 1)),
    `${label}: the marked message up to its marker`
  );
}

const SONNET = "claude-sonnet-5-5";

async function anthropicTurn(opts: {
  history: MessageForModel[];
  rounds: AEvent[][];
  tools?: boolean;
  effort?: "low" | "medium" | "high";
  promptCache?: PromptCacheMode;
  modelId?: string;
  meter?: ReturnType<ReturnType<typeof recorder>["meter"]>;
}) {
  const { requests, transport } = anthropicTransport(opts.rounds);
  const toolset = opts.tools ? fakeTurnToolset() : undefined;
  await drain(
    streamAnthropic(
      model(opts.modelId ?? SONNET),
      SYSTEM,
      opts.history,
      4_000,
      undefined,
      opts.effort ?? "medium",
      false,
      toolset ? createToolLoop(toolset) : undefined,
      DATE,
      false,
      STABLE,
      transport,
      opts.promptCache,
      opts.meter
    )
  );
  return requests;
}

const TURN1 = appendVolatileTail([user("hi"), assistant("Hello."), user("Look these up.")], "# Context for this message\n\nnote A");
const TURN2 = appendVolatileTail(
  [user("hi"), assistant("Hello."), user("Look these up."), assistant("alpha is a letter."), user("Thanks, and beta?")],
  "# Context for this message\n\nnote B"
);

test("Anthropic: tools, system tiers and history stay a byte prefix across tool rounds and turns", async () => {
  const usage1 = { input_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 900 } };
  const turn1 = await anthropicTurn({
    history: TURN1,
    tools: true,
    rounds: [
      [aStart(usage1), ...aToolUse(0, "toolu_1", '{"q":"alpha"}'), aStop("tool_use")],
      [aStart({ input_tokens: 30, cache_read_input_tokens: 900, cache_creation: { ephemeral_5m_input_tokens: 60 } }), ...aText(0, "alpha is a letter."), aStop("end_turn")],
    ],
  });
  const turn2 = await anthropicTurn({
    history: TURN2,
    tools: true,
    rounds: [[aStart({ input_tokens: 25, cache_read_input_tokens: 960 }), ...aText(0, "beta too."), aStop("end_turn")]],
  });
  assert.equal(turn1.length, 2);

  // Tool schemas: one deterministic order and the same bytes on every request,
  // the 1h marker on the last tool only.
  for (const body of [...turn1, ...turn2]) {
    const tools = body.tools as Array<{ name: string; cache_control?: { ttl?: string } }>;
    assert.deepEqual(tools.map((t) => t.name), ["lookup", "slow_job"]);
    assert.deepEqual(tools.map((t) => t.cache_control?.ttl ?? null), [null, "1h"]);
    // Four breakpoints at most: last tool, two system tiers, the conversation.
    const markers = anthropicMarkers(body);
    assert.equal(markers.total, 4);
    assert.equal(markers.conversation.length, 1, "one conversation marker, moved rather than added");
    // The date is a third system block, after both cached tiers, unmarked.
    const system = body.system as Anthropic.TextBlockParam[];
    assert.deepEqual(system.map((b) => !!b.cache_control), [true, true, false]);
    assert.equal(system[2].text, DATE);
  }

  // Round 1: the marker sits on the user's own words; the volatile tail follows it, unmarked.
  const r1Last = turn1[0].messages[turn1[0].messages.length - 1];
  const r1Blocks = asBlocks(r1Last) as Array<{ text?: string; cache_control?: unknown }>;
  assert.equal(r1Blocks[0].text, "Look these up.");
  assert.ok(r1Blocks[0].cache_control);
  assert.match(r1Blocks[1].text ?? "", /note A/);
  assert.equal(r1Blocks[1].cache_control, undefined);
  // Round 2: the marker moved to the newest tool_result.
  const r2 = anthropicMarkers(turn1[1]).conversation[0];
  assert.equal(r2.message, turn1[1].messages.length - 1);
  assert.equal((turn1[1].messages[r2.message].content as Array<{ type: string }>)[0].type, "tool_result");

  assertAnthropicPrefixHolds(turn1[0], turn1[1], "round 1 → round 2");
  // The next turn re-sends the tool rounds as text, so it reads the entry the
  // previous turn's FIRST request wrote at the user's words.
  assertAnthropicPrefixHolds(turn1[0], turn2[0], "turn 1 → turn 2");
  // Same effort, same model: the thinking configuration does not move.
  assert.deepEqual(turn2[0].thinking, turn1[0].thinking);
  assert.deepEqual(turn2[0].output_config, turn1[0].output_config);
});

test("Anthropic: a one-off prompt ('none') carries no cache marker anywhere", async () => {
  const [body] = await anthropicTurn({
    history: [user("Title this chat.")],
    promptCache: "none",
    rounds: [[aStart({ input_tokens: 600 }), ...aText(0, "A title"), aStop("end_turn")]],
  });
  assert.doesNotMatch(JSON.stringify(body), /cache_control/);
});

test("Anthropic: one record per request with its own tokens, cost and prefix verdict (fixture numbers)", async () => {
  const { records, meter } = recorder();
  const m = meter(model(SONNET));
  await anthropicTurn({
    history: TURN1,
    tools: true,
    meter: m,
    rounds: [
      [aStart({ input_tokens: 40, cache_creation: { ephemeral_1h_input_tokens: 900 } }), ...aToolUse(0, "toolu_1", '{"q":"alpha"}'), aStop("tool_use", 30)],
      [aStart({ input_tokens: 30, cache_read_input_tokens: 900, cache_creation: { ephemeral_5m_input_tokens: 60 } }), ...aText(0, "alpha."), aStop("end_turn", 20)],
    ],
  });
  await anthropicTurn({
    history: TURN2,
    tools: true,
    meter: meter(model(SONNET)),
    rounds: [[aStart({ input_tokens: 25, cache_read_input_tokens: 960 }), ...aText(0, "beta."), aStop("end_turn", 10)]],
  });
  assert.deepEqual(records.map((r) => [r.round, r.prefix.verdict]), [[0, "first"], [1, "stable"], [0, "stable"]]);
  const [first, second, third] = records;
  assert.deepEqual(first.tokens, { totalInput: 940, fresh: 40, cacheRead: 0, cacheWrite: 900, cacheWrite5m: 0, cacheWrite1h: 900, output: 30, reasoning: 0 });
  // Sonnet 5.5 list rates (model-rates.generated.ts): $2 in, $10 out, $4 1h write, $2.50 5m write, $0.10 read.
  assert.equal(Math.round(first.costUsd * 1e6), Math.round((40 * 2 + 900 * 4 + 30 * 10) / 1e6 * 1e6));
  assert.equal(Math.round(second.costUsd * 1e6), Math.round((30 * 2 + 900 * 0.1 + 60 * 2.5 + 20 * 10) / 1e6 * 1e6));
  assert.equal(second.cacheReadShare, 0.909);
  assert.equal(third.tokens.cacheRead, 960);
  for (const r of records) {
    assert.equal(r.provider, "anthropic");
    assert.equal(r.role, "chat");
    assert.equal(r.contextTier, "standard");
    assert.equal(r.retry, false);
    assert.ok(r.firstTokenMs !== null && r.firstTokenMs <= r.latencyMs);
    // Hashes and counts only: no prompt text, no raw conversation id.
    const line = JSON.stringify(r);
    assert.doesNotMatch(line, /Look these up|note A|Alevr|conv-1/);
  }
});

test("Anthropic: a model switch and an effort change are named as the reason the prefix moved", async () => {
  const { records, meter } = recorder();
  const round = () => [[aStart({ input_tokens: 10 }), ...aText(0, "ok"), aStop("end_turn")]];
  await anthropicTurn({ history: TURN2, rounds: round(), meter: meter(model(SONNET)) });
  await anthropicTurn({ history: TURN2, rounds: round(), effort: "high", meter: meter(model(SONNET)) });
  await anthropicTurn({ history: TURN2, rounds: round(), effort: "high", modelId: "claude-opus-5-5", meter: meter(model("claude-opus-5-5")) });
  assert.deepEqual(records.map((r) => r.prefix.verdict), ["first", "settings", "model"]);
});

test("Anthropic: rejected fast tier reports the downgrade before standard tokens and meters only consumed usage", async () => {
  const m = model("claude-opus-5-5");
  const records: ProviderRequestRecord[] = [];
  const receipts: Array<{ fastMode?: unknown }> = [];
  const meter = createRequestMeter({ model: m, role: "chat", fastMode: true }, {
    sink: (record) => records.push(record),
    onUsage: (usage) => receipts.push(usage),
  });
  let attempts = 0;
  const events = await drain(streamAnthropic(
    m, SYSTEM, [user("Hello")], 4_000, undefined, "medium", false,
    undefined, DATE, true, STABLE,
    { create: async (_params, options) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("Fast capacity exhausted"), { status: 429 });
      return scripted([aStart({ input_tokens: 100 }), ...aText(0, "Hello."), aStop("end_turn", 20)], options.signal);
    } },
    "none", meter,
  ));
  assert.equal(attempts, 2);
  const downgrade = events.findIndex((event) => event.type === "usage" && event.fast === false);
  const firstText = events.findIndex((event) => event.type === "text");
  assert.ok(downgrade >= 0 && downgrade < firstText);
  assert.deepEqual(records.map((record) => [record.ok, record.usageReported]), [[false, false], [true, true]]);
  assert.equal(records[0].costUsd, 0);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].fastMode, false);
});

// ── OpenAI Responses, GPT-5.6+ ───────────────────────────────────────────────

type REvent = OpenAI.Responses.ResponseStreamEvent;
const rText = (text: string): REvent => ({ type: "response.output_text.delta", delta: text }) as unknown as REvent;
const rCall = (callId: string, args: string): REvent =>
  ({ type: "response.output_item.done", item: { type: "function_call", call_id: callId, name: "lookup", arguments: args } }) as unknown as REvent;
const rDone = (usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 5 }): REvent =>
  ({ type: "response.completed", response: { usage } }) as unknown as REvent;

function responsesTransport(rounds: REvent[][]) {
  const requests: Array<Record<string, unknown> & { input: Array<Record<string, unknown>> }> = [];
  return {
    requests,
    transport: {
      async create(params: OpenAI.Responses.ResponseCreateParamsStreaming, options: { signal?: AbortSignal }) {
        requests.push(structuredClone(params) as unknown as (typeof requests)[number]);
        const round = rounds[requests.length - 1];
        assert.ok(round, `no scripted round ${requests.length}`);
        return scripted(round, options.signal);
      },
    },
  };
}

async function responsesTurn(opts: {
  modelId: string;
  history: MessageForModel[];
  rounds: REvent[][];
  tools?: boolean;
  promptCache?: PromptCacheMode;
  meter?: ReturnType<ReturnType<typeof recorder>["meter"]>;
}) {
  const { requests, transport } = responsesTransport(opts.rounds);
  const toolset = opts.tools ? fakeTurnToolset() : undefined;
  await drain(
    streamOpenAIResponses(
      model(opts.modelId),
      SYSTEM,
      opts.history,
      4_000,
      undefined,
      "low",
      false,
      toolset ? createToolLoop(toolset) : undefined,
      DATE,
      "conv-1",
      false,
      false,
      transport,
      opts.promptCache,
      opts.meter
    )
  );
  return requests;
}

const text = (item: Record<string, unknown>) =>
  ((item.content as Array<{ text?: string }> | undefined) ?? []).map((p) => p.text ?? "").join("");
const hasBp = (item: Record<string, unknown>) =>
  ((item.content as Array<Record<string, unknown>> | undefined) ?? []).some((p) => !!p.prompt_cache_breakpoint);

test("GPT-5.6+: the newest user message ends the cached prefix; the tail and the date follow it", async () => {
  const [body] = await responsesTurn({ modelId: "gpt-6.1-sol", history: TURN1, rounds: [[rText("ok"), rDone()]] });
  const input = body.input;
  assert.deepEqual(body.prompt_cache_options, { mode: "implicit", ttl: "30m" });
  assert.equal(input[0].role, "system");
  assert.ok(hasBp(input[0]), "the system prompt carries an explicit breakpoint");
  const at = input.findIndex((item) => text(item) === "Look these up.");
  assert.ok(at > 0, "the user's own words are their own message, without the tail");
  assert.ok(hasBp(input[at]), "an entry is written at the end of the user's words");
  assert.equal(input[at + 1].role, "user");
  assert.match(text(input[at + 1]), /note A/);
  assert.equal(input[input.length - 1].role, "system");
  assert.equal(text(input[input.length - 1]), DATE, "the date is last, after every lookup boundary");
  // Three writes at most (system, user message, implicit): inside OpenAI's four.
  assert.ok(input.filter(hasBp).length <= 3);
});

test("GPT-5.6+: each turn's entry is a lookup-boundary prefix of the next turn (and of the next tool round)", async () => {
  const turn1 = await responsesTurn({
    modelId: "gpt-6.1-sol",
    history: TURN1,
    tools: true,
    rounds: [[rCall("call_1", '{"q":"alpha"}'), rDone()], [rText("alpha is a letter."), rDone()]],
  });
  const turn2 = await responsesTurn({ modelId: "gpt-6.1-sol", history: TURN2, rounds: [[rText("beta."), rDone()]] });

  const userEnd = (input: Array<Record<string, unknown>>, words: string) => input.findIndex((item) => item.role === "user" && text(item) === words);
  // Turn 1 wrote at the end of "Look these up."; turn 2 must hold the same
  // bytes up to there, ending at a user-message boundary it looks up.
  const end1 = userEnd(turn1[0].input, "Look these up.");
  const end2 = userEnd(turn2[0].input, "Look these up.");
  assert.equal(end1, end2);
  assert.deepEqual(unmarked(turn2[0].input.slice(0, end2 + 1)), unmarked(turn1[0].input.slice(0, end1 + 1)));
  // Round 2 extends round 1 unchanged, so round 1's implicit entry is read.
  assert.deepEqual(unmarked(turn1[1].input.slice(0, turn1[0].input.length)), unmarked(turn1[0].input));
  assert.deepEqual(unmarked(turn1[1].tools), unmarked(turn1[0].tools));
});

test("GPT-5.6+: the new layout reads the history the old one re-wrote every turn (fixture numbers)", async () => {
  // A 6-turn conversation with a volatile tail on every turn, sent through the
  // adapter, then rebuilt in the previous layout (date spliced in front of the
  // newest user turn, tail merged into it) and both run through the simulator
  // of OpenAI's documented cache rules (tests/fixtures/openai-cache-sim.ts).
  const turns: string[] = ["Plan a three-day trip to Lisbon.", "Make day two about food.", "Swap the museum for a walk.", "Add a budget per day.", "Shorten it to bullets.", "Translate the bullets to French."];
  const reply = "Here is a detailed answer. ".repeat(60);
  const after: Array<Record<string, unknown> & { input: Array<Record<string, unknown>> }> = [];
  let history: MessageForModel[] = [];
  for (const [i, words] of turns.entries()) {
    history = [...history, user(words)];
    const sent = await responsesTurn({
      modelId: "gpt-6.1-sol",
      history: appendVolatileTail(history, `# Context for this message\n\n${"Retrieved note. ".repeat(40)}#${i}`),
      rounds: [[rText("ok"), rDone()]],
    });
    after.push(sent[0]);
    history = [...history, assistant(reply)];
  }
  const before = after.map((body) => {
    const input = structuredClone(body.input);
    const date = input.pop()!;
    const tail = input.pop()!;
    const own = input.pop()!;
    const parts = own.content as Array<Record<string, unknown>>;
    const merged = { ...own, content: [{ type: "input_text", text: `${parts[0].text}\n\n${text(tail)}` }] };
    return { ...body, input: [...input, date, merged] };
  });
  const run = (bodies: typeof after) => {
    const sim = createOpenAICacheSim();
    return bodies.map((body) => sim.send(body as never));
  };
  const oldRun: SimRequest[] = run(before);
  const newRun: SimRequest[] = run(after);
  // Old layout: every turn after the first read only the system prompt.
  const systemTokens = oldRun[0].tokens > 0 ? oldRun[1].read : 0;
  for (const r of oldRun.slice(1)) assert.equal(r.read, systemTokens, "old layout: only the system prompt is read");
  // New layout: each turn reads everything up to the previous user message.
  for (let i = 1; i < newRun.length; i++) assert.ok(newRun[i].read > oldRun[i].read, `turn ${i + 1} reads more`);
  // GPT-6.1 Sol list rates per MTok (model-rates.generated.ts): $2 input, $0.10 cached, $2.50 write.
  const rates = { input: 2, cacheRead: 0.1, cacheWrite: 2.5 };
  const oldUsd = simCostUsd(oldRun, rates);
  const newUsd = simCostUsd(newRun, rates);
  if (process.env.PRINT_CACHE_FIXTURE) {
    console.log(JSON.stringify({ oldUsd, newUsd, old: oldRun, new: newRun }));
  }
  assert.ok(newUsd < oldUsd * 0.6, `fixture input cost ${newUsd.toFixed(5)} vs ${oldUsd.toFixed(5)}`);
});

test("GPT-5.6+: a one-off prompt asks for explicit mode with no breakpoint, so nothing is written at 1.25x", async () => {
  const [none] = await responsesTurn({ modelId: "gpt-6-luna", history: [user("Title this.")], promptCache: "none", rounds: [[rText("A"), rDone()]] });
  assert.deepEqual(none.prompt_cache_options, { mode: "explicit", ttl: "30m" });
  assert.doesNotMatch(JSON.stringify(none), /prompt_cache_breakpoint/);
  const sim = createOpenAICacheSim();
  assert.equal(sim.send(none as never).written, 0);

  const [short] = await responsesTurn({ modelId: "gpt-6-luna", history: [user("Extract.")], promptCache: "short", rounds: [[rText("A"), rDone()]] });
  assert.deepEqual(short.prompt_cache_options, { mode: "explicit", ttl: "30m" });
  assert.deepEqual(short.input.filter(hasBp).map((item) => item.role), ["system"], "'short': the shared system prompt only");
});

test("pre-5.6 OpenAI keeps its layout: interval caching, the date in front of the newest turn", async () => {
  const [body] = await responsesTurn({ modelId: "gpt-5.5", history: TURN1, rounds: [[rText("ok"), rDone()]] });
  const input = body.input;
  assert.equal(body.prompt_cache_retention, "24h");
  assert.equal(input[input.length - 2].role, "system");
  assert.equal(text(input[input.length - 2]), DATE);
  assert.match(text(input[input.length - 1]), /^Look these up\.\n\n# Context/);
  assert.doesNotMatch(JSON.stringify(body), /prompt_cache_breakpoint/);
});

test("Responses records name the request's cache counters and the reason for a miss", async () => {
  const { records, meter } = recorder();
  await responsesTurn({
    modelId: "gpt-6.1-sol",
    history: TURN1,
    meter: meter(model("gpt-6.1-sol")),
    rounds: [[rText("ok"), rDone({ input_tokens: 2000, output_tokens: 50, input_tokens_details: { cached_tokens: 1200, cache_write_tokens: 700 } })]],
  });
  await responsesTurn({ modelId: "gpt-6.1-sol", history: TURN2, meter: meter(model("gpt-6.1-sol")), rounds: [[rText("ok"), rDone()]] });
  assert.deepEqual(records.map((r) => r.prefix.verdict), ["first", "stable"]);
  assert.deepEqual(
    [records[0].tokens.fresh, records[0].tokens.cacheRead, records[0].tokens.cacheWrite, records[0].tokens.totalInput],
    [100, 1200, 700, 2000]
  );
  // $2 fresh, $0.10 read, $2.50 write, $10 output per MTok.
  assert.equal(Math.round(records[0].costUsd * 1e6), Math.round(100 * 2 + 1200 * 0.1 + 700 * 2.5 + 50 * 10));
});

// ── Chat Completions (OPENAI_RESPONSES=0, and every other OpenAI-shaped lab) ──

type CChunk = OpenAI.Chat.Completions.ChatCompletionChunk;
const cText = (t: string): CChunk => ({ choices: [{ index: 0, delta: { content: t }, finish_reason: null }] }) as unknown as CChunk;
const cDone = (): CChunk =>
  ({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) as unknown as CChunk;

async function compatTurn(modelId: string, history: MessageForModel[], promptCache?: PromptCacheMode) {
  const requests: Array<Record<string, unknown> & { messages: Array<Record<string, unknown>> }> = [];
  const transport = {
    async create(params: unknown, options: { signal?: AbortSignal }) {
      requests.push(structuredClone(params) as (typeof requests)[number]);
      return scripted([cText("ok"), cDone()], options.signal);
    },
  };
  await drain(
    streamOpenAICompat(model(modelId), SYSTEM, history, 4_000, undefined, undefined, false, undefined, DATE, "conv-1", false, transport as never, promptCache)
  );
  return requests[0];
}

test("Chat Completions: GPT-5.6+ gets the date after the newest turn and no writes on a one-off; other labs unchanged", async () => {
  const sol = await compatTurn("gpt-5.6-sol", [user("hi"), assistant("Hello."), user("And now?")]);
  assert.equal(sol.messages[sol.messages.length - 1].content, DATE);
  const none = await compatTurn("gpt-5.6-sol", [user("Title this.")], "none");
  assert.deepEqual(none.prompt_cache_options, { mode: "explicit", ttl: "30m" });
  assert.doesNotMatch(JSON.stringify(none), /prompt_cache_breakpoint/);
  // Mistral caches by prefix with its key; the date stays in front of the newest turn.
  const mistral = await compatTurn("mistral-large-latest", [user("hi"), assistant("Hello."), user("And now?")]);
  assert.equal(mistral.messages[mistral.messages.length - 2].content, DATE);
  assert.equal(mistral.prompt_cache_key, "conv-1");
});
