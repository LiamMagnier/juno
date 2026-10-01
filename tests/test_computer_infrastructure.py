"""Run with python3 -m unittest discover -s tests -p 'test_computer_infrastructure.py'."""
import importlib.util
from pathlib import Path
import socket
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
POLICY = {"image": "juno-computer:1", "network": "juno-computers", "maxMemoryMb": 2048, "maxCpus": 2}


class BrokerContainment(unittest.TestCase):
    def test_exec_is_always_unprivileged_and_scoped(self):
        self.assertEqual(broker.validate(["exec", "--user", "1000", "juno-agent-test", "bash", "-lc", "pwd"], POLICY), "juno-agent-test")
        for argv in (["exec", "--user", "0", "juno-agent-test", "bash"],
                     ["exec", "--privileged", "--user", "1000", "juno-agent-test", "bash"],
                     ["exec", "--user", "1000", "production", "bash"],
                     ["exec", "--user", "1000", "-e", "LD_PRELOAD=/tmp/attack.so", "juno-agent-test", "bash"],
                     ["run", "--privileged", "debian", "bash"],
                     ["build", "/tmp"], ["volume", "rm", "-f", "production"],
                     ["inspect", "-f", "{{.Config.Env}}", "juno-agent-test"]):
            with self.subTest(argv=argv), self.assertRaises((ValueError, IndexError)):
                broker.validate(argv, POLICY)

    def test_create_requires_complete_fixed_sandbox(self):
        options = {
            "--name": ["juno-agent-test"], "--hostname": ["computer"], "--network": ["juno-computers"],
            "--dns": ["1.1.1.1", "9.9.9.9"], "--memory": ["2048m"], "--memory-swap": ["2048m"],
            "--cpus": ["1.5"], "--pids-limit": ["2048"], "--shm-size": ["1g"], "--cap-drop": ["ALL"],
            "--security-opt": ["no-new-privileges"],
            "--tmpfs": ["/tmp:rw,nosuid,nodev,size=1g,mode=1777", "/run:rw,nosuid,nodev,size=64m", "/run/juno:rw,nosuid,nodev,noexec,size=1m,uid=1001,gid=1001,mode=0700", "/var/tmp:rw,nosuid,nodev,size=256m"],
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
            self.assertEqual(broker.validate(["exec", "--user", "1000", "--workdir", workdir, "juno-agent-t", "timeout", "5", "bash", "-lc", "pwd"], POLICY), "juno-agent-t")
        for workdir in ("/home/browser", "/home/agent/../browser", "/home/agentx", "work", "/home/agent/work/\nx", "/", "/home/agent/./work"):
            with self.subTest(workdir=workdir), self.assertRaises(ValueError):
                broker.validate(["exec", "--user", "1000", "--workdir", workdir, "juno-agent-t", "pwd"], POLICY)

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
            def __init__(self, code, out):
                self.returncode, self.stdout = code, out

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
            with patch.object(proxy, "HEADER_DEADLINE_SECONDS", 0.3):
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


if __name__ == "__main__":
    unittest.main()
