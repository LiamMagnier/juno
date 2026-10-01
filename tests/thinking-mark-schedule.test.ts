import test from "node:test";
import assert from "node:assert/strict";
import {
  THINKING_PASS_MS,
  THINKING_TIMING,
  initThinking,
  nextWake,
  passActive,
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
  assert.equal(T.tone, 220);
  assert.equal(T.stagger, 70);
  assert.equal(T.cooldown, 1600);
  assert.equal(T.settle, 560);
  assert.equal(THINKING_PASS_MS, 2 * 220 + 3 * 70);
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

test("a burst of events coalesces to at most one pass per 1.6 s", () => {
  const events: ThinkingInput[] = [];
  for (let t = 210; t < 6000; t += 16) events.push({ type: "event", now: t }); // a streaming burst at 60 Hz
  const { passes } = run("thinking", events, 6000);
  assert.equal(passes[0], 200); // the start pass
  for (let i = 1; i < passes.length; i++) assert.ok(passes[i] - passes[i - 1] >= T.cooldown, `gap ${passes[i] - passes[i - 1]}`);
  assert.equal(passes.length, 4); // 200, 1800, 3400, 5000
});

test("with no new events the mark holds still after the start pass", () => {
  const { s, passes } = run("thinking", [], 10_000);
  assert.deepEqual(passes, [200]);
  assert.ok(!passActive(s, 10_000));
  assert.equal(s.visible, true);
});

test("one event inside the cooldown waits for it; a second adds nothing", () => {
  const { passes } = run("thinking", [
    { type: "event", now: 500 },
    { type: "event", now: 900 },
  ], 4000);
  assert.deepEqual(passes, [200, 1800]);
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

test("hidden: nothing starts, a queued pass is dropped, and nothing replays on return", () => {
  const { passes } = run("thinking", [
    { type: "event", now: 600 },            // queued for 1800
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

test("switching to reduced motion mid-run cancels a queued pass and a settle", () => {
  let s = initThinking("thinking", 0);
  s = stepThinking(s, { type: "tick", now: 200 });
  s = stepThinking(s, { type: "event", now: 500 });
  assert.equal(s.queuedPass, true);
  s = stepThinking(s, { type: "motion", reduced: true, now: 600 });
  assert.equal(s.queuedPass, false);
  assert.ok(!passActive(s, 600));
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
