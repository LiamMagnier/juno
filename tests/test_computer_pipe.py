"""Pipe/WebSocket integration with a fake Chromium fd protocol (no Docker).

Also the gate's record of Chromium's own sandbox (pipe-v4): the state file says
"on" only when Chromium was started without --no-sandbox and answered its
first pipe command; "off:kernel" when this uid may not create a user
namespace; "off:chromium" when a sandboxed Chromium never answered and was
started again with --no-sandbox.
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest

try:
    import websockets
    from websockets.exceptions import InvalidStatusCode
except ImportError:
    websockets = None

ROOT = Path(__file__).resolve().parents[1]
# The computer-e2e CI job runs this with websockets 10.4 in a venv and sets this, so
# a missing library fails the job instead of skipping every test as green. Elsewhere
# (scripts/local-gates.sh on a machine without websockets) the tests skip, and say so.
REQUIRED = os.environ.get("JUNO_COMPUTER_PIPE_REQUIRED") == "1"


def setUpModule():
    if REQUIRED and websockets is None:
        raise AssertionError("JUNO_COMPUTER_PIPE_REQUIRED=1 and this python has no websockets (10.x, as the image installs)")


@unittest.skipIf(websockets is None, "requires websockets 10.x (image installs python3-websockets)")
class PrivatePipeGate(unittest.IsolatedAsyncioTestCase):
    # "probe": ask this host as the gate does; "yes"/"no": what the probe answers.
    namespaces = "probe"
    # "answers", or "sandboxed-hangs" (a sandboxed launch never answers its first command).
    chromium = "answers"

    def launched_args(self):
        return [json.loads(line) for line in self.launches.read_text().splitlines()]

    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="juno-cdp-test-")
        self.token_file = Path(self.directory.name) / "token"
        self.token_file.write_text("test-private-token")
        self.state_file = Path(self.directory.name) / "browser-sandbox"
        self.launches = Path(self.directory.name) / "launches.jsonl"
        harness = r'''
import asyncio, importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("gate", sys.argv[1])
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
gate.TOKEN_FILE = sys.argv[2]
gate.SANDBOX_STATE_FILE = sys.argv[3]
gate.FIRST_ANSWER_SECONDS = 2
# macOS has no prctl. This protocol test does not claim UID/container isolation.
gate.no_dump = lambda: None
if sys.argv[5] in ("yes", "no"):
    gate.user_namespaces_allowed = lambda: sys.argv[5] == "yes"
actual_exec = os.execv
fake_chromium = """
import json, os, sys
silent = sys.argv[1] == 'silent'
pending = b''
while True:
    pending += os.read(3, 65536)
    while b'\\0' in pending:
        data, pending = pending.split(b'\\0', 1)
        request = json.loads(data)
        if request.get('method') == 'Browser.close':
            raise SystemExit(0)
        if silent:
            continue
        os.write(4, json.dumps({'id': request['id'], 'result': {'echo': request['method']}}).encode() + b'\\0')
"""
def fake_exec(executable, args):
    with open(sys.argv[4], "a") as launches:
        launches.write(json.dumps(args) + "\n")
    # sys.argv[6] == "sandboxed-hangs": a Chromium whose sandbox cannot start (it never answers).
    silent = sys.argv[6] == "sandboxed-hangs" and "--no-sandbox" not in args
    actual_exec(sys.executable, [sys.executable, '-c', fake_chromium, 'silent' if silent else 'answers'])
gate.os.execv = fake_exec
asyncio.run(gate.main())
'''
        self.process = subprocess.Popen([sys.executable, "-c", harness, str(ROOT / "deploy/agent-computers/cdp-gate.py"), str(self.token_file),
                                         str(self.state_file), str(self.launches), self.namespaces, self.chromium],
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for _ in range(100):
            if not self.token_file.exists():
                try:
                    _reader, writer = await asyncio.open_connection("127.0.0.1", 9222)
                    writer.close()
                    await writer.wait_closed()
                    return
                except OSError:
                    pass
            if self.process.poll() is not None:
                _, errors = self.process.communicate()
                self.fail(errors.decode())
            await asyncio.sleep(0.05)
        self.fail("gate did not load its bearer")

    async def asyncTearDown(self):
        self.process.terminate()
        try:
            _, errors = self.process.communicate(timeout=5)
            if self.process.returncode not in (0, -signal.SIGTERM):
                print(errors.decode(), file=sys.stderr)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.communicate()
        self.directory.cleanup()

    async def test_requires_exactly_one_matching_token_then_forwards_pipe_messages(self):
        for headers in ([], [("X-Juno-Cdp-Token", "wrong")], [("X-Juno-Cdp-Token", "test-private-token"), ("X-Juno-Cdp-Token", "test-private-token")]):
            with self.assertRaises(InvalidStatusCode) as rejected:
                async with websockets.connect("ws://127.0.0.1:9222/devtools/browser", extra_headers=headers):
                    self.fail("unauthenticated connection reached the browser")
            self.assertEqual(rejected.exception.status_code, 403)
        async with websockets.connect("ws://127.0.0.1:9222/devtools/browser", extra_headers={"X-Juno-Cdp-Token": "test-private-token"}) as connection:
            await connection.send(json.dumps({"id": 7, "method": "Browser.getVersion"}))
            result = json.loads(await asyncio.wait_for(connection.recv(), timeout=3))
            self.assertEqual(result, {"id": 7, "result": {"echo": "Browser.getVersion"}})

    async def test_the_sandbox_state_says_how_chromium_was_started(self):
        state = self.state_file.read_text().strip()
        launches = self.launched_args()
        self.assertIn(state, ("on", "off:kernel"))
        self.assertEqual(len(launches), 1)
        self.assertEqual(state == "on", "--no-sandbox" not in launches[0], (state, launches))


class SandboxedGate(PrivatePipeGate):
    namespaces = "yes"

    async def test_the_sandbox_state_says_how_chromium_was_started(self):
        self.assertEqual(self.state_file.read_text().strip(), "on")
        self.assertNotIn("--no-sandbox", self.launched_args()[0])


class KernelRefusesNamespaces(PrivatePipeGate):
    namespaces = "no"

    async def test_the_sandbox_state_says_how_chromium_was_started(self):
        self.assertEqual(self.state_file.read_text().strip(), "off:kernel")
        self.assertEqual(len(self.launched_args()), 1)
        self.assertIn("--no-sandbox", self.launched_args()[0], "exactly the pipe-v3 launch")


class SandboxedChromiumThatNeverAnswers(PrivatePipeGate):
    namespaces = "yes"
    chromium = "sandboxed-hangs"

    async def test_the_sandbox_state_says_how_chromium_was_started(self):
        self.assertEqual(self.state_file.read_text().strip(), "off:chromium")
        launches = self.launched_args()
        self.assertEqual([("--no-sandbox" in args) for args in launches], [False, True],
                         "tried with the sandbox, then fell back to the pipe-v3 launch")


if __name__ == "__main__":
    unittest.main()
