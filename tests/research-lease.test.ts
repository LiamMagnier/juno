import test from "node:test";
import assert from "node:assert/strict";
import { createResearchEngine } from "@/lib/research/engine";
import {
  RESEARCH_LEASE_RENEW_MS,
  createLeaseKeeper,
  researchChatOwner,
  researchWebOwner,
  withHeartbeat,
  type LeaseTimers,
} from "@/lib/research/lease-core";
import { memoryStore } from "./fixtures/research-store";
import { reworkDeps } from "./fixtures/research-deps";
import { readSource, serverOnlyIn } from "./fixtures/server-only-graph";

/*
 * SPEC §9.3 B1–B3: a drive lets its lease go on every non-terminal return; the
 * native hand-off keeps it alive from the chat route and cancels on Stop; and
 * every long model stage renews it while it runs.
 */

function fakeTimers() {
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  const timers: LeaseTimers = {
    setInterval(fn, ms) {
      next += 1;
      intervals.set(next, { fn, ms });
      return next;
    },
    clearInterval(handle) {
      intervals.delete(handle as number);
    },
  };
  return { timers, intervals, tick: () => [...intervals.values()].forEach(({ fn }) => fn()) };
}

test("the lease core is importable without server-only; lease.ts binds it", () => {
  assert.deepEqual(serverOnlyIn("src/lib/research/lease-core.ts"), []);
  const lease = readSource("src/lib/research/lease.ts");
  assert.match(lease, /^import "server-only";/m);
  assert.match(lease, /createLeaseKeeper\(/);
  // The keep-alive takes only a lease that is its own or free, like claimRun.
  assert.match(lease, /OR: \[\{ workerLeaseOwner: owner \}, \{ workerLeaseUntil: null \}, \{ workerLeaseUntil: \{ lte: now \} \}\]/);
  assert.match(lease, /researchEngine\(\)\.cancel\(\{ runId, userId: row\.userId, reason \}\)/);
});

test("a keep-alive renews at once and every 45 s until stopped, and survives a failed beat (B2)", async () => {
  const { timers, intervals, tick } = fakeTimers();
  let renewals = 0;
  let failNext = false;
  const errors: unknown[] = [];
  const stop = createLeaseKeeper(
    async () => {
      renewals += 1;
      if (failNext) {
        failNext = false;
        throw new Error("db blip");
      }
    },
    { timers, onError: (error) => errors.push(error) }
  );
  assert.equal(renewals, 1, "the lease is taken the moment the hold starts");
  assert.equal([...intervals.values()][0].ms, RESEARCH_LEASE_RENEW_MS);
  failNext = true;
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1, "a failed renewal is reported, not thrown");
  tick();
  assert.equal(renewals, 3, "and the next beat tries again");
  stop();
  stop();
  assert.equal(intervals.size, 0);
});

test("withHeartbeat renews while the stage runs and stops when it ends (B3)", async () => {
  const { timers, intervals, tick } = fakeTimers();
  let beats = 0;
  let release!: () => void;
  const stage = withHeartbeat(
    () => new Promise<string>((resolve) => (release = () => resolve("written"))),
    async () => {
      beats += 1;
    },
    45_000,
    timers
  );
  tick();
  tick();
  assert.equal(beats, 2);
  release();
  assert.equal(await stage, "written");
  assert.equal(intervals.size, 0, "no heartbeat outlives its stage");
  // Without a heartbeat it is just the stage.
  assert.equal(await withHeartbeat(async () => 7, undefined), 7);
});

test("the web owner is stable per run; the chat owner is per turn", () => {
  assert.equal(researchWebOwner("run_1"), "research-web:run_1");
  assert.equal(researchWebOwner("run_1"), researchWebOwner("run_1"));
  assert.equal(researchChatOwner("run_1", 1_700_000_000_000), "research-chat:run_1:1700000000000");
});

test("a drive that stops at the plan gate lets its lease go, so the nudge after Start can claim it (B1)", async () => {
  const { store, runs } = memoryStore();
  const engine = createResearchEngine(reworkDeps(store));
  const run = await engine.start({ userId: "u", goal: "How do heat pumps cope with Nordic winters?", confirmation: "required" });
  const parked = await engine.drive({ runId: run.id, userId: "u", workerId: "research-web:a" });
  assert.equal(parked?.state, "awaiting_plan_confirmation");
  assert.equal(runs.get(run.id)?.workerLeaseOwner ?? null, null, "a blocked run holds no lease");

  const confirmed = await engine.decidePlan({ runId: run.id, userId: "u", decision: "confirm" });
  assert.equal(confirmed.ok, true);
  // Another owner (the PM2 worker, or a different nudge) can take it at once.
  const claimed = await store.claimRun!({ runId: run.id, userId: "u", workerId: "research-worker:9" });
  assert.equal(claimed?.workerLeaseOwner, "research-worker:9");
});

test("stopping at `until` or on abort releases; holdLeaseAtUntil keeps it for the native hand-off", async () => {
  {
    const { store, runs } = memoryStore();
    const engine = createResearchEngine(reworkDeps(store));
    const run = await engine.start({ userId: "u", goal: "How do heat pumps cope with Nordic winters?", confirmation: "auto" });
    await engine.drive({ runId: run.id, userId: "u", workerId: "w1", until: "investigating" });
    assert.equal(runs.get(run.id)?.state, "investigating");
    assert.equal(runs.get(run.id)?.workerLeaseOwner ?? null, null);
  }
  {
    const { store, runs } = memoryStore();
    const engine = createResearchEngine(reworkDeps(store));
    const run = await engine.start({ userId: "u", goal: "How do heat pumps cope with Nordic winters?", confirmation: "auto" });
    await engine.drive({ runId: run.id, userId: "u", workerId: "chat-owner", until: "investigating", holdLeaseAtUntil: true });
    assert.equal(runs.get(run.id)?.workerLeaseOwner, "chat-owner", "the chat route renews it from here (B2)");
  }
  {
    const { store, runs } = memoryStore();
    const engine = createResearchEngine(reworkDeps(store));
    const run = await engine.start({ userId: "u", goal: "How do heat pumps cope with Nordic winters?", confirmation: "auto" });
    const controller = new AbortController();
    controller.abort();
    await engine.drive({ runId: run.id, userId: "u", workerId: "w2", signal: controller.signal });
    assert.equal(runs.get(run.id)?.workerLeaseOwner ?? null, null);
  }
});

test("a drive that never got the lease releases nothing it does not hold", async () => {
  const { store, runs } = memoryStore();
  const engine = createResearchEngine(reworkDeps(store));
  const run = await engine.start({ userId: "u", goal: "How do heat pumps cope with Nordic winters?", confirmation: "auto" });
  await store.claimRun!({ runId: run.id, userId: "u", workerId: "other" });
  await engine.drive({ runId: run.id, userId: "u", workerId: "me" });
  assert.equal(runs.get(run.id)?.workerLeaseOwner, "other");
});

test("every long model stage heartbeats the lease while it runs (B3)", async () => {
  const { store } = memoryStore();
  const beatsDuring: Record<string, number> = {};
  let claims = 0;
  const claimRun = store.claimRun!.bind(store);
  store.claimRun = async (input) => {
    claims += 1;
    return claimRun(input);
  };
  const slow = async <T>(label: string, value: T): Promise<T> => {
    const before = claims;
    await new Promise((resolve) => setTimeout(resolve, 40));
    beatsDuring[label] = claims - before;
    return value;
  };
  const base = reworkDeps(store);
  const engine = createResearchEngine({
    ...base,
    heartbeatMs: 5,
    draftPlan: (input) => slow("plan", null).then(() => base.draftPlan!(input)),
    synthesize: (input) => slow("synthesize", undefined).then(() => base.synthesize!(input)),
    validateReport: ({ report }) =>
      slow("validate", {
        report,
        repaired: false,
        summary: { claims: 1, supported: 1, partiallySupported: 0, unsupported: 0, contradicted: 0, unverified: 0, duplicateSources: 0 },
      }),
  });
  const run = await engine.start({ userId: "u", goal: "How do heat pumps cope with Nordic winters?", confirmation: "auto" });
  const done = await engine.drive({ runId: run.id, userId: "u", workerId: "w" });
  assert.equal(done?.state, "completed");
  for (const stage of ["plan", "synthesize", "validate"]) {
    assert.ok((beatsDuring[stage] ?? 0) >= 2, `${stage} ran for 40 ms without renewing the lease (${beatsDuring[stage]})`);
  }
});

test("a chat that stopped cancels its run, and says so on the event (B2, B17)", async () => {
  const { store, events } = memoryStore();
  const engine = createResearchEngine(reworkDeps(store));
  const run = await engine.start({ userId: "u", goal: "How do heat pumps cope with Nordic winters?", confirmation: "auto" });
  await engine.drive({ runId: run.id, userId: "u", until: "investigating" });
  const result = await engine.cancel({ runId: run.id, userId: "u", reason: "chat_stopped" });
  assert.deepEqual(result, { ok: true, state: "cancelled" });
  const cancelled = events.find((event) => event.runId === run.id && event.kind === "cancelled");
  assert.deepEqual(
    { actor: (cancelled?.payload as { actor?: string }).actor, reason: (cancelled?.payload as { reason?: string }).reason },
    { actor: "chat", reason: "chat_stopped" }
  );
});
