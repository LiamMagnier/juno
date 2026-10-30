import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, beforeEach, test } from "node:test";

import {
  AlertGate,
  LOOP_STALE_AFTER_MS,
  LoopMonitor,
  SWEEPERS_HEARTBEAT_TTL_MS,
  WATCHER_STARTUP_GRACE_MS,
  sweepersHeartbeatStale,
  workDispatchLoopsEnabled,
} from "../src/lib/worker-watchdog-rules";
import {
  EXECUTOR_HEARTBEAT_TTL_MS,
  EXECUTOR_STALE_WATCHER_GRACE_MS,
  executorStaleWithWaitingWork,
} from "../src/lib/work/executor-presence";

/*
 * The operator alerts for the background workers (src/lib/worker-watchdog.ts):
 * the Work executor's heartbeat gone stale while cloud runs wait, a loop of
 * juno-sweepers that stopped finishing ticks, and juno-sweepers itself gone
 * quiet. Through the real `alertOperator` (src/lib/alerts.ts) with the mail
 * transport recorded, so the hourly de-duplication is the one that ships. No
 * database: every read is injected.
 */

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
const sent: Array<{ to: string; subject: string; text?: string }> = [];
const logged: Array<Record<string, unknown>> = [];
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  if (request === "@/lib/email") return { sendEmail: async (mail: { to: string; subject: string; text?: string }) => void sent.push(mail) };
  if (request === "@/lib/logger") return { logAsync: (_level: string, _event: string, fields: Record<string, unknown>) => void logged.push(fields) };
  if (request === "@/lib/db") return { prismaUnguarded: {}, prisma: {} };
  if (request === "@/lib/work/executor-heartbeat") return { readExecutorPresence: async () => ({ kind: "unknown" }) };
  return origLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const watchdog = req("../src/lib/worker-watchdog") as typeof import("@/lib/worker-watchdog");
const { resetAlertDedupeForTests, WORKER_ALERT_KINDS } = req("../src/lib/alerts") as typeof import("@/lib/alerts");

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const name of ["OWNER_EMAILS", "ALERT_MUTED_KINDS"]) savedEnv[name] = process.env[name];
  process.env.OWNER_EMAILS = "owner@example.invalid";
  delete process.env.ALERT_MUTED_KINDS;
  resetAlertDedupeForTests();
  sent.length = 0;
  logged.length = 0;
});
afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const settle = () => new Promise((resolve) => setImmediate(resolve));
const MIN = 60_000;
const T0 = Date.parse("2026-10-30T12:00:00Z");

test("a loop is stale when its tick has not come back for longer than it ever should", () => {
  let now = T0;
  const loops = new LoopMonitor(() => now);
  loops.register("work-scheduler", LOOP_STALE_AFTER_MS["work-scheduler"]);
  now += 9 * MIN;
  assert.equal(loops.health()[0]!.stale, false);
  now += 2 * MIN;
  assert.deepEqual(
    loops.health().map(({ name, stale, everTicked, silentForMs }) => ({ name, stale, everTicked, silentForMs })),
    [{ name: "work-scheduler", stale: true, everTicked: false, silentForMs: 11 * MIN }]
  );
  loops.beat("work-scheduler");
  assert.equal(loops.health()[0]!.stale, false);
  assert.equal(loops.health()[0]!.everTicked, true);
});

test("the gate says it once an hour while stale, and once when it recovers", () => {
  const gate = new AlertGate();
  assert.equal(gate.observe("k", false, T0), null);
  assert.equal(gate.observe("k", true, T0), "alert");
  assert.equal(gate.observe("k", true, T0 + 30 * MIN), null);
  assert.equal(gate.observe("k", true, T0 + 60 * MIN), "alert");
  assert.equal(gate.observe("k", false, T0 + 61 * MIN), "recovered");
  assert.equal(gate.observe("k", false, T0 + 62 * MIN), null);
});

test("the executor counts as gone only when its heartbeat lapsed, work waits, and the watcher has been up", () => {
  const now = new Date(T0);
  const lapsed = { kind: "read" as const, lastBeatAt: new Date(T0 - EXECUTOR_HEARTBEAT_TTL_MS - MIN), localBeatFresh: false };
  const fresh = { kind: "read" as const, lastBeatAt: new Date(T0 - 30_000), localBeatFresh: false };
  const up = EXECUTOR_STALE_WATCHER_GRACE_MS;
  assert.equal(executorStaleWithWaitingWork({ reading: lapsed, waitingRuns: 2, now, watcherUpForMs: up }), true);
  assert.equal(executorStaleWithWaitingWork({ reading: { ...lapsed, lastBeatAt: null }, waitingRuns: 1, now, watcherUpForMs: up }), true, "never reported");
  assert.equal(executorStaleWithWaitingWork({ reading: lapsed, waitingRuns: 0, now, watcherUpForMs: up }), false, "nothing waits");
  assert.equal(executorStaleWithWaitingWork({ reading: fresh, waitingRuns: 2, now, watcherUpForMs: up }), false);
  assert.equal(executorStaleWithWaitingWork({ reading: { kind: "unknown" }, waitingRuns: 2, now, watcherUpForMs: up }), false, "a failed read proves nothing");
  assert.equal(executorStaleWithWaitingWork({ reading: lapsed, waitingRuns: 2, now, watcherUpForMs: up - 1 }), false, "just after a deploy");
});

test("juno-sweepers counts as gone only from a watcher that has been up, and a missing row only in production", () => {
  const now = new Date(T0);
  const up = WATCHER_STARTUP_GRACE_MS;
  assert.equal(sweepersHeartbeatStale({ expiresAt: new Date(T0 - 1), now, watcherUpForMs: up, expectSweepers: true }), true);
  assert.equal(sweepersHeartbeatStale({ expiresAt: new Date(T0 + MIN), now, watcherUpForMs: up, expectSweepers: true }), false);
  assert.equal(sweepersHeartbeatStale({ expiresAt: new Date(T0 - 1), now, watcherUpForMs: up - 1, expectSweepers: true }), false);
  assert.equal(sweepersHeartbeatStale({ expiresAt: "unknown", now, watcherUpForMs: up, expectSweepers: true }), false);
  assert.equal(sweepersHeartbeatStale({ expiresAt: null, now, watcherUpForMs: up, expectSweepers: true }), true);
  assert.equal(sweepersHeartbeatStale({ expiresAt: null, now, watcherUpForMs: up, expectSweepers: false }), false);
});

test("the scheduler and the trigger poller stay off inside juno-sweepers unless the owner turns them on", () => {
  assert.equal(workDispatchLoopsEnabled(undefined), false);
  assert.equal(workDispatchLoopsEnabled(""), false);
  assert.equal(workDispatchLoopsEnabled("0"), false);
  for (const on of ["1", "true", "ON", " yes "]) assert.equal(workDispatchLoopsEnabled(on), true, on);
});

test("juno-sweepers mails once when a loop stops ticking, not every minute, and once when it is back", async () => {
  let now = T0;
  const loops = new LoopMonitor(() => now);
  loops.register("work-scheduler", LOOP_STALE_AFTER_MS["work-scheduler"]);
  loops.register("agent-reflector", LOOP_STALE_AFTER_MS["agent-reflector"]);
  let beats = 0;
  const check = watchdog.createSweepersWatchdog({
    loops,
    readPresence: async () => ({ kind: "read", lastBeatAt: new Date(now - 10_000), localBeatFresh: false }),
    countWaiting: async () => assert.fail("the executor is up: nothing is counted"),
    writeHeartbeat: async () => void (beats += 1),
    startedAtMs: T0,
  });
  for (let minute = 1; minute <= 15; minute += 1) {
    now = T0 + minute * MIN;
    if (minute <= 15) loops.beat("agent-reflector");
    await check(new Date(now));
  }
  await settle();
  assert.equal(beats, 15, "the process's own heartbeat on every look");
  assert.equal(sent.length, 1, sent.map((mail) => mail.subject).join("\n"));
  assert.match(sent[0]!.subject, /work-scheduler has not finished a tick for 10 min/);
  assert.equal(logged.filter((line) => line.kind === WORKER_ALERT_KINDS.sweeperStale).length, 1, "one log line, not one a minute");

  loops.beat("work-scheduler");
  now += MIN;
  await check(new Date(now));
  await settle();
  assert.equal(sent.length, 2);
  assert.match(sent[1]!.subject, /work-scheduler is finishing ticks again/);
});

test("juno-sweepers mails when the executor's heartbeat lapsed while cloud runs wait", async () => {
  const lastBeat = new Date(T0 - 30 * MIN);
  let waiting = 3;
  const check = watchdog.createSweepersWatchdog({
    loops: new LoopMonitor(() => T0),
    readPresence: async () => ({ kind: "read", lastBeatAt: lastBeat, localBeatFresh: false }),
    countWaiting: async () => waiting,
    writeHeartbeat: async () => undefined,
    startedAtMs: T0 - 10 * MIN,
  });
  await check(new Date(T0));
  await check(new Date(T0 + MIN));
  await settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.subject, /\[Alevr critical\] The cloud Work executor has not reported for 30 min and 3 cloud runs are waiting/);
  assert.match(sent[0]!.text ?? "", /alert: work_executor_stale:cloud/);
  // An hour on, still down: one more. The mail window runs on the wall clock,
  // so an hour passing is its reset here.
  resetAlertDedupeForTests();
  await check(new Date(T0 + 61 * MIN));
  await settle();
  assert.equal(sent.length, 2);
  // Nothing waits any more: the all-clear.
  waiting = 0;
  await check(new Date(T0 + 62 * MIN));
  await settle();
  assert.equal(sent.length, 3);
  assert.match(sent[2]!.subject, /reporting again, or nothing is waiting/);
});

test("a muted kind still logs, and a watcher just started says nothing", async () => {
  process.env.ALERT_MUTED_KINDS = WORKER_ALERT_KINDS.executorStale;
  const check = watchdog.createSweepersWatchdog({
    loops: new LoopMonitor(() => T0),
    readPresence: async () => ({ kind: "read", lastBeatAt: null, localBeatFresh: false }),
    countWaiting: async () => 1,
    writeHeartbeat: async () => undefined,
    startedAtMs: T0 - 10 * MIN,
  });
  await check(new Date(T0));
  await settle();
  assert.equal(sent.length, 0);
  assert.equal(logged.filter((line) => line.kind === WORKER_ALERT_KINDS.executorStale).length, 1);

  delete process.env.ALERT_MUTED_KINDS;
  const fresh = watchdog.createSweepersWatchdog({
    loops: new LoopMonitor(() => T0),
    readPresence: async () => ({ kind: "read", lastBeatAt: null, localBeatFresh: false }),
    countWaiting: async () => 1,
    writeHeartbeat: async () => undefined,
    startedAtMs: T0 - MIN,
  });
  await fresh(new Date(T0));
  await settle();
  assert.equal(sent.length, 0);
});

test("juno-work mails when juno-sweepers stops reporting, looks once a minute, and says when it is back", async () => {
  let reads = 0;
  let expiresAt: Date | null | "unknown" = new Date(T0 - 2 * MIN);
  const check = watchdog.createSweepersWatcher({
    readHeartbeat: async () => {
      reads += 1;
      return expiresAt;
    },
    startedAtMs: T0 - 10 * MIN,
    expectSweepers: true,
  });
  await check(new Date(T0));
  await check(new Date(T0 + 5_000));
  assert.equal(reads, 1, "throttled to one look a minute");
  await settle();
  assert.equal(sent.length, 1);
  const lastBeatMinutes = Math.floor((2 * MIN + SWEEPERS_HEARTBEAT_TTL_MS) / MIN);
  assert.match(sent[0]!.subject, new RegExp(`juno-sweepers has not reported for ${lastBeatMinutes} min`));
  assert.match(sent[0]!.text ?? "", /alert: sweeper_stale:juno-sweepers/);

  expiresAt = new Date(T0 + 10 * MIN);
  await check(new Date(T0 + 2 * MIN));
  await settle();
  assert.equal(sent.length, 2);
  assert.match(sent[1]!.subject, /juno-sweepers is reporting again/);

  // Outside production, a runner with no juno-sweepers beside it says nothing.
  const dev = watchdog.createSweepersWatcher({ readHeartbeat: async () => null, startedAtMs: T0 - 10 * MIN, expectSweepers: false });
  await dev(new Date(T0));
  await settle();
  assert.equal(sent.length, 2);
});
