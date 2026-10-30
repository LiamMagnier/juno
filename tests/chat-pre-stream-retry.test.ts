import assert from "node:assert/strict";
import { test } from "node:test";
import { markModelCallError } from "@/lib/provider-error";
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

/*
 * The one retry before the first byte (src/lib/chat/turn/pre-stream-retry.ts),
 * through its pure policy. The turn wiring — the spend holds, the meter's
 * attempt 2, Auto's next candidate, the activity rows on the wire — is pinned
 * against a real database in tests/chat-turn-pipeline.integration.test.ts,
 * with a scripted provider standing in for the model.
 *
 * The errors below are shaped like the SDKs' (status, headers, cause) and
 * marked the way `streamChat` marks what its adapters throw. Nothing is
 * called: there is no provider key on this machine and none is needed.
 */

/** An error the model call threw, as `streamChat` hands it on. */
function modelError(message: string, extra: Record<string, unknown> = {}): Error {
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
    modelError("getaddrinfo ENOTFOUND api.example.invalid"),
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
