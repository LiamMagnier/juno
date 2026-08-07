/**
 * The failure that started this: an empty-bodied HTTP 429 from a model provider
 * ending a Work run permanently, fourteen seconds in, under the sentence
 * "429 status code (no body)".
 *
 * Four properties are asserted here, and each one is a separate half of that
 * bug:
 *
 *   1. The status is read, so the failure has a kind and a `Retry-After`.
 *   2. A retryable failure is retried rather than thrown, and the wait is the
 *      one the provider asked for.
 *   3. The wait races the abort signal, so Stop is not delayed by a back-off.
 *   4. A tool that throws still leaves a transcript every provider will accept —
 *      the property `work/session.ts` depends on for resume and did not have.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { classifyProviderError, ProviderCallError } from "../runner/agent-core/src/providers/errors.js";
import { runAgentLoop } from "../runner/agent-core/src/loop.js";
import type { ProviderAdapter, ProviderStreamEvent } from "../runner/agent-core/src/providers/types.js";
import type { ChatMessage } from "../runner/agent-core/src/types.js";

// ---------------------------------------------------------------------------
// 1. Classification
// ---------------------------------------------------------------------------

test("classifies an empty-bodied 429 as a rate limit rather than an opaque string", () => {
  // Exactly what the OpenAI SDK throws for a 429 it could not parse a body from.
  const sdkError = Object.assign(new Error("429 status code (no body)"), {
    status: 429,
    headers: { "retry-after": "8" },
  });

  const classified = classifyProviderError(sdkError, "Mistral");

  assert.equal(classified.kind, "rate_limit");
  assert.equal(classified.status, 429);
  assert.equal(classified.retryAfterMs, 8_000);
  assert.equal(classified.retryable, true);
  assert.equal(classified.worthFailingOver, true);
  // The whole point: what a person reads is a sentence, and the SDK's string is
  // nowhere in it.
  assert.match(classified.message, /Mistral is limiting how fast Juno may call it/);
  assert.doesNotMatch(classified.message, /429|status code|no body/);
});

test("prefers retry-after-ms, and caps a wait no run should sit through", () => {
  const withMs = classifyProviderError(
    Object.assign(new Error("x"), { status: 429, headers: { "retry-after-ms": "1500" } }),
    "Zhipu",
  );
  assert.equal(withMs.retryAfterMs, 1_500);

  // A lab saying "come back in an hour" is telling us to fail the run over to a
  // different model, not to hold an executor for an hour.
  const absurd = classifyProviderError(
    Object.assign(new Error("x"), { status: 429, headers: { "retry-after": "3600" } }),
    "Zhipu",
  );
  assert.equal(absurd.retryAfterMs, 60_000);
});

test("separates the failures worth retrying from the ones that will never clear", () => {
  const kinds = (status: number) =>
    classifyProviderError(Object.assign(new Error("x"), { status }), "Lab");

  assert.equal(kinds(429).kind, "rate_limit");
  assert.equal(kinds(529).kind, "overloaded");
  assert.equal(kinds(503).kind, "overloaded");
  assert.equal(kinds(500).kind, "transient");
  assert.equal(kinds(401).kind, "auth");
  assert.equal(kinds(400).kind, "invalid_request");

  assert.equal(kinds(500).retryable, true);
  assert.equal(kinds(401).retryable, false);
  assert.equal(kinds(400).retryable, false);

  // Bad credentials follow us to the next model; a bad request often does not.
  assert.equal(kinds(401).worthFailingOver, false);
  assert.equal(kinds(400).worthFailingOver, true);

  // A socket that never opened has no status and is still worth another go.
  const reset = classifyProviderError(Object.assign(new Error("x"), { code: "ECONNRESET" }), "Lab");
  assert.equal(reset.kind, "transient");
  assert.equal(reset.retryable, true);
});

test("a lab that is out of credit says so, and is worth failing over from", () => {
  // The exact shape DeepSeek returned in production on 2026-08-07, which fell
  // through to `unknown` and told a user their run "failed in a way Juno does
  // not recognise".
  const outOfCredit = Object.assign(new Error("402 Insufficient Balance"), {
    status: 402,
    code: "invalid_request_error",
  });

  const classified = classifyProviderError(outOfCredit, "DeepSeek");

  assert.equal(classified.kind, "insufficient_balance");
  // Retrying the same key cannot help; a different lab can.
  assert.equal(classified.retryable, false);
  assert.equal(classified.worthFailingOver, true);
  assert.match(classified.message, /run out of credit/);
  assert.match(classified.message, /another model can run it/);
  assert.doesNotMatch(classified.message, /does not recognise/);
});

test("three labs, three statuses, one condition: out of credit", () => {
  // Every one of these was captured from the live API on 2026-08-07, on a
  // deployment whose four keys were all unfunded at once. The statuses disagree;
  // the condition does not.
  const cases = [
    { label: "DeepSeek", status: 402, message: "402 Insufficient Balance" },
    {
      label: "OpenAI",
      status: 429,
      message: "429 You have no credits remaining. Add credits to continue using the API.",
    },
    {
      label: "Anthropic",
      status: 400,
      message:
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
    },
  ];

  for (const { label, status, message } of cases) {
    const classified = classifyProviderError(
      Object.assign(new Error(message), { status }),
      label,
    );
    assert.equal(classified.kind, "insufficient_balance", `${label} (${status})`);
    // The one that matters most: OpenAI's is a 429, and treating it as a rate
    // limit means four backed-off retries — up to 90s — waiting out a limit
    // that clears only when somebody pays an invoice.
    assert.equal(classified.retryable, false, `${label} must not be retried`);
    assert.equal(classified.worthFailingOver, true, `${label} should try another lab`);
    assert.match(classified.message, /run out of credit/);
  }
});

test("a genuine rate limit is still a rate limit", () => {
  // The guard above must not swallow the case the retry exists for.
  const real = classifyProviderError(
    Object.assign(new Error("429 status code (no body)"), {
      status: 429,
      headers: { "retry-after": "3" },
    }),
    "Mistral",
  );
  assert.equal(real.kind, "rate_limit");
  assert.equal(real.retryable, true);
  assert.equal(real.retryAfterMs, 3_000);
});

test("classification is idempotent, so a nested adapter cannot wrap twice", () => {
  const once = classifyProviderError(
    Object.assign(new Error("x"), { status: 429 }),
    "Lab",
  );
  assert.equal(classifyProviderError(once, "Other"), once);
});

// ---------------------------------------------------------------------------
// A provider that fails a set number of times and then answers.
// ---------------------------------------------------------------------------

function flakyProvider(failures: number, error: () => unknown): ProviderAdapter & { calls: number } {
  const adapter = {
    id: "test",
    name: "Test Lab",
    defaultModel: "test-model",
    calls: 0,
    models: () => ["test-model"],
    capabilities: () => ({
      tools: true,
      vision: false,
      computerUse: false,
      reasoningLevels: [],
      maxContext: 100_000,
      streaming: true,
      mcp: false,
    }),
    async *stream(): AsyncGenerator<ProviderStreamEvent> {
      adapter.calls += 1;
      if (adapter.calls <= failures) throw error();
      yield { type: "text_delta", text: "done" };
      yield {
        type: "done",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  return adapter as ProviderAdapter & { calls: number };
}

const rateLimited = () =>
  new ProviderCallError("rate_limit", 429, 5, "Test Lab", "Test Lab is limiting us.");

function loopOptions(provider: ProviderAdapter, signal: AbortSignal, messages: ChatMessage[]) {
  return {
    provider,
    model: "test-model",
    system: "s",
    messages,
    tools: [],
    signal,
    maxSteps: 3,
    executeToolCall: async () => ({ type: "tool_result" as const, toolCallId: "x", content: "" }),
  };
}

// ---------------------------------------------------------------------------
// 2 + 3. Retry, and the abort that must beat it
// ---------------------------------------------------------------------------

test("retries a rate-limited turn instead of ending the run", async () => {
  const provider = flakyProvider(2, rateLimited);
  const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
  const retries: number[] = [];

  const result = await runAgentLoop({
    ...loopOptions(provider, new AbortController().signal, messages),
    onProviderRetry: (info) => retries.push(info.delayMs),
  });

  assert.equal(provider.calls, 3, "two failures then a success");
  assert.deepEqual(retries, [5, 5], "waited what the provider asked for, both times");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.finalText, "done");
});

test("gives up on a failure that will never clear, without retrying it", async () => {
  const provider = flakyProvider(1, () =>
    new ProviderCallError("auth", 401, null, "Test Lab", "Credentials rejected."),
  );
  const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];

  await assert.rejects(
    runAgentLoop(loopOptions(provider, new AbortController().signal, messages)),
    (error: unknown) => error instanceof ProviderCallError && error.kind === "auth",
  );
  assert.equal(provider.calls, 1, "an auth failure is not worth a second request");
});

test("Stop interrupts the back-off instead of waiting it out", async () => {
  // A wait far longer than the test could tolerate, so a pass proves the abort
  // cut it short rather than the timer elapsing.
  const provider = flakyProvider(99, () =>
    new ProviderCallError("rate_limit", 429, 30_000, "Test Lab", "Limited."),
  );
  const controller = new AbortController();
  const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];

  const started = Date.now();
  const running = runAgentLoop({
    ...loopOptions(provider, controller.signal, messages),
    onProviderRetry: () => {
      // Fired immediately before the wait begins.
      controller.abort();
    },
  });

  const result = await running;
  const elapsed = Date.now() - started;
  assert.equal(result.stopReason, "aborted");
  assert.ok(
    elapsed < 5_000,
    `stop should not wait out a 30s back-off, took ${elapsed}ms`,
  );
});

// ---------------------------------------------------------------------------
// 4. The transcript a thrown tool leaves behind
// ---------------------------------------------------------------------------

test("a tool that throws still leaves every tool_call answered", async () => {
  const provider: ProviderAdapter = {
    id: "test",
    name: "Test Lab",
    defaultModel: "test-model",
    models: () => ["test-model"],
    capabilities: () => ({
      tools: true,
      vision: false,
      computerUse: false,
      reasoningLevels: [],
      maxContext: 100_000,
      streaming: true,
      mcp: false,
    }),
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<ProviderStreamEvent> {
      yield { type: "tool_call", id: "call-1", name: "ask_user", input: {} };
      yield { type: "tool_call", id: "call-2", name: "other", input: {} };
      yield {
        type: "done",
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];

  // Exactly what the Work runner's `askQuestion` does when its wait expires.
  await assert.rejects(
    runAgentLoop({
      ...loopOptions(provider, new AbortController().signal, messages),
      executeToolCall: async () => {
        throw new Error("paused-waiting-for-answer");
      },
    }),
    /paused-waiting-for-answer/,
  );

  // The property every provider requires, and the one resume depends on: the
  // assistant message carries two tool_calls, so the transcript must carry two
  // tool_results. Before this fix the throw escaped before they were pushed.
  const assistant = messages.find((message) => message.role === "assistant");
  assert.ok(assistant, "the assistant turn was recorded");
  const calls = assistant.content.filter((block) => block.type === "tool_call");
  assert.equal(calls.length, 2);

  const answers = messages
    .flatMap((message) => (message.role === "user" ? message.content : []))
    .filter((block) => block.type === "tool_result");
  assert.equal(answers.length, 2, "every tool_call was answered despite the throw");
  assert.deepEqual(
    answers.map((block) => (block.type === "tool_result" ? block.toolCallId : null)).sort(),
    ["call-1", "call-2"],
  );
});
