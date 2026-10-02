"""The execution host: broker policy, service API, workspace safety.

Run with:  python3 -m unittest discover -s tests -p 'test_exec_host.py'

No Docker needed for the default suite: the service is driven through its real
HTTP handler, and `docker run` is played by a fake that first passes every argv
through the REAL broker's validation (so the service can only build argv the
broker accepts) and then runs the program with the local interpreter in the
session directories, the way the bind mounts would present them.

With JUNO_EXEC_DOCKER_TESTS=1 and Docker running, the last class runs real
containers from the juno-exec:dev image through the real broker (developer
mode) and checks the boundary itself: no network, read-only root, non-root
user, the pids limit, the memory limit.
"""
import importlib.util
import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "deploy/exec-host" / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


broker = module("exec_broker", "juno-exec-docker-broker.py")
service_module = module("juno_exec", "juno-exec.py")

TOKEN = "t" * 48
SESSION = "s_" + "a" * 32
ACCOUNT = "a_" + "b" * 32


def policy_for(sessions_root, image="sha256:" + "c" * 64):
    return {"image": image, "sessionsRoot": sessions_root, "runUser": "1000:1000", "memoryMb": 1536, "cpus": "1",
            "pidsLimit": 256, "tmpfsSize": "256m", "runtime": None, "maxSkillMounts": 8}


# ── a fake Docker that only accepts what the real broker accepts ────────────

class FakeDocker:
    """Plays `docker run/kill/ps/rm` locally after the real broker validated the argv."""

    def __init__(self, policy):
        self.policy = policy
        self.running = {}
        self.validated = []
        self.lock = threading.Lock()

    def call(self, argv):
        broker.validate(argv, self.policy)  # raises on anything the broker would refuse
        self.validated.append(list(argv))
        return argv


class FakeBrokerCall:
    docker = None

    def __init__(self, transport, argv):
        self.argv = argv
        self.exit_code = None
        self.refused = None
        self.process = None
        try:
            FakeBrokerCall.docker.call(argv)
        except (ValueError, IndexError, KeyError) as error:
            self.refused = "exec broker refused request: " + str(error)
            return
        if argv[0] == "run":
            self._start()

    def _mounts(self):
        mounts = {}
        for index, value in enumerate(self.argv):
            if value == "--mount":
                fields = dict(part.split("=", 1) for part in self.argv[index + 1].split(",") if "=" in part)
                mounts[fields["target"]] = fields["source"]
        return mounts

    def _start(self):
        mounts = self._mounts()
        name = self.argv[self.argv.index("--name") + 1]
        image_index = self.argv.index(FakeBrokerCall.docker.policy["image"])
        command = self.argv[image_index + 1:]
        work = mounts["/work"]
        # Present the read-only inputs mount the way Docker would.
        target = os.path.join(work, "inputs")
        if os.path.isdir(target):
            for entry in os.listdir(mounts["/work/inputs"]):
                shutil.copy(os.path.join(mounts["/work/inputs"], entry), os.path.join(target, entry))
        if command[1].startswith("/juno/program/"):
            program = os.path.join(mounts["/juno/program"], os.path.basename(command[1]))
        else:
            program = None
            command = [sys.executable, "-c", "import json; print(json.dumps({'runtimes': {'python': '3.12'}, 'pythonPackages': [{'name': 'pandas', 'version': '2.2.3'}]}))"]
        interpreter = {"python3": sys.executable, "node": shutil.which("node") or "node", "bash": "/bin/bash"}.get(command[0], command[0])
        argv = [interpreter, program] if program else command
        self.process = subprocess.Popen(argv, cwd=work, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={"PATH": "/usr/bin:/bin", "HOME": work})
        with FakeBrokerCall.docker.lock:
            FakeBrokerCall.docker.running[name] = self.process

    def frames(self):
        if self.refused or not self.process:
            if not self.refused:
                self.exit_code = 0
            return
        import selectors
        selector = selectors.DefaultSelector()
        selector.register(self.process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(self.process.stderr, selectors.EVENT_READ, "stderr")
        open_streams = 2
        while open_streams:
            for key, _ in selector.select():
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    open_streams -= 1
                    continue
                yield key.data, chunk
        code = self.process.wait()
        self.exit_code = 137 if code < 0 else code


def fake_broker_run(transport, argv):
    call = FakeBrokerCall(transport, argv)
    if call.refused:
        return None, "", call.refused
    if argv[0] == "kill":
        process = FakeBrokerCall.docker.running.get(argv[1])
        if process and process.poll() is None:
            process.send_signal(signal.SIGKILL)
        return 0, "", None
    if argv[0] == "ps":
        lines = [name + "\t" + SESSION + "\trunning" for name, process in FakeBrokerCall.docker.running.items() if process.poll() is None]
        return 0, "\n".join(lines), None
    return 0, "", None


class ServiceHarness:
    def __init__(self, test):
        self.directory = tempfile.mkdtemp(prefix="juno-exec-test-")
        self.data = os.path.realpath(self.directory)
        self.policy = policy_for(os.path.join(self.data, "sessions"))
        FakeBrokerCall.docker = FakeDocker(self.policy)
        test.addCleanup(self.close)
        self.patches = [unittest.mock.patch.object(service_module, "BrokerCall", FakeBrokerCall),
                        unittest.mock.patch.object(service_module, "broker_run", fake_broker_run)]
        for patch in self.patches:
            patch.start()
        self.start()

    def start(self):
        config = {"token": TOKEN, "policy": self.policy, "dataRoot": self.data, "broker": {"mode": "fake"}, "host": "127.0.0.1", "port": 0}
        self.service = service_module.Service(config)
        self.server = service_module.ThreadingHTTPServer(("127.0.0.1", 0), service_module.make_handler(self.service, TOKEN))
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def close(self):
        for process in FakeBrokerCall.docker.running.values():
            if process.poll() is None:
                process.kill()
        self.stop()
        for patch in self.patches:
            patch.stop()
        shutil.rmtree(self.directory, ignore_errors=True)

    def request(self, method, path, body=None, headers=None, token=TOKEN, raw=False):
        data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, method=method)
        if token is not None:
            request.add_header("Authorization", "Bearer " + token)
        if data is not None and not isinstance(body, bytes):
            request.add_header("Content-Type", "application/json")
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = response.read()
                return response.status, (payload if raw else json.loads(payload or b"null")), dict(response.headers)
        except urllib.error.HTTPError as error:
            payload = error.read()
            try:
                parsed = json.loads(payload)
            except ValueError:
                parsed = payload
            return error.code, parsed, dict(error.headers)

    def run(self, code, language="python", key=None, timeout_ms=30000, session=SESSION, account=ACCOUNT, wait=True):
        status, body, _ = self.request("POST", "/v1/runs", {"session": session, "account": account, "language": language,
                                                            "code": code, "timeoutMs": timeout_ms},
                                       headers={"Idempotency-Key": key or "k-" + os.urandom(6).hex()})
        assert status in (200, 201), (status, body)
        if wait:
            return self.wait(body["id"])
        return body

    def wait(self, run_id, seconds=25):
        deadline = time.time() + 60
        while True:
            status, body, _ = self.request("GET", "/v1/runs/%s?wait=%d" % (run_id, seconds))
            assert status == 200, body
            if body["status"] in service_module.TERMINAL or time.time() > deadline:
                return body


# ── broker policy ──────────────────────────────────────────────────────────

class BrokerPolicy(unittest.TestCase):
    def setUp(self):
        self.directory = os.path.realpath(tempfile.mkdtemp(prefix="exec-broker-"))
        self.addCleanup(shutil.rmtree, self.directory, True)
        self.policy = policy_for(os.path.join(self.directory, "sessions"))
        root = os.path.join(self.directory, "sessions", SESSION)
        self.run_id = "r_" + "1" * 24
        for sub in ("work", "inputs", "programs/" + self.run_id, "programs/r_" + "2" * 24, "skills/report"):
            os.makedirs(os.path.join(root, sub))
        self.root = root

    def argv(self, **overrides):
        flags = [
            ("--rm", None), ("--init", None), ("--read-only", None), ("--name", "juno-exec-" + self.run_id),
            ("--label", "app=juno-exec"), ("--label", "juno.session=" + SESSION), ("--label", "juno.run=" + self.run_id),
            ("--network", "none"), ("--cap-drop", "ALL"), ("--security-opt", "no-new-privileges"), ("--user", "1000:1000"),
            ("--pids-limit", "256"), ("--memory", "1536m"), ("--memory-swap", "1536m"), ("--cpus", "1"),
            ("--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777"), ("--workdir", "/work"), ("--stop-timeout", "1"),
            ("--mount", "type=bind,source=%s/work,target=/work" % self.root),
            ("--mount", "type=bind,source=%s/inputs,target=/work/inputs,readonly" % self.root),
            ("--mount", "type=bind,source=%s/programs/%s,target=/juno/program,readonly" % (self.root, self.run_id)),
        ]
        replace = overrides.pop("replace", {})
        drop = overrides.pop("drop", set())
        extra = overrides.pop("extra", [])
        result = ["run"]
        for key, value in flags:
            if key in drop:
                continue
            if key in replace:
                value = replace[key]
            result += [key] if value is None else [key, value]
        result += extra
        return result + [overrides.get("image", self.policy["image"])] + overrides.get("command", ["python3", "/juno/program/main.py"])

    def test_the_exact_sandbox_profile_is_accepted(self):
        self.assertIsNone(broker.validate(self.argv(), self.policy))
        for command in (["node", "/juno/program/main.js"], ["bash", "/juno/program/main.sh"]):
            self.assertIsNone(broker.validate(self.argv(command=command), self.policy))
        skill = self.argv(extra=["--mount", "type=bind,source=%s/skills/report,target=/skills/report,readonly" % self.root])
        self.assertIsNone(broker.validate(skill, self.policy))

    def test_the_service_builds_argv_the_broker_accepts(self):
        config = {"token": TOKEN, "policy": self.policy, "dataRoot": self.directory, "broker": {"mode": "fake"}}
        with unittest.mock.patch.object(service_module, "broker_run", lambda *a: (0, "", None)):
            service = service_module.Service(config)
        run = service_module.Run({"id": self.run_id, "session": SESSION, "skills": ["report"], "language": "python"})
        argv = service.run_argv(run, ["python3", "/juno/program/main.py"])
        self.assertIsNone(broker.validate(argv, self.policy))

    def test_other_images_networks_mounts_capabilities_users_and_limits_are_refused(self):
        cases = {
            "another image": self.argv(image="python:3.12"),
            "host network": self.argv(replace={"--network": "host"}),
            "bridge network": self.argv(replace={"--network": "bridge"}),
            "no network flag": self.argv(drop={"--network"}),
            "root user": self.argv(replace={"--user": "0:0"}),
            "another user": self.argv(replace={"--user": "1001:1001"}),
            "more memory": self.argv(replace={"--memory": "8192m", "--memory-swap": "8192m"}),
            "unbounded swap": self.argv(replace={"--memory-swap": "-1"}),
            "more cpus": self.argv(replace={"--cpus": "4"}),
            "more pids": self.argv(replace={"--pids-limit": "100000"}),
            "bigger tmpfs": self.argv(replace={"--tmpfs": "/tmp:rw,size=8g"}),
            "writable root": self.argv(drop={"--read-only"}),
            "capabilities kept": self.argv(drop={"--cap-drop"}),
            "privilege escalation": self.argv(drop={"--security-opt"}),
            "privileged": self.argv(extra=["--privileged"]),
            "added capability": self.argv(extra=["--cap-add", "SYS_ADMIN"]),
            "device": self.argv(extra=["--device", "/dev/kvm"]),
            "environment": self.argv(extra=["-e", "LD_PRELOAD=/tmp/x.so"]),
            "host root mount": self.argv(extra=["--mount", "type=bind,source=/,target=/host"]),
            "docker socket": self.argv(extra=["--mount", "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock"]),
            "writable inputs": self.argv(replace={"--mount": "type=bind,source=%s/inputs,target=/work/inputs" % self.root}),
            "volume mount": self.argv(extra=["--mount", "type=volume,source=x,target=/data"]),
            "another run's program": self.argv(replace={"--mount": None}, extra=[]),
            "runtime not in policy": self.argv(extra=["--runtime", "runc"]),
            "unapproved command": self.argv(command=["python3", "-c", "print(1)"]),
            "shell command": self.argv(command=["sh", "-c", "id"]),
            "wrong labels": self.argv(replace={"--label": "app=other"}),
            "wrong name": self.argv(replace={"--name": "production"}),
            "pid host": self.argv(extra=["--pid", "host"]),
            "ipc host": self.argv(extra=["--ipc", "host"]),
            "security unconfined": self.argv(extra=["--security-opt", "seccomp=unconfined"]),
        }
        other = list(self.argv())
        other[other.index("type=bind,source=%s/programs/%s,target=/juno/program,readonly" % (self.root, self.run_id))] = \
            "type=bind,source=%s/programs/r_%s,target=/juno/program,readonly" % (self.root, "2" * 24)
        cases["another run's program"] = other
        for name, argv in cases.items():
            with self.subTest(name), self.assertRaises((ValueError, IndexError)):
                broker.validate(argv, self.policy)

    def test_a_symlinked_mount_source_is_refused(self):
        real = os.path.join(self.directory, "elsewhere")
        os.makedirs(real)
        work = os.path.join(self.root, "work")
        shutil.rmtree(work)
        os.symlink(real, work)
        with self.assertRaises(ValueError):
            broker.validate(self.argv(), self.policy)

    def test_only_the_fixed_short_operations_are_permitted(self):
        name = "juno-exec-" + self.run_id
        self.assertEqual(broker.validate(["kill", name], self.policy), name)
        self.assertEqual(broker.validate(["rm", "-f", name], self.policy), name)
        self.assertIsNone(broker.validate(list(broker.PS_ARGV), self.policy))
        self.assertIsNone(broker.validate(["image", "inspect", "--format", '{{index .Config.Labels "juno.security"}}', self.policy["image"]], self.policy))
        for argv in (["kill", "production"], ["kill", "-s", "HUP", name], ["rm", name], ["ps", "-a"], ["exec", name, "sh"],
                     ["pull", "python"], ["build", "."], ["volume", "ls"], ["inspect", name], ["start", name],
                     ["image", "inspect", "python:3.12"], ["run"], [], "run", [1, 2]):
            with self.subTest(argv=argv), self.assertRaises((ValueError, IndexError, TypeError)):
                broker.validate(argv, self.policy)

    def test_the_policy_itself_is_checked(self):
        path = os.path.join(self.directory, "policy.json")
        for bad in ({**self.policy, "runUser": "0:0"}, {**self.policy, "sessionsRoot": "relative"}, {k: v for k, v in self.policy.items() if k != "image"}):
            with open(path, "w") as file:
                json.dump(bad, file)
            with unittest.mock.patch.dict(os.environ, {"JUNO_EXEC_BROKER_POLICY": path}), self.assertRaises(ValueError):
                broker.load_policy()

    def test_the_framed_protocol_relays_both_streams_and_the_exit_code(self):
        fake = os.path.join(self.directory, "docker")
        with open(fake, "w") as file:
            file.write("#!/bin/sh\necho out-$1; echo err-$1 >&2; exit 3\n")
        os.chmod(fake, 0o755)
        policy_path = os.path.join(self.directory, "policy.json")
        with open(policy_path, "w") as file:
            json.dump(self.policy, file)
        env = {"PATH": "/usr/bin:/bin", "JUNO_EXEC_DOCKER": fake, "JUNO_EXEC_BROKER_POLICY": policy_path}
        result = subprocess.run([sys.executable, str(ROOT / "deploy/exec-host/juno-exec-docker-broker.py")],
                                input=(json.dumps({"argv": list(broker.PS_ARGV)}) + "\n").encode(), capture_output=True, env=env)
        frames = parse_frames(result.stdout)
        self.assertIn((b"o", b"out-ps\n"), frames)
        self.assertIn((b"e", b"err-ps\n"), frames)
        self.assertEqual(frames[-1], (b"x", b"3"))
        refused = subprocess.run([sys.executable, str(ROOT / "deploy/exec-host/juno-exec-docker-broker.py")],
                                 input=(json.dumps({"argv": ["exec", "x", "sh"]}) + "\n").encode(), capture_output=True, env=env)
        frames = parse_frames(refused.stdout)
        self.assertEqual(frames[0][0], b"r")
        self.assertEqual(refused.returncode, 1)


def parse_frames(data):
    frames = []
    while len(data) >= 5:
        kind, length = data[:1], int.from_bytes(data[1:5], "big")
        frames.append((kind, data[5:5 + length]))
        data = data[5 + length:]
    return frames


# ── service API ─────────────────────────────────────────────────────────────

class ServiceApi(unittest.TestCase):
    def setUp(self):
        self.host = ServiceHarness(self)

    def test_requests_without_the_token_are_refused(self):
        for token in (None, "", "wrong", TOKEN[:-1], TOKEN + "x"):
            with self.subTest(token=token):
                status, body, _ = self.host.request("GET", "/v1/health", token=token)
                self.assertEqual(status, 401)
                self.assertEqual(body["error"], "unauthorized")
        status, body, _ = self.host.request("GET", "/v1/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["egress"], "none")
        status, body, _ = self.host.request("POST", "/v1/runs", {"session": SESSION}, token="wrong", headers={"Idempotency-Key": "x"})
        self.assertEqual(status, 401)

    def test_the_pre_v1_execute_endpoint_is_gone(self):
        status, body, _ = self.host.request("POST", "/execute", {"code": "print(1)"})
        self.assertEqual(status, 410)

    def test_an_idempotency_key_replays_its_run_and_refuses_a_different_body(self):
        first = self.host.run("print('once')", key="chat:gen:call_1")
        self.assertEqual(first["status"], "succeeded")
        status, again, _ = self.host.request("POST", "/v1/runs", {"session": SESSION, "account": ACCOUNT, "language": "python",
                                                                   "code": "print('once')", "timeoutMs": 30000},
                                             headers={"Idempotency-Key": "chat:gen:call_1"})
        self.assertEqual(status, 200)
        self.assertTrue(again["replayed"])
        self.assertEqual(again["id"], first["id"])
        self.assertEqual(self.host.service.started_runs, 1)
        status, refused, _ = self.host.request("POST", "/v1/runs", {"session": SESSION, "account": ACCOUNT, "language": "python",
                                                                     "code": "print('twice')", "timeoutMs": 30000},
                                               headers={"Idempotency-Key": "chat:gen:call_1"})
        self.assertEqual(status, 409)
        self.assertEqual(refused["error"], "idempotency_key_reused")
        self.assertEqual(self.host.service.started_runs, 1)
        status, missing, _ = self.host.request("POST", "/v1/runs", {"session": SESSION, "account": ACCOUNT, "code": "print(1)"})
        self.assertEqual(status, 400)
        self.assertEqual(missing["error"], "idempotency_key_required")

    def test_run_requests_are_validated(self):
        for body, code in (({"session": "bad", "account": ACCOUNT, "code": "x"}, "bad_session"),
                           ({"session": SESSION, "account": "user@example.com", "code": "x"}, "bad_account"),
                           ({"session": SESSION, "account": ACCOUNT, "code": "x", "language": "ruby"}, "bad_language"),
                           ({"session": SESSION, "account": ACCOUNT, "code": "  "}, "no_code"),
                           ({"session": SESSION, "account": ACCOUNT, "code": "x", "timeoutMs": 10 ** 9}, "bad_timeout"),
                           ({"session": SESSION, "account": ACCOUNT, "code": "x", "network": "host"}, "unknown_field"),
                           ({"session": SESSION, "account": ACCOUNT, "code": "x", "skills": ["../etc"]}, "bad_skills")):
            with self.subTest(code=code):
                status, refused, _ = self.host.request("POST", "/v1/runs", body, headers={"Idempotency-Key": os.urandom(4).hex()})
                self.assertEqual((status, refused["error"]), (400, code))

    def test_input_names_and_sizes_are_checked(self):
        for name in ("..", ".hidden", "a%2Fb", "%2E%2E%2Fescape", "x" * 201):
            with self.subTest(name=name):
                status, _, _ = self.host.request("PUT", "/v1/sessions/%s/inputs/%s" % (SESSION, name), b"data")
                self.assertIn(status, (400, 404))
        status, body, _ = self.host.request("PUT", "/v1/sessions/%s/inputs/sales.csv" % SESSION, b"region,revenue\nNorth,1\n")
        self.assertEqual(status, 201)
        self.assertEqual(body["bytes"], 23)
        with unittest.mock.patch.dict(service_module.LIMITS, {"maxInputBytes": 10}):
            status, body, _ = self.host.request("PUT", "/v1/sessions/%s/inputs/big.bin" % SESSION, b"x" * 11)
            self.assertEqual((status, body["error"]), (413, "input_too_large"))

    def test_inputs_are_readable_and_new_files_are_collected_but_links_never_followed(self):
        self.host.request("PUT", "/v1/sessions/%s/inputs/sales.csv" % SESSION, b"region,revenue\nNorth,120\nSouth,80\n")
        run = self.host.run("\n".join([
            "import os",
            "rows = open('inputs/sales.csv').read().splitlines()[1:]",
            "print(sum(int(r.split(',')[1]) for r in rows))",
            "os.makedirs('out', exist_ok=True)",
            "open('out/summary.txt', 'w').write('200')",
            "os.symlink('/etc/passwd', 'passwd-link')",
            "os.symlink('/etc', 'etc-link')",
        ]))
        self.assertEqual(run["status"], "succeeded", run)
        self.assertEqual(run["stdout"]["head"].strip(), "200")
        self.assertEqual([entry["path"] for entry in run["files"]], ["out/summary.txt"], "links are not files")
        status, data, headers = self.host.request("GET", "/v1/runs/%s/files/out/summary.txt" % run["id"], raw=True)
        self.assertEqual((status, data), (200, b"200"))
        for path in ("passwd-link", "etc-link/passwd", "../../../etc/passwd", "inputs/sales.csv"):
            with self.subTest(path=path):
                status, _, _ = self.host.request("GET", "/v1/runs/%s/files/%s" % (run["id"], path), raw=True)
                self.assertIn(status, (400, 404))
        # A later program swaps the produced file for a link: the download refuses it.
        work = os.path.join(self.host.policy["sessionsRoot"], SESSION, "work")
        os.unlink(os.path.join(work, "out/summary.txt"))
        os.symlink("/etc/passwd", os.path.join(work, "out/summary.txt"))
        status, _, _ = self.host.request("GET", "/v1/runs/%s/files/out/summary.txt" % run["id"], raw=True)
        self.assertNotEqual(status, 200)

    def test_both_streams_and_the_exit_code_are_reported(self):
        run = self.host.run("echo out; echo err >&2; exit 3", language="bash")
        self.assertEqual((run["status"], run["exitCode"]), ("failed", 3))
        self.assertEqual(run["stdout"]["head"], "out\n")
        self.assertEqual(run["stderr"]["head"], "err\n")
        self.assertEqual(run["context"], "hosted_sandbox")
        self.assertEqual(run["network"], "none")

    def test_events_stream_the_output_and_end_with_the_status(self):
        run = self.host.run("import time\nfor i in range(3):\n    print('line', i, flush=True)\n    time.sleep(0.2)\nraise SystemExit(2)\n")
        status, data, headers = self.host.request("GET", "/v1/runs/%s/events?after=0" % run["id"], raw=True)
        self.assertEqual(status, 200)
        self.assertIn("text/event-stream", headers["Content-Type"])
        text = data.decode()
        self.assertIn("event: chunk", text)
        self.assertIn("line 2", text)
        self.assertIn('event: end\ndata: {"status": "failed", "exitCode": 2}', text)
        status, data, _ = self.host.request("GET", "/v1/runs/%s/events?after=999" % run["id"], raw=True)
        self.assertNotIn("event: chunk", data.decode(), "resuming after the last seq sends only the end")

    def test_long_output_has_a_head_a_tail_and_full_paging(self):
        run = self.host.run("import sys\nfor i in range(100000):\n    print('line %06d ' % i + 'x' * 40)\n")
        self.assertEqual(run["status"], "succeeded")
        self.assertGreater(run["stdoutBytes"], 4_900_000)
        self.assertTrue(run["stdout"]["head"].startswith("line 000000"))
        self.assertIn("line 099999", run["stdout"]["tail"])
        self.assertLessEqual(len(run["stdout"]["head"]) + len(run["stdout"]["tail"]), 2 * 8192 + 8)
        status, page, headers = self.host.request("GET", "/v1/runs/%s/output?stream=stdout&offset=2500000&limit=1000" % run["id"], raw=True)
        self.assertEqual(status, 200)
        self.assertEqual(len(page), 1000)
        self.assertEqual(int(headers["X-Total-Bytes"]), run["stdoutBytes"])

    def test_cancel_kills_the_program_and_reports_cancelled(self):
        run = self.host.run("import time\nfor i in range(60):\n    print(i, flush=True)\n    time.sleep(1)\n", wait=False)
        time.sleep(1.5)
        status, body, _ = self.host.request("POST", "/v1/runs/%s/cancel" % run["id"])
        self.assertEqual(status, 202)
        final = self.host.wait(run["id"])
        self.assertEqual(final["status"], "cancelled")
        self.assertEqual(final["files"], [], "nothing is collected from a cancelled run")

    def test_a_run_past_its_time_limit_is_timed_out(self):
        run = self.host.run("import time\ntime.sleep(30)\n", timeout_ms=1500)
        self.assertEqual(run["status"], "timed_out")

    def test_a_restart_marks_runs_in_flight_as_lost(self):
        run = self.host.run("import time\ntime.sleep(30)\n", wait=False)
        time.sleep(1)
        self.host.stop()
        record_path = os.path.join(self.host.data, "runs", run["id"], "run.json")
        with open(record_path) as file:
            record = json.load(file)
        self.assertEqual(record["status"], "running")
        self.host.start()
        status, body, _ = self.host.request("GET", "/v1/runs/%s" % run["id"])
        self.assertEqual(body["status"], "lost")
        self.assertIn("outcome is unknown", body["error"])

    def test_at_most_twenty_files_are_kept(self):
        run = self.host.run("for i in range(25):\n    open('f%02d.txt' % i, 'w').write(str(i))\n")
        self.assertEqual(len(run["files"]), 20)
        self.assertEqual(len(run["skippedFiles"]), 5)
        self.assertTrue(all(entry["reason"] == "more than 20 files" for entry in run["skippedFiles"]))

    def test_a_session_runs_two_programs_per_account_at_once(self):
        runs = [self.host.run("import time\ntime.sleep(2)\n", wait=False) for _ in range(3)]
        time.sleep(0.8)
        states = [self.host.request("GET", "/v1/runs/%s" % run["id"])[1]["status"] for run in runs]
        self.assertEqual(states.count("running"), 2, states)
        self.assertEqual(states.count("queued"), 1, states)
        for run in runs:
            self.assertEqual(self.host.wait(run["id"])["status"], "succeeded")

    def test_skill_bundles_are_checked_and_mounted_read_only(self):
        def bundle(entries):
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode="w") as archive:
                for name, kind, content in entries:
                    info = tarfile.TarInfo(name)
                    if kind == "file":
                        info.size = len(content)
                        archive.addfile(info, io.BytesIO(content))
                    elif kind == "symlink":
                        info.type, info.linkname = tarfile.SYMTYPE, content
                        archive.addfile(info)
                    elif kind == "hardlink":
                        info.type, info.linkname = tarfile.LNKTYPE, content
                        archive.addfile(info)
            return data.getvalue()
        for name, entries in (("symlink", [("evil", "symlink", "/etc/passwd")]),
                              ("hardlink", [("evil", "hardlink", "/etc/passwd")]),
                              ("dotdot", [("../escape.py", "file", b"x")]),
                              ("absolute", [("/etc/cron.d/x", "file", b"x")])):
            with self.subTest(name):
                status, body, _ = self.host.request("PUT", "/v1/sessions/%s/skills/report" % SESSION, bundle(entries))
                self.assertEqual(status, 400, body)
        with unittest.mock.patch.dict(service_module.LIMITS, {"maxSkillFiles": 3}):
            status, body, _ = self.host.request("PUT", "/v1/sessions/%s/skills/report" % SESSION,
                                                bundle([("f%d" % i, "file", b"x") for i in range(4)]))
            self.assertEqual(status, 413)
        good = bundle([("SKILL.md", "file", b"# Report"), ("scripts/build.py", "file", b"print('built')")])
        status, body, _ = self.host.request("PUT", "/v1/sessions/%s/skills/report" % SESSION, good, headers={"X-Bundle-Digest": "0" * 64})
        self.assertEqual((status, body["error"]), (400, "digest_mismatch"))
        status, body, _ = self.host.request("PUT", "/v1/sessions/%s/skills/report" % SESSION, good)
        self.assertEqual(status, 201)
        mounted = os.path.join(self.host.policy["sessionsRoot"], SESSION, "skills", "report", "scripts", "build.py")
        self.assertEqual(oct(os.stat(mounted).st_mode & 0o777), "0o444")
        status, again, _ = self.host.request("PUT", "/v1/sessions/%s/skills/report" % SESSION, good)
        self.assertTrue(again["reused"])
        status, refused, _ = self.host.request("POST", "/v1/runs", {"session": SESSION, "account": ACCOUNT, "code": "print(1)", "skills": ["other"]},
                                               headers={"Idempotency-Key": "skills-1"})
        self.assertEqual((status, refused["error"]), (409, "skill_not_mounted"))

    def test_deleting_a_session_removes_its_workspace(self):
        self.host.run("open('x.txt','w').write('1')")
        status, _, _ = self.host.request("DELETE", "/v1/sessions/%s" % SESSION)
        self.assertEqual(status, 200)
        self.assertFalse(os.path.exists(os.path.join(self.host.policy["sessionsRoot"], SESSION)))

    def test_the_manifest_comes_from_a_sandboxed_run(self):
        status, body, _ = self.host.request("GET", "/v1/manifest")
        self.assertEqual(status, 200)
        self.assertIn("runtimes", body)
        self.assertIn("limits", body)
        self.assertEqual(self.host.service.started_runs, 0, "the manifest run is not a user run")


# ── real containers (opt-in) ────────────────────────────────────────────────

@unittest.skipUnless(os.environ.get("JUNO_EXEC_DOCKER_TESTS") == "1" and shutil.which("docker"), "set JUNO_EXEC_DOCKER_TESTS=1 with Docker running")
class RealSandboxBoundary(unittest.TestCase):
    """The real image through the real broker (developer mode): the boundary itself."""

    def setUp(self):
        image = subprocess.run(["docker", "image", "inspect", "juno-exec:dev", "--format", "{{.Id}}"], capture_output=True, text=True)
        if image.returncode != 0:
            self.skipTest("build deploy/exec-host/image as juno-exec:dev first")
        self.directory = tempfile.mkdtemp(prefix="juno-exec-real-", dir=os.path.expanduser("~"))
        self.addCleanup(shutil.rmtree, self.directory, True)
        data = os.path.realpath(self.directory)
        policy = policy_for(os.path.join(data, "sessions"), image=image.stdout.strip())
        policy_path = os.path.join(data, "policy.json")
        with open(policy_path, "w") as file:
            json.dump(policy, file)
        env = dict(os.environ, JUNO_EXEC_BROKER_POLICY=policy_path, JUNO_EXEC_DOCKER=shutil.which("docker"))
        config = {"token": TOKEN, "policy": policy, "dataRoot": data,
                  "broker": {"mode": "process", "argv": [sys.executable, str(ROOT / "deploy/exec-host/juno-exec-docker-broker.py")], "env": env}}
        self.service = service_module.Service(config)
        self.server = service_module.ThreadingHTTPServer(("127.0.0.1", 0), service_module.make_handler(self.service, TOKEN))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.shutdown)
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def run_code(self, code, language="python", timeout_ms=60000):
        request = urllib.request.Request(self.base + "/v1/runs", method="POST", data=json.dumps({
            "session": SESSION, "account": ACCOUNT, "language": language, "code": code, "timeoutMs": timeout_ms}).encode())
        request.add_header("Authorization", "Bearer " + TOKEN)
        request.add_header("Idempotency-Key", os.urandom(8).hex())
        with urllib.request.urlopen(request, timeout=30) as response:
            run = json.loads(response.read())
        while True:
            request = urllib.request.Request(self.base + "/v1/runs/%s?wait=25" % run["id"])
            request.add_header("Authorization", "Bearer " + TOKEN)
            with urllib.request.urlopen(request, timeout=60) as response:
                run = json.loads(response.read())
            if run["status"] in service_module.TERMINAL:
                return run

    def test_no_network_read_only_root_non_root_user(self):
        run = self.run_code("\n".join([
            "import os, socket, json",
            "result = {'uid': os.getuid()}",
            "try:",
            "    socket.create_connection(('1.1.1.1', 53), timeout=3); result['net'] = 'open'",
            "except OSError as error:",
            "    result['net'] = type(error).__name__",
            "try:",
            "    socket.getaddrinfo('example.com', 443); result['dns'] = 'resolved'",
            "except OSError as error:",
            "    result['dns'] = type(error).__name__",
            "try:",
            "    open('/usr/escape', 'w'); result['root'] = 'writable'",
            "except OSError as error:",
            "    result['root'] = type(error).__name__",
            "print(json.dumps(result))",
        ]))
        self.assertEqual(run["status"], "succeeded", run)
        result = json.loads(run["stdout"]["head"])
        self.assertNotEqual(result["uid"], 0)
        self.assertNotEqual(result["net"], "open")
        self.assertNotEqual(result["dns"], "resolved")
        self.assertNotEqual(result["root"], "writable")

    def test_pids_and_memory_are_bounded(self):
        forks = self.run_code("for i in $(seq 1 400); do sleep 5 & done; wait; echo done", language="bash", timeout_ms=30000)
        self.assertIn("fork", (forks["stderr"]["head"] + forks["stderr"]["tail"]).lower())
        memory = self.run_code("x = bytearray(3 * 1024 * 1024 * 1024)\nprint('allocated')")
        self.assertNotEqual(memory["status"], "succeeded")


import unittest.mock  # noqa: E402  (patch helpers used above)

if __name__ == "__main__":
    unittest.main()
