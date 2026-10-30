import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWorkerProcessGuard, describeFailure, type WorkerDrain } from "../src/lib/worker-process";

/*
 * The tsx workers' process handlers (src/lib/worker-process.ts): a stray
 * rejection is logged and the worker keeps running; an uncaught exception is
 * logged, drained and exits non-zero so PM2 restarts it. Everything the
 * handlers do to the process is injected here, so nothing exits.
 */

function harness(drains: Array<[string, WorkerDrain]>, timeoutMs = 1_000) {
  const lines: string[] = [];
  const exits: number[] = [];
  const codes: number[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const guard = createWorkerProcessGuard({
    name: "test-worker",
    drainTimeoutMs: timeoutMs,
    log: (line) => void lines.push(line),
    exit: (code) => void exits.push(code),
    setExitCode: (code) => void codes.push(code),
    drains: () => drains,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return { unref: () => undefined };
    },
  });
  return { guard, lines, exits, codes, timers };
}

test("an unhandled rejection is logged and the worker keeps running", () => {
  const { guard, lines, exits, codes } = harness([]);
  guard.onUnhandledRejection(new Error("the database blinked"));
  guard.onUnhandledRejection("a bare string");
  assert.equal(exits.length, 0);
  assert.equal(codes.length, 0);
  assert.equal(guard.draining, false);
  assert.match(lines[0]!, /^\[test-worker\] unhandled rejection \(still running\): Error: the database blinked/);
  assert.match(lines[1]!, /a bare string/);
});

test("a flood of rejections is bounded in the log", () => {
  const { guard, lines } = harness([]);
  for (let i = 0; i < 500; i += 1) guard.onUnhandledRejection(new Error(`tick ${i}`));
  assert.ok(lines.length <= 20, `${lines.length} lines`);
});

test("an uncaught exception drains every registered loop, then exits non-zero", async () => {
  const order: string[] = [];
  let release!: () => void;
  const tick = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { guard, lines, exits, codes } = harness([
    ["scheduler", async () => {
      order.push("scheduler stopping");
      await tick;
      order.push("scheduler drained");
    }],
    ["poller", async () => {
      order.push("poller drained");
    }],
    ["broken", async () => {
      throw new Error("could not stop");
    }],
  ]);

  guard.onUncaughtException(new TypeError("x is undefined"), "uncaughtException");
  assert.equal(guard.draining, true);
  assert.deepEqual(codes, [1], "the exit code is set before the drain");
  assert.deepEqual(exits, [], "not before the loops have drained");
  // A second exception while draining is logged, and starts nothing.
  guard.onUncaughtException(new Error("again"));
  release();
  await guard.drained;
  assert.deepEqual(exits, [1]);
  assert.deepEqual(order, ["scheduler stopping", "poller drained", "scheduler drained"]);
  assert.ok(lines.some((line) => /uncaught exception \(uncaughtException\): TypeError: x is undefined/.test(line)));
  assert.ok(lines.some((line) => /draining, then exiting with code 1/.test(line)));
  assert.ok(lines.some((line) => /broken did not drain cleanly: Error: could not stop/.test(line)));
  assert.equal(lines.filter((line) => /draining, then exiting/.test(line)).length, 1);
});

test("a drain that never settles is cut at the timeout, and a backstop exit is armed", async () => {
  const { guard, exits, timers } = harness([["stuck", () => new Promise<void>(() => undefined)]], 5_000);
  guard.onUncaughtException(new Error("boom"));
  const backstop = timers.find((timer) => timer.ms === 7_000);
  const timeout = timers.find((timer) => timer.ms === 5_000);
  assert.ok(backstop && timeout, JSON.stringify(timers.map((timer) => timer.ms)));
  timeout!.fn();
  await guard.drained;
  assert.deepEqual(exits, [1]);
});

test("in a real process: a rejection keeps it running, an exception drains and exits with code 1", () => {
  const moduleUrl = new URL("../src/lib/worker-process.ts", import.meta.url).href;
  const script = `
    const { installWorkerProcessGuard, registerWorkerDrain } = await import(${JSON.stringify(moduleUrl)});
    installWorkerProcessGuard({ name: "probe", drainTimeoutMs: 2000 });
    registerWorkerDrain("loop", async () => { await new Promise((r) => setTimeout(r, 50)); console.log("loop drained"); });
    Promise.reject(new Error("nobody awaited this"));
    setTimeout(() => console.log("still running"), 50);
    setTimeout(() => { throw new Error("a timer threw"); }, 100);
    setInterval(() => undefined, 1000);
  `;
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 30_000,
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /\[probe\] unhandled rejection \(still running\): Error: nobody awaited this/);
  assert.match(run.stdout, /still running/);
  assert.match(run.stderr, /\[probe\] uncaught exception \(uncaughtException\): Error: a timer threw/);
  assert.match(run.stdout, /loop drained/);
});

test("failures are described in one bounded line", () => {
  assert.match(describeFailure(new RangeError("too far")), /RangeError: too far/);
  assert.equal(describeFailure({ code: 7 }), '{"code":7}');
  assert.ok(describeFailure("x".repeat(10_000)).length <= 4_001);
});

test("every tsx worker installs the handlers and registers a drain", () => {
  const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  for (const [file, loop] of [
    ["scripts/work-scheduler.ts", "work-scheduler"],
    ["scripts/work-trigger-poller.ts", "work-trigger-poller"],
    ["scripts/agent-reflector.ts", "agent-reflector"],
    ["scripts/work-runner.ts", "work-runner"],
  ] as const) {
    const source = read(file);
    assert.match(source, /installWorkerProcessGuard\(/, file);
    assert.match(source, new RegExp(`registerWorkerDrain\\("${loop}"`), file);
  }
  const sweepers = read("scripts/sweepers.ts");
  assert.match(sweepers, /installWorkerProcessGuard\(\);/);
  // Imported, not started, unless the owner turns them on; the watchdog always.
  assert.match(sweepers, /if \(workDispatchLoopsEnabled\(\)\) \{\n  void startWorkScheduler\(\);\n  void startTriggerPoller\(\);/);
  assert.match(sweepers, /startSweepersWatchdog\(\);/);
  for (const loop of ["research-worker", "memory-dreamer", "agent-reflector", "sweep-import-runs", "sweep-stuck-code-tasks"]) {
    assert.match(sweepers, new RegExp(`import "\\./${loop}";`), loop);
  }
});
