import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { applyStreamChunk, type LiveMessage } from "@/lib/chat/live-message";
import { appendReasoningDelta, emptyReasoning } from "@/lib/reasoning-parts";
import type { ClientMessage, StreamChunk } from "@/types/chat";

import { approval, call, commentaryRow, row, source, toolRow } from "./fixtures/run-events";

/*
 * The client's pure stream reducer (SPEC §12.4 WS5): one frame in, the next
 * live message out. `use-chat` and the `/dev/run` player share it.
 */

test("the reducer stays importable from client code and the tests", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/chat/live-message.ts"), "utf8");
  assert.doesNotMatch(source, /^import "server-only";/m);
});

function start(extra: Partial<LiveMessage> = {}): LiveMessage {
  return {
    id: "tmp_1",
    renderKey: "rk_1",
    role: "ASSISTANT",
    content: "",
    createdAt: "2026-09-23T19:07:00.000Z",
    attachments: [],
    streaming: true,
    ...extra,
  };
}

function play(chunks: StreamChunk[], from: LiveMessage = start()): LiveMessage {
  return chunks.reduce(applyStreamChunk, from);
}

test("deltas: content always; liveRounds per round and phase with `timeline`", () => {
  const profile1 = play([{ type: "delta", text: "Let me check." }, { type: "delta", text: "\n\n" }, { type: "delta", text: "Done." }]);
  assert.equal(profile1.content, "Let me check.\n\nDone.");
  assert.equal(profile1.liveRounds, undefined, "no rounds without `timeline`");

  const timeline = play([
    { type: "delta", text: "Let me ", round: 0 },
    { type: "delta", text: "check.", round: 0 },
    { type: "delta", text: "Preamble.", round: 1, phase: "commentary" },
    { type: "delta", text: "Answer.", round: 1, phase: "answer" },
    { type: "delta", text: " More.", round: 1, phase: "answer" },
  ]);
  assert.equal(timeline.content, "Let me check.Preamble.Answer. More.");
  assert.deepEqual(timeline.liveRounds, [
    { round: 0, text: "Let me check." },
    { round: 1, text: "Preamble.", phase: "commentary" },
    { round: 1, text: "Answer. More.", phase: "answer" },
  ]);
});

test("a timeline commentary event moves that round's text out of the answer area", () => {
  const before = play([
    { type: "delta", text: "Let me look.", round: 0 },
    { type: "delta", text: "Declared.", round: 1, phase: "commentary" },
    { type: "delta", text: "Kept.", round: 1, phase: "answer" },
  ]);
  const moved = applyStreamChunk(before, { type: "activity", event: commentaryRow(5, 900, 0, "Let me look.", true) });
  assert.deepEqual(moved.liveRounds, [
    { round: 1, text: "Declared.", phase: "commentary" },
    { round: 1, text: "Kept.", phase: "answer" },
  ]);
  assert.equal(moved.activity?.length, 1);
  const declared = applyStreamChunk(moved, { type: "activity", event: commentaryRow(6, 950, 1, "Declared.", false) });
  assert.deepEqual(declared.liveRounds, [{ round: 1, text: "Kept.", phase: "answer" }], "a declared answer item stays");
});

test("activity merges by id in place; a re-sent record replaces its call's row", () => {
  const queued = toolRow(3, 100, call({ callId: "jc_0_0", tool: "web_search", status: "queued" }));
  const withArgs = { ...queued, call: { ...queued.call!, args: { query: "heat pumps" } } };
  const running = { ...queued, call: { ...queued.call!, status: "running" as const, args: { query: "heat pumps" } } };
  const done = { ...running, id: "act_other", call: { ...running.call, status: "succeeded" as const } };
  const other = row(4, 150, "context", "Tools ready");
  let state = play([
    { type: "activity", event: queued },
    { type: "activity", event: other },
    { type: "activity", event: withArgs },
  ]);
  assert.deepEqual(state.activity!.map((e) => e.id), ["act_3", "act_4"]);
  assert.deepEqual(state.activity![0].call?.args, { query: "heat pumps" }, "the first queued carries `present`");
  state = play([{ type: "activity", event: running }, { type: "activity", event: done }], state);
  assert.deepEqual(state.activity!.map((e) => e.id), ["act_other", "act_4"], "replaced by callId, kept in place");
  assert.equal(state.activity![0].call?.status, "succeeded");
});

test("reasoning: parts and rounds fold like the route's helper, byte for byte", () => {
  const state = play([
    { type: "reasoning", text: "**A**\n\nOne.", part: 0, round: 0 },
    { type: "reasoning", text: " More.", part: 0, round: 0 },
    { type: "reasoning", text: "**B**\n\nTwo.", part: 1, round: 0 },
    { type: "reasoning", text: "Round two.", part: 1, round: 1 },
  ]);
  assert.deepEqual(state.reasoningParts, ["**A**\n\nOne. More.", "**B**\n\nTwo.Round two."]);
  assert.equal(state.reasoning, "**A**\n\nOne. More.\n\n**B**\n\nTwo.\n\nRound two.");
  // Without parts: the helper's flat concat, plus the round boundary.
  const flat = play([
    { type: "reasoning", text: "Thinking." },
    { type: "reasoning", text: " Still.", round: 0 },
    { type: "reasoning", text: "Next round.", round: 1 },
  ]);
  assert.equal(flat.reasoning, "Thinking. Still.\n\nNext round.");
  assert.equal(flat.reasoningParts, undefined);
  let helper = emptyReasoning();
  for (const [text, part] of [["**A**\n\nOne.", 0], [" More.", 0], ["**B**\n\nTwo.", 1]] as const) helper = appendReasoningDelta(helper, text, part);
  assert.ok(state.reasoning!.startsWith(helper.text), "the part rule is the helper's");
});

test("approvals replace by id; sources and progress", () => {
  const pending = approval({ id: "apr_1" });
  const allowed = { ...pending, status: "allowed" as const };
  let state = play([
    { type: "approval", approval: pending },
    { type: "approval", approval: approval({ id: "apr_2" }) },
    { type: "approval", approval: allowed },
  ]);
  assert.deepEqual(state.approvals!.map((a) => [a.id, a.status]), [["apr_1", "allowed"], ["apr_2", "pending"]]);
  const list = [source(1), source(2)];
  state = applyStreamChunk(state, { type: "sources", sources: list });
  assert.equal(state.sources, list);
  state = applyStreamChunk(state, { type: "progress", stage: "generating", pct: 40 });
  assert.deepEqual(state.progress, { modality: "image", stage: "generating", pct: 40 });
});

test("done: the persisted message replaces the live one, only the identity carries over", () => {
  const live = play([{ type: "delta", text: "Hi", round: 0 }, { type: "reasoning", text: "Hm", round: 0 }]);
  const persisted: ClientMessage = { id: "msg_9", role: "ASSISTANT", content: "Hi.", createdAt: "2026-09-23T19:07:05.000Z", attachments: [] };
  const done = applyStreamChunk(live, {
    type: "done",
    message: persisted,
    artifacts: [],
    memoryUpdated: false,
    quota: {} as never,
    finishReason: "stop",
  });
  assert.equal(done.id, "msg_9");
  assert.equal(done.renderKey, "rk_1");
  assert.equal(done.streaming, false);
  assert.equal(done.liveRounds, undefined);
  assert.equal(done.reasoningCursor, undefined);
  assert.equal(done.finishReason, "stop");
});

test("error: a partial answer is kept; otherwise the error is the bubble", () => {
  const partial = applyStreamChunk(play([{ type: "delta", text: "Half" }]), {
    type: "error",
    message: "The provider failed.",
    preservePartial: true,
  });
  assert.equal(partial.content, "Half");
  assert.equal(partial.errorMessage, "The provider failed.");
  assert.equal(partial.streaming, false);
  assert.equal(partial.error, true);
  assert.equal(partial.finishReason, "error");
  const stopped = applyStreamChunk(start(), { type: "error", message: "Stopped.", finishReason: "user_stopped" });
  assert.equal(stopped.content, "Stopped.");
  assert.equal(stopped.finishReason, "user_stopped");
});

test("handoff ends the turn as a research run", () => {
  const state = applyStreamChunk(start(), { type: "handoff", to: "research", runId: "run_7", userMessageId: "u_1" });
  assert.deepEqual(state.handoff, { runId: "run_7" });
  assert.equal(state.streaming, false);
});

test("frames that do not concern the message return it unchanged, and no array is copied needlessly", () => {
  const base = play([
    { type: "delta", text: "x", round: 0 },
    { type: "activity", event: row(1, 0, "context", "Tools ready") },
    { type: "approval", approval: approval({ id: "a" }) },
  ]);
  for (const chunk of [
    { type: "ping" },
    { type: "meta", conversationId: "c", userMessageId: null, title: "T" },
    { type: "title", conversationId: "c", title: "T" },
    { type: "resume", available: false },
    { type: "resume", refetch: true },
  ] as StreamChunk[]) {
    assert.equal(applyStreamChunk(base, chunk), base, chunk.type);
  }
  // Re-sending the identical event object changes nothing.
  assert.equal(applyStreamChunk(base, { type: "activity", event: base.activity![0] }), base);
  assert.equal(applyStreamChunk(base, { type: "approval", approval: base.approvals![0] }), base);
  // A delta copies no array but liveRounds; a reasoning frame none of activity/approvals/liveRounds.
  const afterDelta = applyStreamChunk(base, { type: "delta", text: "y", round: 0 });
  assert.equal(afterDelta.activity, base.activity);
  assert.equal(afterDelta.approvals, base.approvals);
  const afterReasoning = applyStreamChunk(base, { type: "reasoning", text: "r" });
  assert.equal(afterReasoning.activity, base.activity);
  assert.equal(afterReasoning.liveRounds, base.liveRounds);
  assert.equal(afterReasoning.approvals, base.approvals);
  const afterActivity = applyStreamChunk(base, { type: "activity", event: row(2, 0, "context", "More") });
  assert.equal(afterActivity.liveRounds, base.liveRounds);
});

test("a 100 frames/s burst loses nothing", () => {
  const chunks: StreamChunk[] = Array.from({ length: 1_000 }, (_, i) => ({ type: "delta", text: `${i % 10}`, round: Math.floor(i / 500) }));
  const state = play(chunks);
  assert.equal(state.content.length, 1_000);
  assert.deepEqual(state.liveRounds!.map((r) => [r.round, r.text.length]), [[0, 500], [1, 500]]);
});
