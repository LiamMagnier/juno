import test from "node:test";
import assert from "node:assert/strict";
import { anchoredTranscriptTop, transcriptAnchor, transcriptIndexAt, transcriptLayout, transcriptWindow } from "@/lib/chat/transcript-window";

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
