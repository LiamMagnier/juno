import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { test } from "node:test";

/*
 * The wait for x11vnc to exit after `pkill -x x11vnc` (src/lib/computer/docker.ts
 * waitForVncExitWith), on an injected clock: SIGTERM first, SIGKILL once after
 * 3 s, a failure after 10 s. A take over's release and the VNC password rotation
 * count on "stopped" meaning exited, so the person's session is gone before the
 * agent is thawed (COMPUTERS_2026-10.md S2.4; tests/computer-real-e2e.test.ts
 * tests 7, 8 and 12 prove it on a real computer). The host's wait_for_vnc_exit is
 * the same rule (tests/test_computer_escalation.py).
 */

const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return originalLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const docker = req("../src/lib/computer/docker") as typeof import("@/lib/computer/docker");
const errors = req("../src/lib/computer/errors") as typeof import("@/lib/computer/errors");

/** A fake x11vnc: running until `exitsAt` (ms on the fake clock), or until killed if `exitsOnKill`. */
function scenario(opts: { exitsAt?: number; exitsOnKill?: boolean; checkCostMs?: number }) {
  let clock = 0;
  let killedAt: number | null = null;
  const kills: number[] = [];
  const checks: number[] = [];
  return {
    kills,
    checks,
    get clock() {
      return clock;
    },
    deps: {
      now: () => clock,
      pause: async (ms: number) => {
        clock += ms;
      },
      isRunning: async () => {
        clock += opts.checkCostMs ?? 0;
        checks.push(clock);
        if (opts.exitsOnKill && killedAt !== null) return false;
        return opts.exitsAt === undefined || clock < opts.exitsAt;
      },
      killHard: async () => {
        kills.push(clock);
        killedAt = clock;
      },
    },
  };
}

test("an x11vnc that is already gone: no wait, no SIGKILL", async () => {
  const s = scenario({ exitsAt: 0 });
  await docker.waitForVncExitWith(s.deps);
  assert.deepEqual(s.kills, []);
  assert.equal(s.checks.length, 1);
  assert.equal(s.clock, 0);
});

test("one that exits on SIGTERM within 3 s is never killed", async () => {
  const s = scenario({ exitsAt: 2_500, checkCostMs: 30 });
  await docker.waitForVncExitWith(s.deps);
  assert.deepEqual(s.kills, [], "SIGTERM was enough, so x11vnc could put the display back");
  assert.ok(s.clock >= 2_500 && s.clock < docker.VNC_EXIT_KILL_AFTER_MS, String(s.clock));
});

test("one whose TERM handler hangs is killed once, at 3 s, and the wait ends when it is gone", async () => {
  const s = scenario({ exitsOnKill: true, checkCostMs: 30 });
  await docker.waitForVncExitWith(s.deps);
  assert.equal(s.kills.length, 1, "exactly one SIGKILL");
  assert.ok(s.kills[0]! >= docker.VNC_EXIT_KILL_AFTER_MS, `not before 3 s: ${s.kills[0]}`);
  assert.ok(s.kills[0]! < docker.VNC_EXIT_KILL_AFTER_MS + 200, `soon after 3 s: ${s.kills[0]}`);
  assert.ok(s.clock < docker.VNC_EXIT_GIVE_UP_MS, "and the wait ended long before it would give up");
});

test("one that survives SIGKILL fails the wait at 10 s, so nothing starts beside it and no session is taken for ended", async () => {
  const s = scenario({ checkCostMs: 30 });
  await assert.rejects(
    () => docker.waitForVncExitWith(s.deps),
    (error: unknown) => error instanceof errors.ComputerError && error.message === errors.COMPUTER_NOT_RESPONDING,
  );
  assert.equal(s.kills.length, 1, "SIGKILL is sent once, not on every poll");
  assert.ok(s.clock >= docker.VNC_EXIT_GIVE_UP_MS && s.clock < docker.VNC_EXIT_GIVE_UP_MS + 200, String(s.clock));
});

test("the limits are the ones the host uses (juno-computer-host.py wait_for_vnc_exit)", async () => {
  assert.equal(docker.VNC_EXIT_KILL_AFTER_MS, 3_000);
  assert.equal(docker.VNC_EXIT_GIVE_UP_MS, 10_000);
  const { readFileSync } = await import("node:fs");
  const host = readFileSync(new URL("../deploy/computer-host/juno-computer-host.py", import.meta.url), "utf8");
  assert.match(host, /def wait_for_vnc_exit\(self, ns, name, seconds=10, kill_after=3\):/);
});
