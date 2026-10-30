"""The computer host's nftables ruleset, in network namespaces of its own.

deploy/computer-host/setup.sh writes one nftables table (inet juno_computer_host, the
input hook only, policy drop). Revision 1 of the plan copied exec-host's chain, which
would have cut every computer off from the egress proxy (a drop in any nftables base
chain is final). This loads the ruleset setup.sh generates (`--print-nftables`) into the
network namespace of a throwaway "host" container only, never into this machine's own,
and checks it from four other namespaces:

  - a computer behind an interface named br-juno reaches the proxy (172.30.0.1:3128) and
    nothing else on the host (not 443, not 22, not the service's loopback ports);
  - the web VM's address reaches 443 and nothing else;
  - another address reaches neither 443 nor 22;
  - the --ssh-from address reaches 22;
  - the host's own loopback still reaches the service (nginx to 127.0.0.1:8750).
A positive control first shows every one of those ports open without the ruleset.

Opt-in, root, Docker and nft on this machine (each namespace is a container of the
computer image with `sleep` as its entrypoint, on two internal Docker networks):

    sudo JUNO_COMPUTER_HOST_FIREWALL_TESTS=1 python3 -m unittest tests.test_computer_host_firewall

It refuses a machine that already has a network on 172.30.0.0/24 (a computers network),
and removes every container and network it made.
"""
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = os.environ.get("JUNO_COMPUTER_HOST_FIREWALL_TESTS") == "1"
IMAGE = os.environ.get("JUNO_COMPUTER_IMAGE", "juno-computer:1")
PREFIX = "juno-fwtest"
PUBLIC_NET, COMPUTERS_NET = PREFIX + "-public", PREFIX + "-computers"
HOST_PUBLIC, WEB, OTHER, ADMIN = "10.231.20.2", "10.231.20.3", "10.231.20.4", "10.231.20.5"
GATEWAY, COMPUTER = "172.30.0.1", "172.30.0.9"
LISTENER = r"""
import socket, threading, time
def serve(address, port):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((address, port))
    s.listen(16)
    while True:
        connection, _ = s.accept()
        connection.close()
for address, port in (("0.0.0.0", 22), ("0.0.0.0", 443), ("172.30.0.1", 3128), ("127.0.0.1", 8750), ("127.0.0.1", 8751)):
    threading.Thread(target=serve, args=(address, port), daemon=True).start()
while True:
    time.sleep(60)
"""
PROBE = "import socket, sys\ntry:\n    socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=2).close()\nexcept OSError:\n    sys.exit(1)\n"


def docker(*args, check=True):
    result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=180)
    if check and result.returncode != 0:
        raise AssertionError("docker %s failed: %s" % (" ".join(args[:3]), result.stderr[-600:]))
    return result


class Namespaces:
    def __init__(self):
        self.containers, self.networks = [], []

    def network(self, name, subnet, gateway):
        docker("network", "create", "--internal", "--driver", "bridge", "--subnet", subnet, "--gateway", gateway, name)
        self.networks.append(name)

    def container(self, name, network, address, user="1001"):
        docker("run", "-d", "--name", name, "--network", network, "--ip", address, "--user", user, "--entrypoint", "sleep",
               IMAGE, "infinity")
        self.containers.append(name)

    def pid(self, name):
        return docker("inspect", "-f", "{{.State.Pid}}", name).stdout.strip()

    def reaches(self, client, address, port):
        return docker("exec", client, "python3", "-c", PROBE, address, str(port), check=False).returncode == 0

    def close(self):
        for name in self.containers:
            docker("rm", "-f", name, check=False)
        for name in self.networks:
            docker("network", "rm", name, check=False)


def host_has_table():
    return subprocess.run(["nft", "list", "table", "inet", "juno_computer_host"], capture_output=True).returncode == 0


@unittest.skipUnless(REQUIRED, "set JUNO_COMPUTER_HOST_FIREWALL_TESTS=1 (root, Docker, nft)")
class ComputerHostFirewall(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.geteuid() != 0 or not shutil.which("docker") or not shutil.which("nft") or not shutil.which("nsenter"):
            raise AssertionError("needs root, docker, nft and nsenter")
        for network in docker("network", "ls", "--format", "{{.Name}}").stdout.split():
            subnets = docker("network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", network).stdout
            if "172.30.0." in subnets:
                raise AssertionError("network %s already uses 172.30.0.0/24: run this where no computers network exists" % network)
        cls.machine_had_table = host_has_table()
        cls.ns = Namespaces()
        try:
            cls.ns.network(PUBLIC_NET, "10.231.20.0/24", "10.231.20.254")
            cls.ns.network(COMPUTERS_NET, "172.30.0.0/24", "172.30.0.254")
            cls.ns.container(PREFIX + "-host", PUBLIC_NET, HOST_PUBLIC, user="0")
            # The computers network reaches the host on an interface named br-juno, as on a real host.
            docker("network", "connect", "--ip", GATEWAY, "--driver-opt", "com.docker.network.endpoint.ifname=br-juno",
                   COMPUTERS_NET, PREFIX + "-host")
            for name, address in (("web", WEB), ("other", OTHER), ("admin", ADMIN)):
                cls.ns.container("%s-%s" % (PREFIX, name), PUBLIC_NET, address)
            cls.ns.container(PREFIX + "-computer", COMPUTERS_NET, COMPUTER)
            docker("exec", "-d", PREFIX + "-host", "python3", "-c", LISTENER)
            deadline = time.monotonic() + 15
            while not cls.ns.reaches(PREFIX + "-host", "127.0.0.1", 8751):
                if time.monotonic() > deadline:
                    raise AssertionError("the listeners did not start")
                time.sleep(0.2)
            interfaces = docker("exec", PREFIX + "-host", "cat", "/proc/net/dev").stdout
            if "br-juno:" not in interfaces:
                raise AssertionError("the host namespace has no br-juno interface: " + interfaces)
            # The positive control: everything answers before the ruleset.
            cls.control = {
                "other 443": cls.ns.reaches(PREFIX + "-other", HOST_PUBLIC, 443),
                "other 22": cls.ns.reaches(PREFIX + "-other", HOST_PUBLIC, 22),
                "computer 443": cls.ns.reaches(PREFIX + "-computer", GATEWAY, 443),
                "computer 3128": cls.ns.reaches(PREFIX + "-computer", GATEWAY, 3128),
            }
            ruleset = subprocess.run(["bash", str(ROOT / "deploy/computer-host/setup.sh"), "--print-nftables", "--web-ip", WEB,
                                      "--ssh-from", ADMIN + "/32"], capture_output=True, text=True, check=True).stdout
            with tempfile.NamedTemporaryFile("w", suffix=".nft", delete=False) as file:
                file.write(ruleset)
                cls.ruleset_file = file.name
            # Into the host container's namespace only.
            subprocess.run(["nsenter", "--net=/proc/%s/ns/net" % cls.ns.pid(PREFIX + "-host"), "nft", "-f", cls.ruleset_file],
                           check=True, capture_output=True, text=True)
        except BaseException:
            cls.ns.close()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.ns.close()
        os.unlink(cls.ruleset_file)

    def test_the_positive_control_reached_every_port_without_the_ruleset(self):
        self.assertEqual(self.control, {"other 443": True, "other 22": True, "computer 443": True, "computer 3128": True})

    def test_the_ruleset_is_in_the_host_namespace_and_not_on_this_machine(self):
        listing = subprocess.run(["nsenter", "--net=/proc/%s/ns/net" % self.ns.pid(PREFIX + "-host"), "nft", "list", "table",
                                  "inet", "juno_computer_host"], capture_output=True, text=True)
        self.assertEqual(listing.returncode, 0, listing.stderr)
        self.assertIn("policy drop", listing.stdout)
        self.assertEqual(host_has_table(), self.machine_had_table, "this machine's own rules were never touched")

    def test_a_computer_reaches_the_proxy_and_nothing_else_on_the_host(self):
        self.assertTrue(self.ns.reaches(PREFIX + "-computer", GATEWAY, 3128))
        for port in (443, 22, 8750, 8751):
            self.assertFalse(self.ns.reaches(PREFIX + "-computer", GATEWAY, port), port)

    def test_the_web_vm_reaches_443_and_nothing_else(self):
        self.assertTrue(self.ns.reaches(PREFIX + "-web", HOST_PUBLIC, 443))
        for port in (22, 3128, 8750):
            self.assertFalse(self.ns.reaches(PREFIX + "-web", HOST_PUBLIC, port), port)

    def test_another_address_reaches_neither_443_nor_22(self):
        for port in (443, 22, 3128, 8750):
            self.assertFalse(self.ns.reaches(PREFIX + "-other", HOST_PUBLIC, port), port)

    def test_ssh_from_reaches_22(self):
        self.assertTrue(self.ns.reaches(PREFIX + "-admin", HOST_PUBLIC, 22))
        self.assertFalse(self.ns.reaches(PREFIX + "-admin", HOST_PUBLIC, 443))

    def test_the_hosts_own_loopback_still_reaches_the_service(self):
        self.assertTrue(self.ns.reaches(PREFIX + "-host", "127.0.0.1", 8750))
        self.assertTrue(self.ns.reaches(PREFIX + "-host", "127.0.0.1", 8751))


if __name__ == "__main__":
    unittest.main()
