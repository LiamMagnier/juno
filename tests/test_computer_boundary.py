"""Agent computers for real: the image, the network, firewall.sh and egress-proxy.py.

tests/test_computer_infrastructure.py checks the broker and the proxy as Python
functions. This suite builds the production arrangement on a disposable Linux
host and attacks it from inside a real computer container, the way an agent's
shell command arrives (`docker exec --user 1000`, argv accepted by the real
broker): the `juno-computers` network exactly as setup-vm.sh creates it, the
host firewall from firewall.sh, the egress proxy on 172.30.0.1:3128, and a
computer created with the argv the broker requires (the same argv the provider
sends: tests/computer-broker-argv.test.ts holds the two together).

What it proves, each with a positive control so a refusal cannot be an accident
of the test machine:
  - direct connections to cloud metadata, RFC 1918 and link-local addresses, the
    host itself and other computers are dropped (canaries on the host answer an
    unfirewalled container on the default bridge, and do not answer a computer);
  - the proxy is the only way out, and it refuses metadata, private, loopback and
    obfuscated destinations that the proxy host itself can reach;
  - IPv6 has no route;
  - no host secret reaches the agent's shell or the browser user;
  - the root filesystem is read-only, the shell is uid 1000 with no capabilities
    and cannot read the browser's profile or the CDP handover;
  - the container Docker created has exactly the broker's limits;
  - a command past its time limit, `docker stop` and `docker rm -f` kill what the
    agent started before a delayed write lands.
Public-Internet controls (a public resolver answers, CONNECT to a public site
works, a direct public connection does not) need a host with Internet access:
they skip as "optional:" without it, and CI requires them
(JUNO_BOUNDARY_REQUIRE_ALL=1).

It needs root (a Docker network, iptables rules, addresses on lo, a listener on
the bridge) and changes the host, so it runs only when asked and refuses a host
that already has a `juno-computers` network:

    docker build -t juno-computer:1 deploy/agent-computers
    sudo -E JUNO_COMPUTER_DOCKER_TESTS=1 python3 scripts/sandbox-boundary-check.py tests.test_computer_boundary

Teardown removes what setup added (JUNO_COMPUTER_BOUNDARY_KEEP=1 keeps it to debug).
"""
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = os.environ.get("JUNO_COMPUTER_DOCKER_TESTS") == "1"
IMAGE = os.environ.get("JUNO_COMPUTER_IMAGE", "juno-computer:1")
NETWORK = "juno-computers"          # setup-vm.sh and src/lib/env.ts
SUBNET = "172.30.0.0/24"
BRIDGE = "br-juno"
GATEWAY = "172.30.0.1"
PROXY_PORT = 3128
FALLBACK_IP_IMAGE = "alpine:3.20"   # only where the host has no iproute2


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
# What the host holds and a computer must never see.
HOST_SECRET_NAMES = ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "DATABASE_URL", "DIRECT_URL",
                     "AUTH_SECRET", "NEXTAUTH_SECRET", "JUNO_CDP_TOKEN", "COMPUTER_VNC_PASSWORD",
                     "CODE_INTERPRETER_TOKEN", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "STRIPE_SECRET_KEY")
# The agent shell's whole environment: the image's ENV, Docker's HOSTNAME and the
# one `-e HOME=/home/agent` the broker permits.
AGENT_SHELL_ENV = frozenset({"PATH", "HOSTNAME", "HOME", "LANG", "DEBIAN_FRONTEND", "DISPLAY",
                             "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"})
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


def docker(*args, check=True, timeout=300, input_text=None):
    result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout, input=input_text)
    if check and result.returncode != 0:
        raise AssertionError("docker %s failed (%d): %s" % (" ".join(args[:3]), result.returncode, result.stderr.strip()[-800:]))
    return result


def brokered(argv, **options):
    """Run docker with an argv the production broker accepts (it raises otherwise)."""
    broker.validate(argv, POLICY)
    return docker(*argv, **options)


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


def create_argv(name, agent, memory_mb=2048, cpus="2"):
    """The production `docker create` argv (src/lib/computer/docker.ts buildDockerCreateArgv, Linux)."""
    return ["create", "--name", name, "--hostname", "computer", "--network", NETWORK,
            "--dns", "1.1.1.1", "--dns", "9.9.9.9", "--memory", "%dm" % memory_mb, "--memory-swap", "%dm" % memory_mb,
            "--cpus", cpus, "--pids-limit", "2048", "--shm-size", "1g", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--read-only",
            "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g,mode=1777", "--tmpfs", "/run:rw,nosuid,nodev,size=64m",
            "--tmpfs", "/run/juno:rw,nosuid,nodev,noexec,size=1m,uid=1001,gid=1001,mode=0700",
            "--tmpfs", "/var/tmp:rw,nosuid,nodev,size=256m",
            "--mount", "type=volume,source=%s,target=/home/agent" % name,
            "--mount", "type=volume,source=%s-browser,target=/home/browser" % name,
            "--label", "app=juno", "--label", "juno.agent=" + agent, "--label", "juno.user=boundary-test",
            "--restart", "no", "--stop-timeout", "20", IMAGE]


class Computer:
    """One agent computer, created and started through broker-accepted argv."""

    def __init__(self, label):
        self.agent = "boundary-%s-%s" % (label, os.urandom(4).hex())
        self.name = "juno-agent-" + self.agent

    def create(self):
        for volume in (self.name, self.name + "-browser"):
            brokered(["volume", "create", "--label", "app=juno", "--label", "juno.agent=" + self.agent, volume])
        brokered(create_argv(self.name, self.agent))
        brokered(["start", self.name])
        deadline = time.monotonic() + 90
        while True:
            state = brokered(["inspect", "-f", "{{.State.Status}}", self.name]).stdout.strip()
            ready = self.run(["pgrep", "-u", "1001", "-f", "cdp-gate.py"], user="1001", check=False)
            if state == "running" and ready.returncode == 0:
                return self
            if time.monotonic() > deadline:
                logs = docker("logs", self.name, check=False)
                raise AssertionError("the computer never came up (%s): %s %s" % (state, logs.stdout[-1500:], logs.stderr[-1500:]))
            time.sleep(0.5)

    def run(self, command, user="1000", check=True, timeout=120, workdir=None):
        argv = ["exec", "--user", user]
        if user == "1000":
            argv += ["-e", "HOME=/home/agent"]
        if workdir:
            argv += ["--workdir", workdir]
        return brokered(argv + [self.name] + command, check=check, timeout=timeout)

    def probe(self, spec, user="1000"):
        result = self.run(["python3", "-c", sandbox_probe.program(spec)], user=user, timeout=180)
        return sandbox_probe.parse(result.stdout)

    def volume_has(self, path):
        """Look inside the agent's home volume from a throwaway, network-less container."""
        result = docker("run", "--rm", "--network", "none", "--entrypoint", "/bin/sh", "-v", self.name + ":/v:ro",
                        IMAGE, "-c", 'test -e "/v/%s"' % path, check=False)
        return result.returncode == 0

    def destroy(self):
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


class Host:
    """Everything setUpModule puts on the host, and how to take it off again."""

    def __init__(self):
        self.undo = []
        self.proxy = None
        self.canary_port = None
        self.primary = host_primary_address()

    def run(self):
        if docker("network", "inspect", NETWORK, check=False).returncode == 0:
            raise AssertionError("this host already has a %s network: run the suite on a disposable machine" % NETWORK)
        # The network, exactly as setup-vm.sh creates it.
        docker("network", "create", "--driver", "bridge", "--subnet", SUBNET, "-o", "com.docker.network.bridge.name=" + BRIDGE,
               "-o", "com.docker.network.bridge.enable_icc=false", NETWORK)
        self.undo.append(lambda: docker("network", "rm", NETWORK, check=False))
        # The firewall, exactly as installed. Teardown deletes only the rules
        # firewall.sh added (Docker keeps managing its own around them).
        added = [rule for rule in FIREWALL_RULES if not self._has_rule(rule)]
        self.undo.append(lambda: self._remove_rules(added))
        result = subprocess.run(["bash", str(ROOT / "deploy/agent-computers/firewall.sh")], capture_output=True, text=True)
        if result.returncode != 0:
            raise AssertionError("firewall.sh failed: " + result.stderr[-800:])
        # The egress proxy, the production script on the production address.
        self.proxy = subprocess.Popen([sys.executable, str(ROOT / "deploy/agent-computers/egress-proxy.py")],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.undo.append(self._stop_proxy)
        self._wait_for_port(GATEWAY, PROXY_PORT)
        # Canaries: one listener on every host address (a free port), and port 80
        # on each lo canary address for the proxy (it only forwards 80 and 443).
        for address in CANARY_ADDRESSES:
            ip("addr", "add", address + "/32", "dev", "lo")
            self.undo.append(lambda address=address: ip("addr", "del", address + "/32", "dev", "lo", check=False))
        everywhere = self._serve("0.0.0.0", 0)
        self.canary_port = everywhere.server_address[1]
        for address in CANARY_ADDRESSES:
            self._serve(address, 80)

    def _serve(self, address, port):
        server = ThreadingHTTPServer((address, port), CanaryHandler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.undo.append(lambda: (server.shutdown(), server.server_close()))
        return server

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

    def _stop_proxy(self):
        if self.proxy and self.proxy.poll() is None:
            self.proxy.terminate()
            try:
                self.proxy.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proxy.kill()

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
        targets = canaries + host_addresses + real_metadata + [(self.peer_ip, 8080)]
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

    def test_public_internet_only_through_the_proxy(self):
        if not host_has_internet():
            self.skipTest("optional: this host has no direct Internet access, so public controls cannot run")
        report = self.computer.probe({"tcp": [("1.1.1.1", 443), ("8.8.8.8", 53), ("9.9.9.9", 443)],
                                      "dns": ["1.1.1.1", "9.9.9.9", "8.8.8.8"],
                                      "proxy": [GATEWAY, PROXY_PORT], "proxyRequests": [("CONNECT", "example.com:443")],
                                      "timeout": 4})
        for target in ("1.1.1.1:443", "8.8.8.8:53", "9.9.9.9:443"):
            self.assertIn(report["tcp"][target], BLOCKED, target + ": direct public egress from a computer")
        self.assertEqual(report["dns"]["8.8.8.8"], "no-answer", "only the two pinned resolvers are allowed")
        self.assertEqual(report["dns"]["1.1.1.1"], "answered", "the firewall's DNS exception")
        self.assertEqual(report["dns"]["9.9.9.9"], "answered", "the firewall's DNS exception")
        self.assertEqual(report["proxy"]["CONNECT example.com:443"], 200, "public HTTPS through the proxy")
        control = control_probe({"tcp": [("1.1.1.1", 443)], "dns": ["8.8.8.8"], "timeout": 4})
        self.assertEqual(control["tcp"]["1.1.1.1:443"], "open", "control: this host's containers reach the Internet")
        self.assertEqual(control["dns"]["8.8.8.8"], "answered")

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
        self.assertLessEqual(names, AGENT_SHELL_ENV, "unexpected variables in the agent's shell: %s" % sorted(names - AGENT_SHELL_ENV))
        self.assertEqual(shell["environ"]["self"]["HTTPS_PROXY"], "http://%s:%d" % (GATEWAY, PROXY_PORT))
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
                       "/opt/juno/entrypoint.sh", "/home/agent/work/ok.txt", "/tmp/ok.txt", "/run/juno/planted"],
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
        for path in ("/etc/passwd", "/opt/juno/entrypoint.sh"):
            self.assertIn(writes[path], ("EACCES", "EROFS"), path)
        self.assertEqual(writes["/home/agent/work/ok.txt"], "ok")
        self.assertEqual(writes["/tmp/ok.txt"], "ok")
        self.assertEqual(writes["/run/juno/planted"], "EACCES", "the CDP handover tmpfs is the browser's alone")
        for path, result in report["reads"].items():
            self.assertEqual(result, "EACCES", path + " is readable by the agent")
        for path, present in report["exists"].items():
            self.assertFalse(present, path)
        mounts = {entry["mountpoint"]: entry for entry in report["mounts"]}
        self.assertIn("ro", mounts["/"]["options"].split(","))
        for path in ("/tmp", "/run", "/run/juno", "/var/tmp"):
            self.assertEqual(mounts[path]["fstype"], "tmpfs", path)
            self.assertTrue({"nosuid", "nodev"} <= set(mounts[path]["options"].split(",")), path)
        host_disks = {entry["mountpoint"] for entry in report["mounts"] if entry["fstype"] not in PSEUDO_FILESYSTEMS}
        self.assertLessEqual(host_disks, COMPUTER_HOST_MOUNTS, "host directories in the computer: %s" % sorted(host_disks - COMPUTER_HOST_MOUNTS))

    def test_the_container_has_exactly_the_broker_profile(self):
        container = json.loads(docker("inspect", self.computer.name).stdout)[0]
        host = container["HostConfig"]
        self.assertEqual(container["Config"]["User"], "1001")
        self.assertEqual(container["Config"]["Labels"].get("juno.security"), "pipe-v3")
        self.assertEqual(host["NetworkMode"], NETWORK)
        self.assertEqual(host["Dns"], ["1.1.1.1", "9.9.9.9"])
        self.assertTrue(host["ReadonlyRootfs"])
        self.assertFalse(host["Privileged"])
        self.assertEqual(host["CapDrop"], ["ALL"])
        self.assertFalse(host.get("CapAdd"))
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
        result = self.computer.run(["timeout", "--signal=TERM", "--kill-after=5", "2", "bash", "-lc",
                                    "echo started > started-cmd; sleep 6; echo late > late-cmd"],
                                   check=False, workdir="/home/agent/work")
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertLess(time.monotonic() - begun, 5)
        time.sleep(max(0.0, begun + 7 - time.monotonic()))
        self.assertEqual(self.computer.run(["test", "-e", "/home/agent/work/started-cmd"], check=False).returncode, 0)
        self.assertEqual(self.computer.run(["test", "-e", "/home/agent/work/late-cmd"], check=False).returncode, 1,
                         "the command kept running past its time limit")


class ComputerTeardownKills(unittest.TestCase):
    """Stop and destroy take everything the agent left running with them."""

    def setUp(self):
        self.computer = Computer("stop")
        self.addCleanup(self.computer.destroy)
        self.computer.create()

    # Longer than a graceful stop (the entrypoint closes Chromium through its
    # pipe, about 1-3 s) and well short of Docker's 20 s SIGKILL fallback, so a
    # pass means the processes died with the container, not that the write was slow.
    DELAY = 10

    def leave_a_delayed_write(self):
        # Detached from the exec session, as an agent's background job would be:
        # it outlives the command that started it and is reparented to tini.
        self.computer.run(["bash", "-c", 'nohup bash -c "sleep %d; echo late > /home/agent/after-stop" >/dev/null 2>&1 & '
                                         "echo started > /home/agent/started" % self.DELAY])
        self.assertEqual(self.computer.run(["pgrep", "-u", "1000", "-f", "sleep %d" % self.DELAY], check=False).returncode, 0)
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

if __name__ == "__main__":
    unittest.main()
