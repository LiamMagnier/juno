import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SEND_RETRY,
  abortableSleep,
  classifyResponse,
  parseRetryAfter,
  retryDelayMs,
  retryPlan,
  sendFailedMessage,
  sendGatewayMessage,
  sendTurn,
  sendUnreachableMessage,
  signalWithTimeout,
  verifyTurnLanded,
  type SendSafety,
  type SendTurnDeps,
  type SendVerification,
} from "@/lib/chat/send-retry";
import { DRAIN_RETRY_AFTER_SECONDS, DRAINING_RESPONSE } from "@/lib/shutdown";
import { chatBodySchema } from "@/lib/chat/request";

/*
 * Deploy-safe sends (src/lib/chat/send-retry.ts): the client half of the
 * drain. A turn whose POST did not reach a working server goes out again only
 * when that is provably harmless, waits Retry-After (with jitter) or a short
 * backoff between tries, gives up after a small bounded number, and stops the
 * moment its abort signal fires. A turn whose stream started is never posted
 * again: that is the resume path's (use-chat.ts, reconnectFromLog).
 */

type Answer =
  | { kind: "json"; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: "html"; status: number }
  | { kind: "stream" }
  | { kind: "reject" };

function respond(answer: Answer): Response {
  switch (answer.kind) {
    case "json":
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json", ...answer.headers },
      });
    case "html":
      // nginx's own error page: what a 502 looks like while the app is down.
      return new Response("<html><body><center><h1>502 Bad Gateway</h1></center></body></html>", {
        status: answer.status,
        headers: { "content-type": "text/html" },
      });
    case "stream":
      return new Response('data: {"type":"meta"}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    case "reject":
      throw new TypeError("Failed to fetch");
  }
}

const drain = (retryAfter = String(DRAIN_RETRY_AFTER_SECONDS)): Answer => ({
  kind: "json",
  status: 503,
  body: DRAINING_RESPONSE,
  headers: { "retry-after": retryAfter },
});

/** A fake network and a fake clock: every POST is recorded, every wait is instant but counted. */
function harness(answers: Answer[], opts: { random?: number } = {}) {
  let now = 1_000_000;
  const posts: Array<{ url: string; body: string }> = [];
  const waits: number[] = [];
  const queue = [...answers];
  const deps: SendTurnDeps = {
    fetch: async (url, init) => {
      if (init.signal?.aborted) throw init.signal.reason;
      posts.push({ url, body: String(init.body) });
      const next = queue.shift();
      if (!next) throw new Error("the test ran out of answers: a POST nobody expected");
      return respond(next);
    },
    sleep: async (ms, signal) => {
      if (signal.aborted) throw signal.reason;
      waits.push(ms);
      now += ms;
    },
    now: () => now,
    random: () => opts.random ?? 0.5,
  };
  return { deps, posts, waits, remaining: () => queue.length };
}

const BODY = JSON.stringify({ message: "Hello", generationId: "gen-12345678" });

async function send(
  safety: SendSafety,
  h: ReturnType<typeof harness>,
  extra: Partial<Parameters<typeof sendTurn>[0]> = {}
) {
  return sendTurn({ url: "/api/chat", body: BODY, signal: new AbortController().signal, safety, deps: h.deps, ...extra });
}

test("a drain is waited out (Retry-After plus jitter) and the same body goes out again", async () => {
  const h = harness([drain(), { kind: "stream" }]);
  const waiting: number[] = [];
  const retrying: number[] = [];
  const result = await send("drain-only", h, {
    onWaiting: ({ round }) => waiting.push(round),
    onRetrying: (round) => retrying.push(round),
  });
  assert.equal(result.kind, "stream");
  assert.equal(h.posts.length, 2);
  assert.equal(h.posts[0].body, h.posts[1].body, "byte-identical: a durable receipt's hash depends on it");
  assert.equal(h.waits.length, 1);
  const base = DRAIN_RETRY_AFTER_SECONDS * 1_000;
  assert.ok(h.waits[0] >= base && h.waits[0] <= base * (1 + SEND_RETRY.jitterRatio), `waited ${h.waits[0]} ms`);
  assert.deepEqual(waiting, [1]);
  assert.deepEqual(retrying, [2], "the calm 'Reconnecting…' line is told when the next POST goes");
});

test("every kind of turn waits out a drain: it is refused before anything is read", () => {
  const draining = classifyResponse({ status: 503, data: DRAINING_RESPONSE, retryAfter: "5", now: 0 });
  assert.equal(draining.kind, "draining");
  for (const safety of ["idempotent", "verify", "drain-only"] as const) {
    assert.equal(retryPlan(draining, safety), "retry", safety);
  }
});

test("the drain body and header the server sends are the ones the client reads", () => {
  // Pinned to src/lib/shutdown.ts so the two halves cannot drift apart.
  assert.equal(DRAINING_RESPONSE.code, "SERVER_DRAINING");
  assert.equal(DRAINING_RESPONSE.retryable, true);
  const route = readFileSync(new URL("../src/app/api/chat/route.ts", import.meta.url), "utf8");
  assert.ok(route.includes('"Retry-After": String(DRAIN_RETRY_AFTER_SECONDS)'));
  const drainAt = route.indexOf("if (isDraining())");
  const authAt = route.indexOf("await getCurrentUser()");
  assert.ok(drainAt > -1 && drainAt < authAt, "the drain answers before authentication, so nothing was accepted");
});

test("a gateway 502 or a dropped connection is sent again only when a repeat is harmless", async () => {
  for (const failure of [{ kind: "html", status: 502 } as const, { kind: "html", status: 504 } as const, { kind: "reject" } as const]) {
    const idempotent = harness([failure, { kind: "stream" }]);
    assert.equal((await send("idempotent", idempotent)).kind, "stream", `${failure.kind}: durable keys make the repeat safe`);
    assert.equal(idempotent.posts.length, 2);

    const unknown = harness([failure]);
    const refused = await send("drain-only", unknown);
    assert.equal(refused.kind, "failed", `${failure.kind}: a private chat, a regenerate or media is not sent twice`);
    assert.equal(unknown.posts.length, 1);
    assert.equal(unknown.waits.length, 0);
    if (refused.kind === "failed") {
      assert.equal(refused.message, failure.kind === "reject" ? sendUnreachableMessage : sendGatewayMessage);
      assert.doesNotMatch(refused.message, /Failed to fetch|Bad Gateway|<html/i, "never a browser's or a proxy's words");
    }
  }
});

test("a saved follow-up asks the server before sending again, and never sends what already landed", async () => {
  // Landed and running under this turn's id: read it, do not post it again.
  const running = harness([{ kind: "html", status: 502 }]);
  let checks = 0;
  const landed = await send("verify", running, {
    verify: async (): Promise<SendVerification> => {
      checks++;
      return { state: "landed", running: true, userMessageId: null };
    },
  });
  assert.deepEqual(landed, { kind: "landed", running: true, userMessageId: null });
  assert.equal(running.posts.length, 1, "no second POST");
  assert.equal(checks, 1);

  // Absent: the server never saw it, so it goes out again.
  const absent = harness([{ kind: "reject" }, { kind: "stream" }]);
  const resent = await send("verify", absent, { verify: async () => ({ state: "absent" }) });
  assert.equal(resent.kind, "stream");
  assert.equal(absent.posts.length, 2);

  // Unknown (the server is still down): wait and ask again, posting nothing meanwhile.
  const down = harness([{ kind: "html", status: 502 }, { kind: "stream" }]);
  const verdicts: SendVerification[] = [{ state: "unknown" }, { state: "unknown" }, { state: "absent" }];
  const later = await send("verify", down, { verify: async () => verdicts.shift()! });
  assert.equal(later.kind, "stream");
  assert.equal(down.posts.length, 2, "one POST, three checks, then the second POST");
  assert.equal(down.waits.length, 3);
});

test("a check that throws proves nothing, and a follow-up without a check is never sent twice", async () => {
  const h = harness([{ kind: "html", status: 502 }]);
  const result = await send("verify", h, {
    verify: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(result.kind, "failed");
  assert.equal(h.posts.length, 1, "only ever the first POST");
  assert.equal(h.waits.length, SEND_RETRY.maxRounds - 1);
});

test("a 401 opens the session-ended path at once and is never retried", async () => {
  const h = harness([{ kind: "json", status: 401, body: { error: "Unauthorized" } }]);
  const result = await send("idempotent", h);
  assert.deepEqual(result, { kind: "session-expired" });
  assert.equal(h.posts.length, 1);
  assert.equal(h.waits.length, 0);
});

test("an answer the app wrote stands: its own 503s, 4xx and 500s are not retried", async () => {
  const cases: Answer[] = [
    { kind: "json", status: 503, body: { error: "No model is available for Auto right now.", code: "AUTO_NO_ELIGIBLE_MODEL" } },
    { kind: "json", status: 502, body: { error: "upstream said no" } },
    { kind: "json", status: 402, body: { error: "budget_exceeded", message: "You have used this month's budget." } },
    { kind: "json", status: 500, body: { error: "Couldn't start the chat." } },
    { kind: "json", status: 409, body: { error: "idempotency_key_reused", code: "IDEMPOTENCY_KEY_REUSED", message: "This idempotency key is already bound to a different first submission." } },
  ];
  for (const answer of cases) {
    const h = harness([answer]);
    const result = await send("idempotent", h);
    assert.equal(result.kind, "failed");
    assert.equal(h.posts.length, 1, `status ${(answer as { status: number }).status}`);
    if (result.kind === "failed" && answer.kind === "json") {
      const body = answer.body as { message?: string; error?: string };
      assert.equal(result.message, body.message ?? body.error);
    }
  }
});

test("a repeat that the server already accepted is handed back, not run twice", async () => {
  const h = harness([
    { kind: "reject" },
    {
      kind: "json",
      status: 409,
      body: {
        error: "request_already_submitted",
        code: "REQUEST_ALREADY_SUBMITTED",
        conversationId: "conv_1",
        userMessageId: "msg_1",
        generationId: "gen-12345678",
        receiptState: "running",
        retryable: false,
      },
    },
  ]);
  const result = await send("idempotent", h);
  assert.deepEqual(result, {
    kind: "already-submitted",
    conversationId: "conv_1",
    userMessageId: "msg_1",
    generationId: "gen-12345678",
    receiptState: "running",
  });
  assert.equal(h.posts.length, 2);
});

test("a first submission still being accepted elsewhere is asked again, keys unchanged", async () => {
  const inProgress: Answer = {
    kind: "json",
    status: 409,
    body: { error: "request_in_progress", code: "REQUEST_IN_PROGRESS", generationId: "g", receiptState: "claimed", retryable: true },
  };
  const h = harness([{ kind: "reject" }, inProgress, { kind: "stream" }]);
  assert.equal((await send("idempotent", h)).kind, "stream");
  assert.equal(new Set(h.posts.map((p) => p.body)).size, 1);
  const other = harness([inProgress]);
  assert.equal((await send("verify", other)).kind, "failed", "only a keyed submission has a receipt to wait on");
});

test("the number of tries and the time they take are bounded", async () => {
  const h = harness(Array.from({ length: 20 }, () => drain()));
  const result = await send("drain-only", h);
  assert.equal(result.kind, "failed");
  assert.equal(h.posts.length, SEND_RETRY.maxRounds, "a small, fixed number of POSTs");
  assert.equal(h.waits.length, SEND_RETRY.maxRounds - 1);
  if (result.kind === "failed") {
    assert.equal(result.message, DRAINING_RESPONSE.error, "the server's own sentence when it never came back");
    assert.equal(result.code, "SERVER_DRAINING");
  }
  const total = h.waits.reduce((a, b) => a + b, 0);
  assert.ok(total <= SEND_RETRY.budgetMs, `waited ${total} ms in all`);

  // A long Retry-After is clamped, and the budget still holds.
  const slow = harness(Array.from({ length: 20 }, () => drain("120")));
  await send("drain-only", slow);
  assert.ok(slow.waits.every((ms) => ms <= SEND_RETRY.maxRetryAfterSeconds * 1_000 * (1 + SEND_RETRY.jitterRatio)));
  assert.ok(slow.waits.reduce((a, b) => a + b, 0) <= SEND_RETRY.budgetMs);
});

test("Stop ends the wait at once and nothing more is sent", async () => {
  const controller = new AbortController();
  let posts = 0;
  const deps: SendTurnDeps = {
    fetch: async (_url, init) => {
      if (init.signal?.aborted) throw init.signal.reason;
      posts++;
      return respond(drain());
    },
    // The real timer, so the abort has to cut a pending wait short.
    sleep: abortableSleep,
    now: () => Date.now(),
    random: () => 0,
  };
  const started = Date.now();
  const pending = sendTurn({
    url: "/api/chat",
    body: BODY,
    signal: controller.signal,
    safety: "drain-only",
    onWaiting: () => setTimeout(() => controller.abort(), 20),
    deps,
  });
  await assert.rejects(pending, (error: unknown) => (error as { name?: string }).name === "AbortError");
  assert.ok(Date.now() - started < 1_000, "did not sit out the 5 s Retry-After");
  assert.equal(posts, 1);
});

test("Stop during a follow-up's check ends the turn at once, even if the check never answers", async () => {
  // A check that ignores its signal and never settles: sendTurn still lets go.
  const controller = new AbortController();
  const h = harness([{ kind: "html", status: 502 }]);
  let checkSignal: AbortSignal | null = null;
  const pending = sendTurn({
    url: "/api/chat",
    body: BODY,
    signal: controller.signal,
    safety: "verify",
    verify: (signal) => {
      checkSignal = signal;
      setTimeout(() => controller.abort(), 10);
      return new Promise<SendVerification>(() => {});
    },
    deps: h.deps,
  });
  const started = Date.now();
  await assert.rejects(pending, (error: unknown) => (error as { name?: string }).name === "AbortError");
  assert.ok(Date.now() - started < 1_000);
  assert.equal(h.posts.length, 1, "nothing posted after the Stop");
  assert.equal(checkSignal, controller.signal, "the check is handed the turn's signal");
});

/** A fake GET: answers by URL, or hangs until its signal aborts (a server that takes the connection and never answers). */
function getter(answers: Record<string, Response | "hang">) {
  const seen: Array<{ url: string; signal: AbortSignal | null }> = [];
  const fetch = (url: string, init: RequestInit) => {
    const signal = init.signal ?? null;
    seen.push({ url, signal });
    const key = Object.keys(answers).find((prefix) => url.startsWith(prefix));
    const answer = key ? answers[key] : undefined;
    if (answer === undefined) return Promise.reject(new Error(`unexpected GET ${url}`));
    if (answer !== "hang") return Promise.resolve(answer.clone());
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  return { fetch, seen };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const checkArgs = {
  conversationId: "c1",
  generationId: "gen-12345678",
  content: "Hello",
  knownUserIds: new Set(["u-old"]),
};

test("a follow-up's check reads the server's answer: running, saved, or absent", async () => {
  const running = getter({ "/api/chat/stream/active": json(200, { generationId: "gen-12345678" }) });
  assert.deepEqual(
    await verifyTurnLanded({ ...checkArgs, signal: new AbortController().signal, fetch: running.fetch }),
    { state: "landed", running: true, userMessageId: null }
  );
  const saved = getter({
    "/api/chat/stream/active": json(404, { error: "none" }),
    "/api/conversations/c1": json(200, { messages: [{ id: "u-old", role: "USER", content: "Earlier" }, { id: "u-new", role: "USER", content: "Hello " }] }),
  });
  assert.deepEqual(
    await verifyTurnLanded({ ...checkArgs, signal: new AbortController().signal, fetch: saved.fetch }),
    { state: "landed", running: false, userMessageId: "u-new" }
  );
  const absent = getter({
    "/api/chat/stream/active": json(404, { error: "none" }),
    "/api/conversations/c1": json(200, { messages: [{ id: "u-old", role: "USER", content: "Hello" }] }),
  });
  assert.deepEqual(
    await verifyTurnLanded({ ...checkArgs, signal: new AbortController().signal, fetch: absent.fetch }),
    { state: "absent" },
    "a question this tab already had is not this send"
  );
  for (const { signal } of [...running.seen, ...saved.seen, ...absent.seen]) assert.ok(signal, "every read carries a signal");
});

test("a follow-up's check obeys Stop and gives up on a server that never answers", async () => {
  // Stop: both reads are cut at once and the check proves nothing.
  const controller = new AbortController();
  const stuck = getter({ "/api/chat/stream/active": "hang" });
  const started = Date.now();
  const stopped = verifyTurnLanded({ ...checkArgs, signal: controller.signal, fetch: stuck.fetch, timeoutMs: 60_000 });
  setTimeout(() => controller.abort(), 10);
  assert.deepEqual(await stopped, { state: "unknown" });
  assert.ok(Date.now() - started < 1_000, "ended by the Stop, not the timeout");
  assert.equal(stuck.seen[0].signal?.aborted, true, "the GET itself was aborted");

  // No Stop, no answer: the timeout ends it, and it counts as unanswered.
  const silent = getter({ "/api/chat/stream/active": json(404, {}), "/api/conversations/c1": "hang" });
  const timedOut = await verifyTurnLanded({ ...checkArgs, signal: new AbortController().signal, fetch: silent.fetch, timeoutMs: 30 });
  assert.deepEqual(timedOut, { state: "unknown" });
  assert.equal(silent.seen.length, 2);
  assert.equal(silent.seen[1].signal?.aborted, true);
  assert.equal(SEND_RETRY.verifyTimeoutMs, 8_000);
});

test("a bounded signal follows its parent, times out on its own, and lets go of both", async () => {
  const parent = new AbortController();
  const followed = signalWithTimeout(parent.signal, 60_000);
  parent.abort(new DOMException("Stopped", "AbortError"));
  assert.equal(followed.signal.aborted, true);
  assert.equal((followed.signal.reason as DOMException).name, "AbortError");
  followed.dispose();

  const timed = signalWithTimeout(new AbortController().signal, 5);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(timed.signal.aborted, true);
  assert.equal((timed.signal.reason as DOMException).name, "TimeoutError");
  timed.dispose();

  const disposed = signalWithTimeout(new AbortController().signal, 5);
  disposed.dispose();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(disposed.signal.aborted, false, "a disposed timer never fires");
});

test("an abort during the POST itself is thrown, not retried", async () => {
  const controller = new AbortController();
  const deps: SendTurnDeps = {
    fetch: async () => {
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    },
    sleep: abortableSleep,
    now: () => 0,
    random: () => 0,
  };
  await assert.rejects(
    sendTurn({ url: "/api/chat", body: BODY, signal: controller.signal, safety: "idempotent", deps }),
    (error: unknown) => (error as { name?: string }).name === "AbortError"
  );
});

test("a stream that started is returned on the first POST: the loop never posts after a byte arrived", async () => {
  const h = harness([{ kind: "stream" }]);
  const result = await send("idempotent", h);
  assert.equal(result.kind, "stream");
  assert.equal(h.posts.length, 1);
  assert.equal(h.remaining(), 0);
});

test("Retry-After is read as seconds or a date, and held to a sane range", () => {
  assert.equal(parseRetryAfter("5", 0), 5_000);
  assert.equal(parseRetryAfter(" 12 ", 0), 12_000);
  assert.equal(parseRetryAfter(new Date(60_000).toUTCString(), 0), 60_000);
  assert.equal(parseRetryAfter("soon", 0), null);
  assert.equal(parseRetryAfter(null, 0), null);

  const draining = (ms: number | null) => ({ kind: "draining", retryAfterMs: ms, message: "" }) as const;
  assert.equal(retryDelayMs(draining(5_000), 1, () => 0), 5_000);
  assert.equal(retryDelayMs(draining(5_000), 1, () => 1), 5_000 * (1 + SEND_RETRY.jitterRatio));
  assert.equal(retryDelayMs(draining(0), 1, () => 0), SEND_RETRY.minRetryAfterSeconds * 1_000);
  assert.equal(retryDelayMs(draining(600_000), 1, () => 0), SEND_RETRY.maxRetryAfterSeconds * 1_000);
  // No Retry-After: the backoff ladder, capped at its last rung.
  const gateway = { kind: "gateway", status: 502 } as const;
  assert.deepEqual(
    [1, 2, 3, 4, 5, 9].map((n) => retryDelayMs(gateway, n, () => 0)),
    [2_000, 4_000, 8_000, 10_000, 10_000, 10_000]
  );
});

test("a gateway is told apart from the app by its body: every app error on this route is JSON", () => {
  assert.equal(classifyResponse({ status: 502, data: null, retryAfter: null, now: 0 }).kind, "gateway");
  assert.equal(classifyResponse({ status: 503, data: null, retryAfter: null, now: 0 }).kind, "gateway");
  assert.equal(classifyResponse({ status: 504, data: null, retryAfter: null, now: 0 }).kind, "gateway");
  assert.equal(classifyResponse({ status: 502, data: { error: "x" }, retryAfter: null, now: 0 }).kind, "refused");
  assert.equal(classifyResponse({ status: 500, data: null, retryAfter: null, now: 0 }).kind, "refused");
  const refused = classifyResponse({ status: 400, data: {}, retryAfter: null, now: 0 });
  assert.equal(refused.kind === "refused" && refused.message, sendFailedMessage);
});

test("the web's first-submission keys pass the server's schema, and only on a new saved chat", () => {
  const keys = { clientRequestId: `web-req-${crypto.randomUUID()}`, clientMessageId: `web-msg-${crypto.randomUUID()}` };
  assert.ok(chatBodySchema.safeParse({ message: "Hello", generationId: "gen-12345678", ...keys }).success);
  // The server refuses the keys on anything but a new saved conversation, so
  // the client must never attach them there.
  for (const extra of [{ conversationId: "cjld2cjxh0000qzrmn831i7rn" }, { privateMode: true, privateHistory: [{ role: "USER", content: "Hello" }] }]) {
    assert.equal(chatBodySchema.safeParse({ message: "Hello", ...keys, ...extra }).success, false);
  }

  const hook = readFileSync(new URL("../src/hooks/use-chat.ts", import.meta.url), "utf8");
  assert.ok(hook.includes('const chatSend = path === "/api/chat" && !opts.privateMode && !body.regenerate;'), "keys: chat sends only");
  assert.ok(hook.includes("const firstSubmission = chatSend && !body.conversationId;"), "keys: a new saved chat only");
  assert.ok(/\.\.\.\(firstSubmission\s*\?\s*\{\s*clientRequestId:/.test(hook), "keys ride on the first submission");
});

test("the hook routes every send through sendTurn and never shows a raw 401 as the answer", () => {
  const hook = readFileSync(new URL("../src/hooks/use-chat.ts", import.meta.url), "utf8");
  const run = hook.slice(hook.indexOf("const runGeneration = React.useCallback"), hook.indexOf("const startGeneration = React.useCallback"));
  // Compact assertions: a failure here should not print a 2,000-line file.
  const has = (source: string, pattern: RegExp) => pattern.test(source);
  assert.ok(has(run, /await sendTurn\(\{/), "runGeneration posts through sendTurn");
  assert.ok(!has(run, /await fetch\(path/), "no second, unguarded POST");
  assert.ok(has(run, /sent\.kind === "session-expired"/), "a 401 has its own branch");
  assert.ok(has(run, /reportSessionExpired\(/), "which opens the dialog");
  assert.ok(!hook.includes("Unauthorized"), "the route's 401 word never appears in the hook");
  // The stream reader still gets the very response that started, once.
  assert.ok(has(run, /readChatStream\(res\.body, applier\.apply\)/), "the started stream is read by the one applier");
  // The question is handed in by the caller. Read from the message list it
  // would be missing: the caller's setMessages has not committed yet when the
  // send starts (found in the browser: the 401 path then kept nothing).
  assert.ok(run.includes("const sentQuestion = body.regenerate ? null : question;"), "the question is a parameter");
  assert.ok(!/messagesRef\.current\.find\(\(m\) => m\.pending/.test(run), "never read from the uncommitted list");
  assert.ok(/assistantTempId,\s*"\/api\/chat",\s*userMsg\.content/.test(hook), "a message send passes its question");
  assert.equal((hook.match(/"\/api\/generate",\s*userMsg\.content/g) ?? []).length, 2, "both media sends pass theirs");
  // Stop ends a wait at once.
  const stop = hook.slice(hook.indexOf("const stop = React.useCallback"));
  assert.ok(has(stop, /if \(sendWaitingRef\.current === controller\) controller\.abort\(\);/), "Stop aborts a pending wait");
  // The follow-up check gets the turn's signal, so a Stop cuts its reads too.
  assert.ok(has(run, /\(signal\) =>\s*verifyTurnLanded\(\{[\s\S]*?signal,\s*\}\)/), "the check obeys Stop");
  assert.ok(!/async function verifyTurnLanded/.test(hook), "one check, the tested one in send-retry.ts");
});

test("the durable path generates under the caller's id, so a Stop pressed in admission finds it", () => {
  const accept = readFileSync(new URL("../src/lib/chat/turn/accept.ts", import.meta.url), "utf8");
  assert.ok(accept.includes("const proposedGenerationId = input.generationId ?? crypto.randomUUID();"));
});
