"""Pipe/WebSocket integration with a fake Chromium fd protocol (no Docker)."""
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


@unittest.skipIf(websockets is None, "requires websockets 10.x (image installs python3-websockets)")
class PrivatePipeGate(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="juno-cdp-test-")
        self.token_file = Path(self.directory.name) / "token"
        self.token_file.write_text("test-private-token")
        harness = r'''
import asyncio, importlib.util, os, sys
spec = importlib.util.spec_from_file_location("gate", sys.argv[1])
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
gate.TOKEN_FILE = sys.argv[2]
# macOS has no prctl. This protocol test does not claim UID/container isolation.
gate.no_dump = lambda: None
actual_exec = os.execv
fake_chromium = """
import json, os
pending = b''
while True:
    pending += os.read(3, 65536)
    while b'\\0' in pending:
        data, pending = pending.split(b'\\0', 1)
        request = json.loads(data)
        if request.get('method') == 'Browser.close':
            raise SystemExit(0)
        os.write(4, json.dumps({'id': request['id'], 'result': {'echo': request['method']}}).encode() + b'\\0')
"""
def fake_exec(executable, args):
    actual_exec(sys.executable, [sys.executable, '-c', fake_chromium])
gate.os.execv = fake_exec
asyncio.run(gate.main())
'''
        self.process = subprocess.Popen([sys.executable, "-c", harness, str(ROOT / "deploy/agent-computers/cdp-gate.py"), str(self.token_file)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
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


if __name__ == "__main__":
    unittest.main()
