import test from "node:test";
import assert from "node:assert/strict";
import {
  cancelSignalKey,
  createGenerationSignalPump,
  createMemoryGenerationSignalStore,
  GENERATION_CANCEL_POLL_MS,
  GENERATION_CANCEL_TTL_MS,
  GENERATION_LIVE_RENEW_MS,
  GENERATION_LIVE_TTL_MS,
  liveLeaseKey,
  type GenerationRef,
  type GenerationSignalStore,
} from "@/lib/chat/generation-signals";
import { createGenerationRegistry, type GenerationRegistry } from "@/lib/chat/generation-registry";
import { stopGeneration } from "@/lib/chat/stop-generation";

/*
 * Cross-process Stop (LEDGER P1-1): the durable cancel row, the live lease and
 * the per-process pump that reads one and renews the other.
 *
 * Every test here is in-process. The cases titled "two-instance simulation"
 * stand up two registries and two pumps over ONE shared store — two backend
 * processes sharing one database, simulated. The real thing, two Node
 * processes against Postgres through the real routes, is
 * tests/chat-cross-process-stop.integration.test.ts.
 */

const quiet = { info: () => {} };

/** A manual clock and timer queue: nothing runs until the test advances time. */
function manualTime(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    pending: () => timers.size,
    /** Advance the clock, firing due timers in order and letting their promises settle. */
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        await settle();
      }
      now = until;
      await settle();
    },
  };
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function instance(store: GenerationSignalStore, time: ReturnType<typeof manualTime>, extra: { onError?: (stage: string, error: unknown) => void } = {}) {
  const holder: { pump?: ReturnType<typeof createGenerationSignalPump> } = {};
  const delivered: GenerationRef[] = [];
  const registry: GenerationRegistry = createGenerationRegistry({
    now: time.now,
    logger: quiet,
    onRegister: () => holder.pump?.kick(),
    onUnregister: (ref, leased) => holder.pump?.release(ref, leased),
  });
  const pump = createGenerationSignalPump({
    store,
    held: () => registry.held(),
    onCancel: (ref) => {
      delivered.push(ref);
      registry.cancel(ref.generationId, ref.userId);
    },
    now: time.now,
    schedule: time.schedule,
    clearTimer: time.clearTimer,
    onError: extra.onError,
  });
  holder.pump = pump;
  return { registry, pump, delivered };
}

test("the shipped cadence keeps a Stop inside 3 s and a dead process's lease short", () => {
  assert.ok(GENERATION_CANCEL_POLL_MS <= 1_000, "one poll plus a round trip must fit in the 3 s promise");
  assert.ok(GENERATION_LIVE_TTL_MS >= 3 * GENERATION_LIVE_RENEW_MS, "a slow renewal must not read as a dead process");
  assert.ok(GENERATION_LIVE_TTL_MS <= 30_000, "a dead process must stop looking alive within seconds");
  assert.ok(GENERATION_CANCEL_TTL_MS >= 60_000 && GENERATION_CANCEL_TTL_MS <= 60 * 60_000);
});

test("keys are owner-scoped and unambiguous even when a generation id contains ':'", () => {
  const a = { userId: "cluser1", generationId: "b:c" };
  const b = { userId: "cluser1:b", generationId: "c" };
  // User ids are cuids and never contain ':', so `b` cannot exist; the
  // owner is always exactly the first segment after the prefix.
  assert.equal(cancelSignalKey(a), "generation:cancel:cluser1:b:c");
  assert.equal(liveLeaseKey(a), "generation:live:cluser1:b:c");
  assert.notEqual(cancelSignalKey({ userId: "u1", generationId: "g" }), cancelSignalKey({ userId: "u2", generationId: "g" }));
  assert.ok(b);
});

test("two-instance simulation: a Stop recorded by instance B stops a generation streaming on instance A within one poll", async () => {
  const time = manualTime();
  const store = createMemoryGenerationSignalStore(time.now);
  const a = instance(store, time);
  const controller = new AbortController();
  a.registry.register("gen-a", { userId: "u1", controller, model: "m" });
  await time.advance(0); // the kick: lease written, first poll made
  assert.equal(await store.isLive({ userId: "u1", generationId: "gen-a" }), true, "A leased its generation at once");

  // Instance B holds nothing; its Stop goes durable.
  const b = createGenerationRegistry({ now: time.now, logger: quiet });
  const result = await stopGeneration(
    { userId: "u1", generationId: "gen-a" },
    {
      cancelLocal: b.cancel,
      recordCancel: (ref) => store.requestCancel(ref, GENERATION_CANCEL_TTL_MS),
      flagReceipt: async () => false,
      isLive: (ref) => store.isLive(ref),
    }
  );
  assert.deepEqual(result, { cancelled: true, delivery: "remote" }, "B reports a terminal frame is coming");
  assert.equal(controller.signal.aborted, false);

  await time.advance(GENERATION_CANCEL_POLL_MS);
  assert.equal(controller.signal.aborted, true, "A's next poll aborted it");
  assert.equal(a.registry.wasStopped("gen-a"), true, "recorded as the user's Stop, not as an error");
  assert.equal(a.registry.wasAbortedForShutdown("gen-a"), false);
  assert.deepEqual(a.delivered, [{ userId: "u1", generationId: "gen-a" }]);

  await time.advance(GENERATION_CANCEL_POLL_MS * 5);
  assert.equal(a.delivered.length, 1, "a cancel row that outlives the abort is delivered once");
});

test("a Stop for the same generation id under another owner is never delivered", async () => {
  const time = manualTime();
  const store = createMemoryGenerationSignalStore(time.now);
  const a = instance(store, time);
  const controller = new AbortController();
  a.registry.register("gen-shared", { userId: "owner", controller, model: "m" });
  await store.requestCancel({ userId: "intruder", generationId: "gen-shared" }, GENERATION_CANCEL_TTL_MS);
  await time.advance(GENERATION_CANCEL_POLL_MS * 3);
  assert.equal(controller.signal.aborted, false);
  assert.deepEqual(a.delivered, []);
});

test("a Stop recorded before the turn registered stops it as soon as it does", async () => {
  const time = manualTime();
  const store = createMemoryGenerationSignalStore(time.now);
  await store.requestCancel({ userId: "u1", generationId: "gen-early" }, GENERATION_CANCEL_TTL_MS);
  const a = instance(store, time);
  const controller = new AbortController();
  a.registry.register("gen-early", { userId: "u1", controller, model: "m" });
  await time.advance(0);
  assert.equal(controller.signal.aborted, true, "the registration's own kick read the waiting Stop");
  assert.equal(a.registry.wasStopped("gen-early"), true);
});

test("an expired Stop is ignored, so a reused generation id is not cancelled by an old one", async () => {
  const time = manualTime();
  const store = createMemoryGenerationSignalStore(time.now);
  await store.requestCancel({ userId: "u1", generationId: "gen-old" }, GENERATION_CANCEL_TTL_MS);
  await time.advance(GENERATION_CANCEL_TTL_MS + 1);
  const a = instance(store, time);
  const controller = new AbortController();
  a.registry.register("gen-old", { userId: "u1", controller, model: "m" });
  await time.advance(GENERATION_CANCEL_POLL_MS * 2);
  assert.equal(controller.signal.aborted, false);
});

test("Stop is idempotent: repeats refresh one row and the generation is stopped once", async () => {
  const time = manualTime();
  const store = createMemoryGenerationSignalStore(time.now);
  const a = instance(store, time);
  const controller = new AbortController();
  a.registry.register("gen-twice", { userId: "u1", controller, model: "m" });
  await time.advance(0);
  for (let i = 0; i < 3; i += 1) await store.requestCancel({ userId: "u1", generationId: "gen-twice" }, GENERATION_CANCEL_TTL_MS);
  assert.equal(store.rows.get("generation:cancel:u1:gen-twice")?.count, 3);
  assert.equal([...store.rows.keys()].filter((key) => key.startsWith("generation:cancel:")).length, 1);
  await time.advance(GENERATION_CANCEL_POLL_MS * 3);
  assert.equal(a.delivered.length, 1);
  assert.equal(a.registry.cancel("gen-twice", "u1"), true, "a local repeat is acknowledged too");
  assert.equal(a.registry.wasStopped("gen-twice"), true);
});

test("leases: renewed on cadence, released when the turn ends, never taken by a private turn", async () => {
  const time = manualTime();
  const store = createMemoryGenerationSignalStore(time.now);
  const a = instance(store, time);
  const unregister = a.registry.register("gen-saved", { userId: "u1", controller: new AbortController(), model: "m" });
  a.registry.register("gen-private", { userId: "u1", controller: new AbortController(), model: "m", private: true });
  await time.advance(0);
  assert.equal(await store.isLive({ userId: "u1", generationId: "gen-saved" }), true);
  assert.equal(await store.isLive({ userId: "u1", generationId: "gen-private" }), false, "a private turn writes nothing on its own");

  // Well past one TTL: only renewal keeps it alive.
  await time.advance(GENERATION_LIVE_TTL_MS * 3);
  assert.equal(await store.isLive({ userId: "u1", generationId: "gen-saved" }), true, "renewed while held");

  unregister();
  await settle();
  await time.advance(0);
  assert.equal(await store.isLive({ userId: "u1", generationId: "gen-saved" }), false, "released at the end");
});

test("a process that dies stops looking alive once its lease runs out", async () => {
  const time = manualTime();
  const store = createMemoryGenerationSignalStore(time.now);
  const a = instance(store, time);
  a.registry.register("gen-dying", { userId: "u1", controller: new AbortController(), model: "m" });
  await time.advance(0);
  a.pump.stop(); // the process is gone: no renewals, no release
  await time.advance(GENERATION_LIVE_TTL_MS + 1);
  assert.equal(await store.isLive({ userId: "u1", generationId: "gen-dying" }), false);
});

test("the pump is idle with nothing registered: no timer, no query", async () => {
  const time = manualTime();
  let calls = 0;
  const base = createMemoryGenerationSignalStore(time.now);
  const counting: GenerationSignalStore = {
    requestCancel: base.requestCancel,
    pendingCancels: async (refs) => {
      calls += 1;
      return base.pendingCancels(refs);
    },
    renewLive: async (refs, ttl) => {
      calls += 1;
      return base.renewLive(refs, ttl);
    },
    isLive: base.isLive,
    releaseLive: base.releaseLive,
  };
  const a = instance(counting, time);
  await time.advance(10_000);
  assert.equal(calls, 0);
  assert.equal(time.pending(), 0);

  const unregister = a.registry.register("gen-1", { userId: "u1", controller: new AbortController(), model: "m" });
  await time.advance(GENERATION_CANCEL_POLL_MS * 2);
  assert.ok(calls > 0);
  unregister();
  await time.advance(GENERATION_CANCEL_POLL_MS * 2);
  const after = calls;
  await time.advance(60_000);
  assert.equal(calls, after, "back to idle once the last generation is gone");
  assert.equal(a.pump.running, false);
});

test("one read and one write per tick, however many generations the process holds", async () => {
  const time = manualTime();
  const base = createMemoryGenerationSignalStore(time.now);
  const batches: { reads: number[]; writes: number[] } = { reads: [], writes: [] };
  const store: GenerationSignalStore = {
    ...base,
    pendingCancels: async (refs) => {
      batches.reads.push(refs.length);
      return base.pendingCancels(refs);
    },
    renewLive: async (refs, ttl) => {
      batches.writes.push(refs.length);
      return base.renewLive(refs, ttl);
    },
  };
  const a = instance(store, time);
  for (let i = 0; i < 25; i += 1) a.registry.register(`gen-${i}`, { userId: `u${i % 3}`, controller: new AbortController(), model: "m" });
  await time.advance(0);
  assert.deepEqual(batches.reads, [25]);
  assert.deepEqual(batches.writes, [25]);
});

test("a failing store is not a Stop, does not stop the loop, and is logged once per window", async () => {
  const time = manualTime();
  const errors: string[] = [];
  let failing = true;
  const base = createMemoryGenerationSignalStore(time.now);
  const flaky: GenerationSignalStore = {
    ...base,
    pendingCancels: async (refs) => {
      if (failing) throw new Error("db down");
      return base.pendingCancels(refs);
    },
  };
  const a = instance(flaky, time, { onError: (stage) => errors.push(stage) });
  const controller = new AbortController();
  a.registry.register("gen-1", { userId: "u1", controller, model: "m" });
  await base.requestCancel({ userId: "u1", generationId: "gen-1" }, GENERATION_CANCEL_TTL_MS);
  await time.advance(GENERATION_CANCEL_POLL_MS * 10);
  assert.equal(controller.signal.aborted, false, "a failed read never aborts");
  assert.deepEqual(errors, ["poll"], "ten failures, one log line");

  failing = false;
  await time.advance(GENERATION_CANCEL_POLL_MS);
  assert.equal(controller.signal.aborted, true, "the loop kept going and delivered once the store recovered");
});

test("a release never lands before the renewal already in flight", async () => {
  const time = manualTime();
  const base = createMemoryGenerationSignalStore(time.now);
  let releaseRenewal: (() => void) | null = null;
  const slow: GenerationSignalStore = {
    ...base,
    renewLive: (refs, ttl) =>
      new Promise<void>((resolve) => {
        releaseRenewal = () => void base.renewLive(refs, ttl).then(resolve);
      }),
  };
  const a = instance(slow, time);
  const unregister = a.registry.register("gen-race", { userId: "u1", controller: new AbortController(), model: "m" });
  await time.advance(0); // renewal is now in flight, held open
  unregister(); // the turn ends while it is
  await settle();
  assert.ok(releaseRenewal, "the renewal was started");
  (releaseRenewal as () => void)();
  await settle();
  assert.equal(await base.isLive({ userId: "u1", generationId: "gen-race" }), false, "the finished lease was not resurrected");
});
