#!/usr/bin/python3
"""Agent-only HTTP proxy: validate every DNS answer and pin the chosen socket.

The firewall permits computers to reach this proxy and public DNS resolvers,
but refuses direct outbound connections. No cloud/private/loopback destination
is reachable through CONNECT, absolute HTTP requests or a DNS rebinding.
"""
import ipaddress
import select
import socket
import threading
import time
from urllib.parse import urlsplit

DENIED = ipaddress.ip_network("168.63.129.16/32")
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


def relay(client, upstream):
    ends = time.monotonic() + TUNNEL_LIFETIME_SECONDS
    while time.monotonic() < ends:
        readable, _, _ = select.select([client, upstream], [], [], 60)
        if not readable:
            return
        for source in readable:
            data = source.recv(65536)
            if not data:
                return
            (upstream if source is client else client).sendall(data)


def handle(client, source):
    upstream = None
    try:
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
        head, _, rest = pending.partition(b"\r\n\r\n")
        lines = head.decode("iso-8859-1").split("\r\n")
        method, target, version = lines[0].split(" ")
        if version != "HTTP/1.1":
            raise ValueError("Unsupported HTTP version")
        if method == "CONNECT":
            destination = urlsplit("//" + target)
            if destination.username or destination.password or destination.path or destination.query or destination.fragment:
                raise ValueError("Invalid tunnel destination")
            upstream = connect_public(destination.hostname, destination.port or 443)
            client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            if rest:
                upstream.sendall(rest)
        else:
            destination = urlsplit(target)
            if destination.scheme != "http" or destination.username or destination.password or destination.fragment:
                raise ValueError("An absolute HTTP URL is required")
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
        relay(client, upstream)
    except (OSError, ValueError):
        try:
            client.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        except OSError:
            pass
    finally:
        if upstream:
            upstream.close()
        client.close()
        leave(source)


def main():
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("172.30.0.1", 3128))
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
