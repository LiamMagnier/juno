"""A watched command on the computer host streams its output as it runs (COMPUTERS_2026-10.md S5.1).

POST /v1/computers/<name>/exec with `Accept: application/x-ndjson` answers one NDJSON line per piece of
output as the broker relays it, then a last line with the exit status. Checked against the real host
service in developer mode with the same stand-in `docker` as test_computer_host.py, extended with one
command that prints a line, sleeps, and prints the next.

Needs `websockets` 10.4 to 14.x like test_computer_host.py (the host imports it at start):

    python3 -m venv /tmp/ws && /tmp/ws/bin/pip install websockets==10.4
    /tmp/ws/bin/python -m unittest discover -s tests -p 'test_computer_host_stream.py'
"""
import base64
import http.client
import importlib.util
import json
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("juno_test_computer_host", ROOT / "tests/test_computer_host.py")
HOST_TESTS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOST_TESTS)

# One more command for the stand-in docker: N lines, `gap` seconds apart, each flushed; an `err` line on stderr.
LINES_BRANCH = r'''    elif command[-1].startswith("juno-test-lines "):
        import time
        _, count, gap = command[-1].split()
        for index in range(int(count)):
            if index:
                time.sleep(float(gap))
            sys.stdout.write("line %d\n" % (index + 1))
            sys.stdout.flush()
        sys.stderr.buffer.write(b"err \xe2\x82\xac\n")
        sys.stderr.flush()
        sys.exit(3)
    elif "bash" in command:'''
STREAM_DOCKER = HOST_TESTS.FAKE_DOCKER.replace('    elif "bash" in command:', LINES_BRANCH, 1)
assert STREAM_DOCKER != HOST_TESTS.FAKE_DOCKER


def stream_exec(api_port, name, body, token=HOST_TESTS.TOKEN_A):
    """POSTs a watched exec; returns (status, content type, [(arrival seconds, parsed line)])."""
    connection = http.client.HTTPConnection("127.0.0.1", api_port, timeout=60)
    data = json.dumps(body).encode()
    connection.request("POST", "/v1/computers/%s/exec" % name, body=data, headers={
        "Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/x-ndjson"})
    started = time.monotonic()
    response = connection.getresponse()
    lines = []
    if response.getheader("Content-Type") == "application/x-ndjson":
        while True:
            raw = response.readline()
            if not raw:
                break
            lines.append((time.monotonic() - started, json.loads(raw)))
    else:
        lines.append((time.monotonic() - started, json.loads(response.read() or b"null")))
    status, kind = response.status, response.getheader("Content-Type")
    connection.close()
    return status, kind, lines


@unittest.skipUnless(HOST_TESTS.HAVE_WEBSOCKETS, "needs websockets 10.4 to 14.x (python3-websockets, or a venv)")
class ComputerHostStreamedExec(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.saved = HOST_TESTS.FAKE_DOCKER
        HOST_TESTS.FAKE_DOCKER = STREAM_DOCKER
        cls.host = HOST_TESTS.HostProcess()
        cls.host.create("streamer")
        cls.host.request("POST", "/v1/computers/juno-agent-streamer/start")

    @classmethod
    def tearDownClass(cls):
        cls.host.close()
        HOST_TESTS.FAKE_DOCKER = cls.saved

    def test_lines_arrive_one_by_one_while_the_command_runs_then_the_exit(self):
        status, kind, lines = stream_exec(self.host.api, "juno-agent-streamer",
                                          {"command": "juno-test-lines 3 1", "timeoutSeconds": 30})
        self.assertEqual((status, kind), (200, "application/x-ndjson"))
        stdout = [(at, base64.b64decode(line["data_b64"])) for at, line in lines if line.get("stream") == "stdout"]
        self.assertEqual(b"".join(data for _, data in stdout), b"line 1\nline 2\nline 3\n")
        # Each line was sent when it was printed, a second apart, not all at the end.
        first_line_at = next(at for at, data in stdout if b"line 1" in data)
        last_line_at = next(at for at, data in stdout if b"line 3" in data)
        self.assertLess(first_line_at, 1.0, "line 1 arrived before the command slept")
        self.assertGreater(last_line_at - first_line_at, 1.5, "line 3 arrived two seconds later, not with line 1")
        stderr = b"".join(base64.b64decode(line["data_b64"]) for _, line in lines if line.get("stream") == "stderr")
        self.assertEqual(stderr.decode("utf-8"), "err €\n", "bytes as written, UTF-8 intact")
        last = lines[-1][1]
        self.assertEqual(last["exit"], 3)
        self.assertEqual((last["timedOut"], last["stdoutTruncated"], last["stderrTruncated"]), (False, False, False))
        self.assertIsInstance(last["durationMs"], int)
        self.assertGreaterEqual(last["durationMs"], 1500)

    def test_a_refusal_before_the_command_runs_is_an_ordinary_answer(self):
        status, kind, lines = stream_exec(self.host.api, "juno-agent-streamer",
                                          {"command": "pwd", "cwd": "/etc", "timeoutSeconds": 5})
        self.assertEqual((status, kind), (422, "application/json"))
        self.assertEqual(lines[0][1], {"error": "path_refused"})
        status, kind, lines = stream_exec(self.host.api, "juno-agent-nobody", {"command": "pwd"})
        self.assertEqual((status, lines[0][1]), (404, {"error": "no_such_container"}))
        status, _, lines = stream_exec(self.host.api, "juno-agent-streamer", {"command": "pwd"}, token="0" * 64)
        self.assertEqual(status, 401)

    def test_without_the_ndjson_accept_the_answer_is_whole_as_before(self):
        status, body = self.host.request("POST", "/v1/computers/juno-agent-streamer/exec",
                                         body={"command": "juno-test-lines 2 0.2", "timeoutSeconds": 30})
        self.assertEqual(status, 200)
        self.assertEqual(base64.b64decode(body["stdoutBase64"]), b"line 1\nline 2\n")
        self.assertEqual(body["exitCode"], 3)

    def test_the_log_names_the_operation_never_the_output_or_the_command(self):
        stream_exec(self.host.api, "juno-agent-streamer", {"command": "juno-test-lines 1 0", "timeoutSeconds": 10})
        log = self.host.host_log()
        self.assertIn("op=exec computer=juno-agent-streamer", log)
        self.assertNotIn("juno-test-lines", log)
        self.assertNotIn("line 1", log)


if __name__ == "__main__":
    unittest.main()
