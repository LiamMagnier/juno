import test from "node:test";
import assert from "node:assert/strict";
import {
  THINKING_PASS_MS,
  THINKING_TIMING,
  initThinking,
  nextWake,
  passActive,
  passTone,
  settleActive,
  stepThinking,
  type ThinkingInput,
  type ThinkingPhase,
  type ThinkingState,
} from "@/components/brand/thinking-schedule";

const T = THINKING_TIMING;

/** Drive the machine like the component does: feed inputs at their times and every tick it asks for in between. */
function run(start: ThinkingPhase, inputs: ThinkingInput[], until: number, opts: { reducedMotion?: boolean } = {}) {
  let s: ThinkingState = initThinking(start, 0, opts);
  const passes: number[] = [];
  const settles: number[] = [];
  let lastPass = s.passId;
  let lastSettle = s.settleId;
  const note = (now: number) => {
    if (s.passId !== lastPass) { passes.push(now); lastPass = s.passId; }
    if (s.settleId !== lastSettle) { settles.push(now); lastSettle = s.settleId; }
  };
  const queue = [...inputs].sort((a, b) => a.now - b.now);
  let now = 0;
  for (;;) {
    const wake = nextWake(s, now);
    const nextInput = queue[0];
    const t = Math.min(wake ?? Infinity, nextInput?.now ?? Infinity);
    if (!Number.isFinite(t) || t > until) break;
    now = t;
    if (nextInput && nextInput.now === t) { s = stepThinking(s, queue.shift()!); note(now); }
    else { s = stepThinking(s, { type: "tick", now }); note(now); }
  }
  return { s, passes, settles };
}

test("timing tokens are the V3 rungs and the inherited loader contract", () => {
  assert.equal(T.showDelay, 200);
  assert.equal(T.minVisible, 400);
  assert.equal(T.rise, 120); // fast
  assert.equal(T.fall, 220); // base
  assert.equal(T.stagger, 120); // fast: the next blade starts as this one peaks
  assert.equal(T.release, 120); // fast
  assert.equal(T.window, 1600);
  assert.equal(T.windowMax, 6400);
  assert.equal(T.settle, 560); // emphasis
  assert.equal(THINKING_PASS_MS, 3 * 120 + 120 + 220);
});

test("a pass is a handoff: only one blade is ever near its peak, and blades light in clockwise order", () => {
  const peaks: number[] = [];
  for (let t = 0; t <= THINKING_PASS_MS; t += 2) {
    const tones = [0, 1, 2, 3].map((i) => passTone(i, t));
    assert.ok(tones.filter((v) => v > 0.75).length <= 1, `two blades near peak at ${t} ms: ${tones.map((v) => v.toFixed(2)).join(" ")}`);
    assert.ok(tones.filter((v) => v > 0.15).length <= 2, `three blades lit at ${t} ms: ${tones.map((v) => v.toFixed(2)).join(" ")}`);
    const top = tones.indexOf(Math.max(...tones));
    if (tones[top] > 0.99 && peaks[peaks.length - 1] !== top) peaks.push(top);
  }
  assert.deepEqual(peaks, [0, 1, 2, 3]);
  assert.equal(passTone(0, 0), 0);
  assert.equal(passTone(3, THINKING_PASS_MS), 0);
});

test("a pending phase waits 200 ms, then appears with one pass", () => {
  let s = initThinking("thinking", 0);
  assert.equal(s.visible, false);
  assert.equal(nextWake(s, 0), 200);
  s = stepThinking(s, { type: "tick", now: 199 });
  assert.equal(s.visible, false);
  s = stepThinking(s, { type: "tick", now: 200 });
  assert.equal(s.visible, true);
  assert.equal(s.passId, 1);
  assert.ok(passActive(s, 200));
  assert.ok(passActive(s, 200 + THINKING_PASS_MS - 1));
  assert.ok(!passActive(s, 200 + THINKING_PASS_MS));
});

test("work that ends inside the show delay never flashes the mark", () => {
  const { s, passes, settles } = run("thinking", [{ type: "phase", phase: "finished", now: 150 }], 5000);
  assert.equal(s.visible, false);
  assert.equal(s.suppressed, true);
  assert.equal(s.shown, "finished");
  assert.deepEqual(passes, []);
  assert.deepEqual(settles, []);
});

test("waiting or an error inside the show delay still shows, static", () => {
  for (const phase of ["waiting", "error"] as const) {
    const { s, passes } = run("thinking", [{ type: "phase", phase, now: 120 }], 5000);
    assert.equal(s.visible, true);
    assert.equal(s.shown, phase);
    assert.deepEqual(passes, []);
  }
});

test("once shown, a pending phase holds at least 400 ms before a status replaces it", () => {
  let s = initThinking("thinking", 0);
  s = stepThinking(s, { type: "tick", now: 200 }); // shown at 200
  s = stepThinking(s, { type: "phase", phase: "finished", now: 300 });
  assert.equal(s.shown, "thinking");
  assert.equal(nextWake(s, 300), 600);
  s = stepThinking(s, { type: "tick", now: 599 });
  assert.equal(s.shown, "thinking");
  s = stepThinking(s, { type: "tick", now: 600 });
  assert.equal(s.shown, "finished");
  assert.ok(settleActive(s, 600));
});

test("a stream absorbs inside the window and backs it off: 1.6 s, then 3.2 s, then 6.4 s", () => {
  const events: ThinkingInput[] = [];
  for (let t = 210; t < 20_000; t += 16) events.push({ type: "event", now: t }); // a misused 60 Hz stream
  const { passes } = run("thinking", events, 20_000);
  assert.equal(passes[0], 200); // the start pass
  const gaps = passes.slice(1).map((p, i) => p - passes[i]);
  assert.ok(gaps[0] >= 1600 && gaps[0] < 1620, `first gap ${gaps[0]}`);
  assert.ok(gaps[1] >= 3200 && gaps[1] < 3220, `second gap ${gaps[1]}`);
  for (const g of gaps.slice(2)) assert.ok(g >= 6400 && g < 6420, `later gap ${g}`);
});

test("no fixed beat: an irregular stream plus two tool batches never repeats one interval", () => {
  // The critic's case: an irregular 6 s stream, then two tool batches.
  const events: ThinkingInput[] = [];
  let t = 210;
  let k = 0;
  while (t < 6000) { events.push({ type: "event", now: t }); t += 40 + ((k++ * 37) % 90); }
  for (const b of [7200, 9800]) for (let j = 0; j < 4; j++) events.push({ type: "event", now: b + j * 30 });
  const { passes } = run("thinking", events, 14_000);
  const gaps = passes.slice(1).map((p, i) => p - passes[i]);
  // While the stream lasts the window only grows; it never settles into a loop.
  assert.ok(gaps[1] > gaps[0] + 1000, `gaps ${gaps.join(", ")}`);
  for (let i = 1; i < gaps.length; i++) assert.ok(Math.abs(gaps[i] - gaps[i - 1]) > 200, `repeated interval: ${gaps.join(", ")}`);
  assert.ok(passes.length <= 5, `passes ${passes.join(", ")}`);
});

test("a quiet gap resets the window: the next real step is news again", () => {
  const events: ThinkingInput[] = [];
  for (let t = 210; t < 4000; t += 50) events.push({ type: "event", now: t }); // stream until 4 s: passes 200, 1810, (window 3200)
  events.push({ type: "event", now: 6000 }); // 2 s of quiet, then a tool call
  const { passes } = run("thinking", events, 9000);
  assert.deepEqual(passes, [200, 1810, 6000]);
});

test("a step inside the window is absorbed, never deferred into a trailing pass", () => {
  const { passes } = run("thinking", [
    { type: "event", now: 500 },
    { type: "event", now: 900 },
  ], 6000);
  assert.deepEqual(passes, [200]);
});

test("with no new events the mark holds still after the start pass", () => {
  const { s, passes } = run("thinking", [], 10_000);
  assert.deepEqual(passes, [200]);
  assert.ok(!passActive(s, 10_000));
  assert.equal(s.visible, true);
});

test("a step after the window draws a pass at once", () => {
  const { passes } = run("thinking", [{ type: "event", now: 2500 }], 4000);
  assert.deepEqual(passes, [200, 2500]);
});

test("finished settles exactly once", () => {
  const { s, settles } = run("working", [{ type: "phase", phase: "finished", now: 2000 }], 8000);
  assert.deepEqual(settles, [2000]);
  assert.ok(!settleActive(s, 8000));
  assert.equal(s.visible, true);
});

test("waiting and error are static: no pass, no settle, pending events ignored", () => {
  for (const phase of ["waiting", "error"] as const) {
    const { s, passes, settles } = run("thinking", [
      { type: "phase", phase, now: 1000 },
      { type: "event", now: 1200 },
      { type: "event", now: 3000 },
    ], 6000);
    assert.equal(s.shown, phase);
    assert.deepEqual(passes, [200]);
    assert.deepEqual(settles, []);
  }
});

test("a phase change between pending phases is itself an event (coalesced)", () => {
  const { passes, s } = run("thinking", [{ type: "phase", phase: "working", now: 2500 }], 4000);
  assert.equal(s.shown, "working");
  assert.deepEqual(passes, [200, 2500]);
});

test("waiting then thinking again starts a fresh pass immediately", () => {
  const { passes } = run("thinking", [
    { type: "phase", phase: "waiting", now: 3000 },
    { type: "phase", phase: "thinking", now: 6000 },
  ], 8000);
  assert.deepEqual(passes, [200, 6000]);
});

test("hidden: nothing starts and nothing replays on return", () => {
  const { passes } = run("thinking", [
    { type: "event", now: 600 },            // absorbed
    { type: "visibility", visible: false, now: 700 },
    { type: "event", now: 2500 },           // ignored while hidden
    { type: "visibility", visible: true, now: 4000 },
  ], 9000);
  assert.deepEqual(passes, [200]);
});

test("after returning to view, the next real event draws a pass", () => {
  const { passes } = run("thinking", [
    { type: "visibility", visible: false, now: 300 },
    { type: "visibility", visible: true, now: 3000 },
    { type: "event", now: 3100 },
  ], 6000);
  assert.deepEqual(passes, [200, 3100]);
});

test("reduced motion: the mark still appears on the loader contract, but never passes or settles", () => {
  const { s, passes, settles } = run("thinking", [
    { type: "event", now: 2000 },
    { type: "phase", phase: "finished", now: 4000 },
  ], 8000, { reducedMotion: true });
  assert.equal(s.visible, true);
  assert.deepEqual(passes, []);
  assert.deepEqual(settles, []);
});

test("switching to reduced motion mid-pass ends the pass (the renderer fades it) and blocks new ones", () => {
  let s = initThinking("thinking", 0);
  s = stepThinking(s, { type: "tick", now: 200 });
  assert.ok(passActive(s, 300));
  s = stepThinking(s, { type: "motion", reduced: true, now: 300 });
  assert.ok(!passActive(s, 300));
  s = stepThinking(s, { type: "event", now: 2500 });
  assert.ok(!passActive(s, 2500));
});

test("hiding the tab mid-pass does not cut the pass: it finishes on its own clock", () => {
  let s = initThinking("thinking", 0);
  s = stepThinking(s, { type: "tick", now: 200 });
  s = stepThinking(s, { type: "visibility", visible: false, now: 300 });
  assert.ok(passActive(s, 400));
  assert.ok(!passActive(s, 200 + THINKING_PASS_MS));
});

test("idle and finished mounts are static and visible", () => {
  for (const phase of ["idle", "finished"] as const) {
    const s = initThinking(phase, 0);
    assert.equal(s.visible, true);
    assert.equal(nextWake(s, 0), null);
  }
});

test("a suppressed result still shows when the person is later needed", () => {
  let s = initThinking("thinking", 0);
  s = stepThinking(s, { type: "phase", phase: "finished", now: 100 });
  assert.equal(s.visible, false);
  s = stepThinking(s, { type: "phase", phase: "waiting", now: 1000 });
  assert.equal(s.visible, true);
  assert.equal(s.shown, "waiting");
});
