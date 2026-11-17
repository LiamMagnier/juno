import test from "node:test";
import assert from "node:assert/strict";

import { createCallWakeLock, createVoiceHeartbeat, type HeartbeatTimers } from "@/lib/voice-keepalive";

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const jobs = new Map<number, { at: number; every?: number; fn: () => void }>();
  const timers: HeartbeatTimers = {
    setInterval: (fn, ms) => {
      const id = ++seq;
      jobs.set(id, { at: now + ms, every: ms, fn });
      return id;
    },
    clearInterval: (handle) => void jobs.delete(handle as number),
    setTimeout: (fn, ms) => {
      const id = ++seq;
      jobs.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => void jobs.delete(handle as number),
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...jobs.entries()].filter(([, job]) => job.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, job] = due;
      now = job.at;
      if (job.every) job.at = now + job.every;
      else jobs.delete(id);
      job.fn();
    }
    now = until;
  };
  return { timers, advance };
}

test("the heartbeat pings a quiet line and calls a ping nobody answers a drop", () => {
  const { timers, advance } = fakeTimers();
  let pings = 0;
  let silent = 0;
  const beat = createVoiceHeartbeat({ ping: () => pings++, onSilent: () => silent++, timers });

  advance(10_000);
  assert.equal(pings, 1);
  // Any frame back is an answer.
  advance(1_000);
  beat.heard();
  advance(9_000);
  assert.equal(pings, 2);
  assert.equal(silent, 0);

  // No answer within 5 s: one drop, then nothing more.
  advance(5_000);
  assert.equal(silent, 1);
  advance(60_000);
  assert.equal(silent, 1);
  assert.equal(pings, 2, "a dropped line is not pinged again");
});

test("a stopped heartbeat never fires", () => {
  const { timers, advance } = fakeTimers();
  let pings = 0;
  let silent = 0;
  const beat = createVoiceHeartbeat({ ping: () => pings++, onSilent: () => silent++, timers });
  advance(10_000);
  beat.stop();
  advance(60_000);
  assert.equal(pings, 1);
  assert.equal(silent, 0);
});

test("the wake lock is held during a call, taken again when the page comes back, and let go after", async () => {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: "visible",
    addEventListener: (_: "visibilitychange", fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: "visibilitychange", fn: () => void) => void listeners.delete(fn),
  };
  let requests = 0;
  let released = 0;
  const sentinels: { onRelease?: () => void }[] = [];
  const nav = {
    wakeLock: {
      request: async () => {
        requests++;
        const s: { onRelease?: () => void } = {};
        sentinels.push(s);
        return {
          release: async () => {
            released++;
            s.onRelease?.();
          },
          addEventListener: (_: "release", fn: () => void) => (s.onRelease = fn),
        };
      },
    },
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const lock = createCallWakeLock(nav, doc);

  lock.hold();
  await flush();
  assert.equal(requests, 1);

  // Hidden, the browser lets it go; visible again, the call takes it back.
  doc.visibilityState = "hidden";
  sentinels[0].onRelease?.();
  doc.visibilityState = "visible";
  for (const fn of listeners) fn();
  await flush();
  assert.equal(requests, 2);

  lock.release();
  await flush();
  assert.equal(released, 1);
  // After the call, coming back to the page asks for nothing.
  for (const fn of listeners) fn();
  await flush();
  assert.equal(requests, 2);

  lock.dispose();
  assert.equal(listeners.size, 0);
});

test("no Wake Lock API: the call goes on without one", () => {
  const lock = createCallWakeLock({}, { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} });
  lock.hold();
  lock.release();
  lock.dispose();
});
