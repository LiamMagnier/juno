import test from "node:test";
import assert from "node:assert/strict";
import { CompareController } from "@/lib/compare/controller";
import { DROPPED_MESSAGE, OFFLINE_MESSAGE } from "@/lib/compare/pane-run";
import { createRunSpec, sharedInputFingerprint, type CompareRunSpec } from "@/lib/compare/run-spec";
import type { ModelInfo } from "@/lib/models";
import type { ClientQuota, StreamChunk } from "@/types/chat";

/*
 * P2-2: the comparison runtime driven end to end with real SSE bodies through
 * an injected fetch. Pins: parallel identical-input runs, per-pane status
 * transitions, abort per pane (the others keep streaming), server-first Stop
 * with its local fallback, late frames from a superseded run, HTTP and
 * network error mapping, the dropped-connection case, and cancel-on-leave.
 */

const QUOTA: ClientQuota = { plan: "PRO", used: 3, limit: null, remaining: null };
const MODEL_A = "anthropic:claude-sonnet-5";
const MODEL_B = "openai:gpt-6-luna";

const MODELS: Record<string, ModelInfo> = {
  [MODEL_A]: { id: MODEL_A, provider: "anthropic", providerModel: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: true } as unknown as ModelInfo,
  [MODEL_B]: { id: MODEL_B, provider: "openai", providerModel: "gpt-6-luna", name: "GPT-6 Luna", reasoning: true } as unknown as ModelInfo,
};

interface ChatCall {
  body: Record<string, unknown>;
  signal: AbortSignal;
  send: (chunk: StreamChunk) => void;
  close: () => void;
}

interface CancelCall {
  generationId: string;
  keepalive: boolean;
}

type CancelReply = { cancelled: boolean } | "hang" | "reject";

function harness(opts: { chat?: (body: Record<string, unknown>) => Response | Promise<Response> | null } = {}) {
  const encoder = new TextEncoder();
  const chats: ChatCall[] = [];
  const cancels: CancelCall[] = [];
  const quotas: ClientQuota[] = [];
  const cancelReplies = new Map<string, CancelReply>();
  let clock = 0;
  let ids = 0;
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];

  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url === "/api/chat/cancel") {
      const generationId = String(body.generationId);
      cancels.push({ generationId, keepalive: init.keepalive === true });
      const reply = cancelReplies.get(generationId) ?? { cancelled: true };
      if (reply === "hang") return new Promise<Response>(() => {});
      if (reply === "reject") throw new TypeError("Failed to fetch");
      return Response.json({ ok: true, ...reply });
    }
    assert.equal(url, "/api/chat");
    const custom = opts.chat?.(body);
    if (custom) return custom;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const signal = init.signal as AbortSignal;
    signal.addEventListener("abort", () => {
      try {
        controller.error(new DOMException("The operation was aborted.", "AbortError"));
      } catch {
        /* already closed */
      }
    });
    chats.push({
      body,
      signal,
      send: (chunk) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)),
      close: () => controller.close(),
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };

  const compare = new CompareController({
    fetch: fetchImpl,
    now: () => clock,
    newId: () => `gen-${++ids}-0000`,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    resolveModel: (id) => MODELS[id],
    onQuota: (quota) => quotas.push(quota),
    stopFallbackMs: 5000,
  });

  return {
    compare,
    chats,
    cancels,
    quotas,
    timers,
    cancelReplies,
    setClock: (ms: number) => {
      clock = ms;
    },
    chatFor: (model: string) => {
      const call = chats.find((c) => c.body.model === model && !c.signal.aborted);
      assert.ok(call, `an open request for ${model}`);
      return call;
    },
    runs: () => compare.getSnapshot().runs,
  };
}

/** Let streams, promise chains and the reader loop run. */
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

function spec(overrides: Partial<Parameters<typeof createRunSpec>[0]["settings"]> = {}): CompareRunSpec {
  return createRunSpec({
    id: "spec-1",
    prompt: "Explain entanglement to a 12-year-old.",
    settings: { webSearch: false, reasoningEffort: null, ...overrides },
    timeZone: "Europe/Paris",
    now: new Date("2026-10-25T12:00:00.000Z"),
  });
}

const done = (content: string, extra: Record<string, unknown> = {}): StreamChunk =>
  ({
    type: "done",
    message: { id: "private-1", role: "ASSISTANT", content, createdAt: "2026-10-25T12:00:01.000Z", attachments: [], ...extra },
    artifacts: [],
    memoryUpdated: false,
    quota: QUOTA,
  }) as StreamChunk;

test("start sends every pane the same request in the same tick; only the model and generation id differ", async () => {
  const h = harness();
  const runSpec = spec({ webSearch: true, reasoningEffort: "high" });
  void h.compare.start(runSpec, [
    { id: "a", modelId: MODEL_A },
    { id: "b", modelId: MODEL_B },
  ]);
  // Both panes are submitting before any network round trip.
  assert.equal(h.runs().a.status, "submitting");
  assert.equal(h.runs().b.status, "submitting");
  assert.equal(h.compare.getSnapshot().anyStreaming, true);
  await settle();
  assert.equal(h.chats.length, 2);
  const [first, second] = h.chats.map((c) => c.body);
  assert.notEqual(first.generationId, second.generationId);
  assert.deepEqual(new Set([first.model, second.model]), new Set([MODEL_A, MODEL_B]));
  const shared = (body: Record<string, unknown>) => {
    const rest = { ...body };
    delete rest.model;
    delete rest.generationId;
    return rest;
  };
  assert.deepEqual(shared(first), shared(second));
  assert.deepEqual(shared(first), {
    message: runSpec.prompt,
    privateMode: true,
    privateHistory: [{ role: "USER", content: runSpec.prompt }],
    webSearch: true,
    reasoningEffort: "high",
    timeZone: "Europe/Paris",
  });
  // Each pane records the fingerprint of what it really sent: the spec's.
  assert.equal(h.runs().a.inputFingerprint, runSpec.fingerprint);
  assert.equal(h.runs().b.inputFingerprint, runSpec.fingerprint);
  assert.equal(sharedInputFingerprint(first), runSpec.fingerprint);
  assert.equal(h.runs().a.startOffsetMs, 0);
  assert.equal(h.runs().b.startOffsetMs, 0);
});

test("one pane streams from submitting through thinking and writing to done, with measured latency and a reported cost", async () => {
  const h = harness();
  h.setClock(1_000);
  void h.compare.runPane("a", MODEL_A, spec());
  await settle();
  const call = h.chatFor(MODEL_A);
  h.setClock(1_050);
  call.send({ type: "meta", conversationId: "private", userMessageId: null, title: "Private chat", generationId: String(call.body.generationId) });
  call.send({ type: "activity", event: { id: "1", kind: "context", title: "Reading private context", createdAt: "x" } });
  await settle();
  assert.equal(h.runs().a.status, "thinking");
  h.setClock(1_600);
  call.send({ type: "reasoning", text: "Thinking it through." });
  await settle();
  assert.equal(h.runs().a.status, "thinking");
  h.setClock(2_200);
  call.send({ type: "delta", text: "Two particles " });
  await settle();
  assert.equal(h.runs().a.status, "writing");
  h.setClock(3_000);
  call.send(
    done("Two particles share one state.", {
      model: MODEL_A,
      promptTokens: 800,
      completionTokens: 120,
      costUsd: 0.0042,
      applied: { reasoningEffort: "medium", webSearch: false, usageBasis: "reported" },
    })
  );
  call.close();
  await settle();
  const run = h.runs().a;
  assert.equal(run.status, "done");
  assert.equal(run.content, "Two particles share one state.");
  assert.equal(run.firstOutputAt! - run.startedAt!, 600);
  assert.equal(run.firstAnswerAt! - run.startedAt!, 1_200);
  assert.equal(run.elapsedMs, 2_000);
  assert.equal(run.costUsd, 0.0042);
  assert.equal(run.usageBasis, "reported");
  assert.equal(run.appliedEffort, "medium");
  assert.deepEqual(h.quotas, [QUOTA]);
  assert.equal(h.compare.getSnapshot().anyStreaming, false);
  assert.deepEqual(h.compare.inFlight(), {}, "the handle is released");
});

test("removing one pane stops only that pane, server-side first; the other keeps streaming and finishes", async () => {
  const h = harness();
  void h.compare.start(spec(), [
    { id: "a", modelId: MODEL_A },
    { id: "b", modelId: MODEL_B },
  ]);
  await settle();
  const a = h.chatFor(MODEL_A);
  const b = h.chatFor(MODEL_B);
  b.send({ type: "delta", text: "B was here" });
  await settle();

  h.compare.discardPane("b");
  await settle();
  assert.deepEqual(h.cancels.map((c) => c.generationId), [String(b.body.generationId)], "only b is cancelled");
  assert.equal(b.signal.aborted, true);
  assert.equal(a.signal.aborted, false);
  assert.equal("b" in h.runs(), false, "the pane's run is gone");

  a.send({ type: "delta", text: "A answers" });
  a.send(done("A answers", { model: MODEL_A }));
  a.close();
  await settle();
  assert.equal(h.runs().a.status, "done");
  assert.equal("b" in h.runs(), false, "b's late abort never resurrects it");
});

test("Stop asks the server first: a confirmed pane closes with its partial answer, an unconfirmed one is aborted locally", async () => {
  const h = harness();
  void h.compare.start(spec(), [
    { id: "a", modelId: MODEL_A },
    { id: "b", modelId: MODEL_B },
  ]);
  await settle();
  const a = h.chatFor(MODEL_A);
  const b = h.chatFor(MODEL_B);
  h.cancelReplies.set(String(b.body.generationId), { cancelled: false });
  a.send({ type: "delta", text: "Half of A" });
  await settle();

  h.compare.stopAll();
  assert.equal(h.compare.getSnapshot().stopping, true);
  await settle();
  assert.equal(h.cancels.length, 2);
  assert.equal(a.signal.aborted, false, "a confirmed cancel leaves the stream to close itself");
  assert.equal(b.signal.aborted, true, "an unconfirmed cancel aborts locally");
  assert.equal(h.runs().b.status, "error");
  assert.equal(h.runs().b.errorMessage, "Stopped before the model answered.");
  assert.equal(h.runs().b.finishReason, "user_stopped");

  // The server ends a's generation with what it had.
  a.send({ ...done("Half of A", { model: MODEL_A }), finishReason: "user_stopped" } as StreamChunk);
  a.close();
  await settle();
  assert.equal(h.runs().a.status, "done");
  assert.equal(h.runs().a.finishReason, "user_stopped");
  assert.equal(h.compare.getSnapshot().stopping, false, "stopping clears once every pane has closed");
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].cleared, true, "the fallback timer is cancelled");
});

test("Stop's fallback aborts whatever the server has not closed when the timer fires", async () => {
  const h = harness();
  void h.compare.runPane("a", MODEL_A, spec());
  await settle();
  const a = h.chatFor(MODEL_A);
  h.cancelReplies.set(String(a.body.generationId), "hang");
  a.send({ type: "delta", text: "Some text" });
  await settle();
  h.compare.stopAll();
  await settle();
  assert.equal(a.signal.aborted, false);
  assert.equal(h.timers[0].ms, 5000);
  h.timers[0].fn();
  await settle();
  assert.equal(a.signal.aborted, true);
  assert.equal(h.runs().a.status, "done", "the partial answer is kept");
  assert.equal(h.runs().a.finishReason, "user_stopped");
  assert.equal(h.compare.getSnapshot().stopping, false);
});

test("a cancel request that fails outright still stops the pane locally", async () => {
  const h = harness();
  void h.compare.runPane("a", MODEL_A, spec());
  await settle();
  const a = h.chatFor(MODEL_A);
  h.cancelReplies.set(String(a.body.generationId), "reject");
  h.compare.stopAll();
  await settle();
  assert.equal(a.signal.aborted, true);
  assert.equal(h.runs().a.status, "error");
});

test("rerunning a pane cancels the old generation, and the old run's late frames never clobber the new one", async () => {
  const h = harness();
  void h.compare.runPane("a", MODEL_A, spec());
  await settle();
  const old = h.chatFor(MODEL_A);
  old.send({ type: "delta", text: "old answer" });
  await settle();

  void h.compare.runPane("a", MODEL_B, spec());
  await settle();
  assert.equal(old.signal.aborted, true);
  assert.deepEqual(h.cancels.map((c) => c.generationId), [String(old.body.generationId)]);
  const run = h.runs().a;
  assert.equal(run.status, "submitting", "the old run's abort did not overwrite the new run");
  assert.equal(run.requestedModelId, MODEL_B);
  assert.equal(run.content, "");

  const fresh = h.chatFor(MODEL_B);
  fresh.send(done("new answer", { model: MODEL_B }));
  fresh.close();
  await settle();
  assert.equal(h.runs().a.content, "new answer");
});

test("a pane that joins later runs the same spec and records how late it started", async () => {
  const h = harness();
  const runSpec = spec();
  h.setClock(10_000);
  void h.compare.runPane("a", MODEL_A, runSpec);
  h.setClock(14_500);
  void h.compare.runPane("c", MODEL_B, runSpec);
  await settle();
  assert.equal(h.runs().a.startOffsetMs, 0);
  assert.equal(h.runs().c.startOffsetMs, 4_500);
  assert.equal(h.runs().c.inputFingerprint, runSpec.fingerprint);
});

test("HTTP refusals become pane errors with the right action", async () => {
  const replies: Record<string, Response> = {
    [MODEL_A]: Response.json({ error: "budget_exceeded", message: "You’ve used this month’s budget." }, { status: 402 }),
    [MODEL_B]: new Response("<html>Bad gateway</html>", { status: 502 }),
  };
  const h = harness({ chat: (body) => replies[String(body.model)] ?? null });
  await h.compare.start(spec(), [
    { id: "a", modelId: MODEL_A },
    { id: "b", modelId: MODEL_B },
  ]);
  assert.equal(h.runs().a.status, "error");
  assert.equal(h.runs().a.errorMessage, "You’ve used this month’s budget.");
  assert.equal(h.runs().a.errorAction, "upgrade");
  assert.equal(h.runs().b.status, "error");
  assert.equal(h.runs().b.errorMessage, "The server hit an error (502). Run it again.");
  assert.equal(h.runs().b.errorAction, "retry");
  assert.equal(h.compare.getSnapshot().anyStreaming, false);
});

test("an unreachable server reads as offline", async () => {
  const h = harness({
    chat: () => {
      throw new TypeError("Failed to fetch");
    },
  });
  await h.compare.runPane("a", MODEL_A, spec());
  assert.equal(h.runs().a.errorMessage, OFFLINE_MESSAGE);
});

test("a stream that ends without done or error is a dropped connection, and the partial answer stays", async () => {
  const h = harness();
  const finished = h.compare.runPane("a", MODEL_A, spec());
  await settle();
  const a = h.chatFor(MODEL_A);
  a.send({ type: "delta", text: "Partial" });
  a.close();
  await finished;
  assert.equal(h.runs().a.status, "error");
  assert.equal(h.runs().a.errorMessage, DROPPED_MESSAGE);
  assert.equal(h.runs().a.content, "Partial");
});

test("an error frame ends the pane and still reports the quota", async () => {
  const h = harness();
  const finished = h.compare.runPane("a", MODEL_A, spec());
  await settle();
  const a = h.chatFor(MODEL_A);
  a.send({ type: "error", message: "Anthropic is overloaded. Try again in a minute.", quota: QUOTA, finishReason: "error" });
  a.close();
  await finished;
  assert.equal(h.runs().a.status, "error");
  assert.equal(h.runs().a.errorMessage, "Anthropic is overloaded. Try again in a minute.");
  assert.deepEqual(h.quotas, [QUOTA]);
});

test("resetting a running pane cancels it server-side and returns it to idle", async () => {
  const h = harness();
  void h.compare.runPane("a", MODEL_A, spec());
  await settle();
  const a = h.chatFor(MODEL_A);
  h.compare.resetPane("a");
  await settle();
  assert.equal(a.signal.aborted, true);
  assert.deepEqual(h.cancels.map((c) => c.generationId), [String(a.body.generationId)]);
  assert.equal(h.runs().a.status, "idle");
});

test("leaving the page cancels every running generation with a keepalive request", async () => {
  const h = harness();
  void h.compare.start(spec(), [
    { id: "a", modelId: MODEL_A },
    { id: "b", modelId: MODEL_B },
  ]);
  await settle();
  h.compare.dispose();
  await settle();
  assert.equal(h.cancels.length, 2);
  assert.ok(h.cancels.every((c) => c.keepalive), "keepalive lets the cancel outlive the page");
  assert.ok(h.chats.every((c) => c.signal.aborted));
  // The controller stays usable (React's development double-mount).
  void h.compare.runPane("a", MODEL_A, spec());
  assert.equal(h.runs().a.status, "submitting");
});

test("subscribers hear every change, and the snapshot is stable between changes", async () => {
  const h = harness();
  let calls = 0;
  const unsubscribe = h.compare.subscribe(() => calls++);
  const before = h.compare.getSnapshot();
  assert.equal(h.compare.getSnapshot(), before, "same object until something changes");
  void h.compare.runPane("a", MODEL_A, spec());
  assert.ok(calls >= 1);
  assert.notEqual(h.compare.getSnapshot(), before);
  unsubscribe();
  const seen = calls;
  h.compare.resetPane("a");
  assert.equal(calls, seen, "an unsubscribed listener is not called");
});
