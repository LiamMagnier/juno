import test from "node:test";
import assert from "node:assert/strict";
import { initPacer, pacerArrive, pacerStep, revealCut, PACER } from "../src/lib/chat/stream-pacer";

/** Drive the pacer over a burst plan at 60 fps; return the shown length per frame. */
function run(plan: { at: number; to: number }[], until: number) {
  let s = initPacer(0, 0);
  let length = 0;
  let p = 0;
  const shown: number[] = [];
  for (let t = 0; t <= until; t += 1000 / 60) {
    while (p < plan.length && plan[p].at <= t) length = plan[p++].to;
    s = pacerArrive(s, length, t);
    s = pacerStep(s, length, 1000 / 60);
    shown.push(Math.floor(s.shown));
  }
  return shown;
}

test("a burst is spread over frames, not dumped in one", () => {
  // 300 characters arrive at once, then nothing.
  const shown = run([{ at: 100, to: 300 }], 2000);
  const firstFrame = shown.find((n) => n > 0) ?? 0;
  assert.ok(firstFrame < 120, `first frame showed ${firstFrame} of 300`);
  assert.equal(shown[shown.length - 1], 300, "it catches up");
  const reached = shown.findIndex((n) => n === 300);
  assert.ok(reached * (1000 / 60) < 1200, `caught up after ${reached} frames`);
});

test("a steady stream comes out steady: no frame advances more than a few times the mean", () => {
  const plan = Array.from({ length: 200 }, (_, i) => ({ at: i * 50 + (i % 3) * 20, to: (i + 1) * 15 }));
  const shown = run(plan, 11000);
  const steps = shown.slice(30, 500).map((n, i, a) => (i ? n - a[i - 1] : 0)).slice(1);
  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  const max = Math.max(...steps);
  assert.ok(max <= mean * 4 + 2, `max step ${max}, mean ${mean.toFixed(2)}`);
});

test("a huge backlog jumps to the last screenful", () => {
  let s = initPacer(0, 0);
  s = pacerArrive(s, 10_000, 16);
  s = pacerStep(s, 10_000, 16);
  assert.equal(s.shown, 10_000 - PACER.jumpKeep);
});

test("replaced text restarts from the new text", () => {
  let s = initPacer(500, 0);
  s = pacerArrive(s, 120, 50);
  assert.ok(s.shown <= 120);
});

test("revealCut shows whole words", () => {
  const text = "The quick brown fox jumps";
  // Inside "quick", whose end has arrived: forward to the word's end.
  assert.equal(revealCut(text, 6), 9);
  // Inside the last word, still arriving: back to its start.
  assert.equal(revealCut(text, 23), 20);
  // On a space: unchanged.
  assert.equal(revealCut(text, 10), 10);
  assert.equal(revealCut(text, 999), text.length);
  // Never splits a surrogate pair.
  const emoji = "ab \u{1F600}";
  assert.notEqual(revealCut(emoji, 4), 4);
});
