import test from "node:test";
import assert from "node:assert/strict";
import { createFrameSequencer, replayStream, type ReplayEventRow, type StreamReplayPort } from "@/lib/chat/stream-replay";
import { TETHER, TetherLink, type TetherClock, type TetherSignals, type TetherTrigger } from "@/lib/net/tether";

/*
 * Resume after a long offline spell, end to end at the library level: the
 * server's frame log and replay (src/lib/chat/stream-replay.ts) on one side,
 * the client's Tether loop and seq cursor on the other — the same shape as
 * `reconnectFromLog` in src/hooks/use-chat.ts, under a fake clock.
 *
 * Acceptance A3 (docs/rea/designs/reliability-and-native.md): a stream dropped
 * for ten minutes parks, resumes on the next trigger while the log is kept,
 * and never applies a frame twice.
 */

function harness() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: TetherClock = {
    now: () => now,
    random: () => 0.5,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(handle) {
      timers.delete(handle as number);
    },
  };
  let listener: ((signal: TetherTrigger | "offline") => void) | null = null;
  const signals: TetherSignals = {
    online: () => true,
    subscribe(fn) {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  /** Move time forward, firing due timers in order and letting the loop react to each. */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      await settle();
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
    await settle();
  };
  return { clock, signals, advance, settle, fire: (signal: TetherTrigger | "offline") => listener?.(signal) };
}

test("A3: ten minutes unreachable parks the turn; a foreground trigger resumes it from the cursor, exactly once", async () => {
  const h = harness();

  // The server's log for this generation, still being written while the client is away.
  const log: ReplayEventRow[] = [1, 2, 3].map((seq) => ({ seq, kind: "delta", payload: `d${seq}` }));
  let serverReachable = false;
  let generating = true;
  const port: StreamReplayPort = {
    eventsAfter: async (_id, after, limit) => log.filter((r) => r.seq > after).slice(0, limit),
    liveness: async () => (generating ? "running" : "terminal"),
  };
  const requests: number[] = [];

  // The client: frames 1–3 were applied before the drop.
  const sequencer = createFrameSequencer(0);
  const applied: string[] = [];
  for (const row of log) if (sequencer.accept(row.seq)) applied.push(row.payload);
  let sawTerminal = false;

  const phases: string[] = [];
  const link = new TetherLink({ clock: h.clock, signals: h.signals, onChange: (s) => phases.push(s.phase) });

  const loop = (async () => {
    link.drop();
    for (;;) {
      if (!(await link.nextAttempt())) return "stale";
      requests.push(sequencer.lastSeq);
      try {
        if (!serverReachable) throw new Error("ECONNREFUSED");
        for await (const event of replayStream(port, {
          generationId: "g",
          after: sequencer.lastSeq,
          now: h.clock.now,
          sleep: async () => {},
        })) {
          if (event.type !== "frame") continue;
          link.connected();
          if (!sequencer.accept(event.seq)) continue;
          applied.push(event.payload);
          if (event.kind === "done") sawTerminal = true;
        }
      } catch {
        // dropped again; the policy decides when to try next
      }
      if (sawTerminal) return "terminal";
      if (link.state.phase === "connected") link.drop();
      else link.failed();
    }
  })();

  // Ten minutes of nothing. The answer keeps being written meanwhile.
  await h.advance(5 * 60_000);
  log.push(...[4, 5, 6].map((seq) => ({ seq, kind: "delta", payload: `d${seq}` })));
  await h.advance(5 * 60_000);
  log.push({ seq: 7, kind: "delta", payload: "d7" }, { seq: 8, kind: "done", payload: "done" });
  generating = false;

  assert.equal(link.state.phase, "parked", "parked, not given up");
  assert.ok(phases.includes("reconnecting"), "it retried visibly first");
  const parkedAttempts = requests.length;
  // Parked means a slow probe, not a spin: well under one attempt a second.
  assert.ok(parkedAttempts < 40, `${parkedAttempts} attempts in ten minutes`);
  assert.ok(requests.every((after) => after === 3), "every attempt asked for frames after the last applied seq");

  // The person comes back to the tab: one immediate attempt, no backoff wait.
  serverReachable = true;
  h.fire("foreground");
  await h.settle();
  assert.equal(await loop, "terminal");
  assert.equal(requests.length, parkedAttempts + 1, "the trigger went straight to an attempt");
  assert.deepEqual(applied, ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "done"], "every frame once, in order");
  assert.equal(link.state.phase, "connected");
  link.dispose();
});

test("offline for the whole outage shows waiting, never parked, and the network returning resumes at once", async () => {
  const h = harness();
  const link = new TetherLink({ clock: h.clock, signals: h.signals });
  let reachable = false;
  let attempts = 0;
  const loop = (async () => {
    link.drop();
    for (;;) {
      if (!(await link.nextAttempt())) return false;
      attempts++;
      if (reachable) {
        link.connected();
        return true;
      }
      link.failed();
    }
  })();
  h.fire("offline");
  await h.advance(15 * 60_000);
  assert.equal(link.state.phase, "waiting");
  assert.ok(attempts <= Math.ceil((15 * 60_000) / TETHER.probeMs) + 1, `${attempts} probes`);
  reachable = true;
  h.fire("network");
  assert.equal(await loop, true);
  link.dispose();
});
