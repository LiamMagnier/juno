"""The computer host service (deploy/computer-host/juno-computer-host.py), without Docker.

The host runs as it does in development (local/run-local.sh): a real process on
loopback, its broker a child in developer mode with the REAL argv policy
(deploy/agent-computers/docker-broker.py, host mode). Only `docker` itself is a
stand-in: a small script that keeps containers and volumes in a JSON file and
answers the handful of commands the host sends, so namespaces, tickets, tunnels,
errors and logs can be checked on any machine. A stub CDP gate and a stub VNC
server listen on 127.77.0.5, the address the stand-in reports for a computer.

Needs `websockets` 10.4 to 14.x (the host imports websockets.legacy). Debian's
python3-websockets is 10.4; here run it from a venv:

    python3 -m venv /tmp/ws && /tmp/ws/bin/pip install websockets==10.4
    /tmp/ws/bin/python -m unittest discover -s tests -p 'test_computer_host.py'
"""
import asyncio
import hashlib
import hmac
import http.client
from http import HTTPStatus
import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
HOST_PY = ROOT / "deploy/computer-host/juno-computer-host.py"
PATHS_FIXTURE = ROOT / "tests/fixtures/computer-paths.json"
COMPUTER_IP = "127.77.0.5"

try:
    import websockets  # noqa: F401
    import websockets.legacy.client as ws_client
    import websockets.legacy.server as ws_server
    HAVE_WEBSOCKETS = True
except ImportError:  # pragma: no cover - the module is skipped
    HAVE_WEBSOCKETS = False


def load_host_module():
    spec = importlib.util.spec_from_file_location("juno_computer_host", HOST_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# A stand-in `docker`: the commands the host sends, against a JSON state file.
FAKE_DOCKER = r'''#!/usr/bin/env python3
import json, os, posixpath, sys
STATE = os.environ.get("FAKE_DOCKER_STATE") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "state.json")
DOWN = os.path.join(os.path.dirname(STATE), "down")
args = sys.argv[1:]
with open(os.path.join(os.path.dirname(STATE), "calls.jsonl"), "a") as log:
    log.write(json.dumps(args) + "\n")
if os.path.exists(DOWN):
    print("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?", file=sys.stderr)
    sys.exit(1)
state = json.load(open(STATE)) if os.path.exists(STATE) else {"containers": {}, "volumes": {}}
def save():
    with open(STATE + ".part", "w") as f:
        json.dump(state, f)
    os.replace(STATE + ".part", STATE)
def labels_of(flags):
    return dict(value.split("=", 1) for value in flags)
def missing(name):
    print("Error response from daemon: No such container: " + name, file=sys.stderr)
    sys.exit(1)
op = args[0]
if op == "image":
    fmt = args[3]
    if fmt.startswith("{{.Id}}\t"):
        print("sha256:fakeimage\tpipe-v4\t2026-10-01T00:00:00Z")
    elif fmt == "{{.Id}}":
        print("sha256:fakeimage")
    else:
        print("pipe-v4")
elif op == "volume" and args[1] == "inspect":
    volume = state["volumes"].get(args[-1])
    if volume is None:
        print("Error response from daemon: get %s: no such volume" % args[-1], file=sys.stderr)
        sys.exit(1)
    print("%s\t%s" % (volume.get("app", ""), volume.get("juno.ns", "")))
elif op == "volume" and args[1] == "create":
    flags = [args[i + 1] for i in range(2, len(args) - 1) if args[i] == "--label"]
    state["volumes"].setdefault(args[-1], labels_of(flags))
    save()
    print(args[-1])
elif op == "volume" and args[1] == "rm":
    state["volumes"].pop(args[-1], None)
    save()
elif op == "volume" and args[1] == "ls":
    ns = [f.split("=", 2)[2] for f in args if f.startswith("label=juno.ns=")]
    for name, labels in sorted(state["volumes"].items()):
        if not ns or labels.get("juno.ns") == ns[0]:
            print(name)
elif op == "create":
    flags = [args[i + 1] for i in range(1, len(args) - 1) if args[i] == "--label"]
    name = args[args.index("--name") + 1]
    if name in state["containers"]:
        print("Conflict. The container name is already in use", file=sys.stderr)
        sys.exit(1)
    state["containers"][name] = {"labels": labels_of(flags), "state": "created"}
    save()
    print("0123456789ab")
elif op == "inspect" and args[1] == "--type":
    container = state["containers"].get(args[-1])
    if container is None:
        missing(args[-1])
    labels = container["labels"]
    out = labels.get("app", "")
    if "juno.ns" in args[4]:
        out += "\t" + labels.get("juno.ns", "")
    print(out)
elif op == "inspect":
    container = state["containers"].get(args[-1])
    if container is None:
        missing(args[-1])
    if args[2] == "{{.State.Status}}":
        print(container["state"])
    elif args[2] == "{{.Image}}":
        print("sha256:fakeimage")
    else:
        print(os.environ.get("FAKE_COMPUTER_IP", "127.77.0.5"))
elif op in ("start", "stop", "pause", "unpause"):
    container = state["containers"].get(args[1])
    if container is None:
        missing(args[1])
    container["state"] = {"start": "running", "stop": "exited", "pause": "paused", "unpause": "running"}[op]
    save()
elif op == "rm":
    if args[-1] not in state["containers"]:
        missing(args[-1])
    state["containers"].pop(args[-1])
    save()
elif op == "ps":
    if args[1] == "-q":
        for name, c in sorted(state["containers"].items()):
            if c["state"] == "running":
                print(name[-12:])
    else:
        ns = [f.split("=", 2)[2] for f in args if f.startswith("label=juno.ns=")]
        for name, c in sorted(state["containers"].items()):
            labels = c["labels"]
            if not ns or labels.get("juno.ns") == ns[0]:
                print("\t".join([name, labels.get("juno.agent", ""), labels.get("juno.user", ""), c["state"]]))
elif op == "exec":
    command = args[args.index("--") + 1:] if "--" in args else args
    if "realpath" in command:
        print(posixpath.normpath(command[-1]))
    elif "test" in command:
        sys.exit(1)
    elif "-i" in args[:2]:
        data = sys.stdin.buffer.read()
        with open(os.path.join(os.path.dirname(STATE), "stdin.bin"), "ab") as f:
            f.write(data)
    elif "stat" in command:
        print("12:regular file")
    elif "find" in command:
        print("f\t12\t1700000000.5\t/home/agent/work/notes.txt")
    elif "head" in command:
        sys.stdout.write("file-bytes")
    elif "unshare" in command:
        print("unshare: unshare failed: Operation not permitted", file=sys.stderr)
        sys.exit(1)
    elif "bash" in command:
        print("ran")
else:
    print("fake docker: unsupported " + " ".join(args), file=sys.stderr)
    sys.exit(2)
'''


def write_json(path, value):
    with open(path, "w") as file:
        json.dump(value, file)


def read_json(path):
    with open(path) as file:
        return json.load(file)


def token_entry(token, token_id, namespace):
    return {"id": token_id, "sha256": hashlib.sha256(token.encode()).hexdigest(), "namespace": namespace}


TOKEN_A = "a" * 64
TOKEN_A2 = "b" * 64
TOKEN_B = "c" * 64


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class HostProcess:
    """One host service, on free loopback ports, with a stand-in docker."""

    def __init__(self, ttl=60):
        self.dir = tempfile.mkdtemp(prefix="juno-host-test-")
        self.docker = os.path.join(self.dir, "docker")
        with open(self.docker, "w") as file:
            file.write(FAKE_DOCKER)
        os.chmod(self.docker, 0o755)
        self.tokens = os.path.join(self.dir, "tokens.json")
        self.write_tokens([token_entry(TOKEN_A, "a-1", "alpha"), token_entry(TOKEN_A2, "a-2", "alpha"),
                           token_entry(TOKEN_B, "b-1", "beta")])
        self.policy = os.path.join(self.dir, "broker-policy.json")
        write_json(self.policy, {"image": "juno-computer:1", "network": "juno-computers", "maxMemoryMb": 2048, "maxCpus": 2})
        self.api, self.tunnel = free_port(), free_port()
        config = {"apiPort": self.api, "tunnelPort": self.tunnel, "tokensFile": self.tokens, "brokerPolicy": self.policy,
                  "subnet": "127.77.0.0/24", "gateway": "127.77.0.1", "minFreeMemMb": 0, "minFreeDiskMb": 0,
                  "maxRunning": 6, "dockerRoot": "/", "ticketTtlSeconds": ttl,
                  "developerBroker": {"policy": self.policy, "docker": self.docker, "egressMap": "none"}}
        self.config = os.path.join(self.dir, "config.json")
        write_json(self.config, config)
        self.log_path = os.path.join(self.dir, "host.log")
        self.log = open(self.log_path, "w")
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "FAKE_DOCKER_STATE": os.path.join(self.dir, "state.json")}
        self.proc = subprocess.Popen([sys.executable, str(HOST_PY), "--config", self.config], stderr=self.log,
                                     stdout=subprocess.DEVNULL, env=env)
        deadline = time.monotonic() + 15
        while True:
            try:
                socket.create_connection(("127.0.0.1", self.api), timeout=0.5).close()
                socket.create_connection(("127.0.0.1", self.tunnel), timeout=0.5).close()
                break
            except OSError:
                if time.monotonic() > deadline or self.proc.poll() is not None:
                    raise AssertionError("the host did not start: " + self.host_log()[-2000:])
                time.sleep(0.1)

    def write_tokens(self, entries):
        with open(self.tokens + ".part", "w") as f:
            json.dump(entries, f)
        os.replace(self.tokens + ".part", self.tokens)

    def request(self, method, path, token=TOKEN_A, body=None, headers=None, raw=False):
        connection = http.client.HTTPConnection("127.0.0.1", self.api, timeout=30)
        all_headers = dict(headers or {})
        if token is not None:
            all_headers["Authorization"] = "Bearer " + token
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
            all_headers.setdefault("Content-Type", "application/json")
        if method in ("POST", "PUT", "DELETE") and body is None:
            body = b""
        connection.request(method, path, body=body, headers=all_headers)
        response = connection.getresponse()
        data = response.read()
        connection.close()
        if raw:
            return response.status, data
        try:
            return response.status, json.loads(data.decode() or "null")
        except ValueError:
            return response.status, data

    def create(self, agent, token=TOKEN_A):
        return self.request("POST", "/v1/computers", token, {"agentId": agent, "userRef": "u_" + "0" * 32})

    def calls(self):
        try:
            with open(os.path.join(self.dir, "calls.jsonl")) as file:
                return [json.loads(line) for line in file]
        except FileNotFoundError:
            return []

    def host_log(self):
        self.log.flush()
        with open(self.log_path) as file:
            return file.read()

    def close(self):
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.log.close()
        subprocess.run(["rm", "-rf", self.dir])


class StubServers:
    """A CDP gate on 127.77.0.5:9222 that echoes, and an RFB server on :5900."""

    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.headers = []
        ready = threading.Event()
        self.thread = threading.Thread(target=self._run, args=(ready,), daemon=True)
        self.thread.start()
        if not ready.wait(10):
            raise AssertionError("stub servers did not start")

    def _run(self, ready):
        asyncio.set_event_loop(self.loop)

        async def process_request(path, headers):
            self.headers.append((path, list(headers.raw_items())))
            if headers.get("X-Juno-Cdp-Token") != "gate-token":
                return HTTPStatus.FORBIDDEN, [], b""  # what cdp-gate.py answers
            return None

        async def echo(websocket, path=None):
            async for message in websocket:
                await websocket.send(message)

        async def rfb(reader, writer):
            writer.write(b"RFB 003.008\n")
            await writer.drain()
            data = await reader.read(100)
            writer.write(b"echo:" + data)
            await writer.drain()
            writer.close()

        async def start():
            self.gate = await ws_server.serve(echo, COMPUTER_IP, 9222, process_request=process_request,
                                              max_size=64 * 1024 * 1024)
            self.vnc = await asyncio.start_server(rfb, COMPUTER_IP, 5900)

        self.loop.run_until_complete(start())
        ready.set()
        self.loop.run_forever()

    def close(self):
        async def stop():
            self.gate.close()
            await self.gate.wait_closed()
            self.vnc.close()
            await self.vnc.wait_closed()
        asyncio.run_coroutine_threadsafe(stop(), self.loop).result(10)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(10)


def run(coro):
    return asyncio.run(coro)


@unittest.skipUnless(HAVE_WEBSOCKETS, "needs websockets 10.4 to 14.x (python3-websockets, or a venv)")
class ComputerHostApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.host = HostProcess()

    @classmethod
    def tearDownClass(cls):
        cls.host.close()

    def test_a_missing_wrong_or_malformed_token_is_refused(self):
        for token in (None, "d" * 64, "short", "A" * 64 + "!", "a" * 63):
            with self.subTest(token=token):
                status, body = self.host.request("GET", "/v1/available", token=token)
                self.assertEqual(status, 401)
                self.assertEqual(body, {"error": "unauthorized"})
        status, _ = self.host.request("GET", "/v1/available", headers={"Authorization": "Basic " + TOKEN_A}, token=None)
        self.assertEqual(status, 401)

    def test_two_tokens_of_a_namespace_are_accepted(self):
        for token in (TOKEN_A, TOKEN_A2):
            status, body = self.host.request("GET", "/v1/available", token=token)
            self.assertEqual((status, body), (200, {"ok": True}))

    def test_a_token_sees_only_its_namespace(self):
        self.assertEqual(self.host.create("nsone")[0], 200)
        # The other namespace cannot see, read, start, ticket or destroy it.
        status, owned = self.host.request("GET", "/v1/owned", token=TOKEN_B)
        self.assertEqual(status, 200)
        self.assertEqual(owned, {"containers": [], "volumes": []})
        status, owned = self.host.request("GET", "/v1/owned")
        self.assertIn("juno-agent-nsone", [c["name"] for c in owned["containers"]])
        self.assertEqual(sorted(owned["volumes"]), ["juno-agent-nsone", "juno-agent-nsone-browser"])
        for method, path, body in (("GET", "/v1/computers/juno-agent-nsone/state", None),
                                   ("POST", "/v1/computers/juno-agent-nsone/start", None),
                                   ("POST", "/v1/computers/juno-agent-nsone/tickets", {"port": 5900}),
                                   ("DELETE", "/v1/computers/juno-agent-nsone?volumes=1", None)):
            with self.subTest(path=path):
                status, answer = self.host.request(method, path, token=TOKEN_B, body=body)
                self.assertEqual((status, answer), (409, {"error": "name_conflict"}))
        # Still there for its own namespace.
        self.assertEqual(self.host.request("GET", "/v1/computers/juno-agent-nsone/state")[1], {"state": "exited"})
        # Creating the same agent from the other namespace never mounts these volumes.
        status, answer = self.host.create("nsone", token=TOKEN_B)
        self.assertEqual((status, answer), (409, {"error": "name_conflict"}))

    def test_the_create_argv_carries_the_namespace_and_never_a_user_id(self):
        self.host.create("labels")
        create = [call for call in self.host.calls() if call[0] == "create" and "juno-agent-labels" in call][-1]
        labels = [create[i + 1] for i, value in enumerate(create) if value == "--label"]
        self.assertEqual(labels, ["app=juno", "juno.agent=labels", "juno.user=u_" + "0" * 32, "juno.ns=alpha"])
        status, answer = self.host.request("POST", "/v1/computers", body={"agentId": "x", "userRef": "cmuser123"})
        self.assertEqual((status, answer), (400, {"error": "bad_user_ref"}))

    def test_names_outside_juno_agent_are_refused(self):
        for name in ("juno-exec-r_1", "other", "juno-agent-", "juno-agent-a%2Fb", "juno-agent-" + "x" * 121):
            with self.subTest(name=name):
                status, answer = self.host.request("GET", "/v1/computers/%s/state" % name)
                self.assertIn(status, (400, 404))
        status, answer = self.host.request("POST", "/v1/computers", body={"agentId": "../x", "userRef": "u_" + "0" * 32})
        self.assertEqual((status, answer), (400, {"error": "bad_agent"}))

    def test_a_missing_container_is_404_and_a_daemon_error_502(self):
        status, answer = self.host.request("GET", "/v1/computers/juno-agent-nobody/state")
        self.assertEqual((status, answer), (404, {"error": "no_such_container"}))
        down = os.path.join(self.host.dir, "down")
        open(down, "w").close()
        try:
            status, answer = self.host.request("GET", "/v1/computers/juno-agent-nobody/state")
            self.assertEqual((status, answer), (502, {"error": "host_error"}))
            status, answer = self.host.request("GET", "/v1/available")
            self.assertEqual((status, answer), (200, {"ok": False, "reason": "image_missing"}))
        finally:
            os.remove(down)

    def test_tickets_only_for_9222_or_5900(self):
        self.host.create("ports")
        for port in (22, 8750, 9223, 5901, "5900", True, None):
            with self.subTest(port=port):
                status, answer = self.host.request("POST", "/v1/computers/juno-agent-ports/tickets", body={"port": port})
                self.assertEqual((status, answer), (400, {"error": "bad_port"}))
        status, answer = self.host.request("POST", "/v1/computers/juno-agent-ports/tickets", body={"port": 5900})
        self.assertEqual(status, 200)
        self.assertRegex(answer["ticket"], r"^[A-Za-z0-9_-]{43}$")

    def test_write_paths_follow_the_agent_work_area_rule(self):
        self.host.create("files")
        fixture = read_json(PATHS_FIXTURE)
        for case in fixture["writes"]:
            with self.subTest(path=case["path"]):
                status, answer = self.host.request("PUT", "/v1/computers/juno-agent-files/files/content?path="
                                                   + urllib.parse.quote(case["path"], safe="/"),
                                                   body=b"hello", headers={"Content-Type": "application/octet-stream"})
                if case["allowed"]:
                    self.assertEqual((status, answer), (200, {"ok": True}))
                else:
                    self.assertEqual(status, 422, answer)
        status, answer = self.host.request("PUT", "/v1/computers/juno-agent-files/files/content?path=/home/agent/work/a.txt&by=root",
                                           body=b"x")
        self.assertEqual((status, answer), (400, {"error": "bad_by"}))

    def test_the_resolved_path_rules_match_the_shared_fixture(self):
        host = load_host_module()
        for case in read_json(PATHS_FIXTURE)["resolved"]:
            with self.subTest(path=case["path"]):
                self.assertEqual(host.is_safe_agent_path(case["path"]), case["safe"])
                self.assertEqual(host.is_agent_work_area_path(case["path"]), case["workArea"])

    def test_exec_cwd_is_resolved_and_refused_outside_the_home(self):
        self.host.create("execs")
        status, answer = self.host.request("POST", "/v1/computers/juno-agent-execs/exec", body={"command": "pwd", "cwd": "/etc"})
        self.assertEqual((status, answer), (422, {"error": "path_refused"}))
        status, answer = self.host.request("POST", "/v1/computers/juno-agent-execs/exec",
                                           body={"command": "pwd", "cwd": "project", "timeoutSeconds": 999})
        self.assertEqual(status, 200)
        exec_call = [call for call in self.host.calls() if "bash" in call][-1]
        self.assertEqual(exec_call[exec_call.index("--workdir") + 1], "/home/agent/work/project")
        self.assertEqual(exec_call[exec_call.index("timeout") + 3], "300", "the command limit is capped at 300 s")
        self.assertEqual(exec_call[-1], "pwd", "the command is the last argv element, never part of a shell line")

    def test_logs_carry_no_request_line_path_query_command_content_token_or_password(self):
        self.host.create("logs")
        secret_path = "/home/agent/work/secret-path-zq9.txt"
        self.host.request("GET", "/v1/computers/juno-agent-logs/files/content?path=" + secret_path)
        self.host.request("PUT", "/v1/computers/juno-agent-logs/files/content?path=" + secret_path, body=b"content-zq9")
        self.host.request("POST", "/v1/computers/juno-agent-logs/exec", body={"command": "echo command-zq9"})
        self.host.request("PUT", "/v1/computers/juno-agent-logs/vnc", body={"controlPassword": "Pzq9abcd", "viewPassword": "Vzq9abcd"})
        self.host.request("PUT", "/v1/computers/juno-agent-logs/cdp-token", body=b"cdp-zq9-token")
        status, ticket = self.host.request("POST", "/v1/computers/juno-agent-logs/tickets", body={"port": 5900})
        self.host.request("GET", "/v1/computers/juno-agent-logs/state?query-zq9=1")
        self.host.request("GET", "/v1/nowhere-zq9")
        log = self.host.host_log()
        for leaked in ("zq9", TOKEN_A, ticket["ticket"], "GET /", "HTTP/1.1", "secret-path", "echo"):
            self.assertNotIn(leaked, log)
        self.assertIn("op=exec computer=juno-agent-logs token=a-1 status=200", log)


@unittest.skipUnless(HAVE_WEBSOCKETS, "needs websockets 10.4 to 14.x (python3-websockets, or a venv)")
class ComputerHostTunnels(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stubs = StubServers()
        cls.host = HostProcess()
        for agent, token in (("tun", TOKEN_A), ("other", TOKEN_B)):
            cls.host.create(agent, token=token)
            cls.host.request("POST", "/v1/computers/juno-agent-%s/start" % agent, token=token)

    @classmethod
    def tearDownClass(cls):
        cls.host.close()
        cls.stubs.close()

    def ticket(self, port, name="juno-agent-tun", token=TOKEN_A):
        status, answer = self.host.request("POST", "/v1/computers/%s/tickets" % name, token=token, body={"port": port})
        self.assertEqual(status, 200, answer)
        return answer["ticket"]

    def connect(self, ticket, cdp="gate-token", port=None, subprotocols=None):
        headers = [("X-Juno-Tunnel-Ticket", ticket)]
        if cdp:
            headers.append(("X-Juno-Cdp-Token", cdp))
        return ws_client.connect("ws://127.0.0.1:%d/v1/tunnel" % (port or self.host.tunnel), extra_headers=headers,
                                 subprotocols=subprotocols, max_size=64 * 1024 * 1024, open_timeout=10)

    def status_of(self, opener):
        """The HTTP status a tunnel handshake gets; `opener` makes the connection inside the loop."""
        async def attempt():
            try:
                websocket = await opener()
                await websocket.close()
                return 101
            except websockets.exceptions.InvalidStatusCode as error:
                return error.status_code
        return run(attempt())

    def test_a_cdp_message_over_one_mebibyte_crosses_the_tunnel_both_ways(self):
        async def roundtrip():
            websocket = await self.connect(self.ticket(9222))
            payload = json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {"expression": "x" * (3 * 1024 * 1024)}})
            await websocket.send(payload)
            echoed = await asyncio.wait_for(websocket.recv(), 20)
            await websocket.close()
            return payload, echoed
        payload, echoed = run(roundtrip())
        self.assertEqual(len(echoed), len(payload))
        self.assertEqual(echoed, payload)
        path, headers = self.stubs.headers[-1]
        self.assertEqual(path, "/devtools/browser")
        self.assertEqual([value for key, value in headers if key.lower() == "x-juno-cdp-token"], ["gate-token"])
        self.assertFalse(any(key.lower() == "x-juno-tunnel-ticket" for key, _ in headers), "the ticket never reaches the computer")

    def test_the_ticket_is_read_from_the_header_and_no_subprotocol_is_selected(self):
        async def check():
            websocket = await self.connect(self.ticket(5900), cdp=None, subprotocols=["binary"])
            selected = websocket.subprotocol
            banner = await asyncio.wait_for(websocket.recv(), 10)
            await websocket.send(b"RFB 003.008\n")
            reply = await asyncio.wait_for(websocket.recv(), 10)
            await websocket.close()
            return selected, banner, reply
        selected, banner, reply = run(check())
        self.assertIsNone(selected)
        self.assertEqual(banner, b"RFB 003.008\n")
        self.assertEqual(reply, b"echo:RFB 003.008\n")
        # A ticket offered as a subprotocol instead of the header opens nothing.
        ticket = self.ticket(5900)
        self.assertEqual(self.status_of(lambda: ws_client.connect("ws://127.0.0.1:%d/v1/tunnel" % self.host.tunnel,
                                                                  subprotocols=["juno-ticket." + ticket], open_timeout=10)), 401)

    def test_a_ticket_is_single_use_and_bound_to_its_port(self):
        ticket = self.ticket(5900)
        self.assertEqual(self.status_of(lambda: self.connect(ticket, cdp=None)), 101)
        self.assertEqual(self.status_of(lambda: self.connect(ticket, cdp=None)), 401, "a used ticket opens nothing")
        # A 5900 ticket is a VNC tunnel: it never reaches the gate, whatever is asked for.
        before = len(self.stubs.headers)
        self.assertEqual(self.status_of(lambda: self.connect(self.ticket(5900), cdp="gate-token")), 101)
        self.assertEqual(len(self.stubs.headers), before)
        # A CDP tunnel needs exactly one gate token, and a wrong one is the gate's 403.
        self.assertEqual(self.status_of(lambda: self.connect(self.ticket(9222), cdp=None)), 400)
        self.assertEqual(self.status_of(lambda: self.connect(self.ticket(9222), cdp="wrong")), 403)
        for forged in ("", "x" * 43, "!" * 43):
            self.assertEqual(self.status_of(lambda: self.connect(forged, cdp=None)), 401)

    def test_the_api_port_passes_the_tunnel_through(self):
        async def check():
            websocket = await self.connect(self.ticket(5900), cdp=None, port=self.host.api)
            banner = await asyncio.wait_for(websocket.recv(), 10)
            await websocket.close()
            return banner
        self.assertEqual(run(check()), b"RFB 003.008\n")

    def test_tickets_and_tunnels_are_bound_to_the_namespace(self):
        status, answer = self.host.request("POST", "/v1/computers/juno-agent-other/tickets", token=TOKEN_A, body={"port": 5900})
        self.assertEqual((status, answer), (409, {"error": "name_conflict"}))
        # Beta's own ticket opens beta's computer only.
        self.assertEqual(self.status_of(lambda: self.connect(self.ticket(5900, "juno-agent-other", TOKEN_B), cdp=None)), 101)

    def test_an_address_outside_the_subnet_is_refused(self):
        host = load_host_module()
        config = dict(host.DEFAULTS, subnet="127.77.0.0/24", gateway="127.77.0.1")

        class Broker:
            def __init__(self, answer):
                self.answer = answer

            def run(self, argv, namespace, stdin=None, timeout=60):
                return 0, self.answer, b""

        for answer in (b"10.0.0.5\n", b"127.77.0.1\n", b"\n", b"not-an-address\n"):
            with self.subTest(answer=answer):
                with self.assertRaises(host.Refused):
                    host.Host(config, broker=Broker(answer)).address("alpha", "juno-agent-x")
        self.assertEqual(host.Host(config, broker=Broker(b"127.77.0.9\n")).address("alpha", "juno-agent-x"), "127.77.0.9")


@unittest.skipUnless(HAVE_WEBSOCKETS, "needs websockets 10.4 to 14.x (python3-websockets, or a venv)")
class ComputerHostTokensAndTickets(unittest.TestCase):
    def test_every_stored_hash_is_compared(self):
        host = load_host_module()
        tokens = host.Tokens.__new__(host.Tokens)
        tokens.lock = threading.Lock()
        tokens.entries = [token_entry(TOKEN_A, "a-1", "alpha"), token_entry(TOKEN_A2, "a-2", "alpha"),
                          token_entry(TOKEN_B, "b-1", "beta")]
        with mock.patch.object(host.hmac, "compare_digest", wraps=hmac.compare_digest) as compared:
            self.assertEqual(tokens.match("Bearer " + TOKEN_A)["id"], "a-1")
            self.assertEqual(compared.call_count, 3, "no early exit on the first match")
            compared.reset_mock()
            self.assertIsNone(tokens.match("Bearer " + "e" * 64))
            self.assertEqual(compared.call_count, 3)
            compared.reset_mock()
            self.assertIsNone(tokens.match("Bearer short"))
            self.assertEqual(compared.call_count, 0, "a malformed token is refused before hashing")

    def test_the_tokens_file_is_refused_when_malformed(self):
        host = load_host_module()
        good = [token_entry(TOKEN_A, "a-1", "alpha")]
        host.parse_tokens(json.dumps(good))
        for bad in ([], [dict(good[0], extra=1)], [dict(good[0], sha256="xyz")], [dict(good[0], namespace="Bad NS")],
                    good + [dict(good[0])], good + [token_entry(TOKEN_A2, "a-2", "alpha"), token_entry(TOKEN_B, "a-3", "alpha")]):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    host.parse_tokens(json.dumps(bad))

    def test_a_retired_token_is_refused_after_sighup_and_a_new_one_accepted(self):
        process = HostProcess()
        try:
            self.assertEqual(process.request("GET", "/v1/available", token=TOKEN_A2)[0], 200)
            new = "f" * 64
            process.write_tokens([token_entry(TOKEN_A, "a-1", "alpha"), token_entry(new, "a-3", "alpha")])
            process.proc.send_signal(signal.SIGHUP)
            deadline = time.monotonic() + 10
            while process.request("GET", "/v1/available", token=TOKEN_A2)[0] != 401:
                self.assertLess(time.monotonic(), deadline, "the retired token was still accepted")
                time.sleep(0.1)
            self.assertEqual(process.request("GET", "/v1/available", token=new)[0], 200)
            self.assertEqual(process.request("GET", "/v1/available", token=TOKEN_A)[0], 200)
            # A malformed file on reload keeps the tokens in force.
            with open(process.tokens, "w") as f:
                f.write("not json")
            process.proc.send_signal(signal.SIGHUP)
            time.sleep(0.5)
            self.assertEqual(process.request("GET", "/v1/available", token=new)[0], 200)
            self.assertIn("op=reload status=refused", process.host_log())
        finally:
            process.close()

    def test_a_ticket_expires_and_is_bound_to_namespace_container_and_port(self):
        host = load_host_module()
        now = [1000.0]
        with mock.patch.object(host.time, "time", lambda: now[0]):
            tickets = host.Tickets(60, 16)
            ticket, expires = tickets.mint("alpha", "juno-agent-a", 5900, "a-1")
            self.assertEqual(expires, 1060000)
            self.assertEqual(tickets.consume(ticket), {"ns": "alpha", "name": "juno-agent-a", "port": 5900,
                                                      "expires": 1060.0, "token": "a-1"})
            self.assertIsNone(tickets.consume(ticket), "single use")
            late, _ = tickets.mint("alpha", "juno-agent-a", 9222, "a-1")
            now[0] += 61
            self.assertIsNone(tickets.consume(late), "expired after 60 s")
            for _ in range(16):
                tickets.mint("alpha", "juno-agent-a", 5900, "a-1")
            with self.assertRaises(host.Refused):
                tickets.mint("alpha", "juno-agent-a", 5900, "a-1")
            tickets.mint("alpha", "juno-agent-b", 5900, "a-1")  # another computer has its own allowance

    def test_the_print_argv_mode_needs_no_config(self):
        out = subprocess.run([sys.executable, str(HOST_PY), "--print-argv", "thaw", '{"name": "juno-agent-a"}'],
                             capture_output=True, text=True, check=True).stdout
        self.assertEqual(json.loads(out), [["exec", "--user", "1001", "juno-agent-a", "rm", "-f", "/run/juno-state/frozen"],
                                           ["exec", "--user", "1000", "juno-agent-a", "/opt/juno/agent-exec", "thaw"]])


if __name__ == "__main__":
    unittest.main()


class ComputerHostHoldsNoAppSecrets(unittest.TestCase):
    """Decision 5: the host never holds the web VM's secrets. Planted on the web side (the
    environment the host would be started from), they stop the host from starting at all."""

    PLANTED = {"DATABASE_URL": "postgresql://u:canary-db@h/db", "AUTH_SECRET": "canary-auth-secret",
               "OPENAI_API_KEY": "sk-canary", "ANTHROPIC_API_KEY": "canary-anthropic", "DIRECT_URL": "postgresql://canary"}

    def test_the_host_refuses_to_start_with_app_secrets_in_its_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            config = os.path.join(directory, "config.json")
            write_json(config, {"tokensFile": os.path.join(directory, "missing.json")})
            env = dict(os.environ, **self.PLANTED)
            result = subprocess.run([sys.executable, str(HOST_PY), "--config", config], env=env, capture_output=True,
                                    text=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("refusing to start with app secrets", result.stderr)
            for name in self.PLANTED:
                self.assertIn(name, result.stderr)
            for value in self.PLANTED.values():
                self.assertNotIn(value, result.stderr, "the names are said, never the values")

    def test_app_secret_names(self):
        host = load_host_module()
        self.assertEqual(host.app_secrets_in({"PATH": "/usr/bin", "OPENAI_API_KEY": "x", "EMPTY_API_KEY": "", "AUTH_SECRET": "y"}),
                         ["AUTH_SECRET", "OPENAI_API_KEY"])
        self.assertEqual(host.app_secrets_in({"PATH": "/usr/bin", "HOME": "/root", "LANG": "C.UTF-8"}), [])

    def test_run_local_starts_the_host_with_a_clean_environment(self):
        script = (ROOT / "deploy/computer-host/local/run-local.sh").read_text()
        self.assertRegex(script, r'env -i PATH=\S+ HOME="\$HOME" LANG=C\.UTF-8 "\$PYTHON" -I "\$HOST_DIR/juno-computer-host\.py"')
        setup = (ROOT / "deploy/computer-host/setup.sh").read_text()
        # systemd starts the service with its own environment; the unit sets none of the app's.
        unit = setup[setup.index("cat > /etc/systemd/system/juno-computer-host.service"):]
        unit = unit[:unit.index("UNIT\n", 60)]
        for name in ("DATABASE_URL", "AUTH_SECRET", "API_KEY", "EnvironmentFile"):
            self.assertNotIn(name, unit)


class ComputerHostScripts(unittest.TestCase):
    def test_the_scripts_parse(self):
        for script in ("deploy/computer-host/setup.sh", "deploy/computer-host/private-tls.sh",
                       "deploy/computer-host/local/run-local.sh", "deploy/agent-computers/setup-vm.sh"):
            with self.subTest(script=script):
                result = subprocess.run(["bash", "-n", str(ROOT / script)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_the_generated_nftables_accept_the_proxy_and_only_the_web_vm_on_443(self):
        out = subprocess.run(["bash", str(ROOT / "deploy/computer-host/setup.sh"), "--print-nftables", "--web-ip", "10.0.0.4",
                              "--ssh-from", "203.0.113.0/24"], capture_output=True, text=True, check=True).stdout
        self.assertIn("policy drop;", out)
        self.assertIn('iifname "br-juno" ip daddr 172.30.0.1 tcp dport 3128 accept', out)
        self.assertIn("ip saddr 10.0.0.4 tcp dport 443 accept", out)
        self.assertIn("ip saddr 203.0.113.0/24 tcp dport 22 accept", out)
        self.assertNotIn("forward", out, "only the input hook: Docker's own chains are left alone")
        refused = subprocess.run(["bash", str(ROOT / "deploy/computer-host/setup.sh"), "--print-nftables", "--web-ip", "not-an-ip"],
                                 capture_output=True, text=True)
        self.assertNotEqual(refused.returncode, 0)

    def test_the_generated_nginx_config_keeps_paths_out_of_the_logs(self):
        out = subprocess.run(["bash", str(ROOT / "deploy/computer-host/setup.sh"), "--print-nginx", "--domain", "computers.example.test",
                              "--cert", "/c.pem", "--key", "/k.pem"], capture_output=True, text=True, check=True).stdout
        self.assertIn("log_format juno_computer_host '$remote_addr [$time_local] $request_method $status $body_bytes_sent $request_time';", out)
        self.assertNotIn("$request ", out)
        self.assertNotIn("$request_uri", out)
        self.assertNotIn("$uri", out)
        self.assertIn("error_log /var/log/nginx/juno-computer-host.error.log crit;", out)
        self.assertIn("client_max_body_size 30m;", out)
        self.assertRegex(out, r"location = /v1/tunnel \{[^}]*proxy_read_timeout 300s;[^}]*\}")
        self.assertRegex(out, r"location ~ \^/v1/computers/\[\^/\]\+/exec\$ \{[^}]*proxy_buffering off;[^}]*proxy_read_timeout 330s;")
        self.assertNotIn("@", out.replace("$remote_addr", ""), "every placeholder was filled")

    @unittest.skipUnless(os.environ.get("JUNO_COMPUTER_HOST_DOCKER_TESTS") == "1", "set JUNO_COMPUTER_HOST_DOCKER_TESTS=1 (pulls and runs nginx)")
    def test_the_generated_nginx_config_passes_nginx_t_in_the_official_image(self):
        image = os.environ.get("JUNO_COMPUTER_HOST_NGINX_IMAGE", "nginx:1.27-alpine")
        with tempfile.TemporaryDirectory() as directory:
            subprocess.run(["bash", str(ROOT / "deploy/computer-host/private-tls.sh"), "computers.example.test", directory + "/tls"],
                           check=True, capture_output=True)
            conf = subprocess.run(["bash", str(ROOT / "deploy/computer-host/setup.sh"), "--print-nginx", "--domain",
                                   "computers.example.test", "--cert", "/etc/juno-tls/cert.pem", "--key", "/etc/juno-tls/key.pem",
                                   "--access-log", "/var/log/nginx/access.log", "--error-log", "/var/log/nginx/error.log"],
                                  capture_output=True, text=True, check=True).stdout
            write_text = Path(directory, "default.conf")
            write_text.write_text(conf)
            result = subprocess.run(["docker", "run", "--rm", "-v", "%s:/etc/nginx/conf.d/default.conf:ro" % write_text,
                                     "-v", "%s/tls:/etc/juno-tls:ro" % directory, image, "nginx", "-t"],
                                    capture_output=True, text=True, timeout=180)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("test is successful", result.stderr)
