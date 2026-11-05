#!/usr/bin/env python3
"""Run the real-container sandbox boundary suites and accept nothing but a full pass.

    python3 scripts/sandbox-boundary-check.py tests.test_exec_host.RealSandboxBoundary
    sudo -E python3 scripts/sandbox-boundary-check.py tests.test_computer_boundary

A boundary suite that silently skips proves nothing and still reads as green:
`python3 -m unittest` exits 0 when every test is skipped, and these suites skip
unless they are opted in and Docker is there. So this runner fails when no test
ran, when any test errored or failed, and when any test was skipped, with one
exception: a test that skips with a reason starting "optional:" (a positive
control that needs public Internet, which a developer sandbox may not have) is
reported but tolerated, unless JUNO_BOUNDARY_REQUIRE_ALL=1, which CI sets so
that every control runs there.

The suites themselves refuse to start without their opt-in variables
(JUNO_EXEC_DOCKER_TESTS=1, JUNO_COMPUTER_DOCKER_TESTS=1); this runner sets
neither, so running it without them fails loudly instead of skipping.
"""
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main(names):
    if not names:
        print("usage: sandbox-boundary-check.py <unittest name> [...]", file=sys.stderr)
        return 2
    sys.path.insert(0, str(ROOT))
    os.chdir(ROOT)
    suite = unittest.defaultTestLoader.loadTestsFromNames(names)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    require_all = os.environ.get("JUNO_BOUNDARY_REQUIRE_ALL") == "1"
    optional = [(test, reason) for test, reason in result.skipped if reason.startswith("optional:")]
    hard = [(test, reason) for test, reason in result.skipped if not reason.startswith("optional:")]
    problems = []
    if result.testsRun == 0:
        problems.append("no test ran")
    if result.errors or result.failures:
        problems.append("%d failed, %d errored" % (len(result.failures), len(result.errors)))
    if hard:
        problems.append("%d skipped: a boundary test that skips proves nothing" % len(hard))
    if optional and require_all:
        problems.append("%d optional controls skipped and JUNO_BOUNDARY_REQUIRE_ALL=1" % len(optional))
    for test, reason in hard + optional:
        print("SKIPPED %s: %s" % (test.id(), reason))
    ran = max(0, result.testsRun - len(result.skipped))
    if problems:
        print("sandbox boundary: FAIL (%s); %d of %d tests ran to completion" % ("; ".join(problems), ran, result.testsRun))
        return 1
    print("sandbox boundary: PASS, %d of %d tests ran%s" % (ran, result.testsRun,
          "" if not optional else ", %d optional controls skipped (see above)" % len(optional)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
