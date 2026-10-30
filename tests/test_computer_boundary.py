"""Agent computers for real: the image, the network, firewall.sh, egress-proxy.py and the broker.

tests/test_computer_infrastructure.py checks the broker and the proxy as Python
functions. This suite builds the production arrangement on a disposable Linux
host and attacks it from inside a real computer container, the way an agent's
shell command arrives: through the REAL broker (its validation, its namespace
check and its egress-map hooks), as `docker exec --user 1000 <computer>
/opt/juno/agent-exec run -- ...`: the `juno-computers` network exactly as
setup-vm.sh creates it, the host firewall from firewall.sh, the egress proxy on
172.30.0.1:3128 with its address map watcher (egress-map.py), and a computer
created with the argv the broker requires (the same argv the provider sends:
tests/computer-broker-argv.test.ts holds the two together).

What it proves, each with a positive control so a refusal cannot be an accident
of the test machine:
  - direct connections to cloud metadata, RFC 1918 and link-local addresses, the
    host itself and other computers are dropped (canaries on the host answer an
    unfirewalled container on the default bridge, and do not answer a computer);
  - the proxy is the only way out, and it refuses metadata, private, loopback and
    obfuscated destinations that the proxy host itself can reach;
  - no DNS (pipe-v4): names fail at once, public resolvers are rejected;
  - curl, pip, npm, git and Chromium reach a public host through the proxy (a
    local canary on a global address on the host's lo, named in /etc/hosts for
    the proxy, both removed in teardown);
  - every connection is logged by computer name with no path or query; a
    computer over its budget is refused, a new computer on its address starts
    clean, the budget survives a proxy restart, an unmapped address is refused;
  - IPv6 has no route;
  - no host secret reaches the agent's shell or the browser user;
  - the root filesystem is read-only, the shell is uid 1000 with no capabilities
    and cannot read the browser's profile or the CDP handover;
  - the agent cannot create a user namespace (the launcher's ban), Chromium's
    sandbox state is what this kernel allows, and a planted login file, rc file
    or ~/.local/bin entry never runs for an approved command;
  - freeze and thaw: a running loop, a fork loop, a racing command, held keys
    and a resumed typer; VNC answers the host side only;
  - HOME is /home/agent and pip, venv and npm work in it;
  - a container made from an older image is outdated;
  - the container Docker created has exactly the broker's limits;
  - a command past its time limit, `docker stop` and `docker rm -f` kill what the
    agent started before a delayed write lands.
Public-Internet controls (CONNECT to a public site works, a direct public
connection does not) need a host with Internet access: they skip as
"optional:" without it, and CI requires them (JUNO_BOUNDARY_REQUIRE_ALL=1).
Every timed assertion multiplies by JUNO_COMPUTER_TEST_SLACK (default 1).

It needs root (a Docker network, iptables rules, addresses on lo, a listener on
the bridge, a line in /etc/hosts) and changes the host, so it runs only when
asked and refuses a host that already has a `juno-computers` network:

    docker build -t juno-computer:1 deploy/agent-computers
    sudo -E JUNO_COMPUTER_DOCKER_TESTS=1 python3 scripts/sandbox-boundary-check.py tests.test_computer_boundary

JUNO_COMPUTER_TEST_SANDBOX=off runs every computer under Docker's default
seccomp profile; the default (auto) probes this kernel as setup-vm.sh does.
Teardown removes what setup added (JUNO_COMPUTER_BOUNDARY_KEEP=1 keeps it to debug).
"""
import hashlib
import importlib.util
import io
import json
import os
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy/agent-computers"
REQUIRED = os.environ.get("JUNO_COMPUTER_DOCKER_TESTS") == "1"
IMAGE = os.environ.get("JUNO_COMPUTER_IMAGE", "juno-computer:1")
SLACK = float(os.environ.get("JUNO_COMPUTER_TEST_SLACK") or 1)
NETWORK = "juno-computers"          # setup-vm.sh and src/lib/env.ts
SUBNET = "172.30.0.0/24"
BRIDGE = "br-juno"
GATEWAY = "172.30.0.1"
PROXY_PORT = 3128
FALLBACK_IP_IMAGE = "alpine:3.20"   # only where the host has no iproute2
LAUNCHER = "/opt/juno/agent-exec"
SECCOMP_PROFILE = str(DEPLOY / "seccomp-chromium.json")
DNS_SENTINEL = "192.0.2.53"
STATE_TMPFS = "/run/juno-state:rw,nosuid,nodev,noexec,size=64k,uid=1001,gid=1001,mode=0755"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


broker = load("computer_broker", "deploy/agent-computers/docker-broker.py")
sandbox_probe = load("sandbox_probe", "tests/sandbox_probe.py")
POLICY = {"image": IMAGE, "network": NETWORK, "maxMemoryMb": 2048, "maxCpus": 2}

# Addresses put on the host's lo for the run. A container's packet to one of them
# is delivered to the host (INPUT), exactly like a packet to the host's own
# address: the default bridge accepts it, br-juno must not.
CANARY_ADDRESSES = ("169.254.170.2", "10.231.0.1", "192.168.231.1")
# A GLOBAL address on lo, named in /etc/hosts, for the proxy's positive control:
# the proxy only connects to global addresses, so a local "public host" lets curl,
# pip, npm, git and Chromium prove they work through it without the Internet.
# 192.88.99.0/24 is the deprecated 6to4 relay anycast block (RFC 7526): global to
# Python's ipaddress, used by nothing here. Removed in teardown.
PUBLIC_CANARY = "192.88.99.80"
PUBLIC_NAME = "juno-egress-canary.test"
HOSTS_LINE = "%s %s  # juno computer boundary test" % (PUBLIC_CANARY, PUBLIC_NAME)
# What the host holds and a computer must never see.
HOST_SECRET_NAMES = ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "DATABASE_URL", "DIRECT_URL",
                     "AUTH_SECRET", "NEXTAUTH_SECRET", "JUNO_CDP_TOKEN", "COMPUTER_VNC_PASSWORD",
                     "CODE_INTERPRETER_TOKEN", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "STRIPE_SECRET_KEY")
# The agent shell's whole environment: exactly what the launcher sets (nothing
# from the image, Docker or the exec passes through).
AGENT_SHELL_ENV = frozenset({"HOME", "USER", "LOGNAME", "PATH", "LANG", "DISPLAY", "TERM", "HTTP_PROXY", "HTTPS_PROXY",
                             "http_proxy", "https_proxy", "PIP_BREAK_SYSTEM_PACKAGES", "NPM_CONFIG_PREFIX"})
SECRET_LIKE = ("KEY", "SECRET", "TOKEN", "PASSWORD", "PASSWD", "CREDENTIAL", "DATABASE", "POSTGRES", "PRIVATE")
PSEUDO_FILESYSTEMS = {"overlay", "proc", "sysfs", "tmpfs", "devpts", "mqueue", "cgroup", "cgroup2", "devtmpfs",
                      "securityfs", "debugfs", "tracefs", "fusectl", "configfs", "binfmt_misc", "nsfs"}
COMPUTER_HOST_MOUNTS = {"/home/agent", "/home/browser", "/etc/hosts", "/etc/hostname", "/etc/resolv.conf"}
BLOCKED = ("timeout", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH")
NO_IPV6_ROUTE = ("ENETUNREACH", "EADDRNOTAVAIL", "EAFNOSUPPORT")
CANARY_BODY = b"juno-boundary-canary"
# What firewall.sh adds, in the order teardown removes it (the chain last).
FIREWALL_RULES = [
    ("iptables", "DOCKER-USER", ["-i", BRIDGE, "-j", "JUNO-COMPUTERS"]),
    ("iptables", "INPUT", ["-i", BRIDGE, "-d", GATEWAY, "-p", "tcp", "--dport", str(PROXY_PORT), "-j", "ACCEPT"]),
    ("iptables", "INPUT", ["-i", BRIDGE, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"]),
    ("iptables", "INPUT", ["-i", BRIDGE, "-j", "DROP"]),
    ("ip6tables", "DOCKER-USER", ["-i", BRIDGE, "-j", "DROP"]),
    ("ip6tables", "INPUT", ["-i", BRIDGE, "-j", "DROP"]),
    ("iptables", "JUNO-COMPUTERS", None),
]
# The real broker, with only its two fixed paths pointed at this run's files:
# the policy, and the address-map helper's map (its argv and checks unchanged).
BROKER_SHIM = r"""
import importlib.util, sys
spec = importlib.util.spec_from_file_location("broker", sys.argv[1])
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)
broker.CONFIG = sys.argv[2]
broker.EGRESS_MAP_HELPER = [sys.executable, "-I", sys.argv[3]]
broker.EGRESS_MAP_ENV = {"PATH": "/usr/bin:/bin", "HOME": "/root", "JUNO_EGRESS_MAP": sys.argv[4]}
sys.argv = ["juno-computer-docker-broker"] + sys.argv[5:]
sys.exit(broker.run_cli())
"""


def docker(*args, check=True, timeout=300, input_text=None):
    result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout, input=input_text)
    if check and result.returncode != 0:
        raise AssertionError("docker %s failed (%d): %s" % (" ".join(args[:3]), result.returncode, result.stderr.strip()[-800:]))
    return result


def brokered(argv, check=True, timeout=300, input_text=None, background=False):
    """Run docker THROUGH the production broker (validation, namespace check, map hooks)."""
    broker.validate(argv, POLICY)  # fail fast with the broker's own words
    command = [sys.executable, "-I", "-c", BROKER_SHIM, str(DEPLOY / "docker-broker.py"), HOST.policy_file,
               str(DEPLOY / "egress-map.py"), HOST.map_file, *argv]
    if background:
        return subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, input=input_text)
    if check and result.returncode != 0:
        raise AssertionError("broker %s failed (%d): %s" % (" ".join(argv[:3]), result.returncode, result.stderr.strip()[-800:]))
    return result


def ip(*args, check=True):
    if shutil.which("ip"):
        result = subprocess.run(["ip", *args], capture_output=True, text=True)
    else:
        result = docker("run", "--rm", "--network", "host", "--cap-add", "NET_ADMIN", FALLBACK_IP_IMAGE, "ip", *args, check=False)
    if check and result.returncode != 0:
        raise AssertionError("ip %s: %s" % (" ".join(args), result.stderr.strip()))
    return result


def host_primary_address():
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 9))
        return probe.getsockname()[0]
    except OSError:
        return None
    finally:
        probe.close()


def host_has_internet():
    """The host resolves a public name and connects to it: what the proxy itself needs.
    (A bare connect to a public IP is not enough: some sandboxes accept every
    outbound TCP connection at a middlebox and resolve nothing.)"""
    try:
        address = socket.getaddrinfo("example.com", 443, type=socket.SOCK_STREAM)[0][4]
        socket.create_connection(address[:2], timeout=4).close()
        return True
    except OSError:
        return False


def security_options(policy=None):
    policy = POLICY if policy is None else policy
    return broker.security_options(policy)


def create_argv(name, agent, memory_mb=2048, cpus="2", policy=None):
    """The production `docker create` argv (src/lib/computer/docker.ts buildDockerCreateArgv, Linux)."""
    security = []
    for option in security_options(policy):
        security += ["--security-opt", option]
    return ["create", "--name", name, "--hostname", "computer", "--network", NETWORK,
            "--dns", DNS_SENTINEL, "--memory", "%dm" % memory_mb, "--memory-swap", "%dm" % memory_mb,
            "--cpus", cpus, "--pids-limit", "2048", "--shm-size", "1g", "--cap-drop", "ALL",
            *security, "--read-only",
            "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g,mode=1777", "--tmpfs", "/run:rw,nosuid,nodev,size=64m",
            "--tmpfs", "/run/juno:rw,nosuid,nodev,noexec,size=1m,uid=1001,gid=1001,mode=0700",
            "--tmpfs", STATE_TMPFS,
            "--tmpfs", "/var/tmp:rw,nosuid,nodev,size=256m",
            "--mount", "type=volume,source=%s,target=/home/agent" % name,
            "--mount", "type=volume,source=%s-browser,target=/home/browser" % name,
            "--label", "app=juno", "--label", "juno.agent=" + agent, "--label", "juno.user=boundary-test",
            "--restart", "no", "--stop-timeout", "20", IMAGE]


# Run inside the computer as the browser uid with the image's own websockets:
# hands the gate a token over its private tmpfs, then speaks CDP through the
# gate exactly as the app does (one connection, the token header). argv: an
# action and its argument. Prints one JSON line.
CDP_CLIENT = r"""
import asyncio, json, os, sys, time, uuid
import websockets
TOKEN = uuid.uuid4().hex
with open("/run/juno/cdp-token.part", "w") as f:
    f.write(TOKEN)
os.rename("/run/juno/cdp-token.part", "/run/juno/cdp-token")
for _ in range(50):
    if not os.path.exists("/run/juno/cdp-token"):
        break
    time.sleep(0.1)
async def main(action, argument):
    async with websockets.connect("ws://127.0.0.1:9222/devtools/browser", extra_headers={"X-Juno-Cdp-Token": TOKEN},
                                  max_size=64 * 1024 * 1024) as ws:
        counter = [0]
        async def call(method, params=None, session=None):
            counter[0] += 1
            message = {"id": counter[0], "method": method, "params": params or {}}
            if session:
                message["sessionId"] = session
            await ws.send(json.dumps(message))
            while True:
                reply = json.loads(await asyncio.wait_for(ws.recv(), 30))
                if reply.get("id") == counter[0]:
                    return reply
        if action == "open":
            target = (await call("Target.createTarget", {"url": argument}))["result"]["targetId"]
            await call("Target.activateTarget", {"targetId": target})
            print(json.dumps({"targetId": target}))
            return
        if action == "eval":
            target, expression = argument.split(" ", 1)
            session = (await call("Target.attachToTarget", {"targetId": target, "flatten": True}))["result"]["sessionId"]
            reply = await call("Runtime.evaluate", {"expression": expression, "returnByValue": True}, session)
            print(json.dumps({"value": reply.get("result", {}).get("result", {}).get("value")}))
            return
        if action == "text":
            deadline = time.time() + float(sys.argv[3] if len(sys.argv) > 3 else 20)
            target = (await call("Target.createTarget", {"url": argument}))["result"]["targetId"]
            session = (await call("Target.attachToTarget", {"targetId": target, "flatten": True}))["result"]["sessionId"]
            text = None
            while time.time() < deadline:
                reply = await call("Runtime.evaluate", {"expression": "document.body ? document.body.innerText : ''", "returnByValue": True}, session)
                text = reply.get("result", {}).get("result", {}).get("value")
                if text:
                    break
                await asyncio.sleep(0.3)
            await call("Target.closeTarget", {"targetId": target})
            print(json.dumps({"text": text}))
asyncio.run(main(sys.argv[1], sys.argv[2]))
"""


class Computer:
    """One agent computer, created and started through the real broker."""

    def __init__(self, label, policy=None):
        self.agent = "boundary-%s-%s" % (label, os.urandom(4).hex())
        self.name = "juno-agent-" + self.agent
        self.policy = policy

    def create(self, start=True):
        for volume in (self.name, self.name + "-browser"):
            brokered(["volume", "create", "--label", "app=juno", "--label", "juno.agent=" + self.agent, volume])
        argv = create_argv(self.name, self.agent, policy=self.policy)
        if self.policy is not None and self.policy is not POLICY:
            broker.validate(argv, self.policy)  # the broker under that policy accepts it
            docker(*argv)
        else:
            brokered(argv)
        if start:
            self.start()
        return self

    def start(self):
        brokered(["start", self.name])
        deadline = time.monotonic() + 90 * SLACK
        while True:
            state = brokered(["inspect", "-f", "{{.State.Status}}", self.name]).stdout.strip()
            ready = self.run_as_browser(["test", "-s", "/run/juno-state/browser-sandbox"], check=False)
            if state == "running" and ready.returncode == 0:
                return self
            if time.monotonic() > deadline:
                logs = docker("logs", self.name, check=False)
                raise AssertionError("the computer never came up (%s): %s %s" % (state, logs.stdout[-1500:], logs.stderr[-1500:]))
            time.sleep(0.5)

    def run(self, command, check=True, timeout=120, workdir=None, mode="run", input_text=None):
        """As the agent, through the launcher, exactly as the provider sends it."""
        argv = ["exec"] + (["-i"] if input_text is not None else []) + ["--user", "1000"]
        if workdir:
            argv += ["--workdir", workdir]
        return brokered(argv + [self.name, LAUNCHER, mode, "--"] + command, check=check, timeout=timeout,
                        input_text=input_text)

    def run_as_browser(self, command, check=True, timeout=120, display=False, input_text=None):
        argv = ["exec"] + (["-i"] if input_text is not None else []) + ["--user", "1001"]
        if display:
            argv += ["-e", "DISPLAY=:0"]
        return brokered(argv + [self.name] + command, check=check, timeout=timeout, input_text=input_text)

    def launcher(self, mode, check=True):
        return brokered(["exec", "--user", "1000", self.name, LAUNCHER, mode], check=check, timeout=60)

    def probe(self, spec, user="1000"):
        program = ["python3", "-c", sandbox_probe.program(spec)]
        result = self.run(program, timeout=180) if user == "1000" else self.run_as_browser(program, timeout=180)
        return sandbox_probe.parse(result.stdout)

    def cdp(self, action, argument, *extra):
        result = self.run_as_browser(["python3", "-c", CDP_CLIENT, action, argument, *extra], timeout=120)
        return json.loads(result.stdout.strip().splitlines()[-1])

    def address(self):
        return docker("inspect", "-f", '{{(index .NetworkSettings.Networks "%s").IPAddress}}' % NETWORK, self.name).stdout.strip()

    def freeze(self):
        """DockerProvider.freezeAgent, step for step (src/lib/computer/docker.ts)."""
        results = [
            self.run_as_browser(["touch", "/run/juno-state/frozen"], check=False),
            self.launcher("freeze", check=False),
            self.run_as_browser(["python3", "-I", "/opt/juno/x-clients.py", "close-uid", "1000"], check=False, display=True),
            self.run_as_browser(["python3", "-I", "/opt/juno/x-clients.py", "release-all"], check=False, display=True),
        ]
        for result in results:
            if result.returncode != 0:
                raise AssertionError("freeze step failed: %s" % result.stderr[-500:])
        print("\n[boundary] freeze: x-clients %s" % results[2].stdout.strip(), file=sys.stderr)
        return results

    def thaw(self):
        """DockerProvider.thawAgent: the marker first, then SIGCONT."""
        self.run_as_browser(["rm", "-f", "/run/juno-state/frozen"])
        self.launcher("thaw")

    def volume_has(self, path):
        """Look inside the agent's home volume from a throwaway, network-less container."""
        result = docker("run", "--rm", "--network", "none", "--entrypoint", "/bin/sh", "-v", self.name + ":/v:ro",
                        IMAGE, "-c", 'test -e "/v/%s"' % path, check=False)
        return result.returncode == 0

    def stop(self):
        brokered(["stop", self.name], timeout=90)

    def destroy(self):
        brokered(["rm", "-f", self.name], check=False) if HOST else None
        docker("rm", "-f", self.name, check=False)
        for volume in (self.name + "-browser", self.name):
            docker("volume", "rm", "-f", volume, check=False)


class CanaryHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", str(len(CANARY_BODY)))
        self.end_headers()
        self.wfile.write(CANARY_BODY)

    def log_message(self, *args):
        pass


def canary_wheel():
    """A minimal wheel with a console script: what pip downloads and installs."""
    buffer = io.BytesIO()
    files = {
        "juno_canary/__init__.py": "def main():\n    print('juno-canary-tool ran')\n",
        "juno_canary-1.0.dist-info/METADATA": "Metadata-Version: 2.1\nName: juno-canary\nVersion: 1.0\n",
        "juno_canary-1.0.dist-info/WHEEL": "Wheel-Version: 1.0\nGenerator: juno-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
        "juno_canary-1.0.dist-info/entry_points.txt": "[console_scripts]\njuno-canary-tool = juno_canary:main\n",
    }
    record = []
    with zipfile.ZipFile(buffer, "w") as wheel:
        for path, text in files.items():
            data = text.encode()
            wheel.writestr(path, data)
            digest = __import__("base64").urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
            record.append("%s,sha256=%s,%d" % (path, digest, len(data)))
        record.append("juno_canary-1.0.dist-info/RECORD,,")
        wheel.writestr("juno_canary-1.0.dist-info/RECORD", "\n".join(record) + "\n")
    return buffer.getvalue()


WHEEL_NAME = "juno_canary-1.0-py3-none-any.whl"


class PublicCanaryHandler(BaseHTTPRequestHandler):
    """A small "public host": the canary page, a PyPI simple index with one
    wheel, an npm registry document, a git repository over dumb HTTP, and a
    large file for the bandwidth budget."""

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        wheel = canary_wheel()
        sha = hashlib.sha256(wheel).hexdigest()
        tarball_url = "http://%s/npm/juno-canary-1.0.0.tgz" % PUBLIC_NAME
        routes = {
            "/": (b"text/plain", CANARY_BODY),
            "/simple/juno-canary/": (b"text/html", ('<a href="/files/%s#sha256=%s">%s</a>' % (WHEEL_NAME, sha, WHEEL_NAME)).encode()),
            "/files/" + WHEEL_NAME: (b"application/octet-stream", wheel),
            "/npm/juno-canary": (b"application/json", json.dumps({
                "name": "juno-canary", "dist-tags": {"latest": "1.0.0"},
                "versions": {"1.0.0": {"name": "juno-canary", "version": "1.0.0", "description": "juno canary",
                                       "dist": {"tarball": tarball_url, "shasum": "0" * 40}}}}).encode()),
            "/repo.git/info/refs": (b"text/plain", b"1111111111111111111111111111111111111111\trefs/heads/main\n"),
            "/repo.git/HEAD": (b"text/plain", b"ref: refs/heads/main\n"),
            "/big": (b"application/octet-stream", b"z" * (2 * 1024 * 1024)),
        }
        if path not in routes:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        kind, body = routes[path]
        self.send_response(200)
        self.send_header("Content-Type", kind.decode())
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def kernel_allows_the_browser_sandbox():
    """setup-vm.sh's probe, in a throwaway container of the image: the browser
    uid may create a user namespace under the permissive profile, and the agent
    uid through its launcher may not."""
    def probe(uid, *command):
        return subprocess.run(["docker", "run", "--rm", "--network", "none", "--user", uid, "--cap-drop", "ALL",
                               "--security-opt", "no-new-privileges", "--security-opt", "seccomp=" + SECCOMP_PROFILE,
                               "--read-only", "--entrypoint", command[0], IMAGE, *command[1:]],
                              capture_output=True, text=True, timeout=120)
    if probe("1001", "unshare", "--user", "--map-root-user", "true").returncode != 0:
        return False, "the kernel (or AppArmor) refuses user namespaces in a container"
    ban = probe("1000", LAUNCHER, "run", "--", "unshare", "-Ur", "true")
    if ban.returncode == 0:
        raise AssertionError("the agent created a user namespace through its launcher under the permissive profile")
    if "Operation not permitted" not in ban.stderr:
        return False, "the launcher's ban could not be confirmed: " + ban.stderr[-300:]
    return True, "the kernel allows user namespaces in a container and the launcher's ban holds"


class Host:
    """Everything setUpModule puts on the host, and how to take it off again."""

    def __init__(self):
        self.undo = []
        self.proxy = None
        self.watcher = None
        self.canary_port = None
        self.primary = host_primary_address()
        self.directory = tempfile.mkdtemp(prefix="juno-boundary-")
        self.map_file = os.path.join(self.directory, "run", "egress-map.json")
        self.log_file = os.path.join(self.directory, "log", "egress.jsonl")
        self.state_dir = os.path.join(self.directory, "state")
        self.policy_file = os.path.join(self.directory, "computer-broker.json")
        self.ca_file = os.path.join(self.directory, "canary-ca.pem")
        self.sandbox = False
        self.sandbox_reason = "off"

    def write_policy(self):
        with open(self.policy_file, "w") as file:
            json.dump(POLICY, file)

    def run(self):
        self.undo.append(lambda: shutil.rmtree(self.directory, ignore_errors=True))
        os.makedirs(os.path.dirname(self.log_file))
        os.makedirs(self.state_dir)
        if docker("network", "inspect", NETWORK, check=False).returncode == 0:
            raise AssertionError("this host already has a %s network: run the suite on a disposable machine" % NETWORK)
        # Chromium's sandbox, decided as setup-vm.sh decides it.
        if os.environ.get("JUNO_COMPUTER_TEST_SANDBOX", "auto") == "auto":
            self.sandbox, self.sandbox_reason = kernel_allows_the_browser_sandbox()
        if self.sandbox:
            POLICY.update({"browserSandbox": True, "seccompProfile": SECCOMP_PROFILE})
        self.write_policy()
        # The network, exactly as setup-vm.sh creates it.
        docker("network", "create", "--driver", "bridge", "--subnet", SUBNET, "-o", "com.docker.network.bridge.name=" + BRIDGE,
               "-o", "com.docker.network.bridge.enable_icc=false", NETWORK)
        self.undo.append(lambda: docker("network", "rm", NETWORK, check=False))
        # The firewall, exactly as installed. Teardown deletes only the rules
        # firewall.sh added (Docker keeps managing its own around them).
        added = [rule for rule in FIREWALL_RULES if not self._has_rule(rule)]
        self.undo.append(lambda: self._remove_rules(added))
        result = subprocess.run(["bash", str(DEPLOY / "firewall.sh")], capture_output=True, text=True)
        if result.returncode != 0:
            raise AssertionError("firewall.sh failed: " + result.stderr[-800:])
        # The address-map watcher and the egress proxy, the production scripts
        # with the arguments and environment their units give them.
        self.watcher = subprocess.Popen([sys.executable, "-I", str(DEPLOY / "egress-map.py"), "watch"],
                                        env={"PATH": "/usr/bin:/bin", "HOME": "/root", "JUNO_EGRESS_MAP": self.map_file},
                                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.undo.append(self._stop_watcher)
        deadline = time.monotonic() + 15
        while not os.path.exists(self.map_file):
            if time.monotonic() > deadline or self.watcher.poll() is not None:
                raise AssertionError("the map watcher never wrote the map")
            time.sleep(0.1)
        self.start_proxy()
        self.undo.append(self.stop_proxy)
        # Canaries: one listener on every host address (a free port), and port 80
        # on each lo canary address for the proxy (it only forwards 80 and 443).
        for address in CANARY_ADDRESSES + (PUBLIC_CANARY,):
            ip("addr", "add", address + "/32", "dev", "lo")
            self.undo.append(lambda address=address: ip("addr", "del", address + "/32", "dev", "lo", check=False))
        everywhere = self._serve("0.0.0.0", 0)
        self.canary_port = everywhere.server_address[1]
        for address in CANARY_ADDRESSES:
            self._serve(address, 80)
        # The local "public host": HTTP on 80, HTTPS on 443 with a certificate
        # for its name, named in /etc/hosts so the proxy (and only lookups of
        # that one name) resolve it.
        self._serve(PUBLIC_CANARY, 80, PublicCanaryHandler)
        self._serve_tls()
        with open("/etc/hosts", "a") as hosts:
            hosts.write("\n" + HOSTS_LINE + "\n")
        self.undo.append(self._remove_hosts_line)

    def start_proxy(self, max_mb=None):
        environment = {"PATH": "/usr/bin:/bin", "JUNO_EGRESS_MAP": self.map_file, "JUNO_EGRESS_LOG_FILE": self.log_file,
                       "JUNO_EGRESS_STATE_DIR": self.state_dir}
        if max_mb is not None:
            environment["JUNO_EGRESS_MAX_MB_PER_HOUR"] = str(max_mb)
        self.proxy = subprocess.Popen([sys.executable, "-I", str(DEPLOY / "egress-proxy.py")], env=environment,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self._wait_for_port(GATEWAY, PROXY_PORT)

    def stop_proxy(self):
        if self.proxy and self.proxy.poll() is None:
            self.proxy.send_signal(signal.SIGTERM)  # what systemd sends: the budget is saved
            try:
                self.proxy.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proxy.kill()
                self.proxy.wait()

    def restart_proxy(self, max_mb=None):
        self.stop_proxy()
        self.start_proxy(max_mb)

    def log_records(self):
        try:
            with open(self.log_file) as file:
                return [json.loads(line) for line in file if line.strip()]
        except FileNotFoundError:
            return []

    def read_map(self):
        with open(self.map_file) as file:
            return json.load(file)

    def _stop_watcher(self):
        if self.watcher and self.watcher.poll() is None:
            self.watcher.terminate()
            try:
                self.watcher.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.watcher.kill()

    def _serve(self, address, port, handler=CanaryHandler):
        server = ThreadingHTTPServer((address, port), handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.undo.append(lambda: (server.shutdown(), server.server_close()))
        return server

    def _serve_tls(self):
        key = os.path.join(self.directory, "canary-key.pem")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=" + PUBLIC_NAME,
                        "-addext", "subjectAltName=DNS:" + PUBLIC_NAME, "-keyout", key, "-out", self.ca_file],
                       check=True, capture_output=True)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.ca_file, key)
        server = ThreadingHTTPServer((PUBLIC_CANARY, 443), CanaryHandler)
        server.daemon_threads = True
        server.socket = context.wrap_socket(server.socket, server_side=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.undo.append(lambda: (server.shutdown(), server.server_close()))

    @staticmethod
    def _remove_hosts_line():
        with open("/etc/hosts") as hosts:
            lines = hosts.read().split("\n")
        kept = [line for line in lines if line != HOSTS_LINE]
        while len(kept) > 1 and kept[-1] == "" and kept[-2] == "":
            kept.pop()
        with open("/etc/hosts", "w") as hosts:
            hosts.write("\n".join(kept))

    @staticmethod
    def _wait_for_port(address, port, seconds=15):
        deadline = time.monotonic() + seconds
        while True:
            try:
                socket.create_connection((address, port), timeout=1).close()
                return
            except OSError:
                if time.monotonic() > deadline:
                    raise AssertionError("nothing listens on %s:%d" % (address, port))
                time.sleep(0.2)

    @staticmethod
    def _has_rule(rule):
        tool, chain, spec = rule
        if not shutil.which(tool):
            return True
        if spec is None:
            return subprocess.run([tool, "-S", chain], capture_output=True).returncode == 0
        return subprocess.run([tool, "-C", chain, *spec], capture_output=True).returncode == 0

    @staticmethod
    def _remove_rules(rules):
        for tool, chain, spec in rules:
            if spec is None:
                subprocess.run([tool, "-F", chain], capture_output=True)
                subprocess.run([tool, "-X", chain], capture_output=True)
            else:
                subprocess.run([tool, "-D", chain, *spec], capture_output=True)

    def close(self):
        while self.undo:
            try:
                self.undo.pop()()
            except Exception as error:  # keep undoing the rest
                print("teardown: %s" % error, file=sys.stderr)


HOST = None
CANARY = "juno-host-canary-" + os.urandom(12).hex()


def setUpModule():
    global HOST
    if not REQUIRED:
        raise unittest.SkipTest("set JUNO_COMPUTER_DOCKER_TESTS=1 on a disposable host, as root (scripts/sandbox-boundary-check.py)")
    if os.geteuid() != 0:
        raise AssertionError("the agent-computer boundary suite needs root (network, iptables, lo addresses)")
    if not shutil.which("docker") or not shutil.which("iptables"):
        raise AssertionError("docker and iptables are required")
    if docker("image", "inspect", IMAGE, check=False).returncode != 0:
        raise AssertionError("build deploy/agent-computers as %s first" % IMAGE)
    # Host secrets in the environment of everything that creates the computers.
    os.environ.update({name: CANARY for name in HOST_SECRET_NAMES})
    HOST = Host()
    try:
        HOST.run()
    except BaseException:
        HOST.close()
        raise
    print("\n[boundary] Chromium sandbox for this run: %s (%s)" % ("on" if HOST.sandbox else "off", HOST.sandbox_reason),
          file=sys.stderr)


def tearDownModule():
    for name in HOST_SECRET_NAMES:
        os.environ.pop(name, None)
    if HOST and os.environ.get("JUNO_COMPUTER_BOUNDARY_KEEP") != "1":
        HOST.close()


def image_defined_environment():
    """Variables the IMAGE itself exports to the browser: Debian's chromium wrapper
    sources /etc/chromium.d/*, which exports the distribution's public Google API
    keys. They are part of the package, not the host; the test proves that by value."""
    result = docker("run", "--rm", "--network", "none", "--entrypoint", "/bin/sh", IMAGE, "-c",
                    "cat /etc/chromium.d/* 2>/dev/null; true")
    defined = {}
    for line in result.stdout.splitlines():
        line = line.strip()
        if line.startswith("export ") and "=" in line:
            name, _, value = line[len("export "):].partition("=")
            defined[name.strip()] = value.strip().strip('"').strip("'")
    return defined


def control_probe(spec):
    """The same probe from an UNFIREWALLED container on the default bridge."""
    result = docker("run", "--rm", "--network", "bridge", "--entrypoint", "python3", IMAGE, "-c", sandbox_probe.program(spec))
    return sandbox_probe.parse(result.stdout)


def host_get(url):
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url, timeout=5) as response:
        return response.status, response.read()


# Probes run as the agent through the launcher (python3 -c). Each prints JSON.
NAMESPACE_PROBE = r"""
import ctypes, errno, json, subprocess
libc = ctypes.CDLL(None, use_errno=True)
def call(*args):
    result = libc.syscall(*args)
    return "ok" if result >= 0 else errno.errorcode.get(ctypes.get_errno(), str(ctypes.get_errno()))
def run(*argv):
    done = subprocess.run(list(argv), capture_output=True, text=True)
    return "ok" if done.returncode == 0 else ("EPERM" if "Operation not permitted" in done.stderr else "failed:" + done.stderr[-120:])
SIGCHLD = 17
report = {
    "unshare -Ur": run("unshare", "-Ur", "true"),
    "unshare -n": run("unshare", "-n", "true"),
    "unshare -m": run("unshare", "-m", "true"),
    "clone(CLONE_NEWUSER)": call(56, 0x10000000 | SIGCHLD, 0, 0, 0, 0),
    "clone(CLONE_NEWNET)": call(56, 0x40000000 | SIGCHLD, 0, 0, 0, 0),
    "unshare(CLONE_NEWUSER)": call(272, 0x10000000),
    "setns": call(308, 0, 0x10000000),
    "clone3": call(435, 0, 0),
}
print(json.dumps(report))
"""

DNS_PROBE = r"""
import json, socket, time
report = {}
started = time.monotonic()
try:
    socket.getaddrinfo("example.com", 443, type=socket.SOCK_STREAM)
    report["example.com"] = "resolved"
except OSError as error:
    report["example.com"] = type(error).__name__
report["seconds"] = round(time.monotonic() - started, 2)
for server in ("1.1.1.1", "9.9.9.9", "8.8.8.8"):
    # A connected UDP socket hears the firewall's ICMP port-unreachable (REJECT):
    # ECONNREFUSED at once. Dropped, it would time out; answered, it would read.
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(3)
    began = time.monotonic()
    try:
        sock.connect((server, 53))
        sock.send(b"\x4a\x55\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x07example\x03com\x00\x00\x01\x00\x01")
        sock.recv(512)
        udp = "answered"
    except socket.timeout:
        udp = "timeout"
    except OSError as error:
        udp = {111: "ECONNREFUSED"}.get(error.errno, "errno:%s" % error.errno)
    finally:
        sock.close()
    began_tcp = time.monotonic()
    try:
        socket.create_connection((server, 53), timeout=3).close()
        tcp = "open"
    except socket.timeout:
        tcp = "timeout"
    except OSError as error:
        tcp = {111: "ECONNREFUSED"}.get(error.errno, "errno:%s" % error.errno)
    report[server] = {"udp": udp, "tcp": tcp, "seconds": round(time.monotonic() - began, 2)}
print(json.dumps(report))
"""

# As the browser uid with python3-xlib: which keys and buttons the X server holds down.
HELD_INPUT_PROBE = r"""
import json
from Xlib import display, X, XK
d = display.Display(":0")
keymap = d.query_keymap()
def down(name):
    code = d.keysym_to_keycode(XK.string_to_keysym(name))
    return bool(code) and bool(keymap[code // 8] & (1 << (code % 8)))
pointer = d.screen().root.query_pointer()
print(json.dumps({"Control_L": down("Control_L"), "Shift_L": down("Shift_L"), "a": down("a"),
                  "button1": bool(pointer.mask & X.Button1Mask)}))
"""


def agent_processes(computer):
    """[(pid, state, command)] of every uid-1000 process, read as the browser uid."""
    result = computer.run_as_browser(["ps", "-o", "pid=,stat=,args=", "-u", "1000"], check=False)
    rows = []
    for line in result.stdout.splitlines():
        parts = line.split(None, 2)
        if len(parts) >= 2:
            rows.append((int(parts[0]), parts[1], parts[2] if len(parts) > 2 else ""))
    return rows


def wait_for(predicate, seconds, step=0.2):
    deadline = time.monotonic() + seconds * SLACK
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(step)
    return predicate()


class ComputerBoundary(unittest.TestCase):
    """One running computer, attacked from its own shell."""

    @classmethod
    def setUpClass(cls):
        cls.computer = Computer("net")
        try:
            cls.computer.create()
        except BaseException:
            cls.computer.destroy()
            raise
        cls.peer_name = "juno-boundary-peer-" + os.urandom(4).hex()
        docker("run", "-d", "--rm", "--name", cls.peer_name, "--network", NETWORK, "--entrypoint", "python3", IMAGE,
               "-m", "http.server", "8080", "--bind", "0.0.0.0")
        cls.peer_ip = docker("inspect", "-f", '{{(index .NetworkSettings.Networks "%s").IPAddress}}' % NETWORK, cls.peer_name).stdout.strip()
        Host._wait_for_port(cls.peer_ip, 8080)

    @classmethod
    def tearDownClass(cls):
        docker("rm", "-f", cls.peer_name, check=False)
        cls.computer.destroy()

    # ── network ──
    def test_direct_connections_to_metadata_private_addresses_peers_and_the_host_are_dropped(self):
        port = HOST.canary_port
        canaries = [(address, port) for address in CANARY_ADDRESSES] + [(address, 80) for address in CANARY_ADDRESSES]
        host_addresses = [(GATEWAY, port), ("172.17.0.1", port)] + ([(HOST.primary, port)] if HOST.primary else [])
        real_metadata = [("169.254.169.254", 80), ("169.254.169.254", 443), ("168.63.129.16", 80), ("100.100.100.200", 80)]
        targets = canaries + host_addresses + real_metadata + [(self.peer_ip, 8080), (PUBLIC_CANARY, 80)]
        report = self.computer.probe({"tcp": targets, "timeout": 3})
        self.assertEqual(report["loopbackControl"], "open", "the probe cannot detect an open port, so its refusals mean nothing")
        for target in targets:
            self.assertIn(report["tcp"]["%s:%d" % target], BLOCKED, "%s:%d is reachable from a computer" % target)
        # Positive controls: the same listeners answer an unfirewalled container
        # on this host, and the peer answers the host. Only br-juno's rules stop them.
        control_targets = [(address, port) for address in CANARY_ADDRESSES] + [("172.17.0.1", port)]
        if HOST.primary:
            control_targets.append((HOST.primary, port))
        control = control_probe({"tcp": control_targets, "timeout": 3})
        for target in control_targets:
            self.assertEqual(control["tcp"]["%s:%d" % target], "open", "control: %s:%d should answer a container" % target)
        self.assertEqual(host_get("http://%s:8080/" % self.peer_ip)[0], 200)

    def test_the_proxy_is_the_only_way_out_and_refuses_what_its_own_host_can_reach(self):
        requests = [
            ("GET", "http://169.254.169.254/latest/meta-data/"), ("CONNECT", "169.254.169.254:443"),
            ("GET", "http://169.254.170.2/v2/credentials"), ("CONNECT", "169.254.170.2:443"),
            ("GET", "http://10.231.0.1/"), ("CONNECT", "10.231.0.1:80"), ("GET", "http://192.168.231.1/"),
            ("GET", "http://168.63.129.16/machine?comp=goalstate"),
            ("GET", "http://localhost/"), ("CONNECT", "localhost:443"), ("GET", "http://127.0.0.1/"),
            ("GET", "http://%s/" % GATEWAY), ("CONNECT", "%s:%d" % (GATEWAY, PROXY_PORT)),
            ("GET", "http://2852039166/"), ("GET", "http://0xa9fea9fe/"), ("GET", "http://0251.0376.0251.0376/"),
            ("GET", "http://[::ffff:169.254.169.254]/"), ("GET", "http://[::1]/"), ("GET", "http://[fd00:ec2::254]/"),
            ("CONNECT", "example.com:22"), ("GET", "http://example.com:8080/"),
        ]
        report = self.computer.probe({"proxy": [GATEWAY, PROXY_PORT], "proxyRequests": requests,
                                      "tcp": [(GATEWAY, PROXY_PORT)], "timeout": 3})
        self.assertEqual(report["tcp"]["%s:%d" % (GATEWAY, PROXY_PORT)], "open", "the proxy must be reachable from a computer")
        for method, target in requests:
            self.assertEqual(report["proxy"]["%s %s" % (method, target)], 403, "%s %s through the proxy" % (method, target))
        # The proxy's host CAN reach the canaries, so each 403 above is the
        # proxy's policy, not an accident of routing.
        for address in CANARY_ADDRESSES:
            self.assertEqual(host_get("http://%s/" % address), (200, CANARY_BODY))
        self.assertIsNone(HOST.proxy.poll(), "the proxy died: %s" % (HOST.proxy.stderr.read() if HOST.proxy.poll() is not None else ""))

    def test_names_do_not_resolve_and_fail_within_two_seconds(self):
        report = json.loads(self.computer.run(["python3", "-c", DNS_PROBE]).stdout)
        self.assertEqual(report["example.com"], "gaierror", "a name resolved inside a computer")
        self.assertLess(report["seconds"], 2 * SLACK, "a lookup should fail at once, not time out")
        resolv = self.computer.run(["cat", "/etc/resolv.conf"]).stdout
        inspected = json.loads(docker("inspect", self.computer.name).stdout)[0]
        self.assertEqual(inspected["HostConfig"]["Dns"], [DNS_SENTINEL], resolv)

    @staticmethod
    def reject_counters():
        """Packets firewall.sh's two port-53 REJECT rules have answered so far."""
        listing = subprocess.run(["iptables", "-L", "JUNO-COMPUTERS", "-v", "-n", "-x"], capture_output=True, text=True).stdout
        counts = {}
        for line in listing.splitlines():
            for proto in ("udp", "tcp"):
                if "REJECT" in line and "%s dpt:53" % proto in line:
                    counts[proto] = int(line.split()[0])
        return counts

    def test_public_resolvers_are_closed(self):
        before = self.reject_counters()
        self.assertEqual(set(before), {"udp", "tcp"}, "firewall.sh rejects port 53 over both protocols")
        report = json.loads(self.computer.run(["python3", "-c", DNS_PROBE]).stdout)
        after = self.reject_counters()
        for server in ("1.1.1.1", "9.9.9.9", "8.8.8.8"):
            # TCP: firewall.sh's reset, at once; neither an answer nor this
            # host's lack of Internet (which would time out). UDP: never an
            # answer; the ICMP port-unreachable the REJECT sends is rate-limited
            # per peer by the kernel (net.ipv4.icmp_ratelimit), so after the
            # name lookups above it may arrive as a timeout instead.
            self.assertEqual(report[server]["tcp"], "ECONNREFUSED", server)
            self.assertIn(report[server]["udp"], ("ECONNREFUSED", "timeout"), server)
        # Every one of those packets met the REJECT rules, not a missing route.
        self.assertGreaterEqual(after["tcp"] - before["tcp"], 3)
        self.assertGreaterEqual(after["udp"] - before["udp"], 3)

    def test_public_internet_only_through_the_proxy(self):
        if not host_has_internet():
            self.skipTest("optional: this host has no direct Internet access, so public controls cannot run")
        report = self.computer.probe({"tcp": [("1.1.1.1", 443), ("8.8.8.8", 53), ("9.9.9.9", 443)],
                                      "dns": ["1.1.1.1", "9.9.9.9", "8.8.8.8"],
                                      "proxy": [GATEWAY, PROXY_PORT], "proxyRequests": [("CONNECT", "example.com:443")],
                                      "timeout": 4})
        for target in ("1.1.1.1:443", "8.8.8.8:53", "9.9.9.9:443"):
            self.assertIn(report["tcp"][target], BLOCKED, target + ": direct public egress from a computer")
        for server in ("1.1.1.1", "9.9.9.9", "8.8.8.8"):
            self.assertNotEqual(report["dns"][server], "answered", server + ": no resolver answers a computer (pipe-v4)")
        self.assertEqual(report["proxy"]["CONNECT example.com:443"], 200, "public HTTPS through the proxy")
        control = control_probe({"tcp": [("1.1.1.1", 443)], "dns": ["8.8.8.8", "1.1.1.1"], "timeout": 4})
        self.assertEqual(control["tcp"]["1.1.1.1:443"], "open", "control: this host's containers reach the Internet")
        self.assertEqual(control["dns"]["1.1.1.1"], "answered", "control: the resolver answers an unfirewalled container")

    def test_ipv6_has_no_route(self):
        report = self.computer.probe({"tcp": [("2606:4700:4700::1111", 443), ("fd00:ec2::254", 80), ("fe80::1", 80)], "timeout": 3})
        for target, result in report["tcp"].items():
            # A link-local address with no interface named cannot be dialled at
            # all: Linux's tcp_v6_connect returns EINVAL before a packet leaves
            # (GitHub's runners do; others answer ENETUNREACH). Only that target
            # may say so; the routable ones above still must have no route.
            allowed = NO_IPV6_ROUTE + BLOCKED + (("EINVAL",) if target.startswith("fe80:") else ())
            self.assertIn(result, allowed, target)
            self.assertNotEqual(result, "open", target)
        self.assertEqual([entry for entry in report["ipv6Addresses"] if entry["scope"] == "00"], [], "a global IPv6 address")
        self.assertEqual(sorted(report["interfaces"]), ["eth0", "lo"])

    # ── secrets ──
    def test_no_host_secret_reaches_the_agent_shell_or_the_browser_user(self):
        shell = self.computer.probe({"environ": True})
        names = set(shell["environ"]["self"])
        self.assertEqual(names, AGENT_SHELL_ENV, "the agent's shell environment is exactly the launcher's")
        self.assertEqual(shell["environ"]["self"]["HTTPS_PROXY"], "http://%s:%d" % (GATEWAY, PROXY_PORT))
        self.assertEqual(shell["environ"]["self"]["HOME"], "/home/agent")
        self.assertFalse(names & set(HOST_SECRET_NAMES))
        browser = self.computer.probe({"environ": True, "processes": True}, user="1001")
        from_image = image_defined_environment()
        for report in (shell, browser):
            self.assertNotIn(CANARY, json.dumps(report), "a host secret is inside the computer")
            for pid, entries in report["environ"].items():
                if isinstance(entries, dict):
                    pairs = dict(entries)
                elif isinstance(entries, list):
                    pairs = dict(item.split("=", 1) if "=" in item else (item, "") for item in entries)
                else:
                    continue  # another uid's process: unreadable, as it should be
                for name, value in pairs.items():
                    if any(word in name.upper() for word in SECRET_LIKE) or name in HOST_SECRET_NAMES:
                        self.assertEqual(from_image.get(name), value,
                                         "process %s carries %s, which the image does not define" % (pid, name))
        # Every process is the agent's or the browser's; PID 1 (tini) is the browser user's.
        uids = {row["uid"] for row in browser["processes"]}
        self.assertLessEqual(uids, {1000, 1001}, browser["processes"])
        inspected = json.loads(docker("inspect", self.computer.name).stdout)[0]
        image_env = json.loads(docker("image", "inspect", IMAGE).stdout)[0]["Config"]["Env"]
        self.assertEqual(sorted(name.split("=", 1)[0] for name in inspected["Config"]["Env"]),
                         sorted(name.split("=", 1)[0] for name in image_env), "docker create added environment variables")
        self.assertNotIn(CANARY, json.dumps(inspected))

    # ── filesystem and privilege ──
    def test_the_root_is_read_only_and_the_shell_is_unprivileged(self):
        report = self.computer.probe({
            "privileged": True, "mounts": True,
            "writes": ["/escape", "/usr/local/bin/escape", "/etc/planted", "/opt/juno/planted", "/etc/passwd",
                       "/opt/juno/entrypoint.sh", "/opt/juno/agent-exec", "/home/agent/work/ok.txt", "/tmp/ok.txt",
                       "/run/juno/planted", "/run/juno-state/frozen", "/run/juno-state/browser-sandbox"],
            "reads": ["/home/browser", "/home/browser/.chrome", "/run/juno", "/proc/1/environ"],
            "exists": ["/var/run/docker.sock", "/run/docker.sock", "/etc/juno", "/usr/local/sbin/juno-computer-docker-broker"]})
        self.assertEqual((report["uid"], report["gid"]), (1000, 1000))
        self.assertNotIn(0, report["groups"])
        self.assertNotIn(1001, report["groups"], "the agent is in the browser's group")
        for key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"):
            self.assertEqual(int(report["status"][key], 16), 0, key)
        self.assertEqual(report["status"]["NoNewPrivs"], "1")
        self.assertEqual(report["status"]["Seccomp"], "2")
        for call, result in report["privileged"].items():
            self.assertIn(result, ("EPERM", "EACCES"), call)
        writes = report["writes"]
        for path in ("/escape", "/usr/local/bin/escape", "/etc/planted", "/opt/juno/planted"):
            self.assertEqual(writes[path], "EROFS", path + ": the root filesystem must be read-only")
        for path in ("/etc/passwd", "/opt/juno/entrypoint.sh", "/opt/juno/agent-exec"):
            self.assertIn(writes[path], ("EACCES", "EROFS"), path)
        self.assertEqual(writes["/home/agent/work/ok.txt"], "ok")
        self.assertEqual(writes["/tmp/ok.txt"], "ok")
        self.assertEqual(writes["/run/juno/planted"], "EACCES", "the CDP handover tmpfs is the browser's alone")
        for path in ("/run/juno-state/frozen", "/run/juno-state/browser-sandbox"):
            self.assertEqual(writes[path], "EACCES", path + ": the agent can read the state tmpfs, never write it")
        for path, result in report["reads"].items():
            self.assertEqual(result, "EACCES", path + " is readable by the agent")
        for path, present in report["exists"].items():
            self.assertFalse(present, path)
        mounts = {entry["mountpoint"]: entry for entry in report["mounts"]}
        self.assertIn("ro", mounts["/"]["options"].split(","))
        for path in ("/tmp", "/run", "/run/juno", "/run/juno-state", "/var/tmp"):
            self.assertEqual(mounts[path]["fstype"], "tmpfs", path)
            self.assertTrue({"nosuid", "nodev"} <= set(mounts[path]["options"].split(",")), path)
        host_disks = {entry["mountpoint"] for entry in report["mounts"] if entry["fstype"] not in PSEUDO_FILESYSTEMS}
        self.assertLessEqual(host_disks, COMPUTER_HOST_MOUNTS, "host directories in the computer: %s" % sorted(host_disks - COMPUTER_HOST_MOUNTS))

    def test_the_container_has_exactly_the_broker_profile(self):
        container = json.loads(docker("inspect", self.computer.name).stdout)[0]
        host = container["HostConfig"]
        self.assertEqual(container["Config"]["User"], "1001")
        self.assertEqual(container["Config"]["Labels"].get("juno.security"), "pipe-v4")
        self.assertEqual(host["NetworkMode"], NETWORK)
        self.assertEqual(host["Dns"], [DNS_SENTINEL])
        self.assertTrue(host["ReadonlyRootfs"])
        self.assertFalse(host["Privileged"])
        self.assertEqual(host["CapDrop"], ["ALL"])
        self.assertFalse(host.get("CapAdd"))
        if HOST.sandbox:
            # The CLI sends the profile's content; it must be the repo's profile, byte for byte as JSON.
            self.assertEqual(host["SecurityOpt"][0], "no-new-privileges")
            self.assertEqual(len(host["SecurityOpt"]), 2)
            self.assertTrue(host["SecurityOpt"][1].startswith("seccomp="))
            self.assertEqual(json.loads(host["SecurityOpt"][1][len("seccomp="):]), json.loads(Path(SECCOMP_PROFILE).read_text()))
        else:
            self.assertEqual(host["SecurityOpt"], ["no-new-privileges"])
        self.assertEqual(host["PidsLimit"], 2048)
        # src/lib/env.ts defaults: 2048 MB (swap equal, so none), 2 CPUs.
        self.assertEqual(host["Memory"], 2048 * 1024 * 1024)
        self.assertEqual(host["MemorySwap"], 2048 * 1024 * 1024)
        self.assertEqual(host["NanoCpus"], 2000000000)
        self.assertEqual(host["ShmSize"], 1024 * 1024 * 1024)
        self.assertEqual(host["RestartPolicy"]["Name"], "no")
        self.assertFalse(host.get("PortBindings"))
        self.assertFalse(host.get("Devices"))
        self.assertEqual(host["Tmpfs"], {"/tmp": "rw,nosuid,nodev,size=1g,mode=1777", "/run": "rw,nosuid,nodev,size=64m",
                                         "/run/juno": "rw,nosuid,nodev,noexec,size=1m,uid=1001,gid=1001,mode=0700",
                                         "/run/juno-state": STATE_TMPFS.split(":", 1)[1],
                                         "/var/tmp": "rw,nosuid,nodev,size=256m"})
        self.assertEqual(sorted((entry["Type"], entry["Name"], entry["Destination"]) for entry in container["Mounts"]),
                         sorted([("volume", self.computer.name, "/home/agent"), ("volume", self.computer.name + "-browser", "/home/browser")]))
        limits = self.computer.probe({"cgroup": True})["cgroup"]
        self.assertEqual(limits["pids"], "2048")
        self.assertEqual(int(limits["memory"]), 2048 * 1024 * 1024)
        quota, period = limits["cpuMax"].split() if limits["cpuMax"] else (limits["cpuQuota"], limits["cpuPeriod"])
        self.assertEqual(int(quota), 2 * int(period), limits)

    def test_a_command_past_its_time_limit_is_killed_before_a_delayed_write(self):
        # Exactly the argv DockerProvider.exec sends for a 2-second limit.
        begun = time.monotonic()
        result = self.computer.run(["timeout", "--signal=TERM", "--kill-after=5", "2", "bash", "--noprofile", "--norc", "-c",
                                    "echo started > started-cmd; sleep 6; echo late > late-cmd"],
                                   check=False, workdir="/home/agent/work")
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertLess(time.monotonic() - begun, 5 * SLACK)
        time.sleep(max(0.0, begun + 7 - time.monotonic()))
        self.assertEqual(self.computer.run(["test", "-e", "/home/agent/work/started-cmd"], check=False).returncode, 0)
        self.assertEqual(self.computer.run(["test", "-e", "/home/agent/work/late-cmd"], check=False).returncode, 1,
                         "the command kept running past its time limit")

    def test_an_unmapped_address_is_refused_not_guessed(self):
        # The peer is on the computers network but is not a computer (not
        # juno-agent-*), so the map never names it: the proxy waits up to 2 s
        # for the broker's post-start rebuild, then refuses, and logs it.
        before = len(HOST.log_records())
        script = ("import socket,time\ns=socket.create_connection(('%s',%d),timeout=10)\nt=time.monotonic()\n"
                  "s.sendall(b'CONNECT %s:443 HTTP/1.1\\r\\n\\r\\n')\nprint(s.recv(64).decode().split('\\r\\n')[0], round(time.monotonic()-t,2))"
                  % (GATEWAY, PROXY_PORT, PUBLIC_NAME))
        result = docker("exec", self.peer_name, "python3", "-c", script)
        status, seconds = result.stdout.split()[1], float(result.stdout.split()[-1])
        self.assertEqual(status, "403")
        self.assertGreaterEqual(seconds, 1.5, "refused after re-checking the map, not guessed at once")
        records = HOST.log_records()[before:]
        mine = [r for r in records if r["src"] == self.peer_ip]
        self.assertEqual([(r["computer"], r["verdict"]) for r in mine], [(None, "unmapped")])
        # Positive control: the computer itself is mapped under its own name.
        self.assertEqual(HOST.read_map()["entries"].get(self.computer.address(), {}).get("name"), self.computer.name)


class EgressThroughTheProxy(unittest.TestCase):
    """Tools reach a "public" host through the proxy, the log names the computer,
    and the budget is the computer's own (COMPUTERS_2026-10.md S2.1, S2.2, D19)."""

    @classmethod
    def setUpClass(cls):
        cls.computer = Computer("egress")
        try:
            cls.computer.create()
        except BaseException:
            cls.computer.destroy()
            raise
        with open(HOST.ca_file) as file:
            cls.computer.run(["sh", "-c", "cat > /tmp/canary-ca.pem"], input_text=file.read())

    @classmethod
    def tearDownClass(cls):
        cls.computer.destroy()
        HOST.restart_proxy()

    def tearDown(self):
        # Every test starts from the default budget (the budget tests lower it).
        HOST.restart_proxy()

    def test_tools_reach_a_public_host_through_the_proxy(self):
        run = lambda command: self.computer.run(["bash", "--noprofile", "--norc", "-c", command], check=False,
                                               workdir="/home/agent/work", timeout=180)
        curl = run("curl -sS --max-time 20 http://%s/" % PUBLIC_NAME)
        self.assertEqual(curl.stdout, CANARY_BODY.decode(), curl.stderr)
        tls = run("curl -sS --max-time 20 --cacert /tmp/canary-ca.pem https://%s/" % PUBLIC_NAME)
        self.assertEqual(tls.stdout, CANARY_BODY.decode(), "HTTPS through CONNECT: " + tls.stderr)
        pip = run("python3 -m pip download --no-deps --disable-pip-version-check --dest /home/agent/work/dl "
                  "--index-url http://%s/simple/ --trusted-host %s juno-canary && ls /home/agent/work/dl" % (PUBLIC_NAME, PUBLIC_NAME))
        self.assertIn(WHEEL_NAME, pip.stdout, pip.stderr[-800:])
        npm = run("npm view juno-canary description --registry http://%s/npm/ --fetch-retries=0" % PUBLIC_NAME)
        self.assertEqual(npm.stdout.strip(), "juno canary", npm.stderr[-800:])
        git = run("git ls-remote http://%s/repo.git" % PUBLIC_NAME)
        self.assertIn("refs/heads/main", git.stdout, git.stderr[-800:])
        page = self.computer.cdp("text", "http://%s/" % PUBLIC_NAME, str(30 * SLACK))
        self.assertEqual(page["text"], CANARY_BODY.decode(), "Chromium through the gate and the proxy")
        if not host_has_internet():
            print("\n[boundary] optional: the public-Internet half of this control was not run (no Internet here); "
                  "the local canary on a global address stood in for it", file=sys.stderr)

    def test_egress_log_records_each_connection_without_urls(self):
        before = len(HOST.log_records())
        self.computer.run(["curl", "-sS", "--max-time", "20", "-o", "/dev/null",
                           "http://%s/secret-path?token=hunter2" % PUBLIC_NAME], check=False)
        address = self.computer.address()
        records = [r for r in HOST.log_records()[before:] if r["src"] == address and r["host"] == PUBLIC_NAME]
        self.assertEqual(len(records), 1, "the connection was logged once")
        record = records[0]
        self.assertEqual(set(record), {"start", "end", "computer", "src", "host", "port", "up", "down", "verdict"})
        self.assertEqual((record["computer"], record["src"], record["host"], record["port"], record["verdict"]),
                         (self.computer.name, self.computer.address(), PUBLIC_NAME, 80, "ok"))
        self.assertGreater(record["down"], 0)
        with open(HOST.log_file) as file:
            text = file.read()
        for leaked in ("secret-path", "token", "hunter2"):
            self.assertNotIn(leaked, text, "the egress log holds no path or query")

    def test_bandwidth_budget_refuses_a_computer_over_it(self):
        HOST.restart_proxy(max_mb=1)
        get_big = ["curl", "-sS", "--max-time", "30", "-o", "/dev/null", "-w", "%{http_code} %{size_download}",
                   "http://%s/big" % PUBLIC_NAME]
        first = self.computer.run(get_big, check=False)
        second = self.computer.run(get_big, check=False)
        self.assertNotEqual(first.stdout.strip(), "200 %d" % (2 * 1024 * 1024), "a 2 MB download passed a 1 MB budget")
        self.assertTrue(second.stdout.startswith("403"), second.stdout + second.stderr)
        verdicts = [r["verdict"] for r in HOST.log_records() if r["computer"] == self.computer.name]
        self.assertIn("over_budget", verdicts)

    def test_the_budget_survives_a_proxy_restart(self):
        HOST.restart_proxy(max_mb=1)
        get_big = ["curl", "-sS", "--max-time", "30", "-o", "/dev/null", "-w", "%{http_code}", "http://%s/big" % PUBLIC_NAME]
        self.computer.run(get_big, check=False)
        self.assertTrue(self.computer.run(get_big, check=False).stdout.startswith("403"))
        HOST.restart_proxy(max_mb=1)  # SIGTERM saves the budget; the new process loads it
        with open(os.path.join(HOST.state_dir, "budget.json")) as file:
            self.assertIn(self.computer.name, json.load(file)["buckets"])
        after = self.computer.run(get_big, check=False)
        self.assertTrue(after.stdout.startswith("403"), "a restart reset the computer's budget: " + after.stdout)

    def test_a_new_container_on_a_reused_address_starts_with_an_empty_budget_and_its_own_name(self):
        HOST.restart_proxy(max_mb=1)
        first = Computer("reuse-a")
        second = Computer("reuse-b")
        try:
            first.create()
            address = first.address()
            get_big = ["curl", "-sS", "--max-time", "30", "-o", "/dev/null", "-w", "%{http_code}", "http://%s/big" % PUBLIC_NAME]
            first.run(get_big, check=False)
            self.assertTrue(first.run(get_big, check=False).stdout.startswith("403"), "control: A is over its budget")
            first.stop()  # through the broker: release, stop, rebuild
            self.assertNotIn(address, HOST.read_map()["entries"], "a stopped computer keeps no address in the map")
            second.create(start=False)
            docker("network", "disconnect", NETWORK, second.name)
            docker("network", "connect", "--ip", address, NETWORK, second.name)
            second.start()
            self.assertEqual(second.address(), address, "B was given A's address")
            self.assertEqual(HOST.read_map()["entries"][address]["name"], second.name)
            before = len(HOST.log_records())
            small = second.run(["curl", "-sS", "--max-time", "20", "-o", "/dev/null", "-w", "%{http_code}", "http://%s/" % PUBLIC_NAME],
                               check=False)
            self.assertEqual(small.stdout, "200", "B inherited A's refusals")
            records = [r for r in HOST.log_records()[before:] if r["src"] == address]
            # Chromium's own background connections from B are logged too; every
            # line from the address is B's, none is refused for A's budget.
            self.assertEqual({r["computer"] for r in records}, {second.name})
            self.assertNotIn("over_budget", [r["verdict"] for r in records])
            self.assertEqual([r["verdict"] for r in records if r["host"] == PUBLIC_NAME], ["ok"])
        finally:
            second.destroy()
            first.destroy()


class SandboxAndLauncher(unittest.TestCase):
    """Chromium's own sandbox, the agent's namespace ban, the environment every
    agent command gets, and what it can install (COMPUTERS_2026-10.md S2.3, D11, D13)."""

    @classmethod
    def setUpClass(cls):
        cls.computer = Computer("sbx")
        try:
            cls.computer.create()
        except BaseException:
            cls.computer.destroy()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.computer.destroy()

    def renderer_and_gate_namespaces(self, computer):
        # The gate runs in the container's own user namespace, as this exec does
        # (it is non-dumpable, so its /proc links are not readable).
        script = ("import os,subprocess\n"
                  "def ns(p):\n    try:\n        return os.readlink('/proc/%s/ns/user' % p)\n    except OSError:\n        return None\n"
                  "rend=subprocess.run(['pgrep','-u','1001','-f','chrome.*--type=renderer'],capture_output=True,text=True).stdout.split()\n"
                  "seen={ns(p) for p in rend if p!=str(os.getpid())}-{None}\n"
                  "print(ns('self'), ' '.join(sorted(seen)))")
        computer.cdp("open", "data:text/html,<p>renderer</p>")
        out = computer.run_as_browser(["python3", "-c", script]).stdout.split()
        return out[0], out[1:]

    def test_browser_sandbox_state_matches_what_the_kernel_allows(self):
        state = self.computer.run_as_browser(["cat", "/run/juno-state/browser-sandbox"]).stdout.strip()
        self.assertEqual(state, "on" if HOST.sandbox else "off:kernel", HOST.sandbox_reason)
        gate, renderers = self.renderer_and_gate_namespaces(self.computer)
        self.assertTrue(renderers, "a renderer is running")
        if HOST.sandbox:
            self.assertNotIn(gate, renderers, "with the sandbox on, renderers run in their own user namespace")
            launched = self.computer.run_as_browser(["pgrep", "-a", "-u", "1001", "-f", "--no-sandbox"], check=False).stdout
            self.assertNotIn("chrome --no-sandbox", launched.replace("chrome-for-testing/", ""), launched)
        else:
            self.assertEqual(renderers, [gate], "with the sandbox off, renderers share the gate's namespace (pipe-v3)")
        # And a computer under Docker's default profile reports off:kernel, whatever this host allows.
        if HOST.sandbox:
            plain = Computer("sbx-default", policy={k: v for k, v in POLICY.items() if k not in ("browserSandbox", "seccompProfile")})
            try:
                self.computer.stop()
                plain.create()
                self.assertEqual(plain.run_as_browser(["cat", "/run/juno-state/browser-sandbox"]).stdout.strip(), "off:kernel")
                report = json.loads(plain.run(["python3", "-c", NAMESPACE_PROBE]).stdout)
                for call, result in report.items():
                    self.assertIn(result, ("EPERM", "ENOSYS"), "default profile, %s: %s" % (call, result))
            finally:
                plain.destroy()
                self.computer.start()

    def test_agent_shell_cannot_create_a_user_namespace(self):
        report = json.loads(self.computer.run(["python3", "-c", NAMESPACE_PROBE]).stdout)
        for call in ("unshare -Ur", "unshare -n", "unshare -m", "clone(CLONE_NEWUSER)", "clone(CLONE_NEWNET)",
                     "unshare(CLONE_NEWUSER)", "setns"):
            self.assertEqual(report[call], "EPERM", call)
        self.assertEqual(report["clone3"], "ENOSYS")
        # The provider's own check at every wake: a helper probe that must fail.
        probe = self.computer.run(["unshare", "-Ur", "true"], check=False, mode="helper")
        self.assertNotEqual(probe.returncode, 0)
        self.assertIn("Operation not permitted", probe.stderr)
        if HOST.sandbox:
            # Positive control: the container's profile DOES allow namespaces (for
            # Chromium), so the launcher's ban is what stops the agent. Directly,
            # without the launcher (which the broker refuses), uid 1000 gets one.
            direct = docker("exec", "--user", "1000", self.computer.name, "unshare", "-Ur", "id", "-u", check=False)
            self.assertEqual((direct.returncode, direct.stdout.strip()), (0, "0"), direct.stderr)
            with self.assertRaises(ValueError):
                broker.validate(["exec", "--user", "1000", self.computer.name, "unshare", "-Ur", "id"], POLICY)

    def test_a_planted_profile_rc_or_path_entry_does_not_run_for_an_approved_command(self):
        plant = ("mkdir -p ~/.local/bin ~/marks && "
                 "printf '#!/bin/sh\\ntouch ~/marks/path-ls\\nexec /usr/bin/ls \"$@\"\\n' > ~/.local/bin/ls && chmod +x ~/.local/bin/ls && "
                 "echo 'touch ~/marks/profile; export BASH_ENV=~/benv.sh' >> ~/.profile && "
                 "echo 'touch ~/marks/bash_profile' >> ~/.bash_profile && "
                 "echo 'touch ~/marks/bashrc; export BASH_ENV=~/benv.sh' >> ~/.bashrc && "
                 "echo 'touch ~/marks/bash_env' > ~/benv.sh && rm -f ~/marks/*")
        self.computer.run(["sh", "-c", plant])
        # Exactly the shell tool's argv (DockerProvider.exec).
        approved = self.computer.run(["timeout", "--signal=TERM", "--kill-after=5", "30", "bash", "--noprofile", "--norc", "-c",
                                      "ls >/dev/null; command -v ls"], workdir="/home/agent/work")
        self.assertEqual(approved.stdout.strip(), "/usr/bin/ls", "a planted ~/.local/bin entry shadowed a system command")
        self.assertEqual(self.computer.run(["ls", "-A", "/home/agent/marks"]).stdout.strip(), "", "a planted file ran")
        # Even with BASH_ENV in the environment of a later command it would not
        # pass: the launcher replaces the environment.
        self.computer.run(["env", "BASH_ENV=/home/agent/benv.sh", "sh", "-c", "true"])
        self.computer.run(["bash", "--noprofile", "--norc", "-c", "true"])
        self.assertEqual(self.computer.run(["ls", "-A", "/home/agent/marks"]).stdout.strip(), "")
        # Positive control: the pipe-v3 argv (a login shell) WOULD have run them.
        self.computer.run(["bash", "-lc", "ls >/dev/null"], workdir="/home/agent/work")
        ran = self.computer.run(["ls", "-A", "/home/agent/marks"]).stdout.split()
        self.assertIn("bash_profile", ran, "control: a login shell reads the agent's login file, which is why the shell no longer is one")
        self.computer.run(["sh", "-c", "rm -rf ~/marks ~/.local/bin/ls ~/.profile ~/.bash_profile ~/.bashrc ~/benv.sh"])

    def test_agent_shell_home_is_home_agent_and_user_installs_work(self):
        shell = lambda command: self.computer.run(["bash", "--noprofile", "--norc", "-c", command], workdir="/home/agent/work",
                                                 check=False, timeout=240)
        wheel = canary_wheel()
        brokered(["exec", "-i", "--user", "1000", self.computer.name, LAUNCHER, "run", "--", "sh", "-c",
                  "base64 -d > /home/agent/work/%s" % WHEEL_NAME], input_text=__import__("base64").b64encode(wheel).decode())
        home = shell('echo "$HOME $(id -u) $(cd ~ && pwd)"')
        self.assertEqual(home.stdout.strip(), "/home/agent 1000 /home/agent")
        venv = shell("python3 -m venv /home/agent/work/venv && /home/agent/work/venv/bin/python -c 'import sys; print(sys.prefix)'")
        self.assertEqual(venv.stdout.strip(), "/home/agent/work/venv", venv.stderr[-800:])
        user = shell("python3 -m pip install --user --no-index --disable-pip-version-check /home/agent/work/%s && "
                     "command -v juno-canary-tool && juno-canary-tool" % WHEEL_NAME)
        self.assertIn("/home/agent/.local/bin/juno-canary-tool", user.stdout, user.stderr[-800:])
        self.assertIn("juno-canary-tool ran", user.stdout, "a tool in ~/.local/bin is found by name")
        npm = shell("mkdir -p /home/agent/work/pkg && cd /home/agent/work/pkg && "
                    "printf '{\"name\":\"local-canary\",\"version\":\"1.0.0\"}' > package.json && "
                    "npm config get cache && npm pack --silent && test -d /home/agent/.npm")
        self.assertIn("/home/agent/.npm", npm.stdout, npm.stderr[-800:])
        self.assertEqual(npm.returncode, 0, npm.stderr[-800:])


class TakeoverPrimitives(unittest.TestCase):
    """Freeze at take over and thaw at hand back, as DockerProvider sends them
    (COMPUTERS_2026-10.md D3, S2.4), and VNC answering the host side only."""

    @classmethod
    def setUpClass(cls):
        cls.computer = Computer("tko")
        try:
            cls.computer.create()
        except BaseException:
            cls.computer.destroy()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.computer.destroy()

    def tearDown(self):
        # Kill everything the agent left (stopped or not) before the thaw, as
        # the agent's uid (only it may signal its processes), then thaw.
        self.computer.run(["pkill", "-KILL", "-u", "1000"], check=False, mode="helper")
        self.computer.thaw()
        self.computer.run(["pkill", "-KILL", "-u", "1000"], check=False, mode="helper")
        wait_for(lambda: not agent_processes(self.computer), 5)

    def background(self, command):
        """An agent command left running (as a backgrounded shell job would be)."""
        self.computer.run(["sh", "-c", "nohup sh -c %s >/dev/null 2>&1 &" % json.dumps(command)])

    def count_lines(self, path):
        result = self.computer.run(["sh", "-c", "wc -l < %s 2>/dev/null || echo 0" % path], mode="helper")
        return int(result.stdout.strip() or 0)

    def test_freeze_stops_the_agents_processes_and_thaw_resumes_them(self):
        self.background("while true; do date +%s.%N >> /home/agent/work/ticks; sleep 0.1; done")
        self.assertTrue(wait_for(lambda: self.count_lines("/home/agent/work/ticks") > 3, 5))
        self.computer.freeze()
        frozen_at = self.count_lines("/home/agent/work/ticks")
        time.sleep(2 * SLACK)
        self.assertEqual(self.count_lines("/home/agent/work/ticks"), frozen_at, "the loop kept writing while frozen")
        self.assertTrue(all(state.startswith("T") for _, state, _ in agent_processes(self.computer)), agent_processes(self.computer))
        refused = self.computer.run(["true"], check=False)
        self.assertEqual((refused.returncode, refused.stderr.strip()), (75, "frozen"), "a new command while frozen")
        self.assertEqual(self.computer.run(["true"], check=False, mode="helper").returncode, 0, "the provider's reads still work")
        self.computer.thaw()
        self.assertTrue(wait_for(lambda: self.count_lines("/home/agent/work/ticks") > frozen_at + 3, 5), "thaw resumed the loop")

    def test_freeze_holds_against_a_fork_loop(self):
        self.background("while true; do (sleep 0.05 &) ; done")
        time.sleep(1)
        self.computer.freeze()
        for _ in range(int(10 * SLACK)):
            running = [row for row in agent_processes(self.computer) if not row[1].startswith(("T", "Z"))]
            self.assertEqual(running, [], "a uid-1000 task outside state T after the freeze")
            time.sleep(0.2)

    def test_a_command_racing_the_freeze_does_not_run_unfrozen(self):
        # Commands launched in a tight loop from the host while the freeze runs.
        racers = []
        stop = threading.Event()

        # A bounded number (an unbounded loop only measures how fast this host
        # can queue docker execs), each long enough that none can finish
        # during the test: an exit 0 would mean it ran unfrozen.
        def racer():
            return brokered(["exec", "--user", "1000", self.computer.name, LAUNCHER, "run", "--", "sh", "-c",
                             "sleep 300; touch /home/agent/work/raced"], background=True)

        def launch():
            # Before, during and until the end of the freeze, at most 20 each.
            for _ in range(20):
                if stop.is_set():
                    return
                racers.append(racer())
                time.sleep(0.25)
        threads = [threading.Thread(target=launch) for _ in range(2)]
        for thread in threads:
            thread.start()
        time.sleep(1)
        freeze_began = time.monotonic()
        self.computer.freeze()
        frozen_at = time.monotonic()
        stop.set()
        for thread in threads:
            thread.join()
        # And two certainly after the marker, whatever this host's timing was.
        racers.extend([racer(), racer()])
        print("[boundary] racing: %d racers; the freeze took %.1f s" % (len(racers), frozen_at - freeze_began), file=sys.stderr)
        try:
            # A launcher that started after the marker exits 75 once it has
            # started up (python and its filter take a moment under the CPU cap);
            # one already past the marker was a uid-1000 process at the freeze
            # and is stopped. Wait for every racer to be one or the other.
            codes = {}
            deadline = time.monotonic() + 30 * SLACK
            while time.monotonic() < deadline:
                for index, racer in enumerate(racers):
                    if index not in codes and racer.poll() is not None:
                        codes[index] = racer.returncode
                        if racer.returncode != 75:
                            print("[boundary] racing: racer %d exited %s %.1f s after the freeze: %s"
                                  % (index, racer.returncode, time.monotonic() - frozen_at, racer.stderr.read()[-300:]), file=sys.stderr)
                launching = [row for row in agent_processes(self.computer)
                             if "agent-exec" in row[2] and not row[1].startswith(("T", "Z"))]
                if not launching:
                    break
                time.sleep(0.2)
            running = [row for row in agent_processes(self.computer) if not row[1].startswith(("T", "Z"))]
            self.assertEqual(running, [], "a command that raced the freeze is running unfrozen")
            self.assertIn(75, codes.values(), "commands that started after the marker were refused (exit 75)")
            self.assertTrue(set(codes.values()) <= {75}, codes)
            stopped = [row for row in agent_processes(self.computer) if "sleep 300" in row[2]]
            self.assertTrue(stopped, "control: commands that started before the marker exist, stopped")
            self.assertTrue(all(row[1].startswith("T") for row in stopped), stopped)
            time.sleep(1)
            self.assertEqual(self.computer.run(["test", "-e", "/home/agent/work/raced"], check=False, mode="helper").returncode, 1)
        finally:
            for racer in racers:
                if racer.poll() is None:
                    racer.kill()
                    racer.wait()

    def test_freeze_releases_a_held_modifier_and_button(self):
        # A modifier, a plain key (left down, autorepeat would type it for the
        # person) and a button, held by the agent as a cut chord or drag would.
        self.computer.run(["xdotool", "keydown", "Control_L", "keydown", "a", "mousedown", "1"])
        held = json.loads(self.computer.run_as_browser(["python3", "-I", "-c", HELD_INPUT_PROBE], display=True).stdout)
        self.assertEqual((held["Control_L"], held["a"], held["button1"]), (True, True, True), "control: the X server reports them held")
        self.computer.freeze()
        after = json.loads(self.computer.run_as_browser(["python3", "-I", "-c", HELD_INPUT_PROBE], display=True).stdout)
        self.assertEqual((after["Control_L"], after["a"], after["button1"]), (False, False, False), "a key or button stayed held for the person")

    def typed_length(self, target):
        return int(self.computer.cdp("eval", target + " document.getElementById('i').value.length")["value"] or 0)

    def test_a_resumed_typer_cannot_type(self):
        # /tmp is noexec; the agent's own volume is not, so a copy there runs.
        self.computer.run(["cp", "/usr/bin/xdotool", "/home/agent/work/t"])
        for typer in ("xdotool", "/home/agent/work/t"):  # a renamed copy is not caught by name
            with self.subTest(typer=typer):
                target = self.computer.cdp("open", "data:text/html,<input id=i autofocus style='width:90%'>")["targetId"]
                self.assertTrue(wait_for(lambda: self.computer.cdp("eval", target + " document.activeElement && document.activeElement.id")["value"] == "i", 10))
                self.background("%s type --delay 200 %s" % (typer, "a" * 120))
                self.assertTrue(wait_for(lambda: self.typed_length(target) >= 3, 10), "control: the typer reaches the page")
                self.computer.freeze()
                frozen_at = self.typed_length(target)
                print("[boundary] typer %s: %d characters at the freeze; agent processes %s"
                      % (typer, frozen_at, agent_processes(self.computer)), file=sys.stderr)
                self.computer.thaw()
                time.sleep(3 * SLACK)
                self.assertEqual(self.typed_length(target), frozen_at, "%s typed after the person took control" % typer)
                self.assertFalse([row for row in agent_processes(self.computer) if (typer + " type") in row[2]],
                                 "the cut typer exited at thaw")

    def test_vnc_refuses_the_agents_loopback_and_accepts_the_host_side(self):
        # DockerProvider.startVnc, step for step.
        self.computer.run_as_browser(["pkill", "-x", "x11vnc"], check=False)
        self.computer.run_as_browser(["sh", "-c", "umask 077 && rm -f /run/juno/vncpass && set -C && cat > /run/juno/vncpass"],
                                     input_text="abcdefgh\n__BEGIN_VIEWONLY__\nijklmnop\n")
        self.computer.run_as_browser(["x11vnc", "-display", ":0", "-forever", "-shared", "-rfbport", "5900", "-noipv6",
                                      "-allow", GATEWAY, "-passwdfile", "rm:/run/juno/vncpass", "-bg", "-o", "/tmp/x11vnc.log"],
                                     display=True)
        address = self.computer.address()

        # libvncserver sends its version banner before x11vnc's -allow check, so
        # the verdict is the next step: an allowed client is offered security
        # types (VNC authentication, 2); a refused one is disconnected.
        handshake = ("import socket,sys\ndef shake(host):\n"
                     "    try:\n        s=socket.create_connection((host,5900),timeout=5); banner=s.recv(12)\n"
                     "        s.sendall(b'RFB 003.008\\n'); s.settimeout(5); offer=s.recv(16); s.close()\n"
                     "        return 'offered' if offer[:1] not in (b'', b'\\x00') else 'disconnected'\n"
                     "    except OSError as e:\n        return type(e).__name__\n"
                     "for host in sys.argv[1:]:\n    print(host, shake(host))")
        from_host = lambda: subprocess.run([sys.executable, "-c", handshake, address], capture_output=True, text=True).stdout
        self.assertTrue(wait_for(lambda: "offered" in from_host(), 10), "the host side is offered authentication: " + from_host())
        out = self.computer.run(["python3", "-c", handshake, "127.0.0.1", address]).stdout
        verdicts = dict(zip(out.split()[0::2], out.split()[1::2]))
        for host in ("127.0.0.1", address):
            # Closed after the banner (EOF) or reset: either way no security types were offered.
            self.assertIn(verdicts.get(host), ("disconnected", "ConnectionResetError", "BrokenPipeError"),
                          "the agent reached the person's VNC session from %s: %s" % (host, out))
        log = self.computer.run_as_browser(["cat", "/tmp/x11vnc.log"]).stdout
        self.assertIn("denying client: 127.0.0.1 does not match %s" % GATEWAY, log)
        self.computer.run_as_browser(["pkill", "-x", "x11vnc"], check=False)


class ImageFreshness(unittest.TestCase):
    """isOutdated compares image IDs, so a same-label rebuild reaches every container (D16)."""

    def test_a_container_from_an_older_image_is_outdated(self):
        computer = Computer("old")
        original = docker("image", "inspect", "--format", "{{.Id}}", IMAGE).stdout.strip()
        build = tempfile.mkdtemp(prefix="juno-rebuild-")
        try:
            computer.create(start=False)
            container_image = lambda: brokered(["inspect", "-f", "{{.Image}}", computer.name]).stdout.strip()
            current_image = lambda: brokered(["image", "inspect", "--format", "{{.Id}}", IMAGE]).stdout.strip()
            self.assertEqual(container_image(), current_image(), "control: a fresh container is current")
            Path(build, "rebuilt").write_text(os.urandom(8).hex())
            docker("tag", original, "juno-computer-boundary-base:1")
            Path(build, "Dockerfile").write_text("FROM juno-computer-boundary-base:1\nCOPY rebuilt /opt/juno/rebuilt\n")
            docker("build", "-t", IMAGE, build)
            label = brokered(["image", "inspect", "--format", '{{index .Config.Labels "juno.security"}}', IMAGE]).stdout.strip()
            self.assertEqual(label, "pipe-v4", "same label")
            self.assertNotEqual(container_image(), current_image(), "the old container is outdated")
        finally:
            computer.destroy()
            rebuilt = docker("image", "inspect", "--format", "{{.Id}}", IMAGE, check=False).stdout.strip()
            docker("tag", original, IMAGE)
            docker("image", "rm", "juno-computer-boundary-base:1", check=False)
            if rebuilt and rebuilt != original:
                docker("image", "rm", rebuilt, check=False)
            shutil.rmtree(build, ignore_errors=True)


class ComputerTeardownKills(unittest.TestCase):
    """Stop and destroy take everything the agent left running with them."""

    def setUp(self):
        self.computer = Computer("stop")
        self.addCleanup(self.computer.destroy)
        self.computer.create()

    # Longer than a graceful stop (the gate closes Chromium through its pipe and
    # waits for it to exit, usually 1-3 s) and well short of Docker's 20 s
    # SIGKILL fallback, so a pass means the processes died with the container,
    # not that the write was slow.
    DELAY = 10

    def leave_a_delayed_write(self):
        # Detached from the exec session, as an agent's background job would be:
        # it outlives the command that started it and is reparented to tini.
        self.computer.run(["bash", "-c", 'nohup bash -c "sleep %d; echo late > /home/agent/after-stop" >/dev/null 2>&1 & '
                                         "echo started > /home/agent/started" % self.DELAY])
        self.assertEqual(self.computer.run_as_browser(["pgrep", "-u", "1000", "-f", "sleep %d" % self.DELAY], check=False).returncode, 0)
        return time.monotonic()

    def test_stop_kills_the_agents_processes_before_a_delayed_write(self):
        started = self.leave_a_delayed_write()
        brokered(["stop", self.computer.name], timeout=60)
        self.assertLess(time.monotonic() - started, self.DELAY, "docker stop took longer than the delayed write")
        self.assertEqual(brokered(["inspect", "-f", "{{.State.Status}}", self.computer.name]).stdout.strip(), "exited")
        time.sleep(max(0.0, started + self.DELAY + 1 - time.monotonic()))
        self.assertTrue(self.computer.volume_has("started"), "control: the volume check sees the agent's files")
        self.assertFalse(self.computer.volume_has("after-stop"), "a process outlived docker stop")

    def test_destroy_kills_the_agents_processes_before_a_delayed_write(self):
        started = self.leave_a_delayed_write()
        brokered(["rm", "-f", self.computer.name], timeout=60)
        self.assertLess(time.monotonic() - started, self.DELAY)
        self.assertNotEqual(docker("inspect", "--type", "container", self.computer.name, check=False).returncode, 0,
                            "the container survived rm -f")
        time.sleep(max(0.0, started + self.DELAY + 1 - time.monotonic()))
        self.assertTrue(self.computer.volume_has("started"))
        self.assertFalse(self.computer.volume_has("after-stop"), "a process outlived docker rm -f")

    def test_a_missing_container_is_exit_3_through_the_broker(self):
        gone = brokered(["inspect", "-f", "{{.State.Status}}", "juno-agent-boundary-never-existed"], check=False)
        self.assertEqual(gone.returncode, 3, gone.stderr)
        self.assertIn("missing", gone.stderr)


if __name__ == "__main__":
    unittest.main()
