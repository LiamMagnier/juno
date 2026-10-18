import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TETHER,
  TETHER_CONNECTED,
  TetherLink,
  staleGuard,
  tetherDelayMs,
  tetherRetryInSeconds,
  tetherStep,
  tetherView,
  type TetherClock,
  type TetherEvent,
  type TetherSignals,
  type TetherState,
  type TetherTrigger,
} from "@/lib/net/tether";

/*
 * Tether (docs/rea/designs/reliability-and-native.md §3.1): one reconnect
 * policy for every client. The fixture is shared with the Swift twin
 * (native/Packages/JunoNativeKit/Tests/JunoCoreTests/TetherTests.swift), so a
 * transition that drifts on one platform fails on both.
 */

type Fixture = {
  constants: Record<string, number>;
  delays: { attempt: number; unit: number; delayMs: number }[];
  scenarios: {
    name: string;
    online: boolean;
    steps: {
      at: number;
      event: TetherEvent;
      unit: number;
      expect: TetherState & { retryInSeconds: number | null };
    }[];
  }[];
};

const fixture = JSON.parse(readFileSync(new URL("./fixtures/tether-vectors.json", import.meta.url), "utf8")) as Fixture;

test("the constants are the fixture's, so both platforms share them", () => {
  assert.deepEqual({ ...TETHER }, fixture.constants);
  assert.equal(TETHER.baseMs, 1_000);
  assert.equal(TETHER.capMs, 30_000);
  assert.equal(TETHER.staleAfterMs, 2 * TETHER.heartbeatMs);
});

test("delays follow full jitter between the floor and the doubling window, capped", () => {
  for (const { attempt, unit, delayMs } of fixture.delays) {
    assert.equal(tetherDelayMs(attempt, unit), delayMs, `attempt ${attempt}, unit ${unit}`);
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    for (const unit of [0, 0.1, 0.5, 0.9, 0.9999999]) {
      const delay = tetherDelayMs(attempt, unit);
      assert.ok(delay >= TETHER.floorMs && delay <= TETHER.capMs, `${attempt}/${unit} → ${delay}`);
    }
  }
});

for (const scenario of fixture.scenarios) {
  test(`vectors: ${scenario.name}`, () => {
    let state: TetherState = { ...TETHER_CONNECTED, online: scenario.online };
    scenario.steps.forEach((step, index) => {
      state = tetherStep(state, step.event, step.at, step.unit);
      const { retryInSeconds, ...expected } = step.expect;
      assert.deepEqual({ ...state }, expected, `step ${index} (${JSON.stringify(step.event)} at ${step.at})`);
      assert.equal(tetherRetryInSeconds(state, step.at), retryInSeconds, `step ${index} countdown`);
    });
  });
}

test("no give-up: however long the outage, the state is never terminal and a retry is always scheduled", () => {
  let state = tetherStep(TETHER_CONNECTED, { type: "drop" }, 0, 0.5);
  let now = 0;
  for (let i = 0; i < 500; i++) {
    assert.notEqual(state.retryAt, null, `iteration ${i}`);
    now = state.retryAt!;
    state = tetherStep(state, { type: "attempt" }, now);
    state = tetherStep(state, { type: "failed" }, now + 50, (i * 0.37) % 1);
  }
  assert.equal(state.phase, "parked");
  assert.ok(now > 6 * 60 * 60_000, "kept going for hours");
  // And a trigger brings it straight back.
  const back = tetherStep(state, { type: "trigger", reason: "foreground" }, now + 1);
  assert.equal(back.phase, "reconnecting");
  assert.equal(back.retryAt, now + 1);
});

test("A2: 500 clients reconnecting after an outage never put more than 5% of attempts in one 100 ms bucket", () => {
  // Deterministic PRNG (mulberry32) so the test is a vector, not a dice roll.
  let seed = 0x7e7e7;
  const random = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const outageMs = 5 * 60_000;
  const buckets = new Map<number, number>();
  let attempts = 0;
  for (let client = 0; client < 500; client++) {
    // Every client lost the server at the same instant.
    let state = tetherStep(TETHER_CONNECTED, { type: "drop" }, 0, random());
    while (state.retryAt !== null && state.retryAt < outageMs) {
      const at = state.retryAt;
      buckets.set(Math.floor(at / 100), (buckets.get(Math.floor(at / 100)) ?? 0) + 1);
      attempts++;
      state = tetherStep(state, { type: "attempt" }, at);
      state = tetherStep(state, { type: "failed" }, at, random());
    }
  }
  const worst = Math.max(...buckets.values());
  assert.ok(worst / attempts <= 0.05, `worst bucket ${worst}/${attempts}`);
});

test("the view says nothing while connected and never counts down outside `reconnecting`", () => {
  assert.equal(tetherView(TETHER_CONNECTED), undefined);
  const parked: TetherState = { phase: "parked", attempt: 9, online: true, since: 0, retryAt: 999_999 };
  assert.deepEqual(tetherView(parked), { phase: "parked", retryAt: null });
  assert.equal(tetherRetryInSeconds(parked, 0), null);
});

// ── TetherLink under a fake clock ──────────────────────────────────────────

function fakeClock(units: number[] = [0.5]) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let draw = 0;
  const clock: TetherClock & { advance(ms: number): void; pending(): number } = {
    now: () => now,
    random: () => units[draw++ % units.length],
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
  return clock;
}

function fakeSignals(online = true) {
  let listener: ((signal: TetherTrigger | "offline") => void) | null = null;
  const signals: TetherSignals & { fire(signal: TetherTrigger | "offline"): void } = {
    online: () => online,
    subscribe(fn) {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    fire(signal) {
      listener?.(signal);
    },
  };
  return signals;
}

/** Settle promise callbacks queued by a resolved waiter. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("TetherLink waits out the jittered backoff, then goes", async () => {
  const clock = fakeClock([0.5]);
  const link = new TetherLink({ clock });
  link.drop();
  let went = false;
  void link.nextAttempt().then((go) => (went = go));
  clock.advance(624);
  await flush();
  assert.equal(went, false, "not before retryAt");
  clock.advance(1);
  await flush();
  assert.equal(went, true);
  assert.equal(link.state.retryAt, null, "an attempt is now under way");
  link.dispose();
});

test("park and resume: a turn offline past the window parks, then a wake resumes it at once", async () => {
  const clock = fakeClock([0.5]);
  const signals = fakeSignals();
  const states: string[] = [];
  const link = new TetherLink({ clock, signals, onChange: (s) => states.push(s.phase) });
  link.drop();
  // Fail every attempt for four minutes.
  while (clock.now() < 4 * 60_000) {
    const go = link.nextAttempt();
    clock.advance(TETHER.probeMs);
    assert.equal(await go, true);
    link.failed();
  }
  assert.equal(link.state.phase, "parked");
  assert.ok(states.includes("reconnecting"));
  const cursorKeptBy = link.state.since;
  assert.equal(cursorKeptBy, 0, "the window is the original drop's");

  // Parked: the next attempt is a slow probe…
  let went = false;
  void link.nextAttempt().then((go) => (went = go));
  clock.advance(1_000);
  await flush();
  assert.equal(went, false, "parked does not spin");
  // …until the machine wakes.
  signals.fire("wake");
  await flush();
  assert.equal(went, true, "a trigger starts the attempt immediately");
  assert.equal(link.state.phase, "reconnecting");
  assert.equal(link.state.attempt, 0, "and resets the backoff");
  link.connected();
  assert.equal(link.state.phase, "connected");
  link.dispose();
});

test("offline shows waiting with no countdown; the network returning retries immediately", async () => {
  const clock = fakeClock([0.9]);
  const signals = fakeSignals();
  const link = new TetherLink({ clock, signals });
  link.drop();
  signals.fire("offline");
  assert.equal(link.state.phase, "waiting");
  assert.equal(tetherRetryInSeconds(link.state, clock.now()), null);
  let went = false;
  void link.nextAttempt().then((go) => (went = go));
  clock.advance(10_000);
  await flush();
  assert.equal(went, false);
  signals.fire("network");
  await flush();
  assert.equal(went, true);
  link.dispose();
});

test("an abort ends the wait with false and leaves no timer behind", async () => {
  const clock = fakeClock();
  const link = new TetherLink({ clock });
  link.drop();
  const controller = new AbortController();
  const result = link.nextAttempt(controller.signal);
  controller.abort();
  assert.equal(await result, false);
  link.dispose();
  assert.equal(clock.pending(), 0);
});

test("the stale guard fails a resumed stream silent for twice the heartbeat, and heartbeats keep it alive", () => {
  const clock = fakeClock();
  const guard = staleGuard(undefined, clock);
  clock.advance(TETHER.staleAfterMs - 1);
  guard.beat();
  clock.advance(TETHER.staleAfterMs - 1);
  assert.equal(guard.signal.aborted, false);
  clock.advance(1);
  assert.equal(guard.signal.aborted, true);
  assert.equal(guard.stale, true);
  guard.dispose();

  const parent = new AbortController();
  const linked = staleGuard(parent.signal, clock);
  parent.abort();
  assert.equal(linked.signal.aborted, true);
  assert.equal(linked.stale, false, "the caller's abort is not staleness");
  linked.dispose();
});

test("the chat and Code streams reconnect through Tether, keeping the seq cursor", () => {
  const chat = readFileSync(new URL("../src/hooks/use-chat.ts", import.meta.url), "utf8");
  assert.match(chat, /new TetherLink\(/);
  assert.match(chat, /\?after=\$\{args\.applier\.lastSeq\}/, "resume asks for frames after the last applied seq");
  assert.doesNotMatch(chat, /RECONNECT_WINDOW_MS/, "no fixed give-up window");
  const code = readFileSync(new URL("../src/hooks/use-code-session.ts", import.meta.url), "utf8");
  assert.match(code, /new TetherLink\(/);
  assert.match(code, /afterSeq=\$\{lastSeqRef\.current\}/);
});
