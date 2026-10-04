import test from "node:test";
import assert from "node:assert/strict";
import { anchoredTranscriptTop, placeInlineRuns, transcriptAnchor, transcriptIndexAt, transcriptLayout, transcriptWindow } from "@/lib/chat/transcript-window";

test("a thousand dynamic rows mount only a viewport and overscan", () => {
  const keys = Array.from({ length: 1000 }, (_, i) => `m${i}`);
  const layout = transcriptLayout(keys, (_, i) => 80 + i % 7 * 55);
  for (let top = 0; top < layout.total; top += 1237) {
    const { start, end } = transcriptWindow(layout, top, 800);
    assert.ok(end - start < 35);
    assert.ok(layout.offsets[start] <= top);
    assert.ok(layout.offsets[end] >= Math.min(layout.total, top + 800));
  }
});

test("delayed media and research height changes preserve the reader's line", () => {
  const keys = ["question", "image", "report", "answer", "stream"];
  const old = transcriptLayout(keys, () => 200);
  const anchor = transcriptAnchor(old, 637)!;
  assert.deepEqual(anchor, { key: "answer", offset: 37 });
  const expanded = transcriptLayout(keys, (key) => key === "image" ? 800 : key === "report" ? 1200 : 200);
  assert.equal(anchoredTranscriptTop(expanded, anchor, 637), 2237);
});

test("stable row keys preserve anchors when history is inserted or reordered", () => {
  const old = transcriptLayout(["a", "b", "c"], () => 100);
  const anchor = transcriptAnchor(old, 125)!;
  const next = transcriptLayout(["new", "c", "a", "b"], () => 100);
  assert.equal(anchoredTranscriptTop(next, anchor, 125), 325);
  const removed = transcriptLayout(["a", "c"], () => 100);
  assert.equal(anchoredTranscriptTop(removed, anchor, 125), 125);
});

test("boundary lookup includes tall rows and clamps out-of-range scrolls", () => {
  const layout = transcriptLayout(["a", "b", "c"], (_, i) => i === 1 ? 3000 : 100);
  assert.equal(transcriptIndexAt(layout, -100), 0);
  assert.equal(transcriptIndexAt(layout, 99), 0);
  assert.equal(transcriptIndexAt(layout, 100), 1);
  assert.equal(transcriptIndexAt(layout, 2200), 1);
  assert.equal(transcriptIndexAt(layout, 10000), 2);
  assert.deepEqual(transcriptWindow(layout, 1000, 800, 0), { start: 1, end: 2 });
});

test("empty and invalid measurements cannot produce broken spacer geometry", () => {
  const empty = transcriptLayout([], () => 1);
  assert.deepEqual(transcriptWindow(empty, 0, 800), { start: 0, end: 0 });
  assert.equal(transcriptAnchor(empty, 0), null);
  const first = transcriptLayout(["first"], () => 100);
  assert.equal(anchoredTranscriptTop(first, transcriptAnchor(first, -24)!, 0), -24);
  const layout = transcriptLayout(["a", "b", "c"], (_, i) => [NaN, -1, Infinity][i]);
  assert.deepEqual(layout.offsets, [0, 160, 161, 321]);
});

test("inline runs follow the reply to the last question asked before they started", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 4, 0, 0, s)).toISOString();
  const turns = [
    { role: "USER", createdAt: at(0) },
    { role: "ASSISTANT", createdAt: at(1) },
    { role: "USER", createdAt: at(10) },
    { role: "ASSISTANT", createdAt: at(11) },
    { role: "USER", createdAt: at(20) },
  ];
  const placed = placeInlineRuns(turns, [
    { id: "before-everything", createdAt: at(-5) },
    { id: "after-first", createdAt: at(5) },
    { id: "after-second", createdAt: at(12) },
    { id: "also-after-second", createdAt: at(15) },
    { id: "unanswered-question", createdAt: at(25) },
  ]);
  assert.deepEqual(placed.get(-1), ["before-everything"]);
  assert.deepEqual(placed.get(1), ["after-first"]);
  assert.deepEqual(placed.get(3), ["after-second", "also-after-second"]);
  // The last question has no reply yet: the run sits under the question.
  assert.deepEqual(placed.get(4), ["unanswered-question"]);
  assert.equal(placeInlineRuns(turns, []).size, 0);
});
