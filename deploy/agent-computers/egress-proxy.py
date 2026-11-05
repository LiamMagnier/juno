#!/usr/bin/python3
"""Agent-only HTTP proxy: validate every DNS answer and pin the chosen socket.

The firewall lets computers reach this proxy and nothing else: no direct
outbound connection and no DNS (pipe-v4; names resolve here, on the host). No
cloud/private/loopback destination is reachable through CONNECT, absolute HTTP
requests or a DNS rebinding.

Every connection is attributed to the computer that made it, by the address map
the broker and the map watcher keep (egress-map.py; COMPUTERS_2026-10.md D19):
an address the map does not know is re-checked for up to 2 s, then refused
("unmapped"), never guessed. Each connection is logged when it ends, one JSON
line in JUNO_EGRESS_LOG_FILE (default $LOGS_DIRECTORY/egress.jsonl): start, end,
computer, source address, host, port, bytes up and down and the verdict. Never a
path, a query, a header or a body. Each computer (by container name, so a new
computer on a reused address starts empty) has a budget of
JUNO_EGRESS_MAX_MB_PER_HOUR (default 1024) MB per rolling hour, both directions:
over it, a new request gets 403 and an open tunnel is closed at its next chunk.
The budget is saved to $STATE_DIRECTORY/budget.json every 10 s and at SIGTERM,
and loaded at start, so a restart never resets it.
"""
import datetime
import ipaddress
import json
import os
import select
import signal
import socket
import sys
import threading
import time
from urllib.parse import urlsplit

DENIED = ipaddress.ip_network("168.63.129.16/32")
LISTEN = ("172.30.0.1", 3128)
MAP_FILE = os.environ.get("JUNO_EGRESS_MAP") or "/run/juno-computers/egress-map.json"
LOG_FILE = os.environ.get("JUNO_EGRESS_LOG_FILE") or os.path.join(
    os.environ.get("LOGS_DIRECTORY") or "/var/log/juno-computers-egress", "egress.jsonl")
STATE_FILE = os.path.join(os.environ.get("JUNO_EGRESS_STATE_DIR") or os.environ.get("STATE_DIRECTORY")
                          or "/var/lib/juno-computers-egress", "budget.json")
DEFAULT_MAX_MB_PER_HOUR = 1024
IDENTIFY_SECONDS = 2.0
IDENTIFY_STEP_SECONDS = 0.1
SAVE_EVERY_SECONDS = 10


def max_bytes_per_hour(value=None):
    raw = os.environ.get("JUNO_EGRESS_MAX_MB_PER_HOUR") if value is None else value
    try:
        megabytes = float(raw) if raw not in (None, "") else DEFAULT_MAX_MB_PER_HOUR
    except ValueError:
        megabytes = -1
    if not megabytes > 0 or megabytes != megabytes:  # also NaN
        print("egress-proxy: JUNO_EGRESS_MAX_MB_PER_HOUR is not a positive number; using %d" % DEFAULT_MAX_MB_PER_HOUR,
              file=sys.stderr, flush=True)
        megabytes = DEFAULT_MAX_MB_PER_HOUR
    return int(megabytes * 1024 * 1024)


def now_iso(seconds=None):
    moment = datetime.datetime.fromtimestamp(time.time() if seconds is None else seconds, datetime.timezone.utc)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class AddressMap:
    """The broker's address -> computer map, re-read when its generation changes."""

    def __init__(self, path=None):
        self.path = path or MAP_FILE
        self.lock = threading.Lock()
        self.signature = None
        self.gen = None
        self.entries = {}
        self.releasing = frozenset()

    def refresh(self):
        try:
            info = os.stat(self.path)
            signature = (info.st_ino, info.st_mtime_ns, info.st_size)
        except OSError:
            signature = None
        with self.lock:
            if signature == self.signature:
                return
            data = {}
            if signature is not None:
                try:
                    with open(self.path, encoding="utf-8") as file:
                        data = json.load(file)
                except (OSError, ValueError):
                    return  # a reader never acts on half a map; try again next time
            self.signature = signature
            if data.get("gen") != self.gen:
                self.gen = data.get("gen")
                entries = data.get("entries") if isinstance(data.get("entries"), dict) else {}
                self.entries = {address: entry.get("name") for address, entry in entries.items()
                                if isinstance(entry, dict) and isinstance(entry.get("name"), str)}
                self.releasing = frozenset(data.get("releasing") or [])

    def lookup(self, address):
        """("mapped", name) | ("releasing", None) | ("unknown", None)."""
        with self.lock:
            if address in self.releasing:
                return "releasing", None
            name = self.entries.get(address)
        return ("mapped", name) if name else ("unknown", None)

    def identify(self, address, seconds=None, step=None):
        """The computer's name, or None: a releasing address at once, an unknown
        one after re-checking for up to IDENTIFY_SECONDS (the broker's post-start
        rebuild lands well within that)."""
        ends = time.monotonic() + (IDENTIFY_SECONDS if seconds is None else seconds)
        while True:
            self.refresh()
            status, name = self.lookup(address)
            if status == "mapped":
                return name
            if status == "releasing" or time.monotonic() >= ends:
                return None
            time.sleep(IDENTIFY_STEP_SECONDS if step is None else step)


class Budget:
    """Bytes per computer name in one-minute buckets; the rolling hour is the last 60."""

    def __init__(self, limit_bytes, path=None):
        self.limit = limit_bytes
        self.path = path or STATE_FILE
        self.lock = threading.Lock()
        self.buckets = {}

    @staticmethod
    def minute(now):
        return int(now // 60)

    def _prune(self, current):
        for name in list(self.buckets):
            kept = {m: b for m, b in self.buckets[name].items() if m > current - 60}
            if kept:
                self.buckets[name] = kept
            else:
                del self.buckets[name]

    def add(self, name, count, now=None):
        if not name or count <= 0:
            return
        current = self.minute(time.time() if now is None else now)
        with self.lock:
            per = self.buckets.setdefault(name, {})
            per[current] = per.get(current, 0) + count

    def used(self, name, now=None):
        current = self.minute(time.time() if now is None else now)
        with self.lock:
            return sum(b for m, b in self.buckets.get(name, {}).items() if m > current - 60)

    def over(self, name, now=None):
        return self.used(name, now) >= self.limit

    def save(self, now=None):
        current = self.minute(time.time() if now is None else now)
        with self.lock:
            self._prune(current)
            data = {"version": 1, "buckets": {name: {str(m): b for m, b in per.items()} for name, per in self.buckets.items()}}
        directory = os.path.dirname(self.path) or "."
        os.makedirs(directory, exist_ok=True)
        temporary = self.path + ".tmp"
        with open(temporary, "w", encoding="utf-8") as file:
            json.dump(data, file)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, self.path)

    def load(self, now=None):
        try:
            with open(self.path, encoding="utf-8") as file:
                data = json.load(file)
        except FileNotFoundError:
            return
        except (OSError, ValueError):
            # A damaged file must not reset anyone's budget silently: say so.
            print("egress-proxy: the saved budget could not be read; starting empty", file=sys.stderr, flush=True)
            return
        current = self.minute(time.time() if now is None else now)
        with self.lock:
            for name, per in (data.get("buckets") or {}).items():
                self.buckets[name] = {int(m): int(b) for m, b in per.items() if int(m) > current - 60}


class EgressLog:
    """One JSON line per connection, appended when it ends. Opened per line, so
    logrotate's rename-and-create needs no signal."""

    def __init__(self, path=None):
        self.path = path or LOG_FILE
        self.lock = threading.Lock()
        self.failed = False

    def check(self):
        with open(self.path, "a", encoding="utf-8"):
            pass

    def write(self, record):
        line = json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"
        with self.lock:
            try:
                with open(self.path, "a", encoding="utf-8") as file:
                    file.write(line)
            except OSError as error:
                if not self.failed:
                    self.failed = True
                    print("egress-proxy: cannot write the egress log: %s" % error.strerror, file=sys.stderr, flush=True)


ADDRESS_MAP = AddressMap()
BUDGET = Budget(DEFAULT_MAX_MB_PER_HOUR * 1024 * 1024)
LOG = EgressLog()


class OverBudget(Exception):
    pass
# One proxy serves every computer on the host. The unit's TasksMax is 32 (one
# thread per connection plus the accept loop), so the host-wide ceiling stays
# under it, and no single computer may hold more than its share: a busy or
# hostile one used to be able to take all of them and cut everyone else off.
TOTAL_LIMIT = 24
PER_SOURCE_LIMIT = 6
HEADER_DEADLINE_SECONDS = 10
TUNNEL_LIFETIME_SECONDS = 30 * 60
SLOTS = threading.BoundedSemaphore(TOTAL_LIMIT)
ACTIVE = {}
ACTIVE_LOCK = threading.Lock()


def admit(source):
    """Take a slot for this source address, or refuse without waiting."""
    with ACTIVE_LOCK:
        if ACTIVE.get(source, 0) >= PER_SOURCE_LIMIT:
            return False
        if not SLOTS.acquire(blocking=False):
            return False
        ACTIVE[source] = ACTIVE.get(source, 0) + 1
        return True


def leave(source):
    with ACTIVE_LOCK:
        remaining = ACTIVE.get(source, 1) - 1
        if remaining > 0:
            ACTIVE[source] = remaining
        else:
            ACTIVE.pop(source, None)
        SLOTS.release()


def public_ip(value):
    address = ipaddress.ip_address(value)
    # is_global excludes private, reserved, multicast, link-local and shared
    # space; IPv4-mapped IPv6 must also be evaluated as the embedded address.
    if address.version == 6 and address.ipv4_mapped:
        address = address.ipv4_mapped
    return address.is_global and not address.is_multicast and address not in DENIED


def resolve_public(host, port):
    if port not in (80, 443) or not host or "%" in host:
        raise ValueError("Destination is not permitted")
    answers = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not answers or any(not public_ip(answer[4][0]) for answer in answers):
        raise ValueError("Destination resolves outside the public internet")
    # DNS is never consulted again between validation and socket.connect().
    return answers[0]


def connect_public(host, port):
    family, kind, protocol, _, address = resolve_public(host, port)
    upstream = socket.socket(family, kind, protocol)
    upstream.settimeout(10)
    try:
        upstream.connect(address)
        return upstream
    except Exception:
        upstream.close()
        raise


def relay(client, upstream, name=None, counts=None, budget=None):
    """Both directions until either side closes, the tunnel's lifetime ends, or
    the computer's budget runs out (checked before every chunk is forwarded)."""
    budget = budget or BUDGET
    counts = counts if counts is not None else {"up": 0, "down": 0}
    ends = time.monotonic() + TUNNEL_LIFETIME_SECONDS
    while time.monotonic() < ends:
        readable, _, _ = select.select([client, upstream], [], [], 60)
        if not readable:
            return
        for source in readable:
            data = source.recv(65536)
            if not data:
                return
            if name and budget.over(name):
                raise OverBudget()
            (upstream if source is client else client).sendall(data)
            counts["up" if source is client else "down"] += len(data)
            budget.add(name, len(data))


class Unmapped(Exception):
    pass


def handle(client, source):
    upstream = None
    began = time.time()
    record = {"start": now_iso(began), "computer": None, "src": source, "host": None, "port": None, "verdict": "error"}
    counts = {"up": 0, "down": 0}
    answered = False
    name = None
    try:
        name = ADDRESS_MAP.identify(source)
        record["computer"] = name
        # One deadline for the whole header, not per recv: a byte every nine
        # seconds used to hold a slot indefinitely.
        header_ends = time.monotonic() + HEADER_DEADLINE_SECONDS
        pending = b""
        while b"\r\n\r\n" not in pending:
            remaining = header_ends - time.monotonic()
            if remaining <= 0:
                raise ValueError("Request header too slow")
            client.settimeout(remaining)
            chunk = client.recv(4096)
            if not chunk or len(pending) + len(chunk) > 65536:
                raise ValueError("Invalid request header")
            pending += chunk
        client.settimeout(10)
        counts["up"] += len(pending)
        BUDGET.add(name, len(pending))
        head, _, rest = pending.partition(b"\r\n\r\n")
        lines = head.decode("iso-8859-1").split("\r\n")
        method, target, version = lines[0].split(" ")
        if version != "HTTP/1.1":
            raise ValueError("Unsupported HTTP version")
        if method == "CONNECT":
            destination = urlsplit("//" + target)
            record["host"], record["port"] = destination.hostname, destination.port or 443
            if destination.username or destination.password or destination.path or destination.query or destination.fragment:
                raise ValueError("Invalid tunnel destination")
        else:
            destination = urlsplit(target)
            record["host"], record["port"] = destination.hostname, destination.port or 80
            if destination.scheme != "http" or destination.username or destination.password or destination.fragment:
                raise ValueError("An absolute HTTP URL is required")
        # Who is asking comes before where to: an unknown address is never
        # served, and a computer over its hour's budget gets nothing new.
        if name is None:
            raise Unmapped()
        if BUDGET.over(name):
            raise OverBudget()
        if method == "CONNECT":
            upstream = connect_public(destination.hostname, destination.port or 443)
            client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            answered = True
            if rest:
                upstream.sendall(rest)
        else:
            upstream = connect_public(destination.hostname, destination.port or 80)
            path = destination.path or "/"
            if destination.query:
                path += "?" + destination.query
            filtered = []
            for line in lines[1:]:
                key, separator, _ = line.partition(":")
                if not separator:
                    raise ValueError("Malformed header")
                if key.lower() not in {"host", "proxy-authorization", "proxy-connection", "connection"}:
                    filtered.append(line)
            filtered += ["Host: " + destination.netloc, "Connection: close"]
            request = f"{method} {path} HTTP/1.1\r\n" + "\r\n".join(filtered) + "\r\n\r\n"
            upstream.sendall(request.encode("iso-8859-1") + rest)
            answered = True
        relay(client, upstream, name, counts)
        record["verdict"] = "ok"
    except (OSError, ValueError, Unmapped, OverBudget) as error:
        record["verdict"] = ("unmapped" if isinstance(error, Unmapped) else "over_budget" if isinstance(error, OverBudget)
                             else "refused" if isinstance(error, ValueError) else "error")
        if not answered:
            try:
                client.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
    finally:
        if upstream:
            upstream.close()
        client.close()
        leave(source)
        # The destination's name and port, the sizes and the verdict. Never a
        # path, a query, a header or a body.
        record.update({"end": now_iso(), "up": counts["up"], "down": counts["down"]})
        if record["host"] is not None:
            record["host"] = str(record["host"])[:253]
        LOG.write(record)


def save_budget_forever():
    while True:
        time.sleep(SAVE_EVERY_SECONDS)
        try:
            BUDGET.save()
        except OSError as error:
            print("egress-proxy: cannot save the budget: %s" % error.strerror, file=sys.stderr, flush=True)


def main():
    BUDGET.limit = max_bytes_per_hour()
    BUDGET.load()
    # No log, no egress: an unwritable audit log stops the proxy (and with it
    # every computer's way out) rather than letting traffic through unrecorded.
    LOG.check()

    def stop(_signal, _frame):
        try:
            BUDGET.save()
        finally:
            sys.exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    threading.Thread(target=save_budget_forever, daemon=True).start()
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(LISTEN)
    server.listen(64)
    while True:
        client, address = server.accept()
        source = address[0]
        if not admit(source):
            client.close()
            continue
        threading.Thread(target=handle, args=(client, source), daemon=True).start()


if __name__ == "__main__":
    main()
