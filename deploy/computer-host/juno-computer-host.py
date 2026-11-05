#!/usr/bin/python3
"""juno-computer-host: agent computers on a Linux machine of their own.

The web VM holds the database URL, the provider keys and AUTH_SECRET, and must
never run model-driven desktops beside them (COMPUTERS_2026-10.md, decision 5).
This service runs on a separate computer host, holds none of those, and gives
the app (src/lib/computer/remote.ts, RemoteComputerProvider) a narrow,
authenticated API covering exactly the ComputerProvider operations, plus
WebSocket tunnels that reach only ports 9222 (the CDP gate) and 5900 (x11vnc)
of containers this host created in the caller's namespace.

Two listeners on 127.0.0.1, one process, one ticket store:
  - the API (apiPort, a threaded http.server), JSON unless noted;
  - the tunnels (tunnelPort, asyncio websockets, the legacy API imported
    explicitly: Debian 12 and Ubuntu 24.04 ship 10.4, newer releases 13-14,
    whose default API differs; setup.sh refuses anything outside [10.4, 15)).
nginx terminates TLS on 443 and routes /v1/tunnel to the tunnel port and
everything else to the API. The API port also passes a /v1/tunnel upgrade
through to the tunnel port byte for byte, so the plain loopback profile of
local/run-local.sh is one origin too.

Authentication (D17): `Authorization: Bearer <token>`. The token's format is
checked (64 lowercase hex, or at least 43 base64url characters), it is hashed,
and the hash is compared with hmac.compare_digest against EVERY stored hash
(no early exit). The match fixes the request's namespace; every container,
volume, listing, ticket and tunnel is that namespace's only. tokensFile holds
[{"id", "sha256", "namespace"}], at most two per namespace (current and next,
for rotation without a restart); SIGHUP re-reads it. Retiring a token that
way also drops the tickets minted under it and closes the tunnels opened with
them (close code 1008), and a ticket request still in flight at that moment
mints nothing (the token is checked again under the ticket store's lock, and
again when a ticket is used), so a leaked token keeps nothing open once
retired. The log names the token id, never the token.

One process holds every tunnel on the host, under the unit's MemoryMax, so a
command's output is bounded before it is decoded: POST .../exec answers each
stream as base64 cut at 1 MiB (EXEC_OUTPUT_BYTES, with stdoutTruncated and
stderrTruncated; the app keeps 20,000 characters), and at most
maxCommandsPerComputer commands per computer and maxConcurrentCommands on the
host run at once (429 too_many_commands past either).

Every Docker call goes through the root broker (juno-computer-host-broker.py),
which imports the single-box broker's validate() and namespace checks: this
service runs with NoNewPrivileges, no docker group and no sudo. "No such
container" is the only answer that becomes 404 `no_such_container`; every
other daemon or broker failure is 502 `host_error`, so the app never mistakes
an outage for a deleted computer (which it would recreate).

Logs: one line per request with the operation, the computer name, the token
id, the status and the duration. Never a request line, a path or query (users'
file paths travel in ?path=), a command, file content, a token, a password or
a ticket.

    juno-computer-host.py [--config /etc/juno/computer-host.json]
    juno-computer-host.py --print-argv <operation> '<json>'   (lockstep tests)
"""
import asyncio
import base64
import contextlib
import hashlib
import hmac
import ipaddress
import json
import os
import posixpath
import re
import secrets
import signal
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

VERSION = "1"
# The image label src/lib/computer/docker.ts requires (COMPUTER_IMAGE_SECURITY_LABEL).
SECURITY_LABEL = "pipe-v4"
CONFIG = "/etc/juno/computer-host.json"
NAME = re.compile(r"juno-agent-[A-Za-z0-9_-]{1,120}\Z")
AGENT_ID = re.compile(r"[A-Za-z0-9_-]{1,120}\Z")
USER_REF = re.compile(r"u_[0-9a-f]{32}\Z")
NAMESPACE = re.compile(r"[a-z0-9][a-z0-9-]{0,31}\Z")
TOKEN_ID = re.compile(r"[A-Za-z0-9_-]{1,40}\Z")
TOKEN_FORMAT = re.compile(r"(?:[0-9a-f]{64}|[A-Za-z0-9_-]{43,512})\Z")
SHA256_HEX = re.compile(r"[0-9a-f]{64}\Z")
VNC_PASSWORD = re.compile(r"[A-Za-z0-9]{6,8}\Z")
TICKET_FORMAT = re.compile(r"[A-Za-z0-9_-]{43}\Z")
TUNNEL_PORTS = (9222, 5900)
WS_MAX_SIZE = 64 * 1024 * 1024
MAX_BODY = 30 * 1024 * 1024
MAX_OUTPUT = 16 * 1024 * 1024
# What one command's answer carries per stream. The app keeps the first 20,000 characters
# (MAX_SHELL_OUTPUT_CHARS in runner/agent-core/src/work/computer-tools.ts); 1 MiB is far past that.
EXEC_OUTPUT_BYTES = 1024 * 1024
# What a streamed command (POST .../exec with Accept: application/x-ndjson) forwards per stream as it
# runs: the app keeps at most 4096 KB per call for its terminal pane (AGENT_COMPUTER_SHELL_LOG_KB_PER_CALL),
# so past this the rest is read and dropped, never sent.
EXEC_STREAM_BYTES = 4 * 1024 * 1024
NDJSON = "application/x-ndjson"
VNC_TUNNEL_SECONDS = 2 * 60 * 60

# The same strings as src/lib/computer/docker.ts (the lockstep test compares the argv).
LAUNCHER = "/opt/juno/agent-exec"
DNS_SENTINEL = "192.0.2.53"
STATE_TMPFS = "/run/juno-state:rw,nosuid,nodev,noexec,size=64k,uid=1001,gid=1001,mode=0755"
FROZEN_MARKER = "/run/juno-state/frozen"
BROWSER_SANDBOX_STATE = "/run/juno-state/browser-sandbox"
IMAGE_LABEL_FORMAT = '{{index .Config.Labels "juno.security"}}'
IMAGE_INFO_FORMAT = '{{.Id}}\t{{index .Config.Labels "juno.security"}}\t{{.Created}}'
SCREENSHOT_SCRIPT = "scrot -o -z /tmp/juno-shot.png && cat /tmp/juno-shot.png"
PS_FORMAT = '{{.Names}}\t{{.Label "juno.agent"}}\t{{.Label "juno.user"}}\t{{.State}}'
PROVISION_SCRIPT = ("umask 077 && rm -f /run/juno/cdp-token.part && set -C && cat > /run/juno/cdp-token.part "
                    "&& mv -f /run/juno/cdp-token.part /run/juno/cdp-token")
VNC_PASSWORD_SCRIPT = "umask 077 && rm -f /run/juno/vncpass && set -C && cat > /run/juno/vncpass"
MAX_KEY_PRESSES = 32

DEFAULTS = {
    "image": "juno-computer:1",
    "network": "juno-computers",
    "subnet": "172.30.0.0/24",
    "gateway": "172.30.0.1",
    "memoryMb": 2048,
    "cpus": 2,
    "minFreeMemMb": 1024,
    "minFreeDiskMb": 10240,
    "maxRunning": 6,
    "listen": "127.0.0.1",
    "apiPort": 8750,
    "tunnelPort": 8751,
    "ticketTtlSeconds": 60,
    "maxTicketsPerComputer": 16,
    "maxCommandsPerComputer": 4,
    "maxConcurrentCommands": 24,
    "tokensFile": "/etc/juno/computer-host-tokens.json",
    "brokerPolicy": "/etc/juno/computer-host-broker.json",
    "brokerSocket": "/run/juno-computer-host/broker.sock",
    "developerBroker": None,
    "dockerRoot": "/var/lib/docker",
    "tlsCertificate": None,
}


def log(**fields):
    """One line on stderr (journald): only the fields given, never a path, query or secret."""
    parts = ["juno-computer-host"] + ["%s=%s" % (key, value) for key, value in fields.items() if value is not None]
    sys.stderr.write(" ".join(parts) + "\n")
    sys.stderr.flush()


# ── argv, in lockstep with src/lib/computer/docker.ts (computerArgv) ──────────


def agent_exec(name, mode, command, interactive=False, workdir=None):
    return (["exec"] + (["-i"] if interactive else []) + ["--user", "1000"] + (["--workdir", workdir] if workdir else [])
            + [name, LAUNCHER, mode, "--"] + list(command))


def x_clients(name, *args):
    return ["exec", "--user", "1001", "-e", "DISPLAY=:0", name, "python3", "-I", "/opt/juno/x-clients.py"] + list(args)


def js_round(value):
    """JavaScript's Math.round (half up), so both sides print the same number."""
    import math
    return int(math.floor(float(value) + 0.5))


def key_sequence(keys):
    return [key for key in re.split(r"\s+", keys.strip()) if 0 < len(key) <= 64][:MAX_KEY_PRESSES] if keys.strip() else []


def go_number(value):
    """String(n) for the numbers the argv carries (cpus may be 2 or 1.5)."""
    number = float(value)
    return str(int(number)) if number.is_integer() else repr(number)


class Argv:
    """Every docker argv this host sends. `ns` is the request's namespace."""

    @staticmethod
    def volume_create(agent_id, volume, ns):
        return ["volume", "create", "--label", "app=juno", "--label", "juno.agent=" + agent_id, "--label", "juno.ns=" + ns, volume]

    @staticmethod
    def create(agent_id, user_ref, ns, image, network, memory_mb, cpus, seccomp_profile):
        name = "juno-agent-" + agent_id
        argv = ["create", "--name", name, "--hostname", "computer", "--network", network, "--dns", DNS_SENTINEL,
                "--memory", "%dm" % memory_mb, "--memory-swap", "%dm" % memory_mb, "--cpus", go_number(cpus),
                "--pids-limit", "2048", "--shm-size", "1g", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"]
        if seccomp_profile:
            argv += ["--security-opt", "seccomp=" + seccomp_profile]
        argv += ["--read-only",
                 "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g,mode=1777",
                 "--tmpfs", "/run:rw,nosuid,nodev,size=64m",
                 "--tmpfs", "/run/juno:rw,nosuid,nodev,noexec,size=1m,uid=1001,gid=1001,mode=0700",
                 "--tmpfs", STATE_TMPFS,
                 "--tmpfs", "/var/tmp:rw,nosuid,nodev,size=256m",
                 "--mount", "type=volume,source=%s,target=/home/agent" % name,
                 "--mount", "type=volume,source=%s-browser,target=/home/browser" % name,
                 "--label", "app=juno", "--label", "juno.agent=" + agent_id, "--label", "juno.user=" + user_ref,
                 "--label", "juno.ns=" + ns,
                 "--restart", "no", "--stop-timeout", "20", image]
        return argv

    @staticmethod
    def lifecycle(operation, name):
        return [operation, name]

    @staticmethod
    def remove(name):
        return ["rm", "-f", name]

    @staticmethod
    def volume_remove(volume):
        return ["volume", "rm", "-f", volume]

    @staticmethod
    def state(name):
        return ["inspect", "-f", "{{.State.Status}}", name]

    @staticmethod
    def address(name, network):
        return ["inspect", "-f", "{{(index .NetworkSettings.Networks %s).IPAddress}}" % json.dumps(network), name]

    @staticmethod
    def container_image(name):
        return ["inspect", "-f", "{{.Image}}", name]

    @staticmethod
    def image_label(image):
        return ["image", "inspect", "--format", IMAGE_LABEL_FORMAT, image]

    @staticmethod
    def image_id(image):
        return ["image", "inspect", "--format", "{{.Id}}", image]

    @staticmethod
    def image_info(image):
        return ["image", "inspect", "--format", IMAGE_INFO_FORMAT, image]

    @staticmethod
    def provision_token(name):
        return ["exec", "-i", "--user", "1001", name, "sh", "-c", PROVISION_SCRIPT]

    @staticmethod
    def token_pending(name):
        return ["exec", "--user", "1001", name, "test", "-e", "/run/juno/cdp-token"]

    @staticmethod
    def screenshot(name):
        return agent_exec(name, "helper", ["sh", "-c", SCREENSHOT_SCRIPT])

    @staticmethod
    def click(name, x, y, button=None):
        command = ["xdotool", "mousemove", "--sync", str(js_round(x)), str(js_round(y)), "click"]
        if button == "double":
            command += ["--repeat", "2", "1"]
        elif button == "right":
            command += ["3"]
        else:
            command += ["1"]
        return agent_exec(name, "run", command)

    @staticmethod
    def type(name, text):
        return agent_exec(name, "run", ["xdotool", "type", "--delay", "12", "--", text])

    @staticmethod
    def key(name, keys):
        return agent_exec(name, "run", ["xdotool", "key", "--"] + key_sequence(keys))

    @staticmethod
    def scroll(name, x, y, dx=None, dy=None):
        dy = dy or 0
        repeat = max(1, min(20, js_round(abs(dy or dx or 3))))
        button = "4" if dy < 0 else "5"
        return agent_exec(name, "run", ["xdotool", "mousemove", str(js_round(x)), str(js_round(y)), "click", "--repeat",
                                        str(repeat), button])

    @staticmethod
    def drag(name, x1, y1, x2, y2):
        return agent_exec(name, "run", ["xdotool", "mousemove", str(js_round(x1)), str(js_round(y1)), "mousedown", "1",
                                        "mousemove", str(js_round(x2)), str(js_round(y2)), "mouseup", "1"])

    @staticmethod
    def exec(name, command, seconds, workdir):
        return agent_exec(name, "run", ["timeout", "--signal=TERM", "--kill-after=5", str(seconds), "bash", "--noprofile",
                                        "--norc", "-c", command], workdir=workdir)

    @staticmethod
    def realpath(name, candidate):
        return agent_exec(name, "helper", ["realpath", "-m", "--", candidate])

    @staticmethod
    def list(name, directory):
        return agent_exec(name, "helper", ["find", directory, "-maxdepth", "1", "-mindepth", "1", "-printf",
                                           "%y\\t%s\\t%T@\\t%p\\n"])

    @staticmethod
    def read(name, path, max_bytes):
        return agent_exec(name, "helper", ["head", "-c", str(max_bytes), "--", path])

    @staticmethod
    def mkdir(name, directory, mode):
        return agent_exec(name, mode, ["mkdir", "-p", "--", directory])

    @staticmethod
    def write(name, path, mode):
        return agent_exec(name, mode, ["sh", "-c", 'cat > "$1"', "sh", path], interactive=True)

    @staticmethod
    def du(name):
        return agent_exec(name, "helper", ["du", "-sm", "/home/agent"])

    @staticmethod
    def stat(name, path):
        return agent_exec(name, "helper", ["stat", "-c", "%s:%F", "--", path])

    @staticmethod
    def vnc_kill(name):
        return ["exec", "--user", "1001", name, "pkill", "-x", "x11vnc"]

    @staticmethod
    def vnc_kill_hard(name):
        return ["exec", "--user", "1001", name, "pkill", "-KILL", "-x", "x11vnc"]

    @staticmethod
    def vnc_password(name):
        return ["exec", "-i", "--user", "1001", name, "sh", "-c", VNC_PASSWORD_SCRIPT]

    @staticmethod
    def vnc_start(name, gateway):
        return ["exec", "--user", "1001", "-e", "DISPLAY=:0", name, "x11vnc", "-display", ":0", "-forever", "-shared",
                "-rfbport", "5900", "-noipv6", "-allow", gateway, "-passwdfile", "rm:/run/juno/vncpass", "-bg", "-o",
                "/tmp/x11vnc.log"]

    @staticmethod
    def vnc_running(name):
        return ["exec", "--user", "1001", name, "pgrep", "-x", "x11vnc"]

    @staticmethod
    def list_containers(ns):
        return ["ps", "-a", "--filter", "label=app=juno", "--filter", "label=juno.ns=" + ns, "--format", PS_FORMAT]

    @staticmethod
    def list_volumes(ns):
        return ["volume", "ls", "--filter", "name=juno-agent-", "--filter", "label=juno.ns=" + ns, "--format", "{{.Name}}"]

    @staticmethod
    def running_count():
        return ["ps", "-q", "--filter", "label=app=juno", "--filter", "status=running"]

    @staticmethod
    def freeze(name):
        return [["exec", "--user", "1001", name, "touch", FROZEN_MARKER],
                ["exec", "--user", "1000", name, LAUNCHER, "freeze"],
                x_clients(name, "close-uid", "1000"),
                x_clients(name, "release-all")]

    @staticmethod
    def thaw(name):
        return [["exec", "--user", "1001", name, "rm", "-f", FROZEN_MARKER],
                ["exec", "--user", "1000", name, LAUNCHER, "thaw"]]

    @staticmethod
    def sandbox_state(name):
        return ["exec", "--user", "1001", name, "cat", BROWSER_SANDBOX_STATE]

    @staticmethod
    def sandbox_probe(name):
        return agent_exec(name, "helper", ["unshare", "-Ur", "true"])


def print_argv(operation, raw):
    """`--print-argv`: the argv this host would send for one operation, as a JSON list of argv lists."""
    a = json.loads(raw)
    single = {
        "volumeCreate": lambda: Argv.volume_create(a["agentId"], a["volume"], a["namespace"]),
        "create": lambda: Argv.create(a["agentId"], a["userRef"], a["namespace"], a["image"], a["network"], a["memoryMb"],
                                      a["cpus"], a.get("seccompProfile")),
        "lifecycle": lambda: Argv.lifecycle(a["operation"], a["name"]),
        "remove": lambda: Argv.remove(a["name"]),
        "volumeRemove": lambda: Argv.volume_remove(a["volume"]),
        "state": lambda: Argv.state(a["name"]),
        "address": lambda: Argv.address(a["name"], a["network"]),
        "containerImage": lambda: Argv.container_image(a["name"]),
        "imageLabel": lambda: Argv.image_label(a["image"]),
        "imageId": lambda: Argv.image_id(a["image"]),
        "imageInfo": lambda: Argv.image_info(a["image"]),
        "provisionToken": lambda: Argv.provision_token(a["name"]),
        "tokenPending": lambda: Argv.token_pending(a["name"]),
        "screenshot": lambda: Argv.screenshot(a["name"]),
        "click": lambda: Argv.click(a["name"], a["x"], a["y"], a.get("button")),
        "type": lambda: Argv.type(a["name"], a["text"]),
        "key": lambda: Argv.key(a["name"], a["keys"]),
        "scroll": lambda: Argv.scroll(a["name"], a["x"], a["y"], a.get("dx"), a.get("dy")),
        "drag": lambda: Argv.drag(a["name"], a["x1"], a["y1"], a["x2"], a["y2"]),
        "exec": lambda: Argv.exec(a["name"], a["command"], a["seconds"], a["workdir"]),
        "realpath": lambda: Argv.realpath(a["name"], a["path"]),
        "list": lambda: Argv.list(a["name"], a["path"]),
        "read": lambda: Argv.read(a["name"], a["path"], a["maxBytes"]),
        "mkdir": lambda: Argv.mkdir(a["name"], a["path"], a["mode"]),
        "write": lambda: Argv.write(a["name"], a["path"], a["mode"]),
        "du": lambda: Argv.du(a["name"]),
        "stat": lambda: Argv.stat(a["name"], a["path"]),
        "vncKill": lambda: Argv.vnc_kill(a["name"]),
        "vncKillHard": lambda: Argv.vnc_kill_hard(a["name"]),
        "vncPassword": lambda: Argv.vnc_password(a["name"]),
        "vncStart": lambda: Argv.vnc_start(a["name"], a["gateway"]),
        "vncRunning": lambda: Argv.vnc_running(a["name"]),
        "listContainers": lambda: Argv.list_containers(a["namespace"]),
        "listVolumes": lambda: Argv.list_volumes(a["namespace"]),
        "sandboxState": lambda: Argv.sandbox_state(a["name"]),
        "sandboxProbe": lambda: Argv.sandbox_probe(a["name"]),
    }
    multi = {"freeze": lambda: Argv.freeze(a["name"]), "thaw": lambda: Argv.thaw(a["name"])}
    if operation in single:
        return [single[operation]()]
    if operation in multi:
        return multi[operation]()
    raise SystemExit("unknown operation " + operation)


# ── Path rules (the same as src/lib/computer/errors.ts and docker.ts; tests/fixtures/computer-paths.json) ──


def raw_path_ok(raw):
    return isinstance(raw, str) and 0 < len(raw) <= 4096 and not re.search(r"[\0\r\n]", raw)


def is_safe_agent_path(resolved):
    if not resolved or re.search(r"[\0\r\n]", resolved) or not resolved.startswith("/"):
        return False
    if any(part in ("..", ".") for part in resolved.split("/")) or "//" in resolved:
        return False
    return resolved == "/home/agent" or resolved.startswith("/home/agent/")


def is_agent_work_area_path(resolved):
    root = "/home/agent/work/"
    if not resolved.startswith(root):
        return False
    rest = resolved[len(root):].split("/")
    return len(rest) > 0 and all(part and not part.startswith(".") for part in rest)


# ── Config and tokens ──────────────────────────────────────────────────────────


def load_config(path):
    with open(path, encoding="utf-8") as file:
        raw = json.load(file)
    if not isinstance(raw, dict):
        raise SystemExit("juno-computer-host: the config is not a JSON object")
    unknown = set(raw) - set(DEFAULTS)
    if unknown:
        raise SystemExit("juno-computer-host: unknown config keys: " + ", ".join(sorted(unknown)))
    config = dict(DEFAULTS, **raw)
    if config["listen"] not in ("127.0.0.1", "::1"):
        raise SystemExit("juno-computer-host: listen on loopback only; nginx terminates TLS in front of it")
    for key in ("minFreeMemMb", "minFreeDiskMb", "maxRunning", "apiPort", "tunnelPort", "ticketTtlSeconds",
                "maxTicketsPerComputer", "memoryMb", "maxCommandsPerComputer", "maxConcurrentCommands"):
        if not isinstance(config[key], int) or config[key] < 0:
            raise SystemExit("juno-computer-host: %s must be a non-negative whole number" % key)
    # Each command in flight holds up to 2 MiB of output; these keep that far under the unit's MemoryMax.
    if not 1 <= config["maxCommandsPerComputer"] <= 16 or not 1 <= config["maxConcurrentCommands"] <= 64:
        raise SystemExit("juno-computer-host: maxCommandsPerComputer must be 1 to 16 and maxConcurrentCommands 1 to 64")
    if not 10 <= config["ticketTtlSeconds"] <= 300:
        raise SystemExit("juno-computer-host: ticketTtlSeconds must be between 10 and 300")
    ipaddress.ip_network(config["subnet"])
    ipaddress.ip_address(config["gateway"])
    return config


def parse_tokens(raw):
    """The tokens file, validated whole: a list of {id, sha256, namespace}, ids unique, at most two per namespace."""
    entries = json.loads(raw)
    if not isinstance(entries, list) or not entries:
        raise ValueError("the tokens file must be a non-empty JSON list")
    seen, per_namespace = set(), {}
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"id", "sha256", "namespace"}:
            raise ValueError("every token entry is exactly {id, sha256, namespace}")
        if not TOKEN_ID.fullmatch(str(entry["id"])) or not SHA256_HEX.fullmatch(str(entry["sha256"])) \
                or not NAMESPACE.fullmatch(str(entry["namespace"])):
            raise ValueError("a token entry is malformed")
        if entry["id"] in seen:
            raise ValueError("token ids must be unique")
        seen.add(entry["id"])
        per_namespace[entry["namespace"]] = per_namespace.get(entry["namespace"], 0) + 1
        if per_namespace[entry["namespace"]] > 2:
            raise ValueError("at most two tokens per namespace (current and next)")
    return [dict(entry) for entry in entries]


class Tokens:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        with open(path, encoding="utf-8") as file:
            self.entries = parse_tokens(file.read())

    def reload(self):
        """Re-reads the file. The ids of the tokens it no longer holds (an id whose hash changed counts as
        retired too), or None when the file is refused and the tokens in force stay as they are."""
        try:
            with open(self.path, encoding="utf-8") as file:
                entries = parse_tokens(file.read())
        except (OSError, ValueError) as error:
            log(op="reload", status="refused", reason=type(error).__name__)
            return None
        with self.lock:
            before = {(entry["id"], entry["sha256"]) for entry in self.entries}
            self.entries = entries
        kept = {(entry["id"], entry["sha256"]) for entry in entries}
        retired = {token_id for token_id, _ in before - kept}
        log(op="reload", status="ok", tokens=len(entries), retired=len(retired))
        return retired

    def in_force(self, token_id, sha256=None):
        """Whether this token (its id and, when given, its hash) is still in the file as last read."""
        with self.lock:
            return any(entry["id"] == token_id and (sha256 is None or entry["sha256"] == sha256)
                       for entry in self.entries)

    def match(self, header):
        """The entry the bearer token belongs to, or None. Every stored hash is compared."""
        if not header or not header.startswith("Bearer "):
            return None
        token = header[len("Bearer "):].strip()
        if not TOKEN_FORMAT.fullmatch(token):
            return None
        digest = hashlib.sha256(token.encode()).hexdigest().encode()
        with self.lock:
            entries = list(self.entries)
        found = None
        for entry in entries:
            if hmac.compare_digest(digest, entry["sha256"].encode()) and found is None:
                found = entry
        return found


# ── The broker ─────────────────────────────────────────────────────────────────


class BrokerError(Exception):
    pass


class Broker:
    """One docker command through the root broker: the socket, or a developer child process."""

    def __init__(self, config):
        developer = config.get("developerBroker")
        here = os.path.dirname(os.path.abspath(__file__))
        if developer:
            argv = [sys.executable, "-I", os.path.join(here, "juno-computer-host-broker.py"), "--developer",
                    "--policy", developer.get("policy") or config["brokerPolicy"]]
            if developer.get("docker"):
                argv += ["--docker", developer["docker"]]
            argv += ["--egress-map", developer.get("egressMap") or "none"]
            self.transport = {"mode": "process", "argv": argv}
        else:
            self.transport = {"mode": "socket", "path": config["brokerSocket"]}

    def run(self, argv, namespace, stdin=None, timeout=60, max_output=MAX_OUTPUT, on_output=None):
        """(exit status, stdout, stderr), each stream cut at max_output bytes: what follows is read and dropped,
        never held. Raises Missing, Foreign or BrokerError. `on_output(stream, bytes)` (stream "stdout" or
        "stderr") is called with every frame as the broker relays it, for a streamed command; whatever it
        raises (ClientGone) ends the call."""
        request = {"argv": argv, "namespace": namespace}
        if stdin is not None:
            request["stdin_b64"] = base64.b64encode(stdin).decode()
        data = (json.dumps(request) + "\n").encode()
        deadline = time.monotonic() + timeout
        out, err = [], []
        out_size = [0, 0]
        proc = sock = None
        try:
            if self.transport["mode"] == "socket":
                sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                sock.settimeout(timeout)
                sock.connect(self.transport["path"])
                sock.sendall(data)
                sock.shutdown(socket.SHUT_WR)
                reader = sock.makefile("rb")
            else:
                proc = subprocess.Popen(self.transport["argv"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL)
                timer = threading.Timer(timeout, proc.kill)
                timer.daemon = True
                timer.start()
                proc.stdin.write(data)
                proc.stdin.close()
                reader = proc.stdout
            while True:
                header = reader.read(5)
                if len(header) < 5:
                    if time.monotonic() >= deadline:
                        raise BrokerTimeout(b"".join(out), b"".join(err))
                    raise BrokerError("broker closed the connection")
                kind, length = header[:1], struct.unpack(">I", header[1:])[0]
                payload = reader.read(length) if length else b""
                if kind == b"o":
                    if out_size[0] < max_output:
                        out.append(payload[:max_output - out_size[0]])
                    out_size[0] += len(payload)
                    if on_output is not None and payload:
                        on_output("stdout", payload)
                elif kind == b"e":
                    if out_size[1] < max_output:
                        err.append(payload[:max_output - out_size[1]])
                    out_size[1] += len(payload)
                    if on_output is not None and payload:
                        on_output("stderr", payload)
                elif kind == b"x":
                    return int(payload.decode() or "1"), b"".join(out), b"".join(err)
                elif kind == b"r":
                    reason = payload.decode("utf-8", "replace")
                    if reason == "missing":
                        raise Missing()
                    if reason == "foreign":
                        raise Foreign()
                    raise BrokerError(reason)
                else:
                    raise BrokerError("unknown frame")
        except (OSError, ValueError) as error:
            if isinstance(error, socket.timeout) or time.monotonic() >= deadline:
                raise BrokerTimeout(b"".join(out), b"".join(err)) from None
            raise BrokerError(type(error).__name__) from None
        finally:
            if sock is not None:
                sock.close()
            if proc is not None:
                try:
                    proc.kill()
                except OSError:
                    pass
                proc.wait()


class BrokerTimeout(BrokerError):
    def __init__(self, stdout=b"", stderr=b""):
        super().__init__("timed out")
        self.stdout, self.stderr = stdout, stderr


class Missing(Exception):
    pass


class ClientGone(Exception):
    """The caller of a streamed command stopped reading. Not an OSError, so Broker.run does not take it for
    the broker's own failure: it ends the call, the broker's connection closes, and the command keeps its
    own time limit inside the computer."""


class Foreign(Exception):
    pass


class Refused(Exception):
    """An answer to the caller: an HTTP status and a stable code."""

    def __init__(self, status, code, extra=None):
        super().__init__(code)
        self.status, self.code, self.extra = status, code, extra or {}


MISSING_TEXT = re.compile(r"no such (container|object)", re.IGNORECASE)


# ── Tickets ────────────────────────────────────────────────────────────────────


class Tickets:
    """Single use, short lived, bound to one namespace, one container and one port; stored as sha256."""

    def __init__(self, ttl, per_computer, in_force=None):
        self.ttl, self.per_computer = ttl, per_computer
        # (token id, sha256) -> whether that token is still in force (Tokens.in_force), or None in a unit test.
        self.in_force = in_force
        self.lock = threading.Lock()
        self.items = {}

    def _prune(self, now):
        for key in [key for key, item in self.items.items() if item["expires"] <= now]:
            del self.items[key]

    def mint(self, namespace, name, port, token_id, token_sha256=None):
        now = time.time()
        with self.lock:
            # Checked under this lock, which revoke() also takes: a request that authenticated before its token
            # was retired either finds it retired here, or mints before revoke() runs and is dropped by it.
            if self.in_force is not None and not self.in_force(token_id, token_sha256):
                raise Refused(401, "unauthorized")
            self._prune(now)
            outstanding = sum(1 for item in self.items.values() if item["ns"] == namespace and item["name"] == name)
            if outstanding >= self.per_computer:
                raise Refused(429, "too_many_tickets")
            ticket = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
            item = {"ns": namespace, "name": name, "port": port, "expires": now + self.ttl, "token": token_id}
            if token_sha256 is not None:
                item["tokenSha256"] = token_sha256
            self.items[hashlib.sha256(ticket.encode()).hexdigest()] = item
        return ticket, int((now + self.ttl) * 1000)

    def consume(self, ticket):
        if not isinstance(ticket, str) or not TICKET_FORMAT.fullmatch(ticket):
            return None
        key = hashlib.sha256(ticket.encode()).hexdigest()
        with self.lock:
            self._prune(time.time())
            return self.items.pop(key, None)

    def revoke(self, token_ids):
        """Drops every outstanding ticket minted under one of these tokens; how many."""
        with self.lock:
            keys = [key for key, item in self.items.items() if item["token"] in token_ids]
            for key in keys:
                del self.items[key]
        return len(keys)


# ── The host's operations ─────────────────────────────────────────────────────


class Host:
    def __init__(self, config, broker=None, tokens=None):
        self.config = config
        self.broker = broker or Broker(config)
        self.tokens = tokens
        self.tickets = Tickets(config["ticketTtlSeconds"], config["maxTicketsPerComputer"],
                               tokens.in_force if tokens is not None else None)
        # Commands in flight per (namespace, computer): exec_slot().
        self.exec_lock = threading.Lock()
        self.execs_running = {}
        self.subnet = ipaddress.ip_network(config["subnet"])
        self.gateway = config["gateway"]
        # Every tunnel from the moment its ticket is consumed until its connection is lost:
        # protocol -> its record (token id, computer, port). Used on the event loop only.
        self.tunnels = {}

    def revoke_tokens(self, token_ids):
        """Retired tokens (SIGHUP): their outstanding tickets are dropped, a tunnel still in its handshake is
        refused, and every open tunnel is closed with 1008. Runs on the event loop (the signal handler)."""
        if not token_ids:
            return 0, 0
        dropped, closed = self.tickets.revoke(token_ids), 0
        for protocol, record in list(self.tunnels.items()):
            if record.get("token") in token_ids and not record.get("revoked"):
                record["revoked"] = True
                closed += 1
                if record.get("open"):
                    asyncio.ensure_future(protocol.close(1008, "token retired"))
        log(op="revoke", tokens=len(token_ids), tickets=dropped, tunnels=closed)
        return dropped, closed

    # broker helpers

    def docker(self, argv, ns, stdin=None, timeout=60, allow_nonzero=False, max_output=None):
        """stdout text of a command that must succeed (or any exit, with allow_nonzero: (code, out, err))."""
        try:
            if max_output is None:
                code, out, err = self.broker.run(argv, ns, stdin=stdin, timeout=timeout)
            else:
                code, out, err = self.broker.run(argv, ns, stdin=stdin, timeout=timeout, max_output=max_output)
        except Missing:
            raise Refused(404, "no_such_container")
        except Foreign:
            raise Refused(409, "name_conflict")
        except BrokerTimeout:
            raise Refused(504, "host_timeout")
        except BrokerError:
            raise Refused(502, "host_error")
        if allow_nonzero:
            return code, out, err
        if code != 0:
            if MISSING_TEXT.search(err.decode("utf-8", "replace")):
                raise Refused(404, "no_such_container")
            raise Refused(502, "host_error")
        return out

    def seccomp_profile(self):
        try:
            with open(self.config["brokerPolicy"], encoding="utf-8") as file:
                policy = json.load(file)
        except (OSError, ValueError):
            return None
        profile = policy.get("seccompProfile")
        if policy.get("browserSandbox") is True and isinstance(profile, str) and profile.startswith("/") and "\n" not in profile:
            return profile
        return None

    # health and capacity

    def image(self, ns):
        out = self.docker(Argv.image_info(self.config["image"]), ns, timeout=15).decode().strip()
        image_id, label, created = (out.split("\t") + ["", "", ""])[:3]
        return {"id": image_id, "label": label, "createdAt": created}

    def available(self, ns):
        code, out, _ = self.docker(Argv.image_label(self.config["image"]), ns, timeout=15, allow_nonzero=True)
        if code != 0 or out.decode().strip() != SECURITY_LABEL:
            return {"ok": False, "reason": "image_missing"}
        return {"ok": True}

    def running_count(self, ns):
        out = self.docker(Argv.running_count(), ns, timeout=15)
        return len([line for line in out.decode().split("\n") if line.strip()])

    def preflight(self, ns, count=True):
        available = self.available(ns)
        if not available["ok"]:
            return available
        try:
            with open("/proc/meminfo", encoding="utf-8") as file:
                match = re.search(r"^MemAvailable:\s+(\d+)\s+kB", file.read(), re.M)
            if match and int(match.group(1)) // 1024 < self.config["minFreeMemMb"]:
                return {"ok": False, "reason": "memory"}
        except OSError:
            pass
        try:
            stat = os.statvfs(self.config["dockerRoot"])
            if stat.f_bavail * stat.f_frsize // (1024 * 1024) < self.config["minFreeDiskMb"]:
                return {"ok": False, "reason": "disk"}
        except OSError:
            pass
        if count and self.running_count(ns) >= self.config["maxRunning"]:
            return {"ok": False, "reason": "capacity"}
        return {"ok": True}

    def health(self, ns, source):
        result = {"ok": True, "version": VERSION, "source": source, "maxRunning": self.config["maxRunning"]}
        try:
            image = self.image(ns)
            created = image["createdAt"]
            age = None
            try:
                built = time.mktime(time.strptime(created[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
                age = int((time.time() - built) // 86400)
            except ValueError:
                pass
            result["image"] = dict(image, ageDays=age, current=image["label"] == SECURITY_LABEL)
        except Refused:
            result["image"] = None
            result["ok"] = False
        try:
            result["running"] = self.running_count(ns)
        except Refused:
            result["running"] = None
            result["ok"] = False
        result["tls"] = None
        if self.config.get("tlsCertificate"):
            try:
                decoded = ssl._ssl._test_decode_cert(self.config["tlsCertificate"])  # noqa: SLF001
                result["tls"] = {"notAfter": decoded.get("notAfter")}
            except (OSError, ValueError, AttributeError, ssl.SSLError):
                result["tls"] = {"notAfter": None}
        return result

    # names

    @staticmethod
    def name_of(raw):
        if not isinstance(raw, str) or not NAME.fullmatch(raw):
            raise Refused(400, "bad_name")
        return raw

    # lifecycle

    def create(self, ns, body):
        agent_id, user_ref = body.get("agentId"), body.get("userRef")
        if not isinstance(agent_id, str) or not AGENT_ID.fullmatch(agent_id):
            raise Refused(400, "bad_agent")
        if not isinstance(user_ref, str) or not USER_REF.fullmatch(user_ref):
            raise Refused(400, "bad_user_ref")
        pre = self.preflight(ns, count=False)
        if not pre["ok"]:
            raise Refused(409, "preflight", {"reason": pre["reason"]})
        name = "juno-agent-" + agent_id
        self.docker(Argv.volume_create(agent_id, name, ns), ns)
        self.docker(Argv.volume_create(agent_id, name + "-browser", ns), ns)
        argv = Argv.create(agent_id, user_ref, ns, self.config["image"], self.config["network"], self.config["memoryMb"],
                           self.config["cpus"], self.seccomp_profile())
        code, _, _ = self.docker(argv, ns, timeout=60, allow_nonzero=True)
        # Docker's unique name is the last fence if an expired creator wakes up:
        # a container that already exists in this namespace is the computer.
        if code != 0 and self.state(ns, name) == "missing":
            raise Refused(502, "host_error")
        return {"name": name, "volume": name}

    def lifecycle(self, ns, name, operation):
        if operation in ("start", "unpause"):
            pre = self.preflight(ns, count=True)
            if not pre["ok"]:
                raise Refused(409, "preflight", {"reason": pre["reason"]})
        if operation == "stop":
            code, _, err = self.docker(Argv.lifecycle("stop", name), ns, timeout=40, allow_nonzero=True)
            if code != 0 and MISSING_TEXT.search(err.decode("utf-8", "replace")):
                raise Refused(404, "no_such_container")
            return {"ok": code == 0}
        self.docker(Argv.lifecycle(operation, name), ns, timeout=60)
        return {"ok": True}

    def destroy(self, ns, name, volumes):
        def remove(argv):
            try:
                code, _, err = self.docker(argv, ns, timeout=60, allow_nonzero=True)
            except Refused as refused:
                if refused.code == "no_such_container":
                    return
                raise
            if code != 0 and not re.search(r"no such (container|volume)", err.decode("utf-8", "replace"), re.I):
                raise Refused(502, "host_error")
        remove(Argv.remove(name))
        if volumes:
            remove(Argv.volume_remove(name + "-browser"))
            remove(Argv.volume_remove(name))
        return {"ok": True}

    def state(self, ns, name):
        try:
            code, out, err = self.docker(Argv.state(name), ns, timeout=15, allow_nonzero=True)
        except Refused as refused:
            if refused.code == "no_such_container":
                return "missing"
            raise
        if code != 0:
            if MISSING_TEXT.search(err.decode("utf-8", "replace")):
                return "missing"
            raise Refused(502, "host_error")
        status = out.decode().strip().lower()
        return status if status in ("running", "paused") else "exited"

    def provision_token(self, ns, name, token):
        if not token or len(token) > 512:
            raise Refused(400, "bad_token")
        self.docker(Argv.provision_token(name), ns, stdin=token, timeout=15)
        # Until the gate has taken the token it refuses every connection, and on
        # a first boot Chromium can take well over ten seconds to answer the
        # gate. Waited on by the clock, not by a number of tries: a check costs
        # a broker round trip here.
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            code, _, _ = self.docker(Argv.token_pending(name), ns, timeout=5, allow_nonzero=True)
            if code != 0:
                return {"ok": True, "taken": True}
            time.sleep(0.2)
        return {"ok": True, "taken": False}

    def screenshot(self, ns, name):
        code, out, _ = self.docker(Argv.screenshot(name), ns, timeout=30, allow_nonzero=True)
        if code != 0 or not out:
            raise Refused(502, "screenshot_failed")
        return out

    def input(self, ns, name, body):
        kind = body.get("kind")

        def number(key):
            value = body.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or abs(value) > 100000:
                raise Refused(400, "bad_input")
            return value

        def optional_number(key):
            return None if body.get(key) is None else number(key)

        if kind == "click":
            button = body.get("button")
            if button not in (None, "left", "right", "double"):
                raise Refused(400, "bad_input")
            argv = Argv.click(name, number("x"), number("y"), button)
        elif kind == "type":
            text = body.get("text")
            if not isinstance(text, str) or len(text) > 100000:
                raise Refused(400, "bad_input")
            argv = Argv.type(name, text)
        elif kind == "key":
            keys = body.get("keys")
            if not isinstance(keys, str) or not key_sequence(keys):
                raise Refused(400, "bad_input")
            argv = Argv.key(name, keys)
        elif kind == "scroll":
            argv = Argv.scroll(name, number("x"), number("y"), optional_number("dx"), optional_number("dy"))
        elif kind == "drag":
            argv = Argv.drag(name, number("x1"), number("y1"), number("x2"), number("y2"))
        else:
            raise Refused(400, "bad_input")
        code, _, _ = self.docker(argv, ns, timeout=60, allow_nonzero=True)
        if code != 0:
            raise Refused(409, "command_failed", {"exitCode": code})
        return {"ok": True}

    def resolve(self, ns, name, raw):
        """realpath as uid 1000 (an argv, no shell), checked as untrusted text: normalized, under /home/agent."""
        if not raw_path_ok(raw):
            raise Refused(422, "path_refused")
        candidate = raw if raw.startswith("/") else posixpath.join("/home/agent/work", raw)
        out = self.docker(Argv.realpath(name, candidate), ns, timeout=30).decode("utf-8", "replace")
        resolved = out[:-1] if out.endswith("\n") else out
        if not is_safe_agent_path(resolved) or posixpath.normpath(resolved) != resolved:
            raise Refused(422, "path_refused")
        return resolved

    def exec(self, ns, name, body, on_output=None):
        command = body.get("command")
        if not isinstance(command, str) or not command or len(command) > 100000:
            raise Refused(400, "bad_command")
        raw_seconds = body.get("timeoutSeconds", 30)
        if isinstance(raw_seconds, bool) or not isinstance(raw_seconds, (int, float)):
            raise Refused(400, "bad_command")
        seconds = max(1, min(300, js_round(raw_seconds)))
        cwd = body.get("cwd")
        workdir = self.resolve(ns, name, cwd) if cwd else "/home/agent/work"
        started = time.monotonic()
        try:
            # One byte past the cap, so a cut is known; the rest of the output is read and dropped.
            code, out, err = self.broker.run(Argv.exec(name, command, seconds, workdir), ns, timeout=seconds + 10,
                                             max_output=EXEC_OUTPUT_BYTES + 1, on_output=on_output)
            timed_out = code in (124, 137)
        except BrokerTimeout as timeout:
            code, out, err, timed_out = 124, timeout.stdout, timeout.stderr, True
        except Missing:
            raise Refused(404, "no_such_container")
        except Foreign:
            raise Refused(409, "name_conflict")
        except BrokerError:
            raise Refused(502, "host_error")
        # The bytes as they are, base64 (4/3 of the size): JSON's escapes cost six bytes for a control
        # byte, and the app decodes them as UTF-8 exactly as it does a same-host `docker exec`.
        return {"stdoutBase64": base64.b64encode(out[:EXEC_OUTPUT_BYTES]).decode("ascii"),
                "stderrBase64": base64.b64encode(err[:EXEC_OUTPUT_BYTES]).decode("ascii"),
                "stdoutTruncated": len(out) > EXEC_OUTPUT_BYTES, "stderrTruncated": len(err) > EXEC_OUTPUT_BYTES,
                "exitCode": code, "timedOut": timed_out, "durationMs": int((time.monotonic() - started) * 1000)}

    @contextlib.contextmanager
    def exec_slot(self, ns, name):
        """One of the host's command slots (maxConcurrentCommands) and one of this computer's
        (maxCommandsPerComputer), or 429 too_many_commands at once. Bounds the output the host holds."""
        key = (ns, name)
        with self.exec_lock:
            per_computer = self.execs_running.get(key, 0)
            total = sum(self.execs_running.values())
            if per_computer >= self.config["maxCommandsPerComputer"]:
                raise Refused(429, "too_many_commands", {"scope": "computer"})
            if total >= self.config["maxConcurrentCommands"]:
                raise Refused(429, "too_many_commands", {"scope": "host"})
            self.execs_running[key] = per_computer + 1
        try:
            yield
        finally:
            with self.exec_lock:
                left = self.execs_running.get(key, 1) - 1
                if left > 0:
                    self.execs_running[key] = left
                else:
                    self.execs_running.pop(key, None)

    def list_files(self, ns, name, directory):
        resolved = self.resolve(ns, name, directory or "/home/agent/work")
        code, out, _ = self.docker(Argv.list(name, resolved), ns, timeout=30, allow_nonzero=True)
        if code != 0:
            return []
        entries = []
        for line in out.decode("utf-8", "replace").split("\n"):
            line = line.strip()
            if not line:
                continue
            parts = line.split("\t")
            if len(parts) < 4:
                continue
            type_code, size, mtime, full = parts[0], parts[1], parts[2], "\t".join(parts[3:])
            entry = {"name": posixpath.basename(full), "path": full,
                     "type": "dir" if type_code == "d" else "file" if type_code == "f" else "other",
                     "size": int(size) if size.isdigit() else 0}
            try:
                seconds = float(mtime)
                if seconds > 0:
                    entry["modifiedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(seconds)) + ".%03dZ" % (int(seconds * 1000) % 1000)
            except ValueError:
                pass
            entries.append(entry)
        return sorted(entries, key=lambda entry: entry["name"])

    def file_info(self, ns, name, raw):
        resolved = self.resolve(ns, name, raw)
        code, out, _ = self.docker(Argv.stat(name, resolved), ns, timeout=30, allow_nonzero=True)
        if code != 0:
            return None
        size, _, kind = out.decode("utf-8", "replace").strip().partition(":")
        return {"path": resolved, "size": int(size) if size.isdigit() else 0,
                "type": "file" if kind in ("regular file", "regular empty file") else "dir" if kind == "directory" else "other"}

    def read_file(self, ns, name, raw, max_bytes):
        resolved = self.resolve(ns, name, raw)
        # Up to max_bytes (26 MiB), not the default 16 MiB cut: a 20 MiB deliverable is never handed on cut short.
        code, out, _ = self.docker(Argv.read(name, resolved, max_bytes), ns, timeout=60, allow_nonzero=True,
                                   max_output=max_bytes)
        if code != 0:
            raise Refused(422, "unreadable")
        return out[:max_bytes]

    def write_file(self, ns, name, raw, content, by):
        mode = "helper" if by == "person" else "run"
        resolved = self.resolve(ns, name, raw)
        # The rule is applied to the RESOLVED path, so a symlink under work/
        # pointing at ~/.bashrc or ~/.config/autostart cannot carry the write out.
        if not is_agent_work_area_path(resolved):
            raise Refused(422, "write_refused")
        code, _, _ = self.docker(Argv.mkdir(name, posixpath.dirname(resolved), mode), ns, timeout=30, allow_nonzero=True)
        if code != 0:
            raise Refused(409, "command_failed", {"exitCode": code})
        code, _, _ = self.docker(Argv.write(name, resolved, mode), ns, stdin=content, timeout=60, allow_nonzero=True)
        if code != 0:
            raise Refused(409, "command_failed", {"exitCode": code})
        return {"ok": True}

    def disk(self, ns, name):
        code, out, _ = self.docker(Argv.du(name), ns, timeout=60, allow_nonzero=True)
        if code != 0:
            return {"mb": 0}
        first = (out.decode().strip().split() or ["0"])[0]
        return {"mb": int(first) if first.isdigit() else 0}

    def start_vnc(self, ns, name, body):
        control, view = body.get("controlPassword"), body.get("viewPassword")
        if not isinstance(control, str) or not isinstance(view, str) or not VNC_PASSWORD.fullmatch(control) \
                or not VNC_PASSWORD.fullmatch(view):
            raise Refused(400, "bad_password")
        self.docker(Argv.vnc_kill(name), ns, timeout=15, allow_nonzero=True)
        # pkill only signals: the old server (the person's session) holds port
        # 5900 until it has exited, and a new one started at once failed
        # ("Address already in use") on a loaded host (src/lib/computer/docker.ts, the same wait).
        self.wait_for_vnc_exit(ns, name)
        self.docker(Argv.vnc_password(name), ns, stdin=("%s\n__BEGIN_VIEWONLY__\n%s\n" % (control, view)).encode(), timeout=15)
        self.docker(Argv.vnc_start(name, self.gateway), ns, timeout=30)
        return {"ok": True}

    def stop_vnc(self, ns, name):
        self.docker(Argv.vnc_kill(name), ns, timeout=15, allow_nonzero=True)
        # Stopped means exited: a take over that could not rotate ends the person's session this way, then thaws.
        self.wait_for_vnc_exit(ns, name)
        return {"ok": True}

    def wait_for_vnc_exit(self, ns, name, seconds=10, kill_after=3):
        """SIGTERM first; SIGKILL after `kill_after` s (x11vnc's TERM handler was seen deadlocked on a futex,
        holding the port and the person's session open); 502 if one still runs after `seconds`."""
        started = time.monotonic()
        killed = False
        while self.vnc_running(ns, name)["running"]:
            waited = time.monotonic() - started
            if waited >= seconds:
                raise Refused(502, "host_error")
            if not killed and waited >= kill_after:
                killed = True
                self.docker(Argv.vnc_kill_hard(name), ns, timeout=15, allow_nonzero=True)
            time.sleep(0.1)

    def vnc_running(self, ns, name):
        code, out, _ = self.docker(Argv.vnc_running(name), ns, timeout=10, allow_nonzero=True)
        return {"running": code == 0 and bool(out.strip())}

    def freeze(self, ns, name):
        failed = None
        for step, argv in zip(("marker", "stop", "display", "keys"), Argv.freeze(name)):
            code, _, _ = self.docker(argv, ns, timeout=20, allow_nonzero=True)
            if code != 0 and failed is None:
                failed = step
        if failed:
            raise Refused(502, "freeze_failed", {"step": failed})
        return {"ok": True}

    def thaw(self, ns, name):
        for argv in Argv.thaw(name):
            self.docker(argv, ns, timeout=20)
        return {"ok": True}

    def browser_sandbox(self, ns, name):
        code, out, _ = self.docker(Argv.sandbox_state(name), ns, timeout=10, allow_nonzero=True)
        probe_code, _, probe_err = self.docker(Argv.sandbox_probe(name), ns, timeout=15, allow_nonzero=True)
        if probe_code == 0:
            raise Refused(409, "sandbox_check_failed")
        ban_holds = re.search(r"operation not permitted", probe_err.decode("utf-8", "replace"), re.I) is not None
        if code != 0:
            return {"state": "unknown"}
        return {"state": "on" if out.decode().strip() == "on" and ban_holds else "off"}

    def outdated(self, ns, name):
        container = self.docker(Argv.container_image(name), ns, timeout=10).decode().strip()
        current = self.docker(Argv.image_id(self.config["image"]), ns, timeout=10).decode().strip()
        return {"outdated": bool(current) and container != current}

    def owned(self, ns):
        out = self.docker(Argv.list_containers(ns), ns, timeout=30).decode("utf-8", "replace")
        containers = []
        for line in out.split("\n"):
            parts = line.strip().split("\t")
            if len(parts) < 4 or not parts[0].startswith("juno-agent-"):
                continue
            state = parts[3]
            containers.append({"name": parts[0], "agentId": parts[1] or None, "userId": parts[2] or None,
                               "state": state if state in ("running", "paused") else "exited"})
        volumes = [line.strip() for line in self.docker(Argv.list_volumes(ns), ns, timeout=30).decode().split("\n")
                   if line.strip().startswith("juno-agent-")]
        return {"containers": containers, "volumes": volumes}

    def ticket(self, ns, name, body, token_id, token_sha256=None):
        port = body.get("port")
        if isinstance(port, bool) or port not in TUNNEL_PORTS:
            raise Refused(400, "bad_port")
        if self.state(ns, name) == "missing":
            raise Refused(404, "no_such_container")
        ticket, expires_at = self.tickets.mint(ns, name, port, token_id, token_sha256)
        return {"ticket": ticket, "expiresAt": expires_at}

    def address(self, ns, name):
        """The container's address on the computers network, inside the subnet and not the gateway."""
        out = self.docker(Argv.address(name, self.config["network"]), ns, timeout=15).decode().strip()
        try:
            address = ipaddress.ip_address(out)
        except ValueError:
            raise Refused(502, "no_address")
        if address not in self.subnet or str(address) == self.gateway:
            raise Refused(502, "no_address")
        return str(address)


# ── HTTP API ──────────────────────────────────────────────────────────────────

COMPUTER_ROUTE = re.compile(r"/v1/computers/([^/]+)(/[a-z/-]*)?\Z")


def make_handler(host, tokens):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "juno-computer-host"
        sys_version = ""

        # Never the request line: users' file paths travel in ?path=.
        def log_message(self, *_args):
            pass

        def log_request(self, *_args):
            pass

        def log_error(self, *_args):
            pass

        def peer_source(self):
            peer = self.client_address[0]
            forwarded = self.headers.get("X-Real-IP")
            if forwarded and peer in ("127.0.0.1", "::1"):
                return forwarded.strip()[:64]
            return peer

        def respond(self, status, body, content_type="application/json"):
            data = body if isinstance(body, (bytes, bytearray)) else json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def body(self):
            length = self.headers.get("Content-Length")
            if length is None or not length.isdigit():
                raise Refused(411, "length_required")
            size = int(length)
            if size > MAX_BODY:
                raise Refused(413, "too_large")
            data = b""
            while len(data) < size:
                chunk = self.rfile.read(size - len(data))
                if not chunk:
                    break
                data += chunk
            return data

        def json_body(self):
            raw = self.body()
            try:
                value = json.loads(raw.decode("utf-8") or "{}")
            except (ValueError, UnicodeDecodeError):
                raise Refused(400, "bad_json")
            if not isinstance(value, dict):
                raise Refused(400, "bad_json")
            return value

        def handle_method(self, method):
            started = time.monotonic()
            op, name, token_id, status = "unknown", None, None, 500
            self.routed = None  # (operation, computer) once route() has parsed them, for a refusal's log line
            try:
                parts = urlsplit(self.path)
                path, query = parts.path, parse_qs(parts.query)
                if method == "GET" and path == "/v1/tunnel" and self.headers.get("Upgrade", "").lower() == "websocket":
                    op = "tunnel-pass"
                    status = self.splice_tunnel()
                    return
                entry = tokens.match(self.headers.get("Authorization"))
                if entry is None:
                    status = 401
                    raise Refused(401, "unauthorized")
                ns, token_id = entry["namespace"], entry["id"]
                self.token_sha256 = entry["sha256"]
                op, name, status = self.route(method, path, query, ns, token_id)
            except Refused as refused:
                status = refused.status
                if self.routed:
                    op, name = self.routed
                body = dict({"error": refused.code}, **refused.extra)
                try:
                    self.respond(refused.status, body)
                except OSError:
                    pass
            except Exception as error:  # never a traceback, a path or a query to the caller
                status = 500
                log(op=op, status=500, error=type(error).__name__)
                try:
                    self.respond(500, {"error": "host_error"})
                except OSError:
                    pass
            finally:
                log(op=op, computer=name, token=token_id, status=status, ms=int((time.monotonic() - started) * 1000))

        def route(self, method, path, query, ns, token_id):
            if path == "/v1/health" and method == "GET":
                self.respond(200, host.health(ns, self.peer_source()))
                return "health", None, 200
            if path == "/v1/available" and method == "GET":
                self.respond(200, host.available(ns))
                return "available", None, 200
            if path == "/v1/preflight" and method == "GET":
                self.respond(200, host.preflight(ns))
                return "preflight", None, 200
            if path == "/v1/image" and method == "GET":
                self.respond(200, host.image(ns))
                return "image", None, 200
            if path == "/v1/owned" and method == "GET":
                self.respond(200, host.owned(ns))
                return "owned", None, 200
            if path == "/v1/computers" and method == "POST":
                result = host.create(ns, self.json_body())
                self.respond(200, result)
                return "create", result["name"], 200
            match = COMPUTER_ROUTE.fullmatch(path)
            if not match:
                raise Refused(404, "not_found")
            name = Host.name_of(match.group(1))
            action = (match.group(2) or "").lstrip("/")
            self.routed = ((action or "computer").replace("/", "-")[:32], name)  # [a-z/-] only (COMPUTER_ROUTE)
            key = (method, action)
            if key in (("POST", "start"), ("POST", "stop"), ("POST", "pause"), ("POST", "unpause")):
                self.respond(200, host.lifecycle(ns, name, action))
            elif key == ("DELETE", ""):
                self.respond(200, host.destroy(ns, name, query.get("volumes", ["0"])[0] == "1"))
                action = "destroy"
            elif key == ("GET", "state"):
                state = host.state(ns, name)
                if state == "missing":
                    raise Refused(404, "no_such_container")
                self.respond(200, {"state": state})
            elif key == ("PUT", "cdp-token"):
                self.respond(200, host.provision_token(ns, name, self.body()))
            elif key == ("GET", "screenshot"):
                self.respond(200, host.screenshot(ns, name), "image/png")
            elif key == ("POST", "input"):
                self.respond(200, host.input(ns, name, self.json_body()))
            elif key == ("POST", "exec"):
                body = self.json_body()
                # The slot is held until the answer is written, so the host never holds more than
                # maxConcurrentCommands answers at once (Host.exec_slot).
                with host.exec_slot(ns, name):
                    if NDJSON in (self.headers.get("Accept") or ""):
                        self.stream_exec(ns, name, body)
                    else:
                        self.respond(200, host.exec(ns, name, body))
            elif key == ("GET", "files"):
                self.respond(200, host.list_files(ns, name, query.get("path", [None])[0]))
            elif key == ("GET", "files/info"):
                self.respond(200, host.file_info(ns, name, query.get("path", [""])[0]))
            elif key == ("GET", "files/content"):
                raw_max = query.get("maxBytes", [str(5 * 1024 * 1024)])[0]
                if not raw_max.isdigit() or not 0 < int(raw_max) <= 26 * 1024 * 1024:
                    raise Refused(400, "bad_max_bytes")
                self.respond(200, host.read_file(ns, name, query.get("path", [""])[0], int(raw_max)),
                             "application/octet-stream")
            elif key == ("PUT", "files/content"):
                by = query.get("by", ["agent"])[0]
                if by not in ("agent", "person"):
                    raise Refused(400, "bad_by")
                self.respond(200, host.write_file(ns, name, query.get("path", [""])[0], self.body(), by))
            elif key == ("GET", "disk"):
                self.respond(200, host.disk(ns, name))
            elif key == ("PUT", "vnc"):
                self.respond(200, host.start_vnc(ns, name, self.json_body()))
            elif key == ("DELETE", "vnc"):
                self.respond(200, host.stop_vnc(ns, name))
            elif key == ("GET", "vnc"):
                self.respond(200, host.vnc_running(ns, name))
            elif key == ("POST", "freeze"):
                self.respond(200, host.freeze(ns, name))
            elif key == ("POST", "thaw"):
                self.respond(200, host.thaw(ns, name))
            elif key == ("GET", "browser-sandbox"):
                self.respond(200, host.browser_sandbox(ns, name))
            elif key == ("GET", "outdated"):
                self.respond(200, host.outdated(ns, name))
            elif key == ("POST", "tickets"):
                self.respond(200, host.ticket(ns, name, self.json_body(), token_id, self.token_sha256))
            else:
                raise Refused(404, "not_found")
            return (action or "computer").replace("/", "-"), name, 200

        def stream_exec(self, ns, name, body):
            """A command's output as it runs (COMPUTERS_2026-10.md S5.1): NDJSON, one line per piece,
            {"stream": "stdout"|"stderr", "data_b64": ...}, flushed as the broker relays it, and a last line
            {"exit", "timedOut", "durationMs", "stdoutTruncated", "stderrTruncated"}. Nothing is sent until
            the first piece (or the end), so a refusal before the command runs (a refused cwd, a missing
            container) is still an ordinary status and code. A failure after the first line is a last line
            {"error": code}. At most EXEC_STREAM_BYTES of each stream is forwarded; the rest is dropped."""
            state = {"started": False, "sent": {"stdout": 0, "stderr": 0}}

            def chunk(data):
                try:
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
                    self.wfile.flush()
                except OSError:
                    raise ClientGone() from None

            def start():
                if state["started"]:
                    return
                state["started"] = True
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", NDJSON)
                    self.send_header("Transfer-Encoding", "chunked")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("X-Accel-Buffering", "no")
                    self.end_headers()
                except OSError:
                    raise ClientGone() from None

            def line(value):
                start()
                chunk((json.dumps(value) + "\n").encode())

            def on_output(stream, payload):
                room = EXEC_STREAM_BYTES - state["sent"][stream]
                if room <= 0:
                    return
                piece = payload[:room]
                state["sent"][stream] += len(piece)
                line({"stream": stream, "data_b64": base64.b64encode(piece).decode("ascii")})

            try:
                result = host.exec(ns, name, body, on_output=on_output)
            except ClientGone:
                self.close_connection = True
                return
            except Refused as refused:
                if not state["started"]:
                    raise
                result = {"error": refused.code}
            try:
                if "error" in result:
                    line(result)
                else:
                    line({"exit": result["exitCode"], "timedOut": result["timedOut"], "durationMs": result["durationMs"],
                          "stdoutTruncated": result["stdoutTruncated"], "stderrTruncated": result["stderrTruncated"]})
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (ClientGone, OSError):
                self.close_connection = True

        def splice_tunnel(self):
            """Passes a /v1/tunnel upgrade through to the tunnel listener, as nginx does in production."""
            upstream = socket.create_connection(("127.0.0.1", host.config["tunnelPort"]), timeout=10)
            upstream.settimeout(None)
            lines = [self.requestline + "\r\n"]
            for key, value in self.headers.items():
                if key.lower() != "x-real-ip":
                    lines.append("%s: %s\r\n" % (key, value))
            lines.append("X-Real-IP: %s\r\n\r\n" % self.peer_source())
            upstream.sendall("".join(lines).encode("latin-1"))
            self.close_connection = True

            def downstream():
                try:
                    while True:
                        chunk = upstream.recv(65536)
                        if not chunk:
                            break
                        self.connection.sendall(chunk)
                except OSError:
                    pass
                finally:
                    try:
                        self.connection.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass

            thread = threading.Thread(target=downstream, daemon=True)
            thread.start()
            try:
                while True:
                    chunk = self.rfile.read1(65536)
                    if not chunk:
                        break
                    upstream.sendall(chunk)
            except OSError:
                pass
            finally:
                try:
                    upstream.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                thread.join(timeout=5)
                upstream.close()
            return 101

        def do_GET(self):
            self.handle_method("GET")

        def do_POST(self):
            self.handle_method("POST")

        def do_PUT(self):
            self.handle_method("PUT")

        def do_DELETE(self):
            self.handle_method("DELETE")

    return Handler


# ── Tunnels ───────────────────────────────────────────────────────────────────


def tunnel_server(host, loop_ready=None):
    """The asyncio websockets listener: a ticket in X-Juno-Tunnel-Ticket, no subprotocol, 9222 or 5900 only."""
    import websockets
    import websockets.exceptions
    import websockets.legacy.client as ws_client
    import websockets.legacy.server as ws_server
    from websockets.exceptions import ConnectionClosed, InvalidStatusCode

    version = tuple(int(part) for part in websockets.__version__.split(".")[:2])
    if not (10, 4) <= version < (15, 0):
        raise SystemExit("juno-computer-host: websockets %s is outside [10.4, 15)" % websockets.__version__)

    def refuse(juno, status, **fields):
        juno["status"] = status
        log(op="tunnel", status=status, **fields)
        return HTTPStatus(status), [("Content-Length", "0"), ("Connection", "close")], b""

    class TunnelProtocol(ws_server.WebSocketServerProtocol):
        """Checks the ticket, resolves the container and opens the upstream leg
        BEFORE the 101, so a caller whose ticket, computer or gate token is
        refused gets an HTTP status, never an open socket that goes nowhere."""
        juno = None

        async def process_request(self, path, request_headers):
            self.juno = juno = {"started": time.monotonic(), "status": 101}
            if urlsplit(path).path != "/v1/tunnel":
                return refuse(juno, 404)
            values = request_headers.get_all("X-Juno-Tunnel-Ticket")
            record = host.tickets.consume(values[0]) if len(values) == 1 else None
            if record is None:
                return refuse(juno, 401)
            if host.tokens is not None and not host.tokens.in_force(record["token"], record.get("tokenSha256")):
                # Minted under a token retired since (a ticket that escaped Tickets.revoke): opens nothing.
                return refuse(juno, 401, token=record["token"])
            juno.update(name=record["name"], port=record["port"], token=record["token"])
            host.tunnels[self] = juno  # from here on, retiring its token reaches it (Host.revoke_tokens)
            fields = {"computer": record["name"], "token": record["token"], "port": record["port"]}
            cdp = None
            if record["port"] == 9222:
                tokens_ = request_headers.get_all("X-Juno-Cdp-Token")
                if len(tokens_) != 1 or not tokens_[0] or len(tokens_[0]) > 512:
                    return refuse(juno, 400, **fields)
                cdp = tokens_[0]
            loop = asyncio.get_running_loop()
            try:
                address = await loop.run_in_executor(None, host.address, record["ns"], record["name"])
            except Refused as refused:
                return refuse(juno, refused.status, **fields)
            try:
                if cdp is not None:
                    juno["upstream"] = await ws_client.connect(
                        "ws://%s:9222/devtools/browser" % address, extra_headers=[("X-Juno-Cdp-Token", cdp)],
                        max_size=WS_MAX_SIZE, max_queue=32, ping_interval=30, ping_timeout=30, open_timeout=15,
                        compression=None)
                else:
                    juno["upstream"] = await asyncio.wait_for(asyncio.open_connection(address, 5900), 15)
            except InvalidStatusCode as refused:
                # The gate refused the caller's CDP token (403), or is busy with another client.
                return refuse(juno, 403 if refused.status_code == 403 else 502, **fields)
            except (OSError, asyncio.TimeoutError, websockets.exceptions.WebSocketException):
                return refuse(juno, 502, **fields)
            if juno.get("revoked"):
                # Its token was retired while the upstream leg opened.
                return refuse(juno, 401, **fields)
            return None

        def connection_lost(self, exc):
            host.tunnels.pop(self, None)
            # A handshake that failed after the upstream was opened: close it.
            upstream = (self.juno or {}).pop("upstream", None)
            if upstream is not None:
                if isinstance(upstream, tuple):
                    upstream[1].close()
                else:
                    asyncio.ensure_future(upstream.close())
            super().connection_lost(exc)

    async def bridge_cdp(websocket, upstream):
        async def pump(source, target):
            try:
                async for message in source:
                    await target.send(message)
            except ConnectionClosed:
                pass

        tasks = [asyncio.ensure_future(pump(websocket, upstream)), asyncio.ensure_future(pump(upstream, websocket))]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in tasks:
            task.cancel()
        await upstream.close()
        await websocket.close()
        return 1000

    async def bridge_vnc(websocket, upstream):
        reader, writer = upstream

        async def to_tcp():
            try:
                async for message in websocket:
                    if isinstance(message, str):
                        message = message.encode()
                    writer.write(message)
                    await writer.drain()
            except (ConnectionClosed, OSError):
                pass

        async def from_tcp():
            try:
                while True:
                    chunk = await reader.read(65536)
                    if not chunk:
                        break
                    await websocket.send(chunk)
            except (ConnectionClosed, OSError):
                pass

        tasks = [asyncio.ensure_future(to_tcp()), asyncio.ensure_future(from_tcp())]
        await asyncio.wait(tasks, timeout=VNC_TUNNEL_SECONDS, return_when=asyncio.FIRST_COMPLETED)
        for task in tasks:
            task.cancel()
        writer.close()
        await websocket.close()
        return 1000

    async def handler(websocket, path=None):
        juno = websocket.juno or {}
        upstream = juno.pop("upstream", None)
        juno["open"] = True
        code = 1011
        try:
            if juno.get("revoked"):
                code = 1008
                if upstream is not None:
                    if isinstance(upstream, tuple):
                        upstream[1].close()
                    else:
                        await upstream.close()
                await websocket.close(1008, "token retired")
            elif upstream is not None and juno.get("port") == 9222:
                code = await bridge_cdp(websocket, upstream)
            elif upstream is not None and juno.get("port") == 5900:
                code = await bridge_vnc(websocket, upstream)
            else:
                await websocket.close(1011)
        finally:
            if juno.get("revoked"):
                code = 1008
            log(op="tunnel", computer=juno.get("name"), token=juno.get("token"), port=juno.get("port"), status=101,
                close=code, ms=int((time.monotonic() - juno.get("started", time.monotonic())) * 1000))

    return ws_server.serve(handler, host.config["listen"], host.config["tunnelPort"], create_protocol=TunnelProtocol,
                           subprotocols=None, max_size=WS_MAX_SIZE, max_queue=32, ping_interval=30, ping_timeout=30,
                           compression=None)


# ── Main ──────────────────────────────────────────────────────────────────────


# What the web VM holds and a computer host must never (decision 5): it would
# put the database URL, the app's signing secret or a provider key one process
# away from model-driven desktops. The host refuses to start with any of them.
APP_SECRET_NAMES = ("DATABASE_URL", "DIRECT_URL", "AUTH_SECRET", "NEXTAUTH_SECRET", "COMPUTER_HOST_TOKEN",
                    "CODE_INTERPRETER_TOKEN", "STRIPE_SECRET_KEY", "RESEND_API_KEY")


def app_secrets_in(environment):
    """The names of app secrets present in an environment (never their values)."""
    return sorted(name for name, value in environment.items()
                  if value and (name in APP_SECRET_NAMES or name.endswith("_API_KEY")))


def serve(config_path):
    leaked = app_secrets_in(os.environ)
    if leaked:
        raise SystemExit("juno-computer-host: refusing to start with app secrets in its environment (%s): "
                         "a computer host holds none of the web VM's secrets" % ", ".join(leaked))
    config = load_config(config_path)
    try:
        tokens = Tokens(config["tokensFile"])
    except (OSError, ValueError) as error:
        raise SystemExit("juno-computer-host: the tokens file is unreadable or malformed (%s)" % type(error).__name__)
    host = Host(config, tokens=tokens)
    api = ThreadingHTTPServer((config["listen"], config["apiPort"]), make_handler(host, tokens))
    api.daemon_threads = True
    threading.Thread(target=api.serve_forever, daemon=True).start()

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    stop = loop.create_future()
    loop.add_signal_handler(signal.SIGHUP, lambda: host.revoke_tokens(tokens.reload()))
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, lambda: stop.done() or stop.set_result(None))
    server = loop.run_until_complete(tunnel_server(host))
    log(op="listen", api=config["apiPort"], tunnel=config["tunnelPort"], tokens=len(tokens.entries), version=VERSION)
    try:
        loop.run_until_complete(stop)
    finally:
        server.close()
        loop.run_until_complete(server.wait_closed())
        api.shutdown()
        log(op="stopped")


def main(argv):
    if argv[:1] == ["--print-argv"]:
        if len(argv) != 3:
            raise SystemExit("usage: juno-computer-host.py --print-argv <operation> '<json>'")
        print(json.dumps(print_argv(argv[1], argv[2])))
        return 0
    config_path = os.environ.get("JUNO_COMPUTER_HOST_CONFIG") or CONFIG
    if argv[:1] == ["--config"] and len(argv) == 2:
        config_path = argv[1]
    elif argv:
        raise SystemExit("usage: juno-computer-host.py [--config <file>] | --print-argv <operation> '<json>'")
    serve(config_path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
