#!/usr/bin/env python3
"""The production arrangement of an agent-computer host, put on a disposable Linux machine
for the real-container suites, and taken off again.

    sudo -E python3 tests/computer_host_fixture.py up [--demo-page] [--state FILE]
    sudo -E python3 tests/computer_host_fixture.py host-up          # the remote provider's computer host
    sudo -E python3 tests/computer_host_fixture.py host-service stop|start
    sudo -E python3 tests/computer_host_fixture.py host-down
    sudo -E python3 tests/computer_host_fixture.py down [--state FILE]
    python3 tests/computer_host_fixture.py status [--state FILE]

What `up` puts on the machine, each exactly as deploy/agent-computers/setup-vm.sh does it
on the VM: the `juno-computers` network (172.30.0.0/24, bridge br-juno, no
container-to-container traffic), firewall.sh's rules, the egress-address map watcher
(egress-map.py) and the egress proxy (egress-proxy.py) on 172.30.0.1:3128 with their
units' arguments and environment, and Chromium's sandbox decision (setup-vm.sh's probe,
unless JUNO_COMPUTER_TEST_SANDBOX=off). Plus what the suites need to prove things without
the Internet: canary listeners on the host's addresses, three canary addresses on `lo`, a
local "public host" (a global test address on `lo`, named in /etc/hosts for the proxy
only), and with `--demo-page` a small static form page on another global test address,
`http://demo-page.test/` (COMPUTERS_2026-10.md S4.3; the tests never use it, a local demo
does). Nothing in the proxy, the firewall or the site policy changes for any of them.

`up` returns once everything is in place; a detached process holds the listeners and
the proxy until `down`. The state file (default /run/juno-computer-fixture/state.json,
or JUNO_COMPUTER_FIXTURE_STATE) says where the egress map and log are and what the
sandbox decision was; tests/computer-real-e2e.test.ts reads it and refuses to run
without it. `down` stops that process (which removes everything it added, in reverse
order), removes what the suites may have left on the network (`juno-agent-*` containers
and the local host's nginx container), then lists the network, containers, volumes,
iptables rules, lo addresses, hosts lines and nginx containers again and exits 1 if
anything the fixture or a suite added is still there.

tests/test_computer_boundary.py builds the same Host in its own process (setUpModule),
so the two suites test one arrangement. Needs root, and refuses a machine that already
has a `juno-computers` network.
"""
import argparse
import hashlib
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
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy/agent-computers"
IMAGE = os.environ.get("JUNO_COMPUTER_IMAGE", "juno-computer:1")
NETWORK = "juno-computers"          # setup-vm.sh and src/lib/env.ts
SUBNET = "172.30.0.0/24"
BRIDGE = "br-juno"
GATEWAY = "172.30.0.1"
PROXY_PORT = 3128
FALLBACK_IP_IMAGE = "alpine:3.20"   # only where the host has no iproute2
LAUNCHER = "/opt/juno/agent-exec"
SECCOMP_PROFILE = str(DEPLOY / "seccomp-chromium.json")
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
# The demo page (`up --demo-page`): the next address of the same block, its own name.
DEMO_ADDRESS = "192.88.99.81"
DEMO_NAME = "demo-page.test"
DEMO_HOSTS_LINE = "%s %s  # juno computer demo page" % (DEMO_ADDRESS, DEMO_NAME)
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
# deploy/computer-host/local/run-local.sh --nginx (the remote provider's suite).
NGINX_CONTAINER = "juno-computer-host-nginx"
DEFAULT_STATE = "/run/juno-computer-fixture/state.json"


def docker(*args, check=True, timeout=300, input_text=None):
    result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout, input=input_text)
    if check and result.returncode != 0:
        raise AssertionError("docker %s failed (%d): %s" % (" ".join(args[:3]), result.returncode, result.stderr.strip()[-800:]))
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


# The demo page: a static form a scripted or real agent can fill in through its
# browser, reached the way every page is, through the egress proxy. It records
# nothing and stores nothing; a submitted form is echoed back.
DEMO_PAGE = b"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Demo order form</title>
<style>body{font:18px/1.5 sans-serif;margin:48px;max-width:560px}label{display:block;margin:16px 0 4px}
input,select{font:inherit;padding:6px 8px;width:100%;box-sizing:border-box}button{font:inherit;margin-top:20px;padding:8px 20px}</style>
</head><body><h1>Demo order form</h1>
<p>A local test page served by tests/computer_host_fixture.py. Nothing here is real.</p>
<form method="get" action="/thanks">
<label for="name">Name</label><input id="name" name="name" autocomplete="off">
<label for="item">Item</label><select id="item" name="item"><option>Notebook</option><option>Pencil</option><option>Stapler</option></select>
<label for="qty">Quantity</label><input id="qty" name="qty" type="number" min="1" value="1">
<button type="submit">Send</button>
</form></body></html>
"""


class DemoPageHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path == "/":
            body, kind = DEMO_PAGE, "text/html; charset=utf-8"
        elif path == "/thanks":
            from html import escape
            from urllib.parse import parse_qs
            fields = {key: values[0] for key, values in parse_qs(query).items()}
            rows = "".join("<li>%s: %s</li>" % (escape(key), escape(value)) for key, value in sorted(fields.items()))
            body = ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Thanks</title></head>"
                    "<body><h1>Thanks</h1><p>The demo form received:</p><ul>%s</ul></body></html>" % rows).encode()
            kind = "text/html; charset=utf-8"
        else:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
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
    """Everything the fixture puts on the host, and how to take it off again."""

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
        self.demo_page = False

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
        self._add_hosts_line(HOSTS_LINE)

    def add_demo_page(self):
        """S4.3: a static form page on DEMO_ADDRESS:80, named demo-page.test for the proxy."""
        ip("addr", "add", DEMO_ADDRESS + "/32", "dev", "lo")
        self.undo.append(lambda: ip("addr", "del", DEMO_ADDRESS + "/32", "dev", "lo", check=False))
        self._serve(DEMO_ADDRESS, 80, DemoPageHandler)
        self._add_hosts_line(DEMO_HOSTS_LINE)
        self.demo_page = True

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

    def _add_hosts_line(self, line):
        with open("/etc/hosts", "a") as hosts:
            hosts.write("\n" + line + "\n")
        self.undo.append(lambda: self._remove_hosts_line(line))

    @staticmethod
    def _remove_hosts_line(line=HOSTS_LINE):
        with open("/etc/hosts") as hosts:
            lines = hosts.read().split("\n")
        kept = [existing for existing in lines if existing != line]
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


# ── The command line: up, down, status (and serve, the detached holder) ─────────


def state_path(raw=None):
    return Path(raw or os.environ.get("JUNO_COMPUTER_FIXTURE_STATE") or DEFAULT_STATE)


def read_state(path):
    try:
        with open(path) as file:
            return json.load(file)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def inventory():
    """What the fixture and the suites can leave on a machine, listed (names only)."""
    def lines(argv):
        if not shutil.which(argv[0]):
            return []
        result = subprocess.run(argv, capture_output=True, text=True)
        return [line.strip() for line in result.stdout.splitlines() if line.strip()] if result.returncode == 0 else []
    rules = [line for tool in ("iptables", "ip6tables") for line in lines([tool, "-S"])
             if BRIDGE in line or "JUNO-COMPUTERS" in line]
    # `1: lo    inet 127.0.0.1/8 scope host lo ...`: the fourth field.
    lo = [entry.split()[3] for entry in lines(["ip", "-4", "-o", "addr", "show", "dev", "lo"]) if len(entry.split()) > 3]
    try:
        with open("/etc/hosts") as hosts:
            hosts_lines = [line.strip() for line in hosts if "# juno computer" in line]
    except OSError:
        hosts_lines = []
    return {
        "networks": sorted(name for name in lines(["docker", "network", "ls", "--format", "{{.Name}}"]) if name == NETWORK),
        "containers": sorted(lines(["docker", "ps", "-a", "--filter", "label=app=juno", "--format", "{{.Names}}"])),
        "volumes": sorted(name for name in lines(["docker", "volume", "ls", "--format", "{{.Name}}"]) if name.startswith("juno-agent-")),
        "iptablesRules": sorted(rules),
        "loAddresses": sorted(lo),
        "hostsLines": sorted(hosts_lines),
        "nginxContainers": sorted(lines(["docker", "ps", "-a", "--filter", "name=^/%s$" % NGINX_CONTAINER, "--format", "{{.Names}}"])),
    }


def leftovers(before, after):
    """What is there now and was not before `up` (only what this fixture or a suite on it adds)."""
    added = {}
    for key, now in after.items():
        extra = sorted(set(now) - set(before.get(key, [])))
        if key == "containers" or key == "volumes":
            # Another job's computers on its own network are not this fixture's;
            # the suites name theirs juno-agent-e2e* and juno-agent-boundary-*.
            extra = [name for name in extra if name.startswith(("juno-agent-e2e", "juno-agent-boundary-"))]
        if extra:
            added[key] = extra
    return added


def serve(args):
    """The detached holder: builds the Host, writes the state file, waits for SIGTERM."""
    path = state_path(args.state)
    stop = []
    signal.signal(signal.SIGTERM, lambda *_: stop.append(1))
    signal.signal(signal.SIGINT, lambda *_: stop.append(1))
    host = Host()
    try:
        host.run()
        if args.demo_page:
            host.add_demo_page()
        state = {
            "pid": os.getpid(),
            "ready": True,
            "network": NETWORK,
            "gateway": GATEWAY,
            "image": IMAGE,
            "egressMap": host.map_file,
            "egressLog": host.log_file,
            "policyFile": host.policy_file,
            "sandbox": host.sandbox,
            "sandboxReason": host.sandbox_reason,
            "seccompProfile": SECCOMP_PROFILE if host.sandbox else None,
            "demoPage": {"url": "http://%s/" % DEMO_NAME, "address": DEMO_ADDRESS} if host.demo_page else None,
            "before": json.loads(os.environ.get("JUNO_COMPUTER_FIXTURE_BEFORE") or "{}"),
            "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        partial = str(path) + ".part"
        with open(partial, "w") as file:
            json.dump(state, file, indent=1)
        os.chmod(partial, 0o644)
        os.replace(partial, path)
        print("fixture up: sandbox %s (%s)" % ("on" if host.sandbox else "off", host.sandbox_reason), flush=True)
        reported = False
        while not stop:
            if not reported and host.proxy and host.proxy.poll() is not None:
                # Said once, in the log; the network and firewall stay up so a
                # suite in flight fails on its own assertions, not on a teardown.
                reported = True
                print("the egress proxy exited (%s): %s" % (host.proxy.returncode, host.proxy.stderr.read()[-800:]), flush=True)
            time.sleep(0.5)
    finally:
        host.close()
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        print("fixture down", flush=True)


def up(args):
    if os.geteuid() != 0:
        print("computer_host_fixture: up needs root (a Docker network, iptables rules, lo addresses, /etc/hosts)", file=sys.stderr)
        return 2
    for tool in ("docker", "iptables", "openssl"):
        if not shutil.which(tool):
            print("computer_host_fixture: %s is required" % tool, file=sys.stderr)
            return 2
    if docker("image", "inspect", IMAGE, check=False).returncode != 0:
        print("computer_host_fixture: build deploy/agent-computers as %s first" % IMAGE, file=sys.stderr)
        return 2
    path = state_path(args.state)
    existing = read_state(path)
    if existing and alive(existing.get("pid")):
        print("computer_host_fixture: already up (pid %s, %s)" % (existing["pid"], path), file=sys.stderr)
        return 1
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o755)
    log = path.with_name("fixture.log")
    before = inventory()
    command = [sys.executable, "-I", str(Path(__file__).resolve()), "serve", "--state", str(path)]
    if args.demo_page:
        command.append("--demo-page")
    with open(log, "w") as output:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                 start_new_session=True, env={**os.environ, "JUNO_COMPUTER_FIXTURE_BEFORE": json.dumps(before)})
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        state = read_state(path)
        if state and state.get("ready") and state.get("pid") == child.pid:
            print(json.dumps({key: state[key] for key in ("pid", "network", "egressMap", "sandbox", "sandboxReason",
                                                          "seccompProfile", "demoPage")}, indent=1))
            print("computer_host_fixture: up (state %s, log %s)" % (path, log))
            return 0
        if child.poll() is not None:
            break
        time.sleep(0.25)
    if child.poll() is None:
        child.terminate()
        child.wait(timeout=60)
    print("computer_host_fixture: up failed; its log:\n" + log.read_text()[-4000:], file=sys.stderr)
    return 1


def down(args):
    if os.geteuid() != 0:
        print("computer_host_fixture: down needs root", file=sys.stderr)
        return 2
    path = state_path(args.state)
    host_down(args)
    state = read_state(path) or {}
    before = state.get("before") or {}
    pid = state.get("pid")
    # Containers the suites left on the network would keep it from being removed.
    attached = docker("ps", "-aq", "--filter", "network=" + NETWORK, "--filter", "name=juno-agent-", check=False).stdout.split()
    if attached:
        print("computer_host_fixture: removing %d computer container(s) left on %s" % (len(attached), NETWORK))
        docker("rm", "-f", *attached, check=False)
    if NGINX_CONTAINER not in before.get("nginxContainers", []):
        docker("rm", "-f", NGINX_CONTAINER, check=False)
    if pid and alive(pid):
        os.kill(int(pid), signal.SIGTERM)
        deadline = time.monotonic() + 90
        while alive(pid) and time.monotonic() < deadline:
            time.sleep(0.25)
        if alive(pid):
            print("computer_host_fixture: the holder did not stop; killing it", file=sys.stderr)
            os.kill(int(pid), signal.SIGKILL)
    elif not state:
        print("computer_host_fixture: no state file at %s; checking for leftovers only" % path)
    # Whatever an interrupted holder could not undo: the same steps, idempotent.
    if docker("network", "inspect", NETWORK, check=False).returncode == 0 and NETWORK not in before.get("networks", []):
        docker("network", "rm", NETWORK, check=False)
    present = [rule for rule in FIREWALL_RULES if Host._has_rule(rule)]
    if present and not before.get("iptablesRules"):
        Host._remove_rules(present)
    for address in CANARY_ADDRESSES + (PUBLIC_CANARY, DEMO_ADDRESS):
        if not any(entry.startswith(address + "/") for entry in before.get("loAddresses", [])):
            ip("addr", "del", address + "/32", "dev", "lo", check=False)
    for line in (HOSTS_LINE, DEMO_HOSTS_LINE):
        Host._remove_hosts_line(line)
    for name in docker("volume", "ls", "-q", "--filter", "name=juno-agent-e2e", check=False).stdout.split():
        docker("volume", "rm", "-f", name, check=False)
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    after = inventory()
    print(json.dumps({"before": before, "after": after}, indent=1))
    left = leftovers(before, after)
    if left:
        print("computer_host_fixture: down left these behind: %s" % json.dumps(left), file=sys.stderr)
        return 1
    print("computer_host_fixture: down; nothing the fixture or a suite added is left")
    return 0


def status(args):
    path = state_path(args.state)
    state = read_state(path)
    if not state:
        print("computer_host_fixture: not up (no state at %s)" % path)
        return 1
    up_now = alive(state.get("pid"))
    print(json.dumps({**{key: value for key, value in state.items() if key != "before"}, "alive": up_now}, indent=1))
    host = read_state(host_state_path(path))
    if host:
        print(json.dumps({key: host.get(key) for key in ("url", "apiUrl", "caFile", "pythonPid", "bashPid")}, indent=1))
    return 0 if up_now else 1


# ── The computer host on this machine, for the remote provider's suite ──────────
#
# `host-up` runs deploy/computer-host/local/run-local.sh --nginx (the production
# profile: TLS through the generated nginx config, a private name-constrained CA,
# the broker's validate() in developer mode) on this fixture's network and egress
# map, on its own ports (JUNO_COMPUTER_HOST_{API,TUNNEL,TLS}_PORT, default
# 18750/18751/18443, so a developer's own run-local.sh on the defaults is not
# disturbed), and writes host.json and host.env beside the state file. The suite
# reads the URL, the token file and the CA from them; NODE_EXTRA_CA_CERTS must be
# set when Node starts, so the CI step (or a developer) sources host.env first.
#
# `host-service stop|start` is the "host service stopped mid-run" of the suite's
# test 14: stop detaches run-local.sh (SIGKILL, so its EXIT trap does not remove
# nginx) and then stops the service process (SIGTERM, as systemd would), leaving
# nginx answering 502, exactly a stopped juno-computer-host.service behind nginx;
# start runs the service again with the argv and environment run-local.sh gave it.
# `host-down` stops everything, removes the nginx container and deletes the data
# directory (the token and the TLS key). `down` runs it too.


def host_state_path(path):
    return Path(path).with_name("host.json")


def write_json(path, value, mode=0o600):
    partial = str(path) + ".part"
    with open(partial, "w") as file:
        json.dump(value, file, indent=1)
    os.chmod(partial, mode)
    os.replace(partial, path)


def host_ports():
    return {name: int(os.environ.get("JUNO_COMPUTER_HOST_%s_PORT" % name.upper()) or default)
            for name, default in (("api", 18750), ("tunnel", 18751), ("tls", 18443))}


def host_answers(url, token, cafile=None, path="/v1/available"):
    import urllib.error
    import urllib.request
    context = ssl.create_default_context(cafile=cafile) if url.startswith("https:") else None
    request = urllib.request.Request(url + path, headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context)).open(request, timeout=5) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError, ssl.SSLError):
        return False


def find_host_process(config):
    """The pid, argv, environment and working directory of the host service run with this config."""
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open("/proc/%s/cmdline" % entry, "rb") as file:
                argv = [part.decode() for part in file.read().split(b"\0") if part]
        except OSError:
            continue
        if any(part.endswith("juno-computer-host.py") for part in argv) and str(config) in argv:
            with open("/proc/%s/environ" % entry, "rb") as file:
                environment = dict(part.decode().split("=", 1) for part in file.read().split(b"\0") if b"=" in part)
            return int(entry), argv, environment, os.readlink("/proc/%s/cwd" % entry)
    return None


def stop_pid(pid, seconds=20):
    if not alive(pid):
        return
    os.kill(int(pid), signal.SIGTERM)
    deadline = time.monotonic() + seconds
    while alive(pid) and time.monotonic() < deadline:
        time.sleep(0.2)
    if alive(pid):
        os.kill(int(pid), signal.SIGKILL)


def host_up(args):
    if os.geteuid() != 0:
        print("computer_host_fixture: host-up needs root (the developer broker drives docker and the egress map)", file=sys.stderr)
        return 2
    path = state_path(args.state)
    state = read_state(path)
    if not state or not alive(state.get("pid")):
        print("computer_host_fixture: the fixture is not up (run `up` first)", file=sys.stderr)
        return 1
    hpath = host_state_path(path)
    existing = read_state(hpath)
    if existing and alive(existing.get("pythonPid")):
        print("computer_host_fixture: the host is already up (pid %s)" % existing["pythonPid"], file=sys.stderr)
        return 1
    if docker("ps", "-aq", "--filter", "name=^/%s$" % NGINX_CONTAINER, check=False).stdout.strip():
        print("computer_host_fixture: a %s container exists (another run-local.sh --nginx?); stop it first" % NGINX_CONTAINER,
              file=sys.stderr)
        return 1
    ports = host_ports()
    data = path.parent / "host-data"
    shutil.rmtree(data, ignore_errors=True)
    python = os.environ.get("JUNO_COMPUTER_HOST_PYTHON") or "python3"
    environment = {**os.environ, "JUNO_COMPUTER_HOST_DATA": str(data), "JUNO_COMPUTER_HOST_PYTHON": python,
                   "JUNO_EGRESS_MAP": state["egressMap"], "JUNO_COMPUTER_SECCOMP_PROFILE": state.get("seccompProfile") or "",
                   "JUNO_COMPUTER_HOST_API_PORT": str(ports["api"]), "JUNO_COMPUTER_HOST_TUNNEL_PORT": str(ports["tunnel"]),
                   "JUNO_COMPUTER_HOST_TLS_PORT": str(ports["tls"]),
                   "COMPUTER_MEMORY_MB": os.environ.get("COMPUTER_MEMORY_MB") or "1024"}
    log = path.with_name("host.log")
    with open(log, "w") as output:
        child = subprocess.Popen(["bash", str(ROOT / "deploy/computer-host/local/run-local.sh"), "--nginx"], env=environment,
                                 stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    url = "https://localhost:%d" % ports["tls"]
    token_file = data / "token"
    ca_file = data / "tls" / "ca.pem"
    deadline = time.monotonic() + 180
    ready = False
    while time.monotonic() < deadline and child.poll() is None:
        if token_file.exists() and ca_file.exists() and host_answers(url, token_file.read_text().strip(), str(ca_file)):
            ready = True
            break
        time.sleep(0.5)
    found = find_host_process(data / "config.json") if ready else None
    if not ready or not found:
        if child.poll() is None:
            stop_pid(child.pid)
        docker("rm", "-f", NGINX_CONTAINER, check=False)
        shutil.rmtree(data, ignore_errors=True)
        print("computer_host_fixture: the host did not come up; its log:\n" + log.read_text()[-4000:], file=sys.stderr)
        return 1
    pid, argv, process_env, cwd = found
    host = {"url": url, "apiUrl": "http://127.0.0.1:%d" % ports["api"], "tokenFile": str(token_file), "caFile": str(ca_file),
            "dataDir": str(data), "bashPid": child.pid, "pythonPid": pid, "pythonArgv": argv, "pythonEnv": process_env,
            "cwd": cwd, "log": str(log), "ports": ports}
    write_json(hpath, host)
    env_file = path.with_name("host.env")
    with open(env_file, "w") as file:
        file.write("export COMPUTER_HOST_URL=%s\nexport NODE_EXTRA_CA_CERTS=%s\nexport RELAY_COMPUTER_HOSTS=%s\n"
                   "export JUNO_COMPUTER_E2E_HOST_STATE=%s\n" % (url, ca_file, url, hpath))
    os.chmod(env_file, 0o644)
    print("computer_host_fixture: host up at %s (service pid %d; source %s before the suite)" % (url, pid, env_file))
    return 0


def host_service(args):
    path = host_state_path(state_path(args.state))
    host = read_state(path)
    if not host:
        print("computer_host_fixture: no host (run host-up first)", file=sys.stderr)
        return 1
    if args.action == "stop":
        if alive(host.get("bashPid")):
            # Detach run-local.sh first: its EXIT trap would remove nginx.
            os.kill(int(host["bashPid"]), signal.SIGKILL)
        stop_pid(host.get("pythonPid"), seconds=15)
        host.update(bashPid=None, pythonPid=None)
        write_json(path, host)
        print("computer_host_fixture: host service stopped (nginx left running)")
        return 0
    if alive(host.get("pythonPid")):
        print("computer_host_fixture: the host service is already running")
        return 0
    with open(host["log"], "a") as output:
        child = subprocess.Popen(host["pythonArgv"], env=host["pythonEnv"], cwd=host["cwd"], stdin=subprocess.DEVNULL,
                                 stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    token = Path(host["tokenFile"]).read_text().strip()
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline and child.poll() is None:
        if host_answers(host["apiUrl"], token):
            host["pythonPid"] = child.pid
            write_json(path, host)
            print("computer_host_fixture: host service started (pid %d)" % child.pid)
            return 0
        time.sleep(0.2)
    stop_pid(child.pid)
    print("computer_host_fixture: the host service did not start; see %s" % host["log"], file=sys.stderr)
    return 1


def host_down(args):
    path = host_state_path(state_path(args.state))
    host = read_state(path)
    if not host:
        print("computer_host_fixture: no host to stop")
        return 0
    stop_pid(host.get("pythonPid"))
    # run-local.sh ends when its service does, and its EXIT trap removes nginx.
    deadline = time.monotonic() + 30
    while alive(host.get("bashPid")) and time.monotonic() < deadline:
        time.sleep(0.2)
    stop_pid(host.get("bashPid"))
    docker("rm", "-f", NGINX_CONTAINER, check=False)
    shutil.rmtree(host["dataDir"], ignore_errors=True)  # the token and the TLS key
    for leftover in (path, path.with_name("host.env")):
        try:
            leftover.unlink()
        except FileNotFoundError:
            pass
    print("computer_host_fixture: host down")
    return 0


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("up", "down", "status", "serve", "host-up", "host-down", "host-service"):
        command = sub.add_parser(name)
        command.add_argument("--state", help="state file (default %s, or JUNO_COMPUTER_FIXTURE_STATE)" % DEFAULT_STATE)
        if name in ("up", "serve"):
            command.add_argument("--demo-page", action="store_true", help="also serve http://demo-page.test/ (S4.3)")
        if name == "host-service":
            command.add_argument("action", choices=("stop", "start"))
    args = parser.parse_args(argv)
    if args.command == "serve":
        serve(args)
        return 0
    return {"up": up, "down": down, "status": status, "host-up": host_up, "host-down": host_down,
            "host-service": host_service}[args.command](args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
