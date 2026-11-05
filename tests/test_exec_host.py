"""The execution host: broker policy, service API, workspace safety.

Run with:  python3 -m unittest discover -s tests -p 'test_exec_host.py'

No Docker needed for the default suite: the service is driven through its real
HTTP handler, and `docker run` is played by a fake that first passes every argv
through the REAL broker's validation (so the service can only build argv the
broker accepts) and then runs the program with the local interpreter in the
session directories, the way the bind mounts would present them.

With JUNO_EXEC_DOCKER_TESTS=1 and Docker running, the last class runs real
containers from the pinned image (juno-exec:dev, or JUNO_EXEC_IMAGE) through
the real broker (developer mode) and the real service, and checks the boundary
itself: no route to metadata, private or public addresses; no host secret in
the program's environment; a read-only root, read-only inputs and program, and
no host path beyond the session's own; a non-root uid with no capabilities;
cancel and the time limit kill the container before a delayed write; the
container Docker created has exactly the pinned profile; pids, memory, CPU and
/tmp are bounded. CI runs it as a required job (deploy.yml `exec-boundary`):

    docker build -t juno-exec:dev deploy/exec-host/image
    JUNO_EXEC_DOCKER_TESTS=1 python3 scripts/sandbox-boundary-check.py tests.test_exec_host.RealSandboxBoundary
"""
import importlib.util
import io
import json
import os
import shutil
import signal
import socket
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
_probe_spec = importlib.util.spec_from_file_location("sandbox_probe", ROOT / "tests" / "sandbox_probe.py")
sandbox_probe = importlib.util.module_from_spec(_probe_spec)
_probe_spec.loader.exec_module(sandbox_probe)

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
        self.kills = []
        self.validated = []
        self.lock = threading.Lock()

    def call(self, argv):
        broker.validate(argv, self.policy)  # raises on anything the broker would refuse
        self.validated.append(list(argv))
        return argv


class FakeBrokerCall:
    docker = None
    # Seconds between `docker run` being called and the container existing, as on a
    # busy host or with gVisor. A kill sent in that window finds no container.
    start_delay = 0.0

    def __init__(self, transport, argv):
        self.argv = argv
        self.exit_code = None
        self.refused = None
        self.process = None
        self.ready = None
        try:
            FakeBrokerCall.docker.call(argv)
        except (ValueError, IndexError, KeyError) as error:
            self.refused = "exec broker refused request: " + str(error)
            return
        if argv[0] == "run":
            if FakeBrokerCall.start_delay:
                self.ready = threading.Event()
                threading.Thread(target=self._delayed_start, daemon=True).start()
            else:
                self._start()

    def _delayed_start(self):
        time.sleep(FakeBrokerCall.start_delay)
        try:
            self._start()
        finally:
            self.ready.set()

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
        if self.ready is not None:
            self.ready.wait()
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
        FakeBrokerCall.docker.kills.append(argv[1])
        process = FakeBrokerCall.docker.running.get(argv[1])
        if not process:
            # The real broker inspects first and refuses a container that does not exist (yet).
            return None, "", "exec broker refused request: Container is missing or outside the juno-exec namespace"
        if process.poll() is None:
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
        FakeBrokerCall.start_delay = 0.0
        for process in FakeBrokerCall.docker.running.values():
            if process.poll() is None:
                process.kill()
        self.stop()
        for patch in self.patches:
            patch.stop()
        # Read-only skill folders and anything a program chmod-ed shut.
        self.service._remove_tree(self.directory)

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
            ("--log-driver", "none"),
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
            # The daemon's json-file copy of the output has no size cap: a program
            # printing for 30 minutes filled the host's root disk.
            "daemon keeps the output": self.argv(drop={"--log-driver"}),
            "json-file log": self.argv(replace={"--log-driver": "json-file"}),
            "log options": self.argv(extra=["--log-opt", "max-size=10g"]),
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
            # CONFIG too: as root (the Mac deploy's build container) the broker
            # reads only its fixed path and ignores the environment, by design.
            with unittest.mock.patch.dict(os.environ, {"JUNO_EXEC_BROKER_POLICY": path}), \
                    unittest.mock.patch.object(broker, "CONFIG", path), self.assertRaises(ValueError):
                broker.load_policy()

    @unittest.skipIf(os.geteuid() == 0, "as root the broker reads only /etc/juno/exec-broker.json; the policy override is refused by design")
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
        for name, entries in (("file and folder", [("x", "file", b"1"), ("x/y", "file", b"2")]),
                              ("symlink", [("evil", "symlink", "/etc/passwd")]),
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

class Hardening(unittest.TestCase):
    """What the adversarial review of the lane broke, each now held by a test."""

    LOOP = "import time\nwhile True:\n    time.sleep(0.1)\n"

    def setUp(self):
        self.host = ServiceHarness(self)

    def alive(self, run_id):
        process = FakeBrokerCall.docker.running.get("juno-exec-" + run_id)
        return process is not None and process.poll() is None

    def until(self, predicate, seconds=10, message="condition"):
        deadline = time.time() + seconds
        while time.time() < deadline:
            if predicate():
                return
            time.sleep(0.05)
        self.fail("timed out waiting for " + message)

    def status_of(self, run_id):
        return self.host.request("GET", "/v1/runs/%s" % run_id)[1]["status"]

    def test_stop_before_the_container_exists_still_kills_it(self):
        # One `docker kill` sent while `docker run` is still creating the container
        # is refused (no such container) and the program ran on after Stop.
        FakeBrokerCall.start_delay = 0.8
        run = self.host.run(self.LOOP, timeout_ms=600000, wait=False)
        self.until(lambda: self.status_of(run["id"]) == "running", message="running")
        status, _, _ = self.host.request("POST", "/v1/runs/%s/cancel" % run["id"])
        self.assertEqual(status, 202)
        self.until(lambda: self.status_of(run["id"]) == "cancelled", seconds=15, message="cancelled")
        self.assertFalse(self.alive(run["id"]), "the container was killed once it existed")
        self.assertGreater(FakeBrokerCall.docker.kills.count("juno-exec-" + run["id"]), 1, "the first kill found nothing and was repeated")

    def test_a_time_limit_reached_before_the_container_exists_still_stops_it(self):
        # Worse than Stop: the time limit was the only bound, so a missed kill left
        # a container running for good, holding one of the host's four slots.
        FakeBrokerCall.start_delay = 1.5
        run = self.host.run(self.LOOP, timeout_ms=1000, wait=False)
        self.until(lambda: self.status_of(run["id"]) == "timed_out", seconds=15, message="timed_out")
        self.assertFalse(self.alive(run["id"]))

    def test_a_workspace_the_program_locked_with_chmod_is_still_removed(self):
        # The sandbox runs as the service's own uid, so a program can chmod its
        # folders to 000; os.walk and rmtree then left them on the shared disk.
        run = self.host.run("import os\nos.makedirs('locked/deeper/still', exist_ok=True)\n"
                            "open('locked/deeper/still/data.bin', 'wb').write(b'x' * 100000)\n"
                            "for path in ('locked/deeper/still', 'locked/deeper', 'locked'):\n    os.chmod(path, 0)\nprint('locked')\n")
        self.assertEqual(run["status"], "succeeded")
        root = os.path.join(self.host.policy["sessionsRoot"], SESSION)
        status, _, _ = self.host.request("DELETE", "/v1/sessions/%s" % SESSION)
        self.assertEqual(status, 200)
        self.assertFalse(os.path.exists(root), "the locked tree is gone")
        # The idle sweep takes the same path.
        other = "s_" + "9" * 32
        self.host.run("import os\nos.makedirs('shut', exist_ok=True)\nopen('shut/f', 'w').write('1')\nos.chmod('shut', 0)\n", session=other)
        time.sleep(0.5)  # the run's last touch of the session marker lands just after it reports done
        os.utime(os.path.join(self.host.policy["sessionsRoot"], other, ".active"), (0, 0))
        for record in self.host.service.runs.values():
            record.finishedAt = 0
        self.host.service.sweep()
        self.assertFalse(os.path.exists(os.path.join(self.host.policy["sessionsRoot"], other)))

    def test_a_skill_bundle_is_refused_before_a_huge_member_is_read(self):
        def bundle(entries, mode="w:gz"):
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode=mode) as archive:
                for name, content in entries:
                    info = tarfile.TarInfo(name)
                    if content is None:
                        info.type = tarfile.DIRTYPE
                        archive.addfile(info)
                    else:
                        info.size = len(content)
                        archive.addfile(info, io.BytesIO(content))
            return data.getvalue()
        huge = bundle([("big.bin", b"\0" * (6 * 1024 * 1024))])
        self.assertLess(len(huge), 64 * 1024, "a small upload")
        status, body, _ = self.host.request("PUT", "/v1/sessions/%s/skills/report" % SESSION, huge)
        self.assertEqual((status, body["error"]), (413, "bundle_too_large"))
        folders = bundle([("d%04d" % index, None) for index in range(service_module.LIMITS["maxSkillEntries"] + 1)])
        status, body, _ = self.host.request("PUT", "/v1/sessions/%s/skills/report" % SESSION, folders)
        self.assertEqual((status, body["error"]), (413, "bundle_too_large"), "folders count too: each is an inode on the shared disk")

    def test_one_account_cannot_fill_the_host_queue(self):
        limit = service_module.LIMITS["perAccountPending"]
        runs = [self.host.run("import time\ntime.sleep(1)\n", wait=False) for _ in range(limit)]
        status, body, _ = self.host.request("POST", "/v1/runs", {"session": SESSION, "account": ACCOUNT, "code": "print(1)"},
                                            headers={"Idempotency-Key": "one-too-many"})
        self.assertEqual((status, body["error"]), (429, "account_busy"))
        other = self.host.run("print('other account')", account="a_" + "c" * 32, session="s_" + "c" * 32)
        self.assertEqual(other["status"], "succeeded")
        for run in runs:
            self.assertEqual(self.host.wait(run["id"])["status"], "succeeded")

    def test_a_session_belongs_to_the_account_that_first_used_it(self):
        self.assertEqual(self.host.run("open('mine.txt', 'w').write('private')")["status"], "succeeded")
        status, body, _ = self.host.request("POST", "/v1/runs", {"session": SESSION, "account": "a_" + "c" * 32, "code": "print(open('mine.txt').read())"},
                                            headers={"Idempotency-Key": "another-account"})
        self.assertEqual((status, body["error"]), (409, "session_account_mismatch"))

    def test_a_program_filling_the_workspace_disk_is_stopped_and_only_its_session_cleared(self):
        culprit_session, bystander_session = "s_" + "1" * 32, "s_" + "2" * 32
        culprit = self.host.run("open('big.bin', 'wb').write(b'x' * 2000000)\n" + self.LOOP, session=culprit_session,
                                account="a_" + "1" * 32, timeout_ms=600000, wait=False)
        bystander = self.host.run("open('small.txt', 'w').write('1')\nimport time\ntime.sleep(3)\nprint('done')\n",
                                  session=bystander_session, account="a_" + "2" * 32, timeout_ms=600000, wait=False)
        big = os.path.join(self.host.policy["sessionsRoot"], culprit_session, "work", "big.bin")
        small = os.path.join(self.host.policy["sessionsRoot"], bystander_session, "work", "small.txt")
        self.until(lambda: os.path.exists(big) and os.path.getsize(big) == 2000000 and os.path.exists(small), message="both writing")
        self.assertIsNone(self.host.service.watch_disk(), "nothing happens while the disk keeps its reserve")
        with unittest.mock.patch.object(self.host.service, "disk_ok", return_value=False):
            self.assertEqual(self.host.service.watch_disk(), culprit_session)
            status, body, _ = self.host.request("POST", "/v1/runs", {"session": "s_" + "3" * 32, "account": "a_" + "3" * 32, "code": "print(1)"},
                                                headers={"Idempotency-Key": "while-full"})
            self.assertEqual((status, body["error"]), (503, "disk_full"))
        final = self.host.wait(culprit["id"], seconds=10)
        self.assertEqual(final["status"], "failed")
        self.assertIn("disk", final["error"])
        self.assertEqual(final["files"], [])
        self.until(lambda: not os.path.exists(big), message="the culprit's files cleared")
        self.assertTrue(os.path.isdir(os.path.join(self.host.policy["sessionsRoot"], culprit_session, "work", "inputs")))
        done = self.host.wait(bystander["id"])
        self.assertEqual(done["status"], "succeeded")
        self.assertTrue(os.path.exists(small), "another session's files are untouched")

    def test_finished_runs_release_their_live_output(self):
        run = self.host.run("print('x' * 100000)")
        service = self.host.service
        self.assertGreater(service.event_bytes_total, 0)
        record = service.runs[run["id"]]
        record.finishedAt -= service_module.LIMITS["eventRetentionSeconds"] + 1
        service.sweep()
        self.assertEqual(service.event_bytes_total, 0)
        self.assertEqual(record.events, [])
        status, page, _ = self.host.request("GET", "/v1/runs/%s/output?stream=stdout&limit=10" % run["id"], raw=True)
        self.assertEqual((status, page), (200, b"x" * 10), "the full log stays readable")

    def test_the_live_output_of_all_runs_together_is_bounded(self):
        with unittest.mock.patch.dict(service_module.LIMITS, {"maxEventBytesTotal": 50000}):
            run = self.host.run("print('y' * 200000)")
            self.assertLessEqual(self.host.service.event_bytes_total, 50000)
        self.assertEqual(run["stdoutBytes"], 200001)
        self.assertEqual(self.host.service.runs[run["id"]].events[-1][1], "notice")

    def test_a_program_printing_without_end_is_stopped(self):
        # Output past the ceiling is discarded anyway; relaying it for the whole time
        # limit kept the broker and the service busy for every other run.
        with unittest.mock.patch.dict(service_module.LIMITS, {"maxOutputBytes": 300000}):
            run = self.host.run("import sys\nwhile True:\n    sys.stdout.write('z' * 4096)\n    sys.stdout.flush()\n",
                                timeout_ms=600000, wait=False)
            final = self.host.wait(run["id"], seconds=20)
        self.assertEqual(final["status"], "failed", final)
        self.assertIn("printed more than", final["error"])
        self.assertGreater(final["stdoutBytes"], 300000)
        self.assertFalse(self.alive(run["id"]), "the program is no longer running")

    def test_a_full_log_disk_refuses_new_runs(self):
        # The run logs live on dataRoot (the host's root filesystem in production),
        # not on the size-capped workspace image.
        service = self.host.service
        original = service._filesystem_ok
        with unittest.mock.patch.object(service, "_filesystem_ok", side_effect=lambda path: path != service.runs_root and original(path)):
            status, body, _ = self.host.request("POST", "/v1/runs", {"session": SESSION, "account": ACCOUNT, "code": "print(1)"},
                                                headers={"Idempotency-Key": "logs-full"})
        self.assertEqual((status, body["error"]), (503, "disk_full"))

    def test_input_names_are_decoded_once(self):
        # "report%20final.csv" is a real file name; a second decode renamed it, and
        # "a%2Fb.csv" became a name with a slash that failed every run.
        for name, encoded in (("report%20final.csv", "report%2520final.csv"), ("a%2Fb.csv", "a%252Fb.csv"), ("100%.csv", "100%25.csv")):
            with self.subTest(name=name):
                status, body, _ = self.host.request("PUT", "/v1/sessions/%s/inputs/%s" % (SESSION, encoded), b"x")
                self.assertEqual((status, body["name"]), (201, name))
                self.assertTrue(os.path.isfile(os.path.join(self.host.policy["sessionsRoot"], SESSION, "inputs", name)))

    def test_file_names_never_reach_the_journal(self):
        self.assertEqual(service_module.redacted_path("/v1/sessions/%s/inputs/payroll%%202026.xlsx" % SESSION),
                         "/v1/sessions/%s/inputs/<name>" % SESSION)
        self.assertEqual(service_module.redacted_path("/v1/runs/r_%s/files/out/diagnosis.png?x=1" % ("1" * 24)),
                         "/v1/runs/r_%s/files/<path>" % ("1" * 24))
        self.assertEqual(service_module.redacted_path("/v1/runs/r_%s?wait=3" % ("1" * 24)), "/v1/runs/r_%s" % ("1" * 24))


# ── the real boundary: the pinned image, the real broker, real containers ──
#
# Opt in with JUNO_EXEC_DOCKER_TESTS=1 (CI: deploy.yml `exec-boundary`, through
# scripts/sandbox-boundary-check.py, which fails on any skip). Once opted in,
# nothing here quietly skips: no Docker, no image or a root uid is an error.
# The program in most tests is tests/sandbox_probe.py, sent through the API as
# model code arrives; it reports raw observations and the asserts live here.

REAL_EXEC_TESTS = os.environ.get("JUNO_EXEC_DOCKER_TESTS") == "1"
REAL_EXEC_IMAGE = os.environ.get("JUNO_EXEC_IMAGE", "juno-exec:dev")
OTHER_SESSION = "s_" + "c" * 32
OTHER_ACCOUNT = "a_" + "d" * 32

# What the host holds and a program must never see. The suite puts these in the
# service's own environment, so they are in the broker's and Docker's too.
HOST_SECRET_NAMES = ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY",
                     "OPENROUTER_API_KEY", "DATABASE_URL", "DIRECT_URL", "REDIS_URL", "AUTH_SECRET", "NEXTAUTH_SECRET",
                     "CODE_INTERPRETER_TOKEN", "JUNO_EXEC_TOKEN", "CLOUD_CODE_SECRET", "MESSAGE_ENCRYPTION_KEY",
                     "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "STRIPE_SECRET_KEY", "PROD_ENV")

# Every variable a program may see: the pinned image's own ENV (the python base
# and deploy/exec-host/image/Dockerfile) plus the HOSTNAME Docker sets. A new
# one has to be added here on purpose; anything else is a leak.
EXEC_PROGRAM_ENV = frozenset({
    "PATH", "HOSTNAME", "HOME", "LANG", "GPG_KEY", "PYTHON_VERSION", "PYTHON_SHA256", "DEBIAN_FRONTEND",
    "PYTHONDONTWRITEBYTECODE", "PYTHONUNBUFFERED", "PIP_NO_CACHE_DIR", "PIP_DISABLE_PIP_VERSION_CHECK",
    "MPLBACKEND", "MPLCONFIGDIR", "XDG_CACHE_HOME",
})

# `--network none`: no interface but loopback, so every one of these must fail
# with ENETUNREACH (no route), never a refusal or a timeout from something that
# answered. Metadata services, the container bridge and Docker's TCP port, the
# agent-computer proxy, RFC 1918 and CGNAT ranges, a public resolver.
NO_ROUTE_IPV4 = [
    ("169.254.169.254", 80), ("169.254.169.254", 443),   # AWS, GCP, Azure, OCI instance metadata
    ("169.254.170.2", 80),                                # ECS task credentials
    ("168.63.129.16", 80),                                # Azure wire server
    ("100.100.100.200", 80),                              # Alibaba metadata
    ("10.0.0.1", 443), ("172.16.0.1", 443), ("192.168.0.1", 80), ("100.64.0.1", 443),
    ("172.17.0.1", 2375), ("172.30.0.1", 3128),
    ("1.1.1.1", 443), ("1.1.1.1", 53),
]
NO_ROUTE_IPV6 = [("fd00:ec2::254", 80), ("2606:4700:4700::1111", 443)]
# Mount types that are not a host disk.
PSEUDO_FILESYSTEMS = {"overlay", "proc", "sysfs", "tmpfs", "devpts", "mqueue", "cgroup", "cgroup2", "devtmpfs",
                      "securityfs", "debugfs", "tracefs", "fusectl", "configfs", "binfmt_misc", "nsfs"}
# The session's own three directories, the files Docker writes for every
# container, and the host's docker-init binary that `--init` mounts read-only.
EXEC_HOST_MOUNTS = {"/work", "/work/inputs", "/juno/program", "/etc/hosts", "/etc/hostname", "/etc/resolv.conf",
                    "/usr/sbin/docker-init"}


def host_primary_address():
    """The address this host uses for outbound traffic, if it has a route at all."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 9))
        return probe.getsockname()[0]
    except OSError:
        return None
    finally:
        probe.close()


@unittest.skipUnless(REAL_EXEC_TESTS, "set JUNO_EXEC_DOCKER_TESTS=1 with Docker running (scripts/sandbox-boundary-check.py)")
class RealSandboxBoundary(unittest.TestCase):
    """The pinned image through the real broker (developer mode) and the real service."""

    @classmethod
    def setUpClass(cls):
        cls.docker = shutil.which("docker")
        if not cls.docker:
            raise AssertionError("JUNO_EXEC_DOCKER_TESTS=1 but there is no docker binary")
        image = subprocess.run([cls.docker, "image", "inspect", REAL_EXEC_IMAGE, "--format", "{{.Id}}"], capture_output=True, text=True)
        if image.returncode != 0:
            raise AssertionError("build deploy/exec-host/image as %s first: %s" % (REAL_EXEC_IMAGE, image.stderr.strip()))
        cls.image_id = image.stdout.strip()
        # Match setup.sh: the container runs as the workspace-owning service uid,
        # never root. (A hardcoded 1000 cannot write a CI workspace owned by 1001.)
        if os.getuid() == 0 or os.getgid() == 0:
            raise AssertionError("run the real sandbox suite as a non-root user in the docker group, as the service runs")

    def setUp(self):
        self.canary = "juno-host-canary-" + os.urandom(12).hex()
        secrets_env = unittest.mock.patch.dict(os.environ, {name: self.canary for name in HOST_SECRET_NAMES})
        secrets_env.start()
        self.addCleanup(secrets_env.stop)
        self.directory = tempfile.mkdtemp(prefix="juno-exec-real-", dir=os.path.expanduser("~"))
        self.data = os.path.realpath(self.directory)
        self.policy = policy_for(os.path.join(self.data, "sessions"), image=self.image_id)
        self.policy["runUser"] = "%d:%d" % (os.getuid(), os.getgid())
        self.policy_path = os.path.join(self.data, "policy.json")
        with open(self.policy_path, "w") as file:
            json.dump(self.policy, file)
        env = dict(os.environ, JUNO_EXEC_BROKER_POLICY=self.policy_path, JUNO_EXEC_DOCKER=self.docker)
        config = {"token": TOKEN, "policy": self.policy, "dataRoot": self.data,
                  "broker": {"mode": "process", "argv": [sys.executable, str(ROOT / "deploy/exec-host/juno-exec-docker-broker.py")], "env": env}}
        self.service = service_module.Service(config)
        self.workspace = os.path.join(self.policy["sessionsRoot"], SESSION, "work")
        self.server = service_module.ThreadingHTTPServer(("127.0.0.1", 0), service_module.make_handler(self.service, TOKEN))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self._close)
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def _close(self):
        self.server.shutdown()
        self.server.server_close()
        for run_id in list(self.service.runs):
            subprocess.run([self.docker, "rm", "-f", "juno-exec-" + run_id], capture_output=True)
        self.service._remove_tree(self.directory)

    # ── helpers ──
    def request(self, method, path, body=None, headers=None, raw=False):
        data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, method=method)
        request.add_header("Authorization", "Bearer " + TOKEN)
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = response.read()
                return response.status, (payload if raw else json.loads(payload or b"null"))
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def start(self, code, language="python", timeout_ms=60000, session=SESSION, account=ACCOUNT):
        status, run = self.request("POST", "/v1/runs", {"session": session, "account": account, "language": language,
                                                        "code": code, "timeoutMs": timeout_ms},
                                   headers={"Idempotency-Key": os.urandom(8).hex()})
        self.assertIn(status, (200, 201), run)
        return run

    def wait_for_terminal(self, run_id, seconds=90):
        deadline = time.monotonic() + seconds
        while True:
            self.assertLess(time.monotonic(), deadline, "the real container did not finish within its bounded test window")
            status, run = self.request("GET", "/v1/runs/%s?wait=25" % run_id)
            self.assertEqual(status, 200, run)
            if run["status"] in service_module.TERMINAL:
                return run

    def run_code(self, code, **options):
        return self.wait_for_terminal(self.start(code, **options)["id"])

    def full_output(self, run_id, stream="stdout"):
        status, data = self.request("GET", "/v1/runs/%s/output?stream=%s&limit=1048576" % (run_id, stream), raw=True)
        self.assertEqual(status, 200)
        return data.decode("utf-8", "replace")

    def probe(self, spec, **options):
        run = self.run_code(sandbox_probe.program(spec), **options)
        self.assertEqual(run["status"], "succeeded", run)
        return run, sandbox_probe.parse(self.full_output(run["id"]))

    def wait_for_marker(self, name, seconds=30):
        deadline = time.monotonic() + seconds
        while not os.path.isfile(os.path.join(self.workspace, name)):
            self.assertLess(time.monotonic(), deadline, "the container never wrote its start marker")
            time.sleep(0.05)

    def container_exists(self, run_id):
        listed = subprocess.run([self.docker, "ps", "-a", "-q", "--filter", "name=^juno-exec-%s$" % run_id], capture_output=True, text=True)
        self.assertEqual(listed.returncode, 0, listed.stderr)
        return bool(listed.stdout.strip())

    def assert_container_gone(self, run_id, seconds=15):
        deadline = time.monotonic() + seconds
        while self.container_exists(run_id):
            self.assertLess(time.monotonic(), deadline, "the container outlived its run")
            time.sleep(0.2)

    # ── identity and privilege ──
    def test_the_program_runs_as_the_unprivileged_workspace_owner_with_no_capabilities(self):
        _, report = self.probe({"privileged": True, "processes": True})
        self.assertEqual((report["uid"], report["euid"], report["gid"]), (os.getuid(), os.getuid(), os.getgid()))
        self.assertNotIn(0, report["groups"])
        for key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"):
            self.assertEqual(int(report["status"][key], 16), 0, key)
        self.assertEqual(report["status"]["NoNewPrivs"], "1")
        self.assertEqual(report["status"]["Seccomp"], "2", "Docker's seccomp filter is not applied")
        for call, result in report["privileged"].items():
            self.assertIn(result, ("EPERM", "EACCES"), call)
        # Nothing in the sandbox runs as root, not even its init.
        self.assertTrue(report["processes"])
        self.assertEqual({row["uid"] for row in report["processes"]}, {os.getuid()}, report["processes"])

    # ── network ──
    def test_metadata_private_and_public_addresses_have_no_route(self):
        targets = NO_ROUTE_IPV4 + NO_ROUTE_IPV6
        primary = host_primary_address()
        if primary:
            targets = targets + [(primary, 22), (primary, 443)]
        _, report = self.probe({"tcp": targets, "dns": ["1.1.1.1", "169.254.169.254", "10.0.0.2"], "timeout": 3,
                                "resolve": ["example.com", "metadata.google.internal", "localhost.localdomain.invalid"]})
        self.assertEqual(report["loopbackControl"], "open", "the probe cannot detect an open port, so its refusals mean nothing")
        self.assertEqual(report["interfaces"], ["lo"])
        self.assertEqual(report["ipv4Routes"], [], "the sandbox has a route")
        for host, port in targets:
            result = report["tcp"]["%s:%d" % (host, port)]
            if ":" in host:
                self.assertIn(result, ("ENETUNREACH", "EADDRNOTAVAIL", "EAFNOSUPPORT"), "%s:%d" % (host, port))
            else:
                self.assertEqual(result, "ENETUNREACH", "%s:%d: no route, not merely a closed port" % (host, port))
        for server, result in report["dns"].items():
            self.assertEqual(result, "ENETUNREACH", server)
        for name, result in report["resolve"].items():
            self.assertFalse(result.startswith("resolved"), "%s resolved inside the sandbox: %s" % (name, result))

    # ── secrets ──
    def test_host_secrets_and_the_service_token_never_reach_the_program(self):
        run, report = self.probe({"environ": True, "processes": True})
        names = set(report["environ"]["self"])
        self.assertLessEqual(names, EXEC_PROGRAM_ENV, "unexpected variables in the sandbox: %s" % sorted(names - EXEC_PROGRAM_ENV))
        self.assertFalse(names & set(HOST_SECRET_NAMES))
        for pid, entries in report["environ"].items():
            if pid != "self" and isinstance(entries, list):
                visible = {entry.split("=", 1)[0] for entry in entries}
                self.assertLessEqual(visible, EXEC_PROGRAM_ENV, "process %s: %s" % (pid, sorted(visible - EXEC_PROGRAM_ENV)))
        everything = self.full_output(run["id"]) + self.full_output(run["id"], "stderr")
        self.assertIn('"uid"', everything)
        for needle, what in ((self.canary, "a host secret"), (TOKEN, "the service token"), (self.data, "the host data path")):
            self.assertNotIn(needle, everything, what + " reached the program")
        # The configuration Docker holds for the container carries none either.
        self.assertNotIn(self.canary, json.dumps(self.service.runs[run["id"]].record()))

    # ── filesystem ──
    def test_the_filesystem_is_confined_to_the_session(self):
        status, _ = self.request("PUT", "/v1/sessions/%s/inputs/data.csv" % SESSION, body=b"a,b\n1,2\n")
        self.assertEqual(status, 201)
        _, report = self.probe({
            "writes": ["/escape", "/usr/local/bin/escape", "/etc/planted", "/opt/juno/planted", "/skills/planted",
                       "/etc/passwd", "/opt/juno/manifest.py",
                       "/work/inputs/data.csv", "/work/inputs/planted", "/juno/program/main.py", "/juno/program/planted",
                       "/work/written-by-program.txt", "/tmp/scratch.txt"],
            "exists": [self.data, self.policy_path, self.policy["sessionsRoot"], os.path.expanduser("~"),
                       "/var/run/docker.sock", "/run/docker.sock", "/run/juno-exec/broker.sock", "/etc/juno"],
            "mounts": True})
        writes = report["writes"]
        # Creating a file is refused by the read-only mount itself (EROFS comes
        # before any permission check), wherever the directory's owner.
        for path in ("/escape", "/usr/local/bin/escape", "/etc/planted", "/opt/juno/planted", "/skills/planted"):
            self.assertEqual(writes[path], "EROFS", path + ": the root filesystem must be read-only")
        # Existing read-only files (root's, and the program the service wrote
        # 0444): the permission check answers first.
        for path in ("/etc/passwd", "/opt/juno/manifest.py", "/juno/program/main.py"):
            self.assertIn(writes[path], ("EACCES", "EROFS"), path)
        # The input is owned by the very uid the program runs as and writable by
        # it, so only the read-only bind mount stands between them.
        for path in ("/work/inputs/data.csv", "/work/inputs/planted", "/juno/program/planted"):
            self.assertEqual(writes[path], "EROFS", path + ": inputs and the program are mounted read-only")
        self.assertEqual(writes["/work/written-by-program.txt"], "ok")
        self.assertEqual(writes["/tmp/scratch.txt"], "ok")
        for path, present in report["exists"].items():
            self.assertFalse(present, path + " is visible inside the sandbox")
        mounts = {entry["mountpoint"]: entry for entry in report["mounts"]}
        self.assertEqual(mounts["/"]["fstype"], "overlay")
        self.assertIn("ro", mounts["/"]["options"].split(","))
        self.assertEqual(mounts["/tmp"]["fstype"], "tmpfs")
        self.assertTrue({"nosuid", "nodev"} <= set(mounts["/tmp"]["options"].split(",")))
        host_disks = {entry["mountpoint"] for entry in report["mounts"] if entry["fstype"] not in PSEUDO_FILESYSTEMS}
        self.assertLessEqual(host_disks, EXEC_HOST_MOUNTS, "host directories mounted into the sandbox: %s" % sorted(host_disks - EXEC_HOST_MOUNTS))
        for path in ("/work/inputs", "/juno/program", "/usr/sbin/docker-init"):
            if path in mounts:
                self.assertIn("ro", mounts[path]["options"].split(","), path)
        self.assertIn("/work/inputs", mounts)
        self.assertIn("/juno/program", mounts)
        self.assertIn("rw", mounts["/work"]["options"].split(","))
        self.assertEqual(mounts["/work"]["root"].rstrip("/").rsplit("/", 2)[-2:], [SESSION, "work"], "/work is not this session's workspace")
        with open(os.path.join(self.policy["sessionsRoot"], SESSION, "inputs", "data.csv"), "rb") as file:
            self.assertEqual(file.read(), b"a,b\n1,2\n")

    def test_workspace_symlinks_never_lead_the_service_out_of_the_session(self):
        run = self.run_code("\n".join([
            "import os",
            "os.symlink(%r, '/work/host-policy')" % self.policy_path,
            "os.symlink('/etc/passwd', '/work/passwd')",
            "os.symlink('/', '/work/root')",
            "os.makedirs('/work/out')",
            "os.symlink(%r, '/work/out/sessions')" % self.policy["sessionsRoot"],
            "open('/work/real.txt', 'w').write('real')",
        ]))
        self.assertEqual(run["status"], "succeeded", run)
        self.assertEqual([entry["path"] for entry in run["files"]], ["real.txt"])
        for path in ("host-policy", "passwd", "root/etc/passwd", "out/sessions"):
            status, _ = self.request("GET", "/v1/runs/%s/files/%s" % (run["id"], path), raw=True)
            self.assertEqual(status, 404, path)
        with open(self.policy_path, encoding="utf-8") as file:
            self.assertEqual(json.load(file)["image"], self.image_id)

    def test_another_session_cannot_see_this_workspace(self):
        first = self.run_code("open('/work/private.txt', 'w').write('session one')")
        self.assertEqual(first["status"], "succeeded", first)
        _, report = self.probe({"exists": ["/work/private.txt", self.workspace], "reads": ["/work"], "mounts": True},
                               session=OTHER_SESSION, account=OTHER_ACCOUNT)
        self.assertEqual(report["reads"]["/work"], "ok")
        self.assertEqual(report["exists"], {"/work/private.txt": False, self.workspace: False})
        mounts = {entry["mountpoint"]: entry for entry in report["mounts"]}
        self.assertEqual(mounts["/work"]["root"].rstrip("/").rsplit("/", 2)[-2:], [OTHER_SESSION, "work"])

    # ── stopping ──
    def test_cancel_kills_the_container_before_a_delayed_write(self):
        run = self.start("import time\nfrom pathlib import Path\nPath('/work/started').write_text('started')\n"
                         "time.sleep(6)\nPath('/work/after-stop').write_text('unauthorized-after-stop')\n")
        self.wait_for_marker("started")
        started = time.monotonic()
        self.assertTrue(self.container_exists(run["id"]))
        status, _ = self.request("POST", "/v1/runs/%s/cancel" % run["id"], body=b"")
        self.assertEqual(status, 202)
        final = self.wait_for_terminal(run["id"])
        self.assertEqual(final["status"], "cancelled")
        self.assertLess(time.monotonic() - started, 5, "cancel took longer than the program's own delay")
        self.assert_container_gone(run["id"])
        time.sleep(max(0.0, started + 6.5 - time.monotonic()))
        self.assertFalse(os.path.exists(os.path.join(self.workspace, "after-stop")), "the program kept running after cancel")

    def test_the_time_limit_kills_the_container_before_a_delayed_write(self):
        begun = time.monotonic()
        run = self.start("import time\nfrom pathlib import Path\nPath('/work/started').write_text('started')\n"
                         "time.sleep(8)\nPath('/work/late').write_text('after the limit')\n", timeout_ms=3000)
        final = self.wait_for_terminal(run["id"])
        self.assertEqual(final["status"], "timed_out", final)
        self.assertLess(time.monotonic() - begun, 8, "the time limit did not stop the program before it finished")
        self.assertTrue(os.path.exists(os.path.join(self.workspace, "started")))
        self.assert_container_gone(run["id"])
        time.sleep(max(0.0, begun + 9 - time.monotonic()))
        self.assertFalse(os.path.exists(os.path.join(self.workspace, "late")))

    # ── what Docker actually created ──
    def test_a_running_container_has_exactly_the_pinned_profile(self):
        run = self.start("import time\nopen('/work/started', 'w').write('1')\ntime.sleep(60)\n")
        self.wait_for_marker("started")
        inspected = subprocess.run([self.docker, "inspect", "juno-exec-" + run["id"]], capture_output=True, text=True)
        self.assertEqual(inspected.returncode, 0, inspected.stderr)
        container = json.loads(inspected.stdout)[0]
        self.request("POST", "/v1/runs/%s/cancel" % run["id"], body=b"")
        host = container["HostConfig"]
        self.assertEqual(container["Image"], self.image_id)
        self.assertEqual(container["Config"]["User"], self.policy["runUser"])
        self.assertEqual(container["Config"]["Labels"].get("juno.security"), "exec-v1")
        self.assertEqual(host["NetworkMode"], "none")
        self.assertTrue(host["ReadonlyRootfs"])
        self.assertFalse(host["Privileged"])
        self.assertEqual(host["CapDrop"], ["ALL"])
        self.assertFalse(host.get("CapAdd"))
        self.assertEqual(host["SecurityOpt"], ["no-new-privileges"])
        self.assertEqual(host["PidsLimit"], 256)
        self.assertEqual(host["Memory"], 1536 * 1024 * 1024)
        self.assertEqual(host["MemorySwap"], 1536 * 1024 * 1024)
        self.assertEqual(host["NanoCpus"], 1000000000)
        self.assertTrue(host["Init"])
        self.assertTrue(host["AutoRemove"])
        self.assertEqual(host["LogConfig"]["Type"], "none")
        self.assertEqual(host["Tmpfs"], {"/tmp": "rw,nosuid,nodev,size=256m,mode=1777"})
        self.assertFalse(host.get("Devices"))
        self.assertFalse(host.get("PortBindings"))
        self.assertIn(host.get("PidMode") or "", ("", "private"))
        self.assertIn(host.get("IpcMode") or "", ("", "private", "shareable"))
        self.assertFalse(host.get("UsernsMode"))
        root = os.path.join(self.policy["sessionsRoot"], SESSION)
        mounts = sorted((entry["Type"], entry["Source"], entry["Destination"], entry["RW"]) for entry in container["Mounts"])
        self.assertEqual(mounts, sorted([("bind", root + "/work", "/work", True),
                                         ("bind", root + "/inputs", "/work/inputs", False),
                                         ("bind", root + "/programs/" + run["id"], "/juno/program", False)]))
        names = {entry.split("=", 1)[0] for entry in container["Config"]["Env"]}
        self.assertLessEqual(names, EXEC_PROGRAM_ENV)
        self.assertNotIn(self.canary, inspected.stdout)
        self.assertEqual(self.wait_for_terminal(run["id"])["status"], "cancelled")
        self.assert_container_gone(run["id"])

    # ── resources ──
    def test_processes_memory_cpu_and_tmp_are_bounded(self):
        _, report = self.probe({"cgroup": True, "fill": ["/tmp/fill", 320]})
        limits = report["cgroup"]
        self.assertEqual(int(limits["memory"]), 1536 * 1024 * 1024, limits)
        self.assertEqual(limits["pids"], "256", limits)
        if limits["cpuMax"]:
            quota, period = limits["cpuMax"].split()
        else:
            quota, period = limits["cpuQuota"], limits["cpuPeriod"]
        self.assertEqual(int(quota), int(period), "one CPU: %s" % limits)
        self.assertEqual(report["fill"]["result"], "ENOSPC", report["fill"])
        self.assertLessEqual(report["fill"]["megabytes"], 256)

        forks = self.run_code("for i in $(seq 1 400); do sleep 5 & done; wait; echo done", language="bash", timeout_ms=30000)
        self.assertIn("fork", (forks["stderr"]["head"] + forks["stderr"]["tail"]).lower(), forks)

        memory = self.run_code("x = bytearray(3 * 1024 * 1024 * 1024)\nprint('allocated')")
        self.assertEqual(memory["status"], "failed", memory)
        self.assertNotIn("allocated", memory["stdout"]["head"])
        self.assertEqual(memory["exitCode"], 137, "killed by the memory limit: %s" % memory)


import unittest.mock  # noqa: E402  (patch helpers used above)

if __name__ == "__main__":
    unittest.main()
