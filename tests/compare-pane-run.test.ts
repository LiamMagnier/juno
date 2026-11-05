import test from "node:test";
import assert from "node:assert/strict";
import {
  abortRun,
  applyChunk,
  DROPPED_MESSAGE,
  failRun,
  failureFromException,
  failureFromResponse,
  IDLE_RUN,
  isPaneStreaming,
  OFFLINE_MESSAGE,
  paneChatMessages,
  resolvePaneCost,
  startRun,
  timeToFirstAnswerMs,
  timeToFirstOutputMs,
  totalMs,
  type PaneRun,
} from "@/lib/compare/pane-run";
import type { ModelInfo } from "@/lib/models";
import type { ClientActivityEvent, ClientMessage, ClientQuota, StreamChunk } from "@/types/chat";

/*
 * P2-2: the side-by-side /compare pane, as the pure state machine the
 * controller feeds. Status transitions, measured latency, the cost basis and
 * the failure sentences are pinned here without React, fetch or a clock.
 */

const QUOTA: ClientQuota = { plan: "PRO", used: 1, limit: null, remaining: null };

const SONNET = {
  id: "anthropic:claude-sonnet-5",
  provider: "anthropic",
  providerModel: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  modality: "chat",
  reasoning: true,
  webSearch: true,
  cost: 2,
} as unknown as ModelInfo;

const resolve = (id: string) => (id === SONNET.id ? SONNET : undefined);

function activity(kind: ClientActivityEvent["kind"]): StreamChunk {
  return { type: "activity", event: { id: `a-${kind}`, kind, title: "any title", createdAt: "2026-10-25T00:00:00.000Z" } };
}

function doneChunk(message: Partial<ClientMessage>, finishReason?: ClientMessage["finishReason"]): StreamChunk {
  return {
    type: "done",
    message: {
      id: "private-1",
      role: "ASSISTANT",
      content: "",
      createdAt: "2026-10-25T00:00:00.000Z",
      attachments: [],
      ...message,
    },
    artifacts: [],
    memoryUpdated: false,
    quota: QUOTA,
    ...(finishReason ? { finishReason } : {}),
  } as StreamChunk;
}

function started(at = 1_000): PaneRun {
  return startRun({ at, specId: "spec-1", requestedModelId: SONNET.id, inputFingerprint: "fp", startOffsetMs: 0 });
}

test("a started pane is submitting, carries its spec, fingerprint and start time, and streams", () => {
  const run = started();
  assert.equal(run.status, "submitting");
  assert.equal(run.specId, "spec-1");
  assert.equal(run.inputFingerprint, "fp");
  assert.equal(run.requestedModelId, SONNET.id);
  assert.equal(run.startedAt, 1_000);
  assert.equal(isPaneStreaming(run), true);
  assert.equal(isPaneStreaming(IDLE_RUN), false);
  assert.equal(isPaneStreaming(undefined), false);
  assert.equal(startRun({ at: 5, specId: "s", requestedModelId: "m", inputFingerprint: "f", startOffsetMs: -3 }).startOffsetMs, 0, "never negative");
});

test("status follows the stream: context → thinking, reasoning → thinking, write → writing, and writing is never undone", () => {
  let run = started();
  run = applyChunk(run, activity("context"), 1_010);
  assert.equal(run.status, "thinking", "any server row means the request was accepted");
  run = applyChunk(run, activity("reasoning"), 1_020);
  assert.equal(run.status, "thinking");
  run = applyChunk(run, activity("write"), 1_030);
  assert.equal(run.status, "writing");
  run = applyChunk(run, activity("reasoning"), 1_040);
  assert.equal(run.status, "writing", "a late reasoning row does not send a writing pane back");
  run = applyChunk(run, { type: "reasoning", text: "hmm" }, 1_050);
  assert.equal(run.status, "writing");
  assert.equal(run.reasoning, "hmm");
});

test("latency is measured from the request to the first output, the first answer text and the terminal frame", () => {
  let run = started(1_000);
  run = applyChunk(run, { type: "meta", conversationId: "private", userMessageId: null, title: "Private chat" }, 1_100);
  assert.equal(run.firstOutputAt, null, "a meta frame is not output");
  run = applyChunk(run, { type: "reasoning", text: "Let me think." }, 1_400);
  run = applyChunk(run, { type: "reasoning", text: " More." }, 1_500);
  assert.equal(timeToFirstOutputMs(run), 400, "the first reasoning text is the first output, and it is kept");
  assert.equal(timeToFirstAnswerMs(run), null);
  run = applyChunk(run, { type: "delta", text: "Hello" }, 2_000);
  run = applyChunk(run, { type: "delta", text: " world" }, 2_100);
  assert.equal(run.content, "Hello world");
  assert.equal(timeToFirstAnswerMs(run), 1_000);
  assert.equal(timeToFirstOutputMs(run), 400);
  run = applyChunk(run, doneChunk({ content: "Hello world", model: SONNET.id }), 3_250);
  assert.equal(totalMs(run), 2_250);
  assert.equal(run.elapsedMs, 2_250);
});

test("an answer without visible reasoning starts its first-output clock at the first delta", () => {
  let run = started(0);
  run = applyChunk(run, { type: "delta", text: "Hi" }, 700);
  assert.equal(timeToFirstOutputMs(run), 700);
  assert.equal(timeToFirstAnswerMs(run), 700);
});

test("a search row of any title marks search as offered; a sources frame replaces the sources", () => {
  let run = applyChunk(started(), activity("search"), 1_010);
  assert.equal(run.webSearchApplied, true);
  const sources = [{ title: "MDN", url: "https://developer.mozilla.org/", snippet: "" }];
  run = applyChunk(run, { type: "sources", sources }, 1_020);
  assert.deepEqual(run.sources, sources);
});

test("done records the served model, the effort and search the server applied, and a reported cost", () => {
  const run = applyChunk(
    applyChunk(started(), { type: "delta", text: "partial" }, 1_100),
    doneChunk(
      {
        content: "Final answer.",
        model: SONNET.id,
        promptTokens: 1_200,
        completionTokens: 300,
        costUsd: 0.0081,
        applied: { reasoningEffort: "high", webSearch: false, usageBasis: "reported" },
        sources: [{ title: "A", url: "https://a.example/x", snippet: "" }],
      },
      "stop"
    ),
    2_000,
    resolve
  );
  assert.equal(run.status, "done");
  assert.equal(run.content, "Final answer.", "the done frame's content wins over the streamed text");
  assert.equal(run.servedModelId, SONNET.id);
  assert.equal(run.appliedEffort, "high");
  assert.equal(run.webSearchApplied, false);
  assert.equal(run.costUsd, 0.0081);
  assert.equal(run.usageBasis, "reported");
  assert.equal(run.promptTokens, 1_200);
  assert.equal(run.completionTokens, 300);
  assert.equal(run.finishReason, "stop");
  assert.equal(run.sources.length, 1);
  assert.equal(isPaneStreaming(run), false);
});

test("a done frame with no `applied` record never claims a reported cost or an effort it was not told", () => {
  const run = applyChunk(started(), doneChunk({ content: "x", model: SONNET.id, promptTokens: 10, completionTokens: 5, costUsd: 0.001 }), 2_000, resolve);
  assert.equal(run.usageBasis, "estimated", "an unstated basis is an estimate");
  assert.equal(run.appliedEffort, undefined, "unknown, not Instant");
  assert.equal(run.webSearchApplied, null);
});

test("Auto's routing receipt supplies the effort when the applied record is absent", () => {
  const run = applyChunk(
    started(),
    doneChunk({ content: "x", model: SONNET.id, routing: { v: 1, effort: "medium", taskClass: "general", reasons: [] } as never }),
    2_000,
    resolve
  );
  assert.equal(run.appliedEffort, "medium");
});

test("a done frame without a server cost is priced on the client and labelled an estimate", () => {
  const run = applyChunk(started(), doneChunk({ content: "x", model: SONNET.id, promptTokens: 1_000, completionTokens: 1_000 }), 2_000, resolve);
  assert.ok((run.costUsd ?? 0) > 0);
  assert.equal(run.usageBasis, "estimated");
});

test("a done frame with no usage at all has no cost and no basis", () => {
  const run = applyChunk(started(), doneChunk({ content: "x", model: SONNET.id }), 2_000, resolve);
  assert.equal(run.costUsd, null);
  assert.equal(run.usageBasis, null);
  assert.equal(run.finishReason, "stop", "a done frame without a reason finished normally");
});

test("resolvePaneCost: a reported server cost, an unknown basis, a client estimate, and nothing", () => {
  assert.deepEqual(resolvePaneCost({ costUsd: 0.5, applied: { reasoningEffort: null, webSearch: false, usageBasis: "reported" } }, SONNET), { usd: 0.5, basis: "reported" });
  assert.deepEqual(resolvePaneCost({ costUsd: 0.5, applied: { reasoningEffort: null, webSearch: false, usageBasis: "estimated" } }, SONNET), { usd: 0.5, basis: "estimated" });
  assert.deepEqual(resolvePaneCost({ costUsd: 0.5 }, SONNET), { usd: 0.5, basis: "estimated" });
  assert.equal(resolvePaneCost({ costUsd: 0, promptTokens: 0, completionTokens: 0 }, SONNET), null);
  assert.equal(resolvePaneCost({ promptTokens: 10, completionTokens: 10 }, undefined), null, "no model, no price");
  const estimate = resolvePaneCost({ promptTokens: 1_000_000, completionTokens: 0 }, SONNET);
  assert.equal(estimate?.basis, "estimated");
  assert.ok((estimate?.usd ?? 0) > 0);
  assert.equal(resolvePaneCost({ costUsd: Number.NaN }, undefined), null);
});

test("an error frame ends the pane with the server's sentence and a retry", () => {
  const run = applyChunk(started(1_000), { type: "error", message: "Claude is overloaded right now.", finishReason: "error" }, 1_500);
  assert.equal(run.status, "error");
  assert.equal(run.errorMessage, "Claude is overloaded right now.");
  assert.equal(run.errorAction, "retry");
  assert.equal(run.finishReason, "error");
  assert.equal(totalMs(run), 500);
});

test("failRun keeps what streamed; abortRun closes a partial answer as stopped and an empty one as an error", () => {
  const partial = applyChunk(started(0), { type: "delta", text: "half an answer" }, 100);
  const dropped = failRun(partial, { message: DROPPED_MESSAGE, action: "retry" }, 900);
  assert.equal(dropped.status, "error");
  assert.equal(dropped.content, "half an answer");
  assert.equal(dropped.errorMessage, DROPPED_MESSAGE);
  assert.equal(dropped.elapsedMs, 900);

  const stopped = abortRun(partial, 400);
  assert.equal(stopped.status, "done");
  assert.equal(stopped.finishReason, "user_stopped");
  assert.equal(stopped.content, "half an answer");

  const empty = abortRun(started(0), 400);
  assert.equal(empty.status, "error");
  assert.equal(empty.errorMessage, "Stopped before the model answered.");
  assert.equal(empty.finishReason, "user_stopped");
});

test("frames that carry nothing for a pane leave it untouched", () => {
  const run = started();
  assert.equal(applyChunk(run, { type: "ping" }, 2_000), run);
  assert.equal(applyChunk(run, { type: "title", conversationId: "c", title: "t" }, 2_000), run);
});

test("refusals map to one sentence and the one action that fixes them", () => {
  const budget = failureFromResponse(402, { error: "budget_exceeded", message: "You’ve used this month’s Pro budget." });
  assert.deepEqual(budget, { message: "You’ve used this month’s Pro budget.", action: "upgrade" });

  const quota = failureFromResponse(402, { error: "You've reached your monthly message limit.", code: "QUOTA_EXCEEDED" });
  assert.equal(quota.action, "upgrade");
  assert.equal(quota.message, "You've reached your monthly message limit.");

  const unverified = failureFromResponse(402, { error: "Confirm your email address to start sending messages.", code: "EMAIL_UNVERIFIED" });
  assert.equal(unverified.action, "retry", "no plan clears an unverified email");

  assert.equal(failureFromResponse(402, { error: "budget_exceeded" }).message, "You’ve reached your plan’s limit for now.", "a bare machine code is never shown");
  assert.deepEqual(failureFromResponse(401, { error: "Unauthorized" }), { message: "You’re signed out. Sign in again, then run it again.", action: null });
  assert.match(failureFromResponse(429, {}).message, /Too many requests/);
  assert.equal(failureFromResponse(503, { error: "Alevr is restarting. Please try again in a moment.", code: "SERVER_DRAINING" }).message, "Alevr is restarting. Please try again in a moment.");
  assert.match(failureFromResponse(503, null).message, /unavailable right now/);
  assert.equal(failureFromResponse(500, {}).message, "The server hit an error (500). Run it again.");
  assert.equal(failureFromResponse(400, { error: "Invalid request." }).message, "Invalid request.");
  assert.equal(failureFromResponse(404, "not json").message, "The request was refused (404).");
});

test("thrown errors: an unreachable server reads as offline, anything else keeps its message", () => {
  assert.deepEqual(failureFromException(new TypeError("Failed to fetch")), { message: OFFLINE_MESSAGE, action: "retry" });
  assert.deepEqual(failureFromException(new TypeError("Load failed")), { message: OFFLINE_MESSAGE, action: "retry" });
  assert.equal(failureFromException(new Error("Stream parse failed.")).message, "Stream parse failed.");
  assert.equal(failureFromException(undefined).message, "Something went wrong. Run it again.");
});

test("Continue in chat credits the model that answered and dates the prompt by the wall clock", () => {
  const spec = { id: "spec-1", prompt: "Plan a 3-day Lisbon trip.", createdAt: "2026-10-25T14:03:00.000Z" };
  const answered: PaneRun = {
    ...IDLE_RUN,
    status: "done",
    specId: spec.id,
    content: "Day 1: Alfama.",
    requestedModelId: "auto",
    servedModelId: "anthropic:claude-sonnet-5",
    // A monotonic reading (ms since the page loaded), not a date.
    startedAt: 1_234.5,
    promptTokens: 10,
    completionTokens: 20,
    costUsd: 0.001,
    sources: [{ title: "Visit Lisboa", url: "https://www.visitlisboa.com/", snippet: "" }],
  };
  const now = new Date("2026-10-25T14:04:00.000Z");
  const messages = paneChatMessages({ spec, run: answered, paneModelId: "auto", now });
  assert.ok(messages);
  const [user, assistant] = messages;
  assert.equal(user.content, spec.prompt);
  assert.equal(user.createdAt, spec.createdAt, "not 1970: startedAt is never read as a date");
  assert.equal(assistant.model, "anthropic:claude-sonnet-5", "Auto's pick, not the pane's Auto");
  assert.equal(assistant.createdAt, now.toISOString());
  assert.equal(assistant.content, "Day 1: Alfama.");
  assert.deepEqual([assistant.promptTokens, assistant.completionTokens, assistant.costUsd], [10, 20, 0.001]);
  assert.equal(assistant.sources?.length, 1);
  assert.notEqual(user.id, assistant.id);

  // A swapped model is credited too; with no served model the request names it.
  assert.equal(paneChatMessages({ spec, run: { ...answered, servedModelId: null, requestedModelId: "openai:gpt-6-luna" }, paneModelId: "auto", now })?.[1].model, "openai:gpt-6-luna");
  assert.equal(paneChatMessages({ spec, run: { ...answered, servedModelId: null, requestedModelId: null }, paneModelId: "google:x", now })?.[1].model, "google:x");
  // Nothing to carry: no answer, or an answer to another comparison.
  assert.equal(paneChatMessages({ spec, run: { ...answered, content: "" }, paneModelId: "auto", now }), null);
  assert.equal(paneChatMessages({ spec, run: { ...answered, specId: "older" }, paneModelId: "auto", now }), null);
});
