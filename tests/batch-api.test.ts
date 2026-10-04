import test from "node:test";
import assert from "node:assert/strict";
import {
  BREAKER_WINDOW,
  MAX_REQUESTS_PER_JOB,
  batchApiEnabled,
  batchBreakerTripped,
  batchDecision,
  batchRequests,
  createBatchingLlm,
  customIdFor,
  isBatchProvider,
  promptKey,
  type PendingPrompt,
} from "@/lib/batch/plan";
import {
  anthropicBatchRequest,
  anthropicBatchStatus,
  openAIBatchLine,
  openAIBatchStatus,
  parseAnthropicBatchResult,
  parseOpenAIBatchOutput,
} from "@/lib/batch/parse";

const prompt = (userMsg: string, label = "memory/extract", system = "sys"): PendingPrompt => ({
  key: promptKey({ label, system, userMsg, maxTokens: 500 }),
  label,
  system,
  userMsg,
  maxTokens: 500,
});

test("BATCH_API_ENABLED defaults on and accepts the usual off spellings", () => {
  assert.equal(batchApiEnabled({}), true);
  assert.equal(batchApiEnabled({ BATCH_API_ENABLED: "true" }), true);
  for (const off of ["false", "0", "off", "no", " FALSE "]) assert.equal(batchApiEnabled({ BATCH_API_ENABLED: off }), false);
});

test("only Anthropic and OpenAI batch", () => {
  assert.ok(isBatchProvider("anthropic"));
  assert.ok(isBatchProvider("openai"));
  assert.ok(!isBatchProvider("google"));
});

test("an extraction's key ignores the known-facts system prompt; other prompts key on everything", () => {
  const a = promptKey({ label: "memory/extract", system: "known: A", userMsg: "chunk", maxTokens: 500 });
  const b = promptKey({ label: "memory/extract", system: "known: A, B", userMsg: "chunk", maxTokens: 500 });
  assert.equal(a, b);
  const c = promptKey({ label: "memory/consolidate", system: "s1", userMsg: "facts", maxTokens: 1400 });
  const d = promptKey({ label: "memory/consolidate", system: "s2", userMsg: "facts", maxTokens: 1400 });
  assert.notEqual(c, d);
  assert.match(a, /^[0-9a-f]{40}$/);
});

test("custom ids fit both APIs' pattern and are unique per request", () => {
  const id = customIdFor(12, "f".repeat(40));
  assert.match(id, /^[a-zA-Z0-9_-]{1,64}$/);
  const requests = batchRequests([prompt("one"), prompt("one"), prompt("two")]);
  assert.equal(requests.length, 2, "a repeated prompt is asked once");
  assert.notEqual(requests[0].customId, requests[1].customId);
  assert.equal(batchRequests(Array.from({ length: 80 }, (_, i) => prompt(`m${i}`))).length, MAX_REQUESTS_PER_JOB);
});

test("the decision: an answer wins; then sync when batching cannot serve; else queue, or wait behind a running batch", () => {
  assert.equal(batchDecision({ hasAnswer: true, enabled: false, hasModel: false, canQueue: false }), "answer");
  assert.equal(batchDecision({ hasAnswer: false, enabled: false, hasModel: true, canQueue: true }), "sync");
  assert.equal(batchDecision({ hasAnswer: false, enabled: true, hasModel: false, canQueue: true }), "sync");
  assert.equal(batchDecision({ hasAnswer: false, enabled: true, hasModel: true, canQueue: true }), "queue");
  assert.equal(batchDecision({ hasAnswer: false, enabled: true, hasModel: true, canQueue: false }), "wait");
});

function harness(over: Partial<Parameters<typeof createBatchingLlm<string>>[0]> = {}) {
  const queued: PendingPrompt[] = [];
  const used: string[] = [];
  const synced: string[] = [];
  const llm = createBatchingLlm<string>({
    answers: new Map(),
    onAnswerUsed: (key) => used.push(key),
    enabled: true,
    canQueue: true,
    chooseModel: () => "claude-haiku-4-5",
    queue: (_model, p) => queued.push(p),
    sync: async (opts) => {
      synced.push(opts.userMsg);
      return "sync answer";
    },
    ...over,
  });
  return { llm, queued, used, synced };
}

test("a prompt with no answer is queued and returns null, which the memory pipeline reads as 'retry later'", async () => {
  const h = harness();
  const out = await h.llm({ system: "sys", userMsg: "chunk 1", maxTokens: 500, label: "memory/extract" });
  assert.equal(out, null);
  assert.equal(h.queued.length, 1);
  assert.equal(h.queued[0].userMsg, "chunk 1");
  assert.deepEqual(h.synced, []);
});

test("an ended batch's answer is returned and counted as used", async () => {
  const key = promptKey({ label: "memory/extract", system: "other", userMsg: "chunk 1", maxTokens: 500 });
  const h = harness({ answers: new Map([[key, '{"facts":[]}']]) });
  const out = await h.llm({ system: "sys", userMsg: "chunk 1", maxTokens: 500, label: "memory/extract" });
  assert.equal(out, '{"facts":[]}');
  assert.deepEqual(h.used, [key]);
  assert.equal(h.queued.length, 0);
});

test("while a batch is running, new prompts wait instead of piling up a second batch", async () => {
  const h = harness({ canQueue: false });
  assert.equal(await h.llm({ system: "s", userMsg: "x", maxTokens: 500, label: "memory/extract" }), null);
  assert.equal(h.queued.length, 0);
  assert.deepEqual(h.synced, []);
});

test("batching off, a tripped breaker, or no batch-capable provider: the synchronous walk answers", async () => {
  for (const over of [{ enabled: false }, { chooseModel: () => null }]) {
    const h = harness(over);
    assert.equal(await h.llm({ system: "s", userMsg: "x", maxTokens: 500, label: "memory/extract" }), "sync answer");
    assert.equal(h.queued.length, 0);
  }
});

test("the breaker trips only after BREAKER_WINDOW settled batches that all failed or went unused", () => {
  const failed = { status: "failed", requestCount: 3, matchedCount: 0 };
  const unused = { status: "applied", requestCount: 3, matchedCount: 0 };
  const useful = { status: "applied", requestCount: 3, matchedCount: 2 };
  assert.equal(batchBreakerTripped([failed, failed]), false);
  assert.equal(batchBreakerTripped(Array(BREAKER_WINDOW).fill(failed)), true);
  assert.equal(batchBreakerTripped([unused, failed, unused]), true);
  assert.equal(batchBreakerTripped([useful, failed, failed]), false);
  assert.equal(batchBreakerTripped([{ status: "submitted", requestCount: 1, matchedCount: 0 }, failed, failed]), false);
});

test("Anthropic: one Messages request per item, with the sync path's thinking settings", () => {
  const req = anthropicBatchRequest(
    { customId: "r0_abc", system: "sys", userMsg: "hello", maxTokens: 500 },
    { model: "claude-haiku-4-5", maxTokens: 500 }
  );
  assert.deepEqual(req, {
    custom_id: "r0_abc",
    params: { model: "claude-haiku-4-5", max_tokens: 500, system: "sys", messages: [{ role: "user", content: "hello" }] },
  });
  assert.equal(anthropicBatchStatus("in_progress"), "in_progress");
  assert.equal(anthropicBatchStatus("ended"), "ended");
});

test("Anthropic results: succeeded text and usage, errors and refusals are not answers", () => {
  const ok = parseAnthropicBatchResult({
    custom_id: "r0_a",
    result: {
      type: "succeeded",
      message: {
        content: [{ type: "text", text: '{"facts":[]}' }],
        stop_reason: "end_turn",
        usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
  });
  assert.deepEqual(ok, {
    customId: "r0_a",
    ok: true,
    text: '{"facts":[]}',
    error: null,
    usage: { input: 900, output: 40, cacheRead: 0, cacheWrite: 0 },
  });
  const errored = parseAnthropicBatchResult({ custom_id: "r1_b", result: { type: "errored", error: { type: "error", error: { type: "invalid_request_error", message: "bad" } } } });
  assert.equal(errored?.ok, false);
  assert.equal(errored?.usage, null, "an errored request is not billed");
  const refused = parseAnthropicBatchResult({
    custom_id: "r2_c",
    result: { type: "succeeded", message: { content: [], stop_reason: "refusal", usage: { input_tokens: 10, output_tokens: 0 } } },
  });
  assert.equal(refused?.ok, false);
  assert.equal(refused?.usage?.input, 10, "a refusal still ran and still bills");
  assert.equal(parseAnthropicBatchResult({}), null);
});

test("OpenAI: a JSONL chat-completions line, and status mapping that keeps partial output", () => {
  const line = JSON.parse(
    openAIBatchLine(
      { customId: "r0_a", system: "sys", userMsg: "hi", maxTokens: 500 },
      { model: "gpt-6-luna", maxCompletionTokens: 500, reasoningEffort: "none" }
    )
  );
  assert.deepEqual(line, {
    custom_id: "r0_a",
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: "gpt-6-luna",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      max_completion_tokens: 500,
      reasoning_effort: "none",
    },
  });
  assert.equal(openAIBatchStatus("in_progress", false), "in_progress");
  assert.equal(openAIBatchStatus("finalizing", false), "in_progress");
  assert.equal(openAIBatchStatus("completed", true), "ended");
  assert.equal(openAIBatchStatus("expired", true), "ended");
  assert.equal(openAIBatchStatus("expired", false), "failed");
  assert.equal(openAIBatchStatus("failed", false), "failed");
});

test("OpenAI output files: answers with usage, per-line errors, junk lines skipped", () => {
  const jsonl = [
    JSON.stringify({
      custom_id: "r0_a",
      response: {
        status_code: 200,
        body: {
          choices: [{ message: { content: "summary" } }],
          usage: { prompt_tokens: 1200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 1024 } },
        },
      },
      error: null,
    }),
    JSON.stringify({ custom_id: "r1_b", response: { status_code: 400, body: { error: { message: "bad" } } }, error: null }),
    "not json",
    "",
  ].join("\n");
  const results = parseOpenAIBatchOutput(jsonl);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    customId: "r0_a",
    ok: true,
    text: "summary",
    error: null,
    usage: { input: 1200, output: 80, cacheRead: 1024, cacheWrite: 0 },
  });
  assert.equal(results[1].ok, false);
  assert.equal(results[1].error, "bad");
});
