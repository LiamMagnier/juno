"""Run with python3 -m unittest discover -s tests -p 'test_computer_infrastructure.py'."""
import importlib.util
from pathlib import Path
import socket
import unittest
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
            "--tmpfs": ["/tmp:rw,nosuid,nodev,size=1g,mode=1777", "/run:rw,nosuid,nodev,size=64m", "/var/tmp:rw,nosuid,nodev,size=256m"],
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
        for key, replacement in (("--mount", ["type=bind,source=/,target=/host"]), ("--network", ["host"]), ("--memory", ["9999m"]), ("--cpus", ["nan"]), ("--cap-drop", ["NET_ADMIN"])):
            with self.subTest(key=key), self.assertRaises(ValueError):
                broker.validate(args({**options, key: replacement}), POLICY)


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

    def test_connection_uses_validated_ip_without_resolving_again(self):
        answer = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))
        with patch.object(proxy.socket, "getaddrinfo", return_value=[answer]) as resolve, patch.object(proxy.socket, "socket") as new_socket:
            proxy.connect_public("public.example", 443)
            resolve.assert_called_once()
            new_socket.return_value.connect.assert_called_once_with(("1.1.1.1", 443))


if __name__ == "__main__":
    unittest.main()
