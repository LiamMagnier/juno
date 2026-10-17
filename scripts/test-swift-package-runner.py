"""Behavioral tests for the CI runner, using a disposable fake Swift executable."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

RUNNER = Path(__file__).with_name("run-swift-package-tests.py").resolve()


class SwiftRunnerTests(unittest.TestCase):
    def run_fixture(self, mode):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "native/Packages/Fixture").mkdir(parents=True)
            binary = root / "bin"
            binary.mkdir()
            swift = binary / "swift"
            swift.write_text(f'''#!{sys.executable}
import os, pathlib, sys, time
root = pathlib.Path(os.environ["FIXTURE_ROOT"])
with (root / "calls").open("a") as f:
    f.write(" ".join(sys.argv[1:]) + "\\n")
mode = os.environ["FIXTURE_MODE"]
if sys.argv[1] == "build":
    if mode == "build-failure": sys.exit(7)
    if mode == "build-stall": time.sleep(10)
    if mode == "separate-budgets": time.sleep(.65)
else:
    if mode == "test-failure": sys.exit(9)
    if mode == "separate-budgets": time.sleep(.65)
    if mode == "test-stall" and not (root / "retried").exists():
        (root / "retried").touch()
        time.sleep(10)
''')
            swift.chmod(0o700)
            result = subprocess.run(
                [sys.executable, str(RUNNER), "--package", "Fixture",
                 "--timeout-seconds", "1", "--build-timeout-seconds", "1"],
                cwd=root, env={**os.environ, "PATH": f"{binary}:{os.environ['PATH']}",
                               "RUNNER_TEMP": str(root), "FIXTURE_ROOT": str(root),
                               "FIXTURE_MODE": mode},
                capture_output=True, text=True, timeout=8,
            )
            return result, (root / "calls").read_text().splitlines()

    def test_compilation_does_not_consume_the_test_deadline(self):
        result, calls = self.run_fixture("separate-budgets")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 2)
        self.assertIn("--skip-build", calls[1])

    def test_assertion_failure_is_never_retried(self):
        result, calls = self.run_fixture("test-failure")
        self.assertEqual(result.returncode, 9)
        self.assertEqual(len(calls), 2)

    def test_only_a_stalled_test_is_retried_without_rebuilding(self):
        result, calls = self.run_fixture("test-stall")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[1], calls[2])

    def test_compilation_failure_never_starts_tests(self):
        result, calls = self.run_fixture("build-failure")
        self.assertEqual(result.returncode, 7)
        self.assertEqual(len(calls), 1)

    def test_compilation_timeout_never_starts_tests(self):
        result, calls = self.run_fixture("build-stall")
        self.assertEqual(result.returncode, 124)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
