"""Two waits at a take over, on an injected clock (no Docker, no root):

- agent-exec's freeze (deploy/agent-computers/agent-exec.py): it signals and
  scans until every uid-1000 task shows as stopped (T), for up to FREEZE_SECONDS.
  Only at that deadline does a task in uninterruptible sleep (D) with SIGSTOP
  pending count as stopped; anything else still running fails it (exit 3).
- the computer host's wait for x11vnc to exit (deploy/computer-host/
  juno-computer-host.py wait_for_vnc_exit): SIGKILL once after 3 s, 502 after
  10 s. src/lib/computer/docker.ts has the same rule (tests/computer-vnc-exit.test.ts).

tests/computer-real-e2e.test.ts (tests 7, 8 and 12) proves both on a real computer.

Run with python3 -m unittest discover -s tests -p 'test_computer_escalation.py'.
"""
import contextlib
import importlib.util
import io
import os
import signal
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


launcher = load("agent_exec_escalation", "deploy/agent-computers/agent-exec.py")
host_module = load("juno_computer_host_escalation", "deploy/computer-host/juno-computer-host.py")

SIGSTOP_PENDING = "%016x" % (1 << (signal.SIGSTOP - 1))


class FakeTime:
    """monotonic() and sleep() on a clock that only moves when slept on."""

    def __init__(self):
        self.now = 1000.0  # an offset that is exact in binary, so differences are too
        self.slept = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds
        self.slept += seconds


class FreezeScan(unittest.TestCase):
    """agent_tasks_not_stopped over a /proc tree written here."""

    def setUp(self):
        self.proc = tempfile.mkdtemp(prefix="juno-proc-")
        self.addCleanup(lambda: __import__("shutil").rmtree(self.proc, ignore_errors=True))

    def task(self, pid, uid, state, sigpnd="0000000000000000", shdpnd="0000000000000000", tid=None):
        directory = os.path.join(self.proc, str(pid), "task", str(tid or pid))
        os.makedirs(directory)
        with open(os.path.join(directory, "status"), "w") as status:
            status.write("Name:\tx\nState:\t%s (x)\nUid:\t%d\t%d\t%d\t%d\nSigPnd:\t%s\nShdPnd:\t%s\n"
                         % (state, uid, uid, uid, uid, sigpnd, shdpnd))

    def test_only_stopped_or_gone_agent_tasks_count_as_frozen(self):
        self.task(100, 1000, "R")
        self.task(101, 1000, "T")
        self.task(102, 1000, "t")
        self.task(103, 1000, "Z")
        self.task(104, 1001, "R")             # the browser uid: not the agent's
        self.task(105, 1000, "S")
        self.task(106, 1000, "S", tid=107)    # a thread of a process
        self.task(999, 1000, "R")             # the freezer itself
        self.assertEqual(sorted(launcher.agent_tasks_not_stopped(999, proc=self.proc)), [100, 105, 107])

    def test_a_task_in_d_with_sigstop_pending_counts_only_when_accepted(self):
        self.task(200, 1000, "D", sigpnd=SIGSTOP_PENDING)
        self.task(201, 1000, "D", shdpnd=SIGSTOP_PENDING)   # pending on the process, not the thread
        self.task(202, 1000, "D")                            # no stop pending: it would run on
        self.task(203, 1000, "R", sigpnd=SIGSTOP_PENDING)    # runnable: it may still run its own code
        self.assertEqual(sorted(launcher.agent_tasks_not_stopped(1, proc=self.proc)), [200, 201, 202, 203])
        self.assertEqual(sorted(launcher.agent_tasks_not_stopped(1, accept_pending_stop=True, proc=self.proc)), [202, 203])


class FreezeDeadline(unittest.TestCase):
    """freeze(): strict until FREEZE_SECONDS, the D rule only at the deadline."""

    def run_freeze(self, scan):
        clock = FakeTime()
        calls = []

        def fake_scan(own, accept_pending_stop=False):
            calls.append((clock.now - 1000.0, accept_pending_stop))
            return scan(clock.now - 1000.0, accept_pending_stop)

        stderr = io.StringIO()
        with patch.object(launcher, "time", clock), patch.object(launcher.os, "kill"), \
                patch.object(launcher, "agent_tasks_not_stopped", fake_scan), contextlib.redirect_stderr(stderr):
            code = launcher.freeze()
        return code, calls, stderr.getvalue()

    def test_everything_stopped_at_once_returns_at_once(self):
        code, calls, _ = self.run_freeze(lambda at, lenient: [])
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 1)
        self.assertAlmostEqual(calls[0][0], launcher.FREEZE_PAUSE_SECONDS)
        self.assertFalse(calls[0][1])

    def test_a_task_that_stops_late_is_waited_for_with_the_strict_rule(self):
        code, calls, _ = self.run_freeze(lambda at, lenient: [7] if at < 1.0 else [])
        self.assertEqual(code, 0)
        self.assertFalse(any(lenient for _, lenient in calls), "the D rule was never needed")
        self.assertLess(calls[-1][0], launcher.FREEZE_SECONDS)

    def test_a_task_stuck_in_d_with_the_stop_pending_is_accepted_only_at_the_deadline(self):
        code, calls, stderr = self.run_freeze(lambda at, lenient: [] if lenient else [7])
        self.assertEqual(code, 0)
        lenient = [at for at, accepted in calls if accepted]
        self.assertEqual(len(lenient), 1, "one scan with the D rule")
        self.assertGreaterEqual(lenient[0], launcher.FREEZE_SECONDS, "and only once the deadline has passed")
        self.assertTrue(all(not accepted for _, accepted in calls[:-1]))
        self.assertIn("uninterruptible", stderr)

    def test_a_task_still_running_at_the_deadline_fails_the_freeze(self):
        code, calls, stderr = self.run_freeze(lambda at, lenient: [7])
        self.assertEqual(code, 3)
        self.assertGreaterEqual(calls[-1][0], launcher.FREEZE_SECONDS)
        self.assertLess(calls[-1][0], launcher.FREEZE_SECONDS + 2 * launcher.FREEZE_PAUSE_SECONDS)
        self.assertIn("still running after the freeze", stderr)

    def test_the_window(self):
        self.assertEqual((launcher.FREEZE_SECONDS, launcher.FREEZE_PAUSE_SECONDS), (3.0, 0.05))


class HostVncExit(unittest.TestCase):
    """The host's wait_for_vnc_exit with a stand-in pgrep and pkill."""

    def run_wait(self, running):
        clock = FakeTime()
        kills = []
        checks = []
        host = object.__new__(host_module.Host)

        def vnc_running(ns, name):
            checks.append(clock.now - 1000.0)
            return {"running": running(clock.now - 1000.0, kills)}

        def docker(argv, ns, **kwargs):
            self.assertEqual(argv, host_module.Argv.vnc_kill_hard("juno-agent-a"))
            kills.append(clock.now - 1000.0)
            return 0, "", ""

        host.vnc_running = vnc_running
        host.docker = docker
        with patch.object(host_module, "time", clock):
            try:
                host.wait_for_vnc_exit("ns", "juno-agent-a")
                outcome = "exited"
            except host_module.Refused as refused:
                outcome = refused
        return outcome, kills, checks

    def test_gone_at_once(self):
        outcome, kills, checks = self.run_wait(lambda at, kills: False)
        self.assertEqual((outcome, kills, len(checks)), ("exited", [], 1))

    def test_exits_on_sigterm_and_is_never_killed(self):
        outcome, kills, _ = self.run_wait(lambda at, kills: at < 2.0)
        self.assertEqual((outcome, kills), ("exited", []))

    def test_a_hung_term_handler_is_killed_once_at_three_seconds(self):
        outcome, kills, checks = self.run_wait(lambda at, kills: not kills)
        self.assertEqual(outcome, "exited")
        self.assertEqual(len(kills), 1)
        self.assertGreaterEqual(kills[0], 3.0)
        self.assertLess(kills[0], 3.2)

    def test_one_that_survives_sigkill_is_a_502_at_ten_seconds(self):
        outcome, kills, checks = self.run_wait(lambda at, kills: True)
        self.assertIsInstance(outcome, host_module.Refused)
        self.assertEqual(len(kills), 1, "SIGKILL once, not on every poll")
        self.assertGreaterEqual(checks[-1], 10.0)
        self.assertLess(checks[-1], 10.2)


if __name__ == "__main__":
    unittest.main()
