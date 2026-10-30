#!/usr/bin/python3 -I
"""Which computer each address on the computers network belongs to (COMPUTERS_2026-10.md D19).

Installed as /usr/local/sbin/juno-computers-egress-map (root). The egress proxy
reads the map to name the computer behind every connection it logs and to keep
each computer's bandwidth budget under its own name, so a new computer that is
given a stopped computer's address never inherits its budget or its log lines.

    juno-computers-egress-map rebuild         the map from `docker network inspect`
                                              (running computers only)
    juno-computers-egress-map release <name>  drop that computer's addresses now,
                                              and list them as releasing until the
                                              next rebuild (the proxy refuses them)
    juno-computers-egress-map watch           rebuild once, then on every network
                                              connect or disconnect of the computers
                                              network and every container `die`
                                              (the juno-computers-egress-map unit)

Writers: the broker, around every start (rebuild before and after), stop and
remove (release before, rebuild after), and the watch unit, which repairs the
map for a computer that stopped on its own (a crash, an OOM kill, the kill
switch). There is no timer.

The map (JUNO_EGRESS_MAP, default /run/juno-computers/egress-map.json, 0644):
    {"gen": n, "entries": {"172.30.0.x": {"name": "juno-agent-...", "since": iso}},
     "releasing": ["172.30.0.y"]}
written whole to a temporary file and renamed into place, under an flock, so a
reader never sees half of it. Only names the provider creates (juno-agent-*)
are mapped; anything else on the network stays unknown, and the proxy refuses it.
"""
import datetime
import fcntl
import json
import os
import re
import signal
import subprocess
import sys

MAP = os.environ.get("JUNO_EGRESS_MAP") or "/run/juno-computers/egress-map.json"
NETWORK = os.environ.get("JUNO_EGRESS_NETWORK") or "juno-computers"
DOCKER = "/usr/bin/docker"
NAME = re.compile(r"juno-agent-[A-Za-z0-9_-]{1,120}\Z")
DOCKER_ENV = {"PATH": "/usr/bin:/bin", "HOME": "/root"}


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def empty():
    return {"gen": 0, "entries": {}, "releasing": []}


def read_map(path=None):
    try:
        with open(path or MAP, encoding="utf-8") as file:
            data = json.load(file)
    except (OSError, ValueError):
        return empty()
    if not isinstance(data, dict) or not isinstance(data.get("entries"), dict):
        return empty()
    data.setdefault("gen", 0)
    data.setdefault("releasing", [])
    return data


def write_map(data, path=None):
    path = path or MAP
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, mode=0o755, exist_ok=True)
    temporary = "%s.%d.tmp" % (path, os.getpid())
    with open(temporary, "w", encoding="utf-8") as file:
        json.dump(data, file, sort_keys=True)
        file.flush()
        os.fsync(file.fileno())
    os.chmod(temporary, 0o644)
    os.replace(temporary, path)


class Locked:
    """flock on a sibling lock file: one writer at a time (broker calls and the watcher)."""

    def __init__(self, path=None):
        self.path = (path or MAP) + ".lock"

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path) or ".", mode=0o755, exist_ok=True)
        self.file = open(self.path, "a")
        fcntl.flock(self.file, fcntl.LOCK_EX)
        return self

    def __exit__(self, *_):
        fcntl.flock(self.file, fcntl.LOCK_UN)
        self.file.close()


def running_addresses(network=None, docker=None):
    """{address: name} for every juno-agent-* container attached to the network.
    A stopped container is detached, so only running (and paused) ones appear."""
    result = subprocess.run([docker or DOCKER, "network", "inspect", network or NETWORK, "--format", "{{json .Containers}}"],
                            capture_output=True, text=True, env=DOCKER_ENV, timeout=30)
    if result.returncode != 0:
        raise RuntimeError("docker network inspect failed")
    containers = json.loads(result.stdout or "null") or {}
    found = {}
    for value in containers.values():
        name = value.get("Name", "")
        address = (value.get("IPv4Address") or "").split("/")[0]
        if NAME.fullmatch(name) and address:
            found[address] = name
    return found


def rebuild(path=None, addresses=None):
    with Locked(path):
        old = read_map(path)
        current = running_addresses() if addresses is None else addresses
        entries = {}
        for address, name in sorted(current.items()):
            before = old["entries"].get(address)
            since = before["since"] if isinstance(before, dict) and before.get("name") == name and before.get("since") else now_iso()
            entries[address] = {"name": name, "since": since}
        data = {"gen": int(old.get("gen", 0)) + 1, "entries": entries, "releasing": []}
        write_map(data, path)
        return data


def release(name, path=None):
    if not NAME.fullmatch(name):
        raise ValueError("not a computer name")
    with Locked(path):
        old = read_map(path)
        entries = {address: entry for address, entry in old["entries"].items() if entry.get("name") != name}
        freed = [address for address, entry in old["entries"].items() if entry.get("name") == name]
        releasing = sorted(set(old.get("releasing", [])) | set(freed))
        data = {"gen": int(old.get("gen", 0)) + 1, "entries": entries, "releasing": releasing}
        write_map(data, path)
        return data


def relevant(event, network=None):
    """A docker event that can change which computer holds which address."""
    kind, action = event.get("Type"), event.get("Action", "")
    attributes = (event.get("Actor") or {}).get("Attributes") or {}
    if kind == "network" and action in ("connect", "disconnect"):
        return attributes.get("name") == (network or NETWORK)
    return kind == "container" and action == "die"


def watch():
    # Subscribe first, then rebuild, so nothing that happens in between is missed.
    events = subprocess.Popen([DOCKER, "events", "--filter", "type=network", "--filter", "type=container",
                               "--format", "{{json .}}"], stdout=subprocess.PIPE, text=True, env=DOCKER_ENV)

    def stop(_signal, _frame):
        events.terminate()
        sys.exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    rebuild()
    print("egress-map: watching", file=sys.stderr, flush=True)
    for line in events.stdout:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if relevant(event):
            try:
                rebuild()
            except Exception as error:  # keep watching; the next event retries
                print("egress-map: rebuild failed: %s" % type(error).__name__, file=sys.stderr, flush=True)
    return events.wait() or 1  # the stream ended: let the unit restart it


def main(argv):
    if argv[1:] == ["rebuild"]:
        rebuild()
        return 0
    if len(argv) == 3 and argv[1] == "release":
        release(argv[2])
        return 0
    if argv[1:] == ["watch"]:
        return watch()
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as error:
        print("egress-map: %s" % error, file=sys.stderr)
        sys.exit(1)
