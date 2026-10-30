"""Run with python3 -m unittest discover -s tests -p 'test_computer_infrastructure.py'."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
import unittest.mock
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "deploy/agent-computers" / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


broker = module("broker", "docker-broker.py")
proxy = module("proxy", "egress-proxy.py")
egress_map = module("egress_map", "egress-map.py")
launcher = module("agent_exec", "agent-exec.py")
POLICY = {"image": "juno-computer:1", "network": "juno-computers", "maxMemoryMb": 2048, "maxCpus": 2}
LAUNCH = ["/opt/juno/agent-exec", "run", "--"]


class BrokerContainment(unittest.TestCase):
    def test_exec_is_always_unprivileged_and_scoped(self):
        self.assertEqual(broker.validate(["exec", "--user", "1000", "juno-agent-test", *LAUNCH, "bash", "--noprofile", "--norc", "-c", "pwd"], POLICY), "juno-agent-test")
        for argv in (["exec", "--user", "0", "juno-agent-test", "bash"],
                     ["exec", "--privileged", "--user", "1000", "juno-agent-test", "bash"],
                     ["exec", "--user", "1000", "production", "bash"],
                     ["exec", "--user", "1000", "-e", "LD_PRELOAD=/tmp/attack.so", "juno-agent-test", *LAUNCH, "bash"],
                     ["exec", "--user", "1000", "juno-agent-test", "bash", "-lc", "pwd"],
                     ["run", "--privileged", "debian", "bash"],
                     ["build", "/tmp"], ["volume", "rm", "-f", "production"],
                     ["inspect", "-f", "{{.Config.Env}}", "juno-agent-test"]):
            with self.subTest(argv=argv), self.assertRaises((ValueError, IndexError)):
                broker.validate(argv, POLICY)

    def test_create_requires_complete_fixed_sandbox(self):
        options = {
            "--name": ["juno-agent-test"], "--hostname": ["computer"], "--network": ["juno-computers"],
            "--dns": ["192.0.2.53"], "--memory": ["2048m"], "--memory-swap": ["2048m"],
            "--cpus": ["1.5"], "--pids-limit": ["2048"], "--shm-size": ["1g"], "--cap-drop": ["ALL"],
            "--security-opt": ["no-new-privileges"],
            "--tmpfs": ["/tmp:rw,nosuid,nodev,size=1g,mode=1777", "/run:rw,nosuid,nodev,size=64m", "/run/juno:rw,nosuid,nodev,noexec,size=1m,uid=1001,gid=1001,mode=0700",
                        "/run/juno-state:rw,nosuid,nodev,noexec,size=64k,uid=1001,gid=1001,mode=0755", "/var/tmp:rw,nosuid,nodev,size=256m"],
            "--mount": ["type=volume,source=juno-agent-test,target=/home/agent", "type=volume,source=juno-agent-test-browser,target=/home/browser"],
            "--label": ["app=juno", "juno.agent=test", "juno.user=user"], "--restart": ["no"], "--stop-timeout": ["20"],
        }
        def args(values):
            result = ["create", "--read-only"]
            for key, entries in values.items():
                for entry in entries:
                    result += [key, entry]
            return result + [POLICY["image"]]
        valid = args(options)
        self.assertIsNone(broker.validate(valid, POLICY))
        for argv in (valid[:-1] + ["attacker-image"], valid[:-1] + ["--privileged", POLICY["image"]], [value for value in valid if value != "--read-only"]):
            with self.assertRaises(ValueError):
                broker.validate(argv, POLICY)
        # Without the browser-owned handover tmpfs the agent could reach the token path.
        with self.assertRaises(ValueError):
            broker.validate(args({**options, "--tmpfs": [t for t in options["--tmpfs"] if not t.startswith("/run/juno")]}), POLICY)
        for key, replacement in (("--mount", ["type=bind,source=/,target=/host"]), ("--network", ["host"]), ("--memory", ["9999m"]), ("--cpus", ["nan"]), ("--cap-drop", ["NET_ADMIN"])):
            with self.subTest(key=key), self.assertRaises(ValueError):
                broker.validate(args({**options, key: replacement}), POLICY)
        # pipe-v4: public resolvers are gone from the argv, the state tmpfs is required,
        # and the security options are exactly the policy's.
        for key, replacement in (("--dns", ["1.1.1.1", "9.9.9.9"]), ("--dns", ["192.0.2.53", "1.1.1.1"]), ("--dns", []),
                                 ("--tmpfs", [t for t in options["--tmpfs"] if not t.startswith("/run/juno-state")]),
                                 ("--security-opt", ["no-new-privileges", "seccomp=unconfined"]),
                                 ("--security-opt", ["no-new-privileges", "seccomp=/etc/juno/computer-seccomp.json"]),
                                 ("--security-opt", ["seccomp=unconfined"])):
            with self.subTest(key=key, replacement=replacement), self.assertRaises(ValueError):
                broker.validate(args({**options, key: replacement}), POLICY)
        sandbox = {**POLICY, "browserSandbox": True, "seccompProfile": "/etc/juno/computer-seccomp.json"}
        self.assertIsNone(broker.validate(args({**options, "--security-opt": ["no-new-privileges", "seccomp=/etc/juno/computer-seccomp.json"]}), sandbox))
        for opts in (["no-new-privileges"], ["no-new-privileges", "seccomp=unconfined"], ["seccomp=/etc/juno/computer-seccomp.json", "no-new-privileges"]):
            with self.subTest(opts=opts), self.assertRaises(ValueError):
                broker.validate(args({**options, "--security-opt": opts}), sandbox)
        for bad in ({**sandbox, "seccompProfile": "relative.json"}, {**sandbox, "seccompProfile": None}):
            with self.assertRaises(ValueError):
                broker.validate(args({**options, "--security-opt": ["no-new-privileges", "seccomp=relative.json"]}), bad)


class BrokerMatchesProvider(unittest.TestCase):
    """The argv shapes src/lib/computer/docker.ts actually sends. A broker that
    refused them left the feature broken on first use, and the quick workaround
    (docker group or a wider sudo rule) would make the app root-equivalent.
    tests/computer-broker-argv.test.ts runs the real provider against this."""

    def test_labelled_volume_creation_is_accepted_only_for_its_own_agent(self):
        for name in ("juno-agent-abc", "juno-agent-abc-browser"):
            self.assertIsNone(broker.validate(["volume", "create", "--label", "app=juno", "--label", "juno.agent=abc", name], POLICY))
        for argv in (["volume", "create", "--label", "app=juno", "--label", "juno.agent=abc", "juno-agent-other"],
                     ["volume", "create", "--label", "app=other", "--label", "juno.agent=abc", "juno-agent-abc"],
                     ["volume", "create", "--label", "app=juno", "--label", "juno.agent=abc", "--driver", "local", "juno-agent-abc"],
                     ["volume", "create", "--opt", "type=none", "--opt", "device=/", "--opt", "o=bind", "juno-agent-abc"],
                     ["volume", "create", "production"]):
            with self.subTest(argv=argv), self.assertRaises((ValueError, IndexError)):
                broker.validate(argv, POLICY)

    def test_exec_working_directory_stays_in_the_agent_home(self):
        for workdir in ("/home/agent", "/home/agent/work", "/home/agent/work/sub dir"):
            self.assertEqual(broker.validate(["exec", "--user", "1000", "--workdir", workdir, "juno-agent-t", *LAUNCH, "timeout", "5", "bash", "-c", "pwd"], POLICY), "juno-agent-t")
        for workdir in ("/home/browser", "/home/agent/../browser", "/home/agentx", "work", "/home/agent/work/\nx", "/", "/home/agent/./work"):
            with self.subTest(workdir=workdir), self.assertRaises(ValueError):
                broker.validate(["exec", "--user", "1000", "--workdir", workdir, "juno-agent-t", *LAUNCH, "pwd"], POLICY)

    def test_only_the_two_fixed_listings_are_allowed(self):
        self.assertIsNone(broker.validate(list(broker.PS_ARGV), POLICY))
        self.assertIsNone(broker.validate(list(broker.VOLUME_LS_ARGV), POLICY))
        for argv in (["ps", "-a"], ["ps", "-a", "--format", "{{json .}}"], ["volume", "ls"],
                     ["volume", "ls", "--filter", "name=", "--format", "{{.Name}}"],
                     ["ps", "-a", "--filter", "label=app=juno", "--format", "{{.Mounts}}"]):
            with self.subTest(argv=argv), self.assertRaises((ValueError, IndexError)):
                broker.validate(argv, POLICY)

    def test_namespace_check_fails_closed_when_inspect_fails(self):
        calls = []

        class Result:
            def __init__(self, code, out, err=""):
                self.returncode, self.stdout, self.stderr = code, out, err

        for code, out in ((1, ""), (0, "other\n")):
            with self.subTest(code=code, out=out), \
                 patch.object(broker, "open", unittest.mock.mock_open(read_data='{"image": "juno-computer:1", "network": "juno-computers", "maxMemoryMb": 2048, "maxCpus": 2}'), create=True), \
                 patch.object(broker.sys, "argv", ["broker", "start", "juno-agent-t"]), \
                 patch.object(broker.subprocess, "run", return_value=Result(code, out)) as run, \
                 patch.object(broker.os, "execve", side_effect=lambda *a: calls.append(a)):
                with self.assertRaises(ValueError):
                    broker.main()
                self.assertIn("--type", run.call_args.args[0])
        self.assertEqual(calls, [])


class PinnedEgress(unittest.TestCase):
    def test_all_private_and_metadata_families_are_denied(self):
        for address in ("127.0.0.1", "10.0.0.1", "172.30.0.1", "192.168.1.1", "100.64.0.1", "169.254.169.254", "168.63.129.16", "0.0.0.0", "224.0.0.1", "240.1.1.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1"):
            with self.subTest(address=address):
                self.assertFalse(proxy.public_ip(address))
        self.assertTrue(proxy.public_ip("1.1.1.1"))
        self.assertTrue(proxy.public_ip("2606:4700:4700::1111"))

    def test_mixed_dns_answers_and_unapproved_ports_fail_closed(self):
        public = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))
        private = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))
        with patch.object(proxy.socket, "getaddrinfo", return_value=[public, private]):
            with self.assertRaises(ValueError):
                proxy.resolve_public("rebind.example", 443)
        for port in (22, 5432, 9222):
            with self.assertRaises(ValueError):
                proxy.resolve_public("public.example", port)

    def test_one_computer_cannot_take_every_slot(self):
        self.assertLess(proxy.TOTAL_LIMIT, 32, "must stay under the unit's TasksMax")
        taken = []
        try:
            for _ in range(proxy.PER_SOURCE_LIMIT):
                self.assertTrue(proxy.admit("172.30.0.2"))
                taken.append("172.30.0.2")
            self.assertFalse(proxy.admit("172.30.0.2"), "a seventh connection from one computer is refused")
            self.assertTrue(proxy.admit("172.30.0.3"), "another computer still gets a slot")
            taken.append("172.30.0.3")
        finally:
            for source in taken:
                proxy.leave(source)
        self.assertEqual(proxy.ACTIVE, {})

    def test_a_slow_header_is_cut_off_by_one_deadline(self):
        server, client = socket.socketpair()
        try:
            with patch.object(proxy, "HEADER_DEADLINE_SECONDS", 0.3), mapped({"slow": "juno-agent-slow"}), logging_to_a_file():
                self.assertTrue(proxy.admit("slow"))
                client.sendall(b"CONNECT example.com:443 HTTP/1.1\r\n")  # never finished
                started = __import__("time").monotonic()
                proxy.handle(server, "slow")
                self.assertLess(__import__("time").monotonic() - started, 2)
            self.assertIn(b"403", client.recv(1024))
        finally:
            client.close()
        self.assertEqual(proxy.ACTIVE, {})

    def test_connection_uses_validated_ip_without_resolving_again(self):
        answer = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))
        with patch.object(proxy.socket, "getaddrinfo", return_value=[answer]) as resolve, patch.object(proxy.socket, "socket") as new_socket:
            proxy.connect_public("public.example", 443)
            resolve.assert_called_once()
            new_socket.return_value.connect.assert_called_once_with(("1.1.1.1", 443))



class FakeMap:
    """Stands in for the broker's address map in handler tests."""

    def __init__(self, entries, releasing=()):
        self.entries, self.releasing = dict(entries), set(releasing)

    def identify(self, address, seconds=None, step=None):
        return None if address in self.releasing else self.entries.get(address)


def mapped(entries, releasing=()):
    return patch.object(proxy, "ADDRESS_MAP", FakeMap(entries, releasing))


class logging_to_a_file:
    """The proxy's log in a temporary file; `.records()` reads it back."""

    def __enter__(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.directory.name, "egress.jsonl")
        self.patch = patch.object(proxy, "LOG", proxy.EgressLog(self.path))
        self.patch.__enter__()
        return self

    def __exit__(self, *exc):
        self.patch.__exit__(*exc)
        self.directory.cleanup()

    def records(self):
        if not os.path.exists(self.path):
            return []
        with open(self.path) as file:
            return [json.loads(line) for line in file]


def run_handler(request, source, upstream_reply=b"", resolve_to="93.184.216.34"):
    """One request through proxy.handle with a socketpair client and a fake upstream."""
    server, client = socket.socketpair()
    up_server, up_client = socket.socketpair()
    answer = (socket.AF_INET, socket.SOCK_STREAM, 6, "", (resolve_to, 443))
    try:
        assert proxy.admit(source)
        client.sendall(request)

        def answer_upstream():
            try:
                if upstream_reply:
                    up_client.sendall(upstream_reply)
                up_client.shutdown(socket.SHUT_WR)
            except OSError:
                pass  # the proxy closed the tunnel first (over budget)
        threading.Thread(target=answer_upstream, daemon=True).start()
        received = []

        def read_client():
            client.settimeout(15)
            try:
                while True:
                    chunk = client.recv(65536)
                    if not chunk:
                        break
                    received.append(chunk)
            except OSError:
                pass
        reader = threading.Thread(target=read_client, daemon=True)
        reader.start()
        with patch.object(proxy.socket, "getaddrinfo", return_value=[answer]), \
             patch.object(proxy, "connect_public", side_effect=lambda host, port: (proxy.resolve_public(host, port), up_server)[1]):
            proxy.handle(server, source)
        reader.join(15)
        return b"".join(received)
    finally:
        for end in (client, up_client, up_server):
            try:
                end.close()
            except OSError:
                pass


class EgressAudit(unittest.TestCase):
    """The egress log and the per-computer budget (COMPUTERS_2026-10.md S2.2)."""

    def setUp(self):
        self.budget = patch.object(proxy, "BUDGET", proxy.Budget(1024 * 1024, os.path.join(tempfile.mkdtemp(), "budget.json")))
        self.budget.start()
        self.addCleanup(self.budget.stop)

    def test_each_connection_is_logged_with_its_computer_and_never_a_path_or_query(self):
        with mapped({"172.30.0.7": "juno-agent-seven"}), logging_to_a_file() as log:
            reply = run_handler(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\nhello", "172.30.0.7", b"world")
            self.assertIn(b"200 Connection Established", reply)
            run_handler(b"GET http://example.com/secret/path?token=abc HTTP/1.1\r\nHost: example.com\r\nCookie: s=1\r\n\r\n",
                        "172.30.0.7", b"HTTP/1.1 200 OK\r\n\r\n")
            records = log.records()
        self.assertEqual(len(records), 2)
        for record in records:
            self.assertEqual(set(record), {"start", "end", "computer", "src", "host", "port", "up", "down", "verdict"})
            self.assertEqual((record["computer"], record["src"], record["host"], record["verdict"]),
                             ("juno-agent-seven", "172.30.0.7", "example.com", "ok"))
            self.assertGreater(record["up"], 0)
            self.assertGreater(record["down"], 0)
        self.assertEqual([r["port"] for r in records], [443, 80])
        text = json.dumps(records)
        for leaked in ("secret", "path", "token", "abc", "Cookie", "hello", "world"):
            self.assertNotIn(leaked, text)

    def test_refusals_are_logged_too(self):
        with mapped({"172.30.0.7": "juno-agent-seven"}, releasing={"172.30.0.9"}), logging_to_a_file() as log:
            self.assertIn(b"403", run_handler(b"CONNECT example.com:22 HTTP/1.1\r\n\r\n", "172.30.0.7"))
            self.assertIn(b"403", run_handler(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n", "172.30.0.9"))
            self.assertIn(b"403", run_handler(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n", "172.30.0.8"))
            verdicts = [(r["src"], r["computer"], r["verdict"]) for r in log.records()]
        self.assertEqual(verdicts, [("172.30.0.7", "juno-agent-seven", "refused"), ("172.30.0.9", None, "unmapped"),
                                    ("172.30.0.8", None, "unmapped")])

    def test_a_computer_over_its_budget_gets_403_and_others_do_not(self):
        proxy.BUDGET.add("juno-agent-busy", 2 * 1024 * 1024)
        with mapped({"172.30.0.7": "juno-agent-busy", "172.30.0.8": "juno-agent-quiet"}), logging_to_a_file() as log:
            self.assertIn(b"403", run_handler(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n", "172.30.0.7"))
            self.assertIn(b"200", run_handler(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n", "172.30.0.8", b"x"))
            self.assertEqual([r["verdict"] for r in log.records()], ["over_budget", "ok"])

    def test_an_open_tunnel_is_closed_at_its_next_chunk_once_over_budget(self):
        with mapped({"172.30.0.7": "juno-agent-big"}), logging_to_a_file() as log:
            reply = run_handler(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n", "172.30.0.7", b"y" * (3 * 1024 * 1024))
            record = log.records()[0]
        self.assertEqual(record["verdict"], "over_budget")
        # The tunnel stopped near the budget, not after the whole 3 MB.
        self.assertLess(len(reply), 2 * 1024 * 1024)
        self.assertLessEqual(record["down"], 1024 * 1024 + 65536)

    def test_the_budget_is_a_rolling_hour_by_name_and_survives_a_save_and_load(self):
        now = 1_800_000_000.0
        budget = proxy.Budget(1000, os.path.join(tempfile.mkdtemp(), "budget.json"))
        budget.add("juno-agent-a", 600, now=now - 3500)   # 58 minutes ago: counts
        budget.add("juno-agent-a", 600, now=now)
        budget.add("juno-agent-b", 10, now=now - 4000)    # 66 minutes ago: expired
        self.assertTrue(budget.over("juno-agent-a", now=now))
        self.assertEqual(budget.used("juno-agent-b", now=now), 0)
        self.assertEqual(budget.used("juno-agent-c", now=now), 0, "a new name starts empty")
        budget.save(now=now)
        restarted = proxy.Budget(1000, budget.path)
        restarted.load(now=now)
        self.assertTrue(restarted.over("juno-agent-a", now=now))
        self.assertFalse(restarted.over("juno-agent-a", now=now + 3700), "an hour later the old minutes have rolled off")

    def test_the_limit_comes_from_the_environment_with_a_safe_default(self):
        self.assertEqual(proxy.max_bytes_per_hour("1"), 1024 * 1024)
        self.assertEqual(proxy.max_bytes_per_hour(""), 1024 * 1024 * 1024)
        for bad in ("0", "-5", "lots", "nan"):
            self.assertEqual(proxy.max_bytes_per_hour(bad), 1024 * 1024 * 1024, bad)


class EgressAddressMap(unittest.TestCase):
    """egress-map.py and the proxy's reader of it (D19)."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = os.path.join(self.directory.name, "run", "egress-map.json")

    def test_rebuild_keeps_since_for_the_same_computer_and_release_marks_addresses_releasing(self):
        first = egress_map.rebuild(self.path, addresses={"172.30.0.2": "juno-agent-a", "172.30.0.3": "juno-agent-b"})
        self.assertEqual(oct(os.stat(self.path).st_mode & 0o777), "0o644")
        since = first["entries"]["172.30.0.2"]["since"]
        time.sleep(0.01)
        second = egress_map.rebuild(self.path, addresses={"172.30.0.2": "juno-agent-a", "172.30.0.3": "juno-agent-c"})
        self.assertEqual(second["entries"]["172.30.0.2"]["since"], since)
        self.assertNotEqual(second["entries"]["172.30.0.3"]["since"], first["entries"]["172.30.0.3"]["since"])
        self.assertEqual(second["gen"], first["gen"] + 1)
        released = egress_map.release("juno-agent-a", self.path)
        self.assertNotIn("172.30.0.2", released["entries"])
        self.assertEqual(released["releasing"], ["172.30.0.2"])
        rebuilt = egress_map.rebuild(self.path, addresses={})
        self.assertEqual((rebuilt["entries"], rebuilt["releasing"]), ({}, []))
        with self.assertRaises(ValueError):
            egress_map.release("../../etc/passwd", self.path)

    def test_only_computers_are_mapped_from_the_network(self):
        class Result:
            returncode = 0
            stdout = json.dumps({
                "c1": {"Name": "juno-agent-abc", "IPv4Address": "172.30.0.2/24"},
                "c2": {"Name": "juno-boundary-peer-1", "IPv4Address": "172.30.0.3/24"},
                "c3": {"Name": "juno-agent-", "IPv4Address": "172.30.0.4/24"},
            })
        with patch.object(egress_map.subprocess, "run", return_value=Result()) as run:
            found = egress_map.running_addresses()
        self.assertEqual(found, {"172.30.0.2": "juno-agent-abc"})
        self.assertEqual(run.call_args.args[0][1:4], ["network", "inspect", "juno-computers"])

    def test_the_watcher_rebuilds_on_network_changes_and_container_deaths_only(self):
        self.assertTrue(egress_map.relevant({"Type": "network", "Action": "connect", "Actor": {"Attributes": {"name": "juno-computers"}}}))
        self.assertTrue(egress_map.relevant({"Type": "network", "Action": "disconnect", "Actor": {"Attributes": {"name": "juno-computers"}}}))
        self.assertTrue(egress_map.relevant({"Type": "container", "Action": "die", "Actor": {"Attributes": {"name": "juno-agent-a"}}}))
        self.assertFalse(egress_map.relevant({"Type": "network", "Action": "connect", "Actor": {"Attributes": {"name": "bridge"}}}))
        self.assertFalse(egress_map.relevant({"Type": "container", "Action": "start", "Actor": {"Attributes": {}}}))

    def test_the_proxy_reads_a_new_generation_and_refuses_unknown_and_releasing_addresses(self):
        egress_map.rebuild(self.path, addresses={"172.30.0.2": "juno-agent-a"})
        reader = proxy.AddressMap(self.path)
        self.assertEqual(reader.identify("172.30.0.2", seconds=0), "juno-agent-a")
        started = time.monotonic()
        self.assertIsNone(reader.identify("172.30.0.5", seconds=0.3, step=0.05), "an unknown address is never guessed")
        self.assertGreaterEqual(time.monotonic() - started, 0.3)
        egress_map.release("juno-agent-a", self.path)
        started = time.monotonic()
        self.assertIsNone(reader.identify("172.30.0.2", seconds=2))
        self.assertLess(time.monotonic() - started, 0.5, "a releasing address is refused at once")
        egress_map.rebuild(self.path, addresses={"172.30.0.2": "juno-agent-b"})
        self.assertEqual(reader.identify("172.30.0.2", seconds=0), "juno-agent-b", "the next computer on the address is its own")

    def test_an_address_mapped_while_the_proxy_waits_is_found(self):
        reader = proxy.AddressMap(self.path)
        later = threading.Timer(0.3, lambda: egress_map.rebuild(self.path, addresses={"172.30.0.6": "juno-agent-late"}))
        later.start()
        self.addCleanup(later.cancel)
        self.assertEqual(reader.identify("172.30.0.6", seconds=2, step=0.05), "juno-agent-late")


class BrokerLifecycleHooks(unittest.TestCase):
    """start, stop and rm -f update the address map around the docker call (D19);
    a missing container is exit 3, any other inspect failure exit 1 (fact 23)."""

    def run_broker(self, argv, results):
        calls = []
        policy = json.dumps(POLICY)

        class Result:
            def __init__(self, code, out="", err=""):
                self.returncode, self.stdout, self.stderr = code, out, err

        def fake_run(command, **_kwargs):
            calls.append(list(command))
            if command[1:3] == ["inspect", "--type"]:
                return results.get("inspect", Result(0, "juno\n"))
            if command[:len(broker.EGRESS_MAP_HELPER)] == broker.EGRESS_MAP_HELPER:
                return results.get(tuple(command[len(broker.EGRESS_MAP_HELPER):]), Result(0))
            return results.get("docker", Result(0))

        with patch.object(broker, "open", unittest.mock.mock_open(read_data=policy), create=True), \
             patch.object(broker.sys, "argv", ["broker", *argv]), \
             patch.object(broker.subprocess, "run", side_effect=fake_run), \
             patch.object(broker.os, "execve", side_effect=lambda *a: calls.append(["execve", *a[1][1:]])):
            code = broker.run_cli()
        return code, [call[len(broker.EGRESS_MAP_HELPER):] if call[:len(broker.EGRESS_MAP_HELPER)] == broker.EGRESS_MAP_HELPER
                      else call[1:] if call[0] == broker.DOCKER else call for call in calls]

    def test_start_rebuilds_the_map_before_and_after(self):
        code, calls = self.run_broker(["start", "juno-agent-t"], {})
        self.assertEqual(code, 0)
        self.assertEqual(calls[1:], [["rebuild"], ["start", "juno-agent-t"], ["rebuild"]])

    def test_start_is_refused_when_the_map_cannot_be_rebuilt_first(self):
        class Failed:
            returncode, stdout, stderr = 1, "", ""
        code, calls = self.run_broker(["start", "juno-agent-t"], {("rebuild",): Failed()})
        self.assertEqual(code, 1)
        self.assertNotIn(["start", "juno-agent-t"], calls)

    def test_stop_and_remove_release_first_and_rebuild_after(self):
        for argv in (["stop", "juno-agent-t"], ["rm", "-f", "juno-agent-t"]):
            code, calls = self.run_broker(argv, {})
            self.assertEqual(code, 0)
            self.assertEqual(calls[1:], [["release", "juno-agent-t"], argv, ["rebuild"]], argv)

    def test_other_operations_replace_the_broker_with_docker(self):
        code, calls = self.run_broker(["pause", "juno-agent-t"], {})
        self.assertEqual(calls[-1], ["execve", "pause", "juno-agent-t"])
        self.assertFalse(any(call in (["rebuild"],) for call in calls))

    def test_a_missing_container_is_exit_3_and_a_daemon_error_exit_1(self):
        class Missing:
            returncode, stdout, stderr = 1, "", "Error response from daemon: No such container: juno-agent-t\n"

        class Down:
            returncode, stdout, stderr = 1, "", "Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n"
        for operation in (["inspect", "-f", "{{.State.Status}}", "juno-agent-t"], ["start", "juno-agent-t"], ["rm", "-f", "juno-agent-t"]):
            code, calls = self.run_broker(operation, {"inspect": Missing()})
            self.assertEqual(code, broker.EXIT_MISSING, operation)
            self.assertEqual(len(calls), 1, "nothing ran after the check")
            code, _ = self.run_broker(operation, {"inspect": Down()})
            self.assertEqual(code, 1, operation)


class SeccompProfiles(unittest.TestCase):
    """seccomp-chromium.json is Docker's default profile plus exactly the written
    additions Chromium's own sandbox needs, and nothing removed (D13, S2.3)."""

    DEFAULT = ROOT / "deploy/agent-computers/seccomp-docker-default.json"
    CHROMIUM = ROOT / "deploy/agent-computers/seccomp-chromium.json"
    # github.com/moby/profiles/seccomp v0.2.4 default.json: the version Docker
    # 29.9.2 (moby commit 0367cbeb49b9) requires. Apache-2.0.
    UPSTREAM_SHA256 = "785b2429264afba4d594320337cb17f144f3c7d51585f9805eef72e28f4f9334"
    ADDITIONS = [
        {"names": ["clone", "unshare"], "action": "SCMP_ACT_ALLOW"},
        {"names": ["chroot"], "action": "SCMP_ACT_ALLOW"},
    ]

    def test_the_vendored_default_is_unchanged(self):
        self.assertEqual(hashlib.sha256(self.DEFAULT.read_bytes()).hexdigest(), self.UPSTREAM_SHA256)

    def test_the_chromium_profile_adds_only_the_written_list_and_removes_nothing(self):
        default = json.loads(self.DEFAULT.read_text())
        chromium = json.loads(self.CHROMIUM.read_text())
        self.assertEqual({k: v for k, v in chromium.items() if k != "syscalls"}, {k: v for k, v in default.items() if k != "syscalls"})
        self.assertEqual(chromium["syscalls"][:len(default["syscalls"])], default["syscalls"], "a default rule was changed or removed")
        added = [{k: v for k, v in rule.items() if k != "comment"} for rule in chromium["syscalls"][len(default["syscalls"]):]]
        self.assertEqual(added, self.ADDITIONS)
        for rule in chromium["syscalls"][len(default["syscalls"]):]:
            self.assertIn("juno", rule.get("comment", ""), "every addition says why")
            self.assertNotIn("args", rule)
            self.assertNotIn("includes", rule)
        # clone3 keeps the default's ENOSYS answer.
        self.assertFalse(any("clone3" in rule["names"] for rule in chromium["syscalls"][len(default["syscalls"]):]))


class AgentLauncher(unittest.TestCase):
    """agent-exec.py's fixed parts; the real-container suite proves the rest."""

    def test_the_environment_is_fixed_and_puts_the_agents_bin_last(self):
        env = launcher.ENVIRONMENT
        self.assertEqual(env["HOME"], "/home/agent")
        self.assertEqual(env["PATH"].split(":")[-1], "/home/agent/.local/bin")
        self.assertNotIn("/home/agent/.local/bin", env["PATH"].split(":")[:-1])
        for name in ("BASH_ENV", "ENV", "LD_PRELOAD", "PYTHONPATH", "PYTHONSTARTUP"):
            self.assertNotIn(name, env)
        self.assertEqual({env[k] for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy")}, {"http://172.30.0.1:3128"})

    def test_it_bans_every_namespace_flag(self):
        self.assertEqual(sum(launcher.NAMESPACE_FLAGS), 0x7E020000, "the same mask Docker's default profile uses for clone")
        self.assertEqual(launcher.EX_FROZEN, 75)
        source = (ROOT / "deploy/agent-computers/agent-exec.py").read_text()
        self.assertTrue(source.startswith("#!/usr/bin/python3 -I\n"), "isolated: no user site-packages from the agent's home")

    def test_it_refuses_to_run_as_anyone_but_the_agent(self):
        if os.getuid() == 1000:
            self.skipTest("optional: this test needs a uid other than 1000")
        with patch.object(launcher.os, "_exit", side_effect=SystemExit) as leave, self.assertRaises(SystemExit):
            launcher.main(["agent-exec", "run", "--", "id"])
        self.assertEqual(leave.call_args.args[0], 126)


if __name__ == "__main__":
    unittest.main()
