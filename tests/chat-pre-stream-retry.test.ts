import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { buildRun } from "@/components/chat/thought-process-model";
import { createRequestMeter, type ProviderRequestRecord } from "@/lib/llm/request-meter";
import { createPrefixTracker } from "@/lib/llm/prefix-diagnostic";
import { getModel } from "@/lib/models";
import { markModelCallError, markRequestRejected, requestRejection } from "@/lib/provider-error";
import {
  DEFAULT_PRE_STREAM_RETRY_TUNABLES,
  RETRYING_ACTIVITY_TITLE,
  countingStream,
  planPreStreamRetry,
  preStreamRetryTunables,
  retryActivityRows,
  retryAfterMsOf,
  waitBeforeRetry,
} from "@/lib/chat/turn/pre-stream-retry";
import type { ClientActivityEvent } from "@/types/chat";

/*
 * The one retry before the first byte (src/lib/chat/turn/pre-stream-retry.ts),
 * through its pure policy. The turn wiring — the spend holds, the meter's
 * attempt 2, Auto's next candidate, the activity rows on the wire — is pinned
 * against a real database in tests/chat-turn-pipeline.integration.test.ts,
 * with a scripted provider standing in for the model.
 *
 * The errors below are shaped like the SDKs' (status, headers, cause) and
 * marked the way the adapters and `streamChat` mark what they throw. Nothing
 * is called here: there is no provider key on this machine and none is
 * needed. The marks themselves are pinned against the real SDKs and a local
 * server in tests/chat-pre-stream-retry-wire.test.ts.
 */

/**
 * An error thrown while the adapter opened its first request (an HTTP status
 * instead of a stream, or a connection that failed), as `streamChat` hands it on.
 */
function modelError(message: string, extra: Record<string, unknown> = {}): Error {
  const err = Object.assign(new Error(message), extra);
  markRequestRejected(err);
  markModelCallError(err);
  return err;
}

/** An error raised while reading a stream the provider had accepted. */
function streamError(message: string, extra: Record<string, unknown> = {}): Error {
  const err = Object.assign(new Error(message), extra);
  markModelCallError(err);
  return err;
}

const nothing = { events: 0, output: false };
const tunables = DEFAULT_PRE_STREAM_RETRY_TUNABLES;
/** The middle of every jitter, so the expected waits are exact. */
const mid = () => 0.5;

test("tunables: on with an 8 s bound by default; an off switch; the bound is clamped", () => {
  assert.deepEqual(preStreamRetryTunables({}), { enabled: true, maxWaitMs: 8000 });
  for (const off of ["off", "OFF", "0", "false", "no"]) {
    assert.equal(preStreamRetryTunables({ CHAT_PRESTREAM_RETRY: off }).enabled, false, off);
  }
  assert.equal(preStreamRetryTunables({ CHAT_PRESTREAM_RETRY: "on" }).enabled, true);
  assert.equal(preStreamRetryTunables({ CHAT_PRESTREAM_RETRY_MAX_WAIT_MS: "2500" }).maxWaitMs, 2500);
  assert.equal(preStreamRetryTunables({ CHAT_PRESTREAM_RETRY_MAX_WAIT_MS: "999999" }).maxWaitMs, 15000);
  assert.equal(preStreamRetryTunables({ CHAT_PRESTREAM_RETRY_MAX_WAIT_MS: "-5" }).maxWaitMs, 0);
  assert.equal(preStreamRetryTunables({ CHAT_PRESTREAM_RETRY_MAX_WAIT_MS: "soon" }).maxWaitMs, 8000, "garbage keeps the default");
});

test("a 429, a 503 and a 529 before anything arrived: one retry on the same model, after a jittered wait", () => {
  for (const [status, klass] of [
    [429, "rate_limit"],
    [503, "capacity"],
    [529, "rate_limit"], // "overloaded" wording classifies as a throttle
  ] as const) {
    const err = modelError(status === 529 ? "529 overloaded_error: Overloaded" : `${status} status code (no body)`, { status });
    const verdict = planPreStreamRetry({ err, attempt: 1, received: nothing, cancelled: false, auto: false, tunables, random: mid });
    assert.equal(verdict.retry, true, `${status}`);
    if (!verdict.retry) continue;
    assert.equal(verdict.class, klass);
    assert.equal(verdict.status, status);
    assert.deepEqual(verdict.sameModel, { delayMs: 800 }, "the centre of 400–1200 ms");
    assert.equal(verdict.nextModel, null, "an explicit choice never moves");
  }
  // The jitter really spreads the wait between half and one and a half times the base.
  const lo = planPreStreamRetry({ err: modelError("503", { status: 503 }), attempt: 1, received: nothing, cancelled: false, auto: false, tunables, random: () => 0 });
  const hi = planPreStreamRetry({ err: modelError("503", { status: 503 }), attempt: 1, received: nothing, cancelled: false, auto: false, tunables, random: () => 0.999 });
  assert.ok(lo.retry && hi.retry);
  if (lo.retry && hi.retry) {
    assert.equal(lo.sameModel?.delayMs, 400);
    assert.equal(hi.sameModel?.delayMs, 1199);
  }
});

test("a connection that failed before any answer is a rejection too: reset, refused, unresolvable, the SDKs' 'Connection error.'", () => {
  const cases: Error[] = [
    modelError("fetch failed", { cause: { code: "ECONNREFUSED" } }),
    modelError("socket hang up", { code: "ECONNRESET" }),
    // Undici's shape: the code rides the cause, not the words.
    modelError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.example.invalid"), { code: "ENOTFOUND" }) }),
    modelError("Connection error.", { cause: { code: "UND_ERR_SOCKET" } }),
    modelError("Connection error."),
    modelError("connect timeout", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }),
  ];
  for (const err of cases) {
    const verdict = planPreStreamRetry({ err, attempt: 1, received: nothing, cancelled: false, auto: false, tunables, random: mid });
    assert.equal(verdict.retry, true, err.message);
    if (verdict.retry) assert.equal(verdict.class, "network", err.message);
  }
});

test("a stream the provider had accepted is never asked again, however it broke: only the request's own opening is a rejection", () => {
  // Undici's mid-body failure after the provider's 200 and opening events
  // (Anthropic's message_start, the Responses response.created), which the
  // adapters keep to themselves: the stream yielded nothing, but the provider
  // had started work and billing.
  const terminated = Object.assign(new TypeError("terminated"), {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });
  markModelCallError(terminated);
  for (const err of [
    terminated,
    streamError("network error while generating"),
    streamError("Connection error.", { cause: { code: "ECONNRESET" } }),
    // An SSE error event the SDK raises with a status mid-stream.
    streamError("503 overloaded_error", { status: 503 }),
    streamError("429 rate_limit_error", { status: 429 }),
  ]) {
    for (const auto of [false, true]) {
      const verdict = planPreStreamRetry({ err, attempt: 1, received: nothing, cancelled: false, auto, tunables, random: mid });
      assert.equal(verdict.retry, false, `${err.message} (auto ${auto})`);
      if (!verdict.retry) assert.equal(verdict.why, "not_rejection", err.message);
    }
  }
  // Marked at the request's opening but with neither a status nor a socket
  // code: wording that mentions the network is not a failed connection.
  const worded = planPreStreamRetry({ err: modelError("network error while generating"), attempt: 1, received: nothing, cancelled: false, auto: false, tunables });
  assert.equal(worded.retry, false);
  if (!worded.retry) assert.equal(worded.why, "not_rejection");
});

test("a timeout anywhere down the cause chain is never a failed connection; a connect timeout (no request sent) is", () => {
  // The SDKs wrap fetch's TypeError, which wraps undici's error: the code
  // sits two levels down under "Connection error.".
  const headersTimeout = modelError("Connection error.", {
    cause: Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
    }),
  });
  const bodyTimeout = modelError("Connection error.", {
    cause: Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" }),
    }),
  });
  for (const err of [headersTimeout, bodyTimeout]) {
    const verdict = planPreStreamRetry({ err, attempt: 1, received: nothing, cancelled: false, auto: true, tunables });
    assert.deepEqual(verdict, { retry: false, why: "not_rejection", class: "unknown" }, String((err.cause as Error).cause));
  }
  const connectTimeout = modelError("Connection error.", {
    cause: Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("Connect Timeout Error (attempted address: api.example.invalid:443, timeout: 10000ms)"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    }),
  });
  const verdict = planPreStreamRetry({ err: connectTimeout, attempt: 1, received: nothing, cancelled: false, auto: false, tunables, random: mid });
  assert.ok(verdict.retry && verdict.class === "network" && verdict.sameModel);
  // A cycle in the chain does not hang the check.
  const looped = modelError("Connection error.");
  Object.defineProperty(looped, "cause", { value: looped });
  assert.equal(planPreStreamRetry({ err: looped, attempt: 1, received: nothing, cancelled: false, auto: false, tunables, random: mid }).retry, true);
});

test("a safety refusal sent as a 403 is final under Auto too: never moved to another lab", () => {
  for (const err of [
    modelError("Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_BIO", { status: 403 }),
    // The openai SDK's shape for a body whose `error` is a bare string (xAI's
    // `{ code, error }`): the string becomes `error` and, quoted, the message.
    modelError('403 "Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_CSAM"', {
      status: 403,
      error: "Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_CSAM",
    }),
    modelError("Request blocked by content policy", { status: 403 }),
  ]) {
    for (const auto of [false, true]) {
      const verdict = planPreStreamRetry({ err, attempt: 1, received: nothing, cancelled: false, auto, tunables, random: mid });
      assert.deepEqual(verdict, { retry: false, why: "class", class: "content_filter" }, `${err.message} (auto ${auto})`);
    }
  }
  // A bare 403 with no safety wording is still an account fault Auto may move on from.
  const bare = planPreStreamRetry({ err: modelError("403 Forbidden", { status: 403 }), attempt: 1, received: nothing, cancelled: false, auto: true, tunables, random: mid });
  assert.ok(bare.retry && bare.class === "auth" && bare.nextModel && !bare.sameModel);
});

test("an adapter that already sent the request twice (Anthropic's fast-mode fallback) has used the same model's second ask", () => {
  const err = Object.assign(new Error("429 rate_limit_error"), { status: 429 });
  markRequestRejected(err, { adapterRetried: true });
  markModelCallError(err);
  assert.deepEqual(requestRejection(err), { adapterRetried: true });
  const explicit = planPreStreamRetry({ err, attempt: 1, received: nothing, cancelled: false, auto: false, tunables, random: mid });
  assert.deepEqual(explicit, { retry: false, why: "class", class: "rate_limit" }, "a third request to the same model is not 'one retry'");
  const auto = planPreStreamRetry({ err, attempt: 1, received: nothing, cancelled: false, auto: true, tunables, random: mid });
  assert.ok(auto.retry && auto.sameModel === null && auto.nextModel, "Auto may still ask another model once");
  // The marks are invisible to everything else that reads the error.
  assert.deepEqual(Object.keys(err), ["status"]);
  assert.equal(requestRejection(new Error("plain")), null);
  assert.equal(requestRejection(null), null);
});

test("never after a single event, a token or a usage report: the no-double-billing rule comes before the error is read", () => {
  const err = modelError("429 Too Many Requests", { status: 429 });
  for (const received of [
    { events: 1, output: false },
    { events: 0, output: true },
    { events: 7, output: true },
  ]) {
    const verdict = planPreStreamRetry({ err, attempt: 1, received, cancelled: false, auto: true, tunables, random: mid });
    assert.deepEqual(verdict, { retry: false, why: "output_received", class: null }, JSON.stringify(received));
  }
});

test("bounded: a second attempt is never retried, and the off switch turns it off", () => {
  const err = modelError("503", { status: 503 });
  assert.equal(
    (planPreStreamRetry({ err, attempt: 2, received: nothing, cancelled: false, auto: true, tunables, random: mid }) as { why?: string }).why,
    "already_retried",
  );
  assert.equal(
    (planPreStreamRetry({ err, attempt: 1, received: nothing, cancelled: false, auto: true, tunables: { ...tunables, enabled: false } }) as { why?: string }).why,
    "disabled",
  );
});

test("a Stop, a drain, the watchdog or a lost lease is never retried, and neither is an abort or a timeout", () => {
  const rate = modelError("429", { status: 429 });
  assert.equal(
    (planPreStreamRetry({ err: rate, attempt: 1, received: nothing, cancelled: true, auto: true, tunables }) as { why?: string }).why,
    "cancelled",
  );
  const abort = new DOMException("Stopped by user", "AbortError");
  markModelCallError(abort);
  for (const err of [
    abort,
    modelError("Request was aborted."),
    // The request may be running at the provider: the billing risk itself.
    modelError("Request timed out."),
    modelError("Headers Timeout Error", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }),
    modelError("read ETIMEDOUT", { code: "ETIMEDOUT" }),
  ]) {
    const verdict = planPreStreamRetry({ err, attempt: 1, received: nothing, cancelled: false, auto: true, tunables });
    assert.equal(verdict.retry, false, err.message);
    if (!verdict.retry) assert.equal(verdict.why, "not_rejection", err.message);
  }
});

test("only what the model call threw: an error from a tool, the research leg or our own code is not the provider's rejection", () => {
  const unmarked = Object.assign(new Error("503 Service Unavailable"), { status: 503 });
  const verdict = planPreStreamRetry({ err: unmarked, attempt: 1, received: nothing, cancelled: false, auto: true, tunables });
  assert.deepEqual(verdict, { retry: false, why: "not_model_call", class: null });
  // A marked error with neither a status nor a failed connection (an SSE
  // error event inside an accepted stream, an internal throw).
  const noStatus = planPreStreamRetry({ err: modelError("overloaded_error"), attempt: 1, received: nothing, cancelled: false, auto: true, tunables });
  assert.equal(noStatus.retry, false);
  if (!noStatus.retry) assert.equal(noStatus.why, "not_rejection");
});

test("an explicit choice is not moved and not retried for faults a moment cannot cure; Auto moves on from a model or account fault", () => {
  const account = [
    modelError("402 Insufficient Balance", { status: 402 }),
    modelError("401 Incorrect API key provided", { status: 401 }),
    modelError("403 Forbidden", { status: 403 }),
    modelError("404 The model `x` does not exist", { status: 404 }),
  ];
  for (const err of account) {
    const explicit = planPreStreamRetry({ err, attempt: 1, received: nothing, cancelled: false, auto: false, tunables, random: mid });
    assert.equal(explicit.retry, false, err.message);
    if (!explicit.retry) assert.equal(explicit.why, "class");
    const auto = planPreStreamRetry({ err, attempt: 1, received: nothing, cancelled: false, auto: true, tunables, random: mid });
    assert.equal(auto.retry, true, err.message);
    if (auto.retry) {
      assert.equal(auto.sameModel, null, "the same model would fail the same way");
      assert.deepEqual(auto.nextModel, { delayMs: 400 }, "another model owes no backoff: a short jitter");
    }
  }
  // Auto with a transient fault may do either; run-turn prefers the next candidate.
  const busy = planPreStreamRetry({ err: modelError("503", { status: 503 }), attempt: 1, received: nothing, cancelled: false, auto: true, tunables, random: mid });
  assert.ok(busy.retry && busy.sameModel && busy.nextModel);
});

test("never model-shopping: a safety refusal, an oversize prompt, a malformed request or an unknown 4xx is final, even under Auto", () => {
  for (const err of [
    modelError("400 Output blocked by content filtering policy", { status: 400 }),
    modelError("400 This model's maximum context length is 128000 tokens", { status: 400 }),
    modelError("400 Invalid value for 'tool_choice'", { status: 400 }),
    modelError("409 Conflict", { status: 409 }),
  ]) {
    const verdict = planPreStreamRetry({ err, attempt: 1, received: nothing, cancelled: false, auto: true, tunables, random: mid });
    assert.equal(verdict.retry, false, err.message);
    if (!verdict.retry) assert.equal(verdict.why, "class", err.message);
  }
});

test("the provider's own wait is honoured up to the bound; a longer one is not retried on the same model, and does not hold Auto back", () => {
  const asked = (seconds: number) => modelError(`429 Too Many Requests`, { status: 429, headers: { "retry-after": String(seconds) } });
  const three = planPreStreamRetry({ err: asked(3), attempt: 1, received: nothing, cancelled: false, auto: false, tunables, random: mid });
  assert.ok(three.retry);
  if (three.retry) {
    assert.equal(three.retryAfterMs, 3000);
    assert.equal(three.sameModel?.delayMs, 3125, "the asked wait plus up to 250 ms of spread");
  }
  const thirty = planPreStreamRetry({ err: asked(30), attempt: 1, received: nothing, cancelled: false, auto: false, tunables, random: mid });
  assert.deepEqual(thirty, { retry: false, why: "wait_too_long", class: "rate_limit" });
  const thirtyAuto = planPreStreamRetry({ err: asked(30), attempt: 1, received: nothing, cancelled: false, auto: true, tunables, random: mid });
  assert.ok(thirtyAuto.retry);
  if (thirtyAuto.retry) {
    assert.equal(thirtyAuto.sameModel, null);
    assert.deepEqual(thirtyAuto.nextModel, { delayMs: 400 });
  }
  // A tighter owner bound caps every wait, and refuses an ask above it.
  const tight = { enabled: true, maxWaitMs: 100 };
  const capped = planPreStreamRetry({ err: modelError("503", { status: 503 }), attempt: 1, received: nothing, cancelled: false, auto: false, tunables: tight, random: () => 0.999 });
  assert.ok(capped.retry && capped.sameModel?.delayMs === 100);
  assert.equal((planPreStreamRetry({ err: asked(1), attempt: 1, received: nothing, cancelled: false, auto: false, tunables: tight }) as { why?: string }).why, "wait_too_long");
});

test("Gemini's adapter already retried its own transient faults: no third ask of the same model; Auto may still move on", () => {
  const err = modelError("429 RESOURCE_EXHAUSTED", { status: 429 });
  const explicit = planPreStreamRetry({ err, attempt: 1, received: nothing, cancelled: false, auto: false, adapterRetries: true, tunables });
  assert.deepEqual(explicit, { retry: false, why: "class", class: "rate_limit" });
  const auto = planPreStreamRetry({ err, attempt: 1, received: nothing, cancelled: false, auto: true, adapterRetries: true, tunables, random: mid });
  assert.ok(auto.retry && auto.sameModel === null && auto.nextModel);
});

test("the wait the provider named, in every spelling it uses", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  assert.equal(retryAfterMsOf({ headers: { "retry-after-ms": "1500" } }, now), 1500);
  assert.equal(retryAfterMsOf({ headers: new Headers({ "retry-after": "4" }) }, now), 4000);
  assert.equal(retryAfterMsOf({ headers: { "retry-after": "Fri, 30 Oct 2026 12:00:05 GMT" } }, now), 5000);
  assert.equal(retryAfterMsOf(new Error("RESOURCE_EXHAUSTED. Please retry in 2.5s."), now), 3000, "Gemini's wording, whole seconds");
  assert.equal(retryAfterMsOf(new Error("503"), now), null);
  assert.equal(retryAfterMsOf({ headers: { "retry-after": "" } }, now), null);
});

test("the attempt's stream is counted as it is read: zero when the provider threw before yielding", async () => {
  async function* rejects(): AsyncGenerator<{ type: string }> {
    throw modelError("429", { status: 429 });
  }
  const before = countingStream(rejects());
  await assert.rejects(async () => {
    for await (const _ of before.stream) void _;
  }, /429/);
  assert.equal(before.received(), 0);

  async function* oneThenFails(): AsyncGenerator<{ type: string }> {
    yield { type: "usage" };
    throw modelError("503", { status: 503 });
  }
  const after = countingStream(oneThenFails());
  const seen: string[] = [];
  await assert.rejects(async () => {
    for await (const event of after.stream) seen.push(event.type);
  }, /503/);
  assert.deepEqual(seen, ["usage"], "events pass through untouched");
  assert.equal(after.received(), 1);
});

test("the wait ends early when the turn is stopped, and not at all when it already was", async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 20);
  await waitBeforeRetry(5_000, controller.signal);
  assert.ok(Date.now() - started < 1_000, "a Stop does not sit out the backoff");
  const already = Date.now();
  await waitBeforeRetry(5_000, controller.signal);
  assert.ok(Date.now() - already < 50);
  const plain = Date.now();
  await waitBeforeRetry(30, new AbortController().signal);
  assert.ok(Date.now() - plain >= 25);
});

test("the activity rows: a visible 'Retrying…', in words true to the fault, and never the account's state", () => {
  const busy = retryActivityRows({ failed: { name: "Qwen3.8 Flash" }, class: "rate_limit", delayMs: 3100 });
  assert.deepEqual(busy, [
    { kind: "model", title: RETRYING_ACTIVITY_TITLE, detail: "Qwen3.8 Flash is busy right now. Asking it again in 3 seconds." },
  ]);
  assert.equal(RETRYING_ACTIVITY_TITLE, "Retrying…");
  assert.equal(
    retryActivityRows({ failed: { name: "Claude Sonnet 5" }, class: "capacity", delayMs: 600 })[0].detail,
    "Claude Sonnet 5 had a temporary server problem. Asking it again.",
    "a wait nobody notices is not announced",
  );
  assert.equal(
    retryActivityRows({ failed: { name: "GPT-6 Luna" }, class: "network", delayMs: 900 })[0].detail,
    "GPT-6 Luna could not be reached. Asking it again.",
  );
  const moved = retryActivityRows({ failed: { name: "Qwen3.8 Flash" }, next: { name: "GPT-6 Luna" }, class: "billing", delayMs: 400 });
  assert.deepEqual(moved.map((row) => [row.kind, row.title]), [
    ["model", "Retrying…"],
    ["model", "Selected model"],
  ]);
  assert.match(moved[1].detail!, /GPT-6 Luna/, "the second row names the model that now answers");
  for (const row of moved) {
    assert.doesNotMatch(row.detail ?? "", /credit|balance|quota|billing|key|funds/i, "the platform's funding state stays off the stream");
  }
});

test("the run panel's Model fact names the model that answered after Auto moved on, and a same-model retry leaves it alone", () => {
  const T0 = Date.parse("2026-10-30T10:00:00.000Z");
  const stamp = (rows: Array<Omit<ClientActivityEvent, "id" | "createdAt">>): ClientActivityEvent[] =>
    rows.map((row, index) => ({ ...row, id: `e${index}`, createdAt: new Date(T0 + index * 400).toISOString() }));
  const selected = { kind: "model" as const, title: "Selected model", detail: "Auto picked Qwen3.8 Flash — quick reply, low cost" };
  const writing = [
    { kind: "write" as const, title: "Writing the answer", detail: "Streaming response text" },
    { kind: "usage" as const, title: "Token usage recorded", detail: "40 input · 12 output" },
    { kind: "done" as const, title: "Finished response" },
  ];
  const moved = buildRun(
    stamp([
      selected,
      ...retryActivityRows({ failed: { name: "Qwen3.8 Flash" }, next: { name: "GPT-6 Luna" }, class: "billing", delayMs: 400 }),
      ...writing,
    ]),
    null,
  );
  assert.equal(moved.facts.find((fact) => fact.label === "Model")?.value, "Auto switched to GPT-6 Luna — Qwen3.8 Flash did not answer");
  const same = buildRun(
    stamp([selected, ...retryActivityRows({ failed: { name: "Qwen3.8 Flash" }, class: "rate_limit", delayMs: 800 }), ...writing]),
    null,
  );
  assert.equal(same.facts.find((fact) => fact.label === "Model")?.value, selected.detail, "the same model still answers");
  // The retry row is not a warning: the finished run is not marked as cut short or failed.
  assert.equal(same.steps.some((step) => step.failed), false);
});

test("attempt 2 is metered as a retry: run-turn passes the attempt, streamChat hands it to the request meter", () => {
  const records: ProviderRequestRecord[] = [];
  const model = getModel("qwen:qwen3.8-flash");
  assert.ok(model, "a catalogue model to meter");
  const tracker = createPrefixTracker();
  for (const attempt of [undefined, 1, 2]) {
    const meter = createRequestMeter(
      { model, role: "chat", cacheKey: "conv-retry", attempt },
      { sink: (record) => records.push(record), tracker, now: () => 1_000 },
    );
    // A rejected request: begun, ended with no usage and not ok.
    meter.begin({ wire: "compat", round: 0, body: { model: model.providerModel, messages: [] } }).end(null, { ok: false });
  }
  assert.deepEqual(
    records.map((record) => [record.attempt, record.retry, record.ok, record.usageReported]),
    [
      [1, false, false, false],
      [1, false, false, false],
      [2, true, false, false],
    ],
  );
  // The wiring between the two, as written: the turn opens each attempt with
  // its number, and streamChat passes it to the meter untouched.
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  assert.match(read("src/lib/chat/turn/run-turn.ts"), /const openModelStream = \(attempt: number\) => streamChat\(\{\s*attempt,/);
  assert.match(read("src/lib/llm.ts"), /createRequestMeter\(\s*\{[\s\S]*?attempt: opts\.attempt,/);
});
