"""What a program sees from INSIDE a sandbox: one probe for both boundaries.

Not a test module. The real-container suites send this file's source into the
sandbox as the program itself (tests/test_exec_host.py RealSandboxBoundary runs
it through juno-exec's API as model code would arrive; tests/test_computer_boundary.py
runs it with `docker exec --user 1000`, the way an agent's shell command arrives)
and append one `main({...})` call naming what to look at. It prints one line,
`JUNO-PROBE <json>`, and the suite asserts on that report on the host.

Standard library only, Python 3.8+, and no secret or expected answer travels in:
the report carries raw observations (errno names, environment names and values,
mounts, cgroup limits) and the host decides what they mean. So a canary value
the host planted in its own environment can only appear in the report if it
really crossed the boundary.
"""
import concurrent.futures
import ctypes
import errno
import json
import os
import socket
import stat
import struct
import time


def _errno_name(error):
    if isinstance(error, socket.timeout):
        return "timeout"
    if isinstance(error, socket.gaierror):
        return "gaierror"
    code = getattr(error, "errno", None)
    if code is None:
        return "error:" + type(error).__name__
    return errno.errorcode.get(code, "errno:%s" % code)


def tcp(host, port, timeout):
    """open | an errno symbol (ENETUNREACH, ECONNREFUSED, ...) | timeout."""
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    try:
        sock = socket.socket(family, socket.SOCK_STREAM)
    except OSError as error:
        return _errno_name(error)
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))
        return "open"
    except OSError as error:
        return _errno_name(error)
    finally:
        sock.close()


def dns_query(server, timeout):
    """A real DNS question (example.com A) over UDP: answered | no-answer | errno."""
    question = struct.pack(">HHHHHH", 0x4a55, 0x0100, 1, 0, 0, 0)
    question += b"".join(bytes([len(label)]) + label for label in (b"example", b"com")) + b"\x00"
    question += struct.pack(">HH", 1, 1)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(question, (server, 53))
        data, _ = sock.recvfrom(4096)
        return "answered" if data[:2] == b"\x4a\x55" else "garbled"
    except socket.timeout:
        return "no-answer"
    except OSError as error:
        return _errno_name(error)
    finally:
        sock.close()


def resolve(name):
    try:
        return "resolved:" + socket.getaddrinfo(name, 443, type=socket.SOCK_STREAM)[0][4][0]
    except OSError as error:
        return _errno_name(error)


def proxy_request(proxy_host, proxy_port, method, target, timeout, attempts=8):
    """The status code an HTTP proxy answers a request with.

    A connection the proxy closes without answering is its admission control
    (a few connections per source at once; a browser in the same computer may
    hold some), not a verdict on the destination, so that is retried."""
    result = None
    for _ in range(attempts):
        result = _proxy_request_once(proxy_host, proxy_port, method, target, timeout)
        if isinstance(result, int):
            return result
        time.sleep(0.5)
    return result


def _proxy_request_once(proxy_host, proxy_port, method, target, timeout):
    try:
        sock = socket.create_connection((proxy_host, proxy_port), timeout=timeout)
    except OSError as error:
        return _errno_name(error)
    try:
        sock.settimeout(timeout)
        if method == "CONNECT":
            head = "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n" % (target, target)
        else:
            host = target.split("/")[2]
            head = "GET %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n" % (target, host)
        sock.sendall(head.encode("ascii"))
        data = b""
        while b"\r\n" not in data and len(data) < 4096:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
        line = data.split(b"\r\n", 1)[0].decode("latin-1")
        parts = line.split(" ")
        return int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else "no-status:" + line[:40]
    except OSError as error:
        return _errno_name(error)
    finally:
        sock.close()


def loopback_control():
    """Positive control: the same connect code DOES report a reachable listener."""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    try:
        return tcp("127.0.0.1", server.getsockname()[1], 2)
    finally:
        server.close()


def write(path):
    try:
        with open(path, "a") as file:
            file.write("probe\n")
        return "ok"
    except OSError as error:
        return _errno_name(error)


def read(path):
    try:
        if os.path.isdir(path):
            os.listdir(path)
        else:
            with open(path, "rb") as file:
                file.read(1)
        return "ok"
    except OSError as error:
        return _errno_name(error)


def _libc_call(name, *args):
    libc = ctypes.CDLL(None, use_errno=True)
    result = getattr(libc, name)(*args)
    if result == 0:
        return "ok"
    return errno.errorcode.get(ctypes.get_errno(), "errno:%d" % ctypes.get_errno())


def privileged_calls():
    """Each one needs a capability or a privilege the sandbox must not have."""
    results = {}
    try:
        os.mknod("/tmp/.probe-null", 0o600 | stat.S_IFCHR, os.makedev(1, 3))
        results["mknod"] = "ok"
    except OSError as error:
        results["mknod"] = _errno_name(error)
    results["mount"] = _libc_call("mount", b"none", b"/tmp", b"tmpfs", 0, None)
    try:
        os.chroot("/tmp")
        results["chroot"] = "ok"
    except OSError as error:
        results["chroot"] = _errno_name(error)
    try:
        os.setuid(0)
        results["setuid0"] = "ok"
    except OSError as error:
        results["setuid0"] = _errno_name(error)
    clone_newuser, clone_newnet = 0x10000000, 0x40000000
    results["unshare_user"] = _libc_call("unshare", clone_newuser)
    results["unshare_net"] = _libc_call("unshare", clone_newnet)
    return results


def proc_status():
    fields = {}
    with open("/proc/self/status") as file:
        for line in file:
            key, _, value = line.partition(":")
            if key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs", "Seccomp"):
                fields[key] = value.strip()
    return fields


def mounts():
    entries = []
    with open("/proc/self/mountinfo") as file:
        for line in file:
            left, _, right = line.rstrip("\n").partition(" - ")
            parts, tail = left.split(" "), right.split(" ")
            entries.append({"root": parts[3], "mountpoint": parts[4].replace("\\040", " "), "options": parts[5],
                            "fstype": tail[0], "source": tail[1] if len(tail) > 1 else "",
                            "superOptions": tail[2] if len(tail) > 2 else ""})
    return entries


def _first(*paths):
    for path in paths:
        try:
            with open(path) as file:
                return file.read().strip()
        except OSError:
            continue
    return None


def cgroup_limits():
    """cgroup v2 first, then v1. Raw strings; the host compares them to the policy."""
    return {
        "memory": _first("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"),
        "memorySwap": _first("/sys/fs/cgroup/memory.swap.max", "/sys/fs/cgroup/memory/memory.memsw.limit_in_bytes"),
        "pids": _first("/sys/fs/cgroup/pids.max", "/sys/fs/cgroup/pids/pids.max"),
        "cpuMax": _first("/sys/fs/cgroup/cpu.max"),
        "cpuQuota": _first("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us"),
        "cpuPeriod": _first("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us"),
    }


def environments():
    """Every environment this uid can read: its own and every visible process's."""
    seen = {"self": dict(os.environ)}
    for pid in sorted(p for p in os.listdir("/proc") if p.isdigit()):
        try:
            with open("/proc/%s/environ" % pid, "rb") as file:
                raw = file.read()
        except OSError as error:
            seen[pid] = _errno_name(error)
            continue
        seen[pid] = [item.decode("utf-8", "replace") for item in raw.split(b"\0") if item]
    return seen


def processes():
    rows = []
    for pid in sorted((p for p in os.listdir("/proc") if p.isdigit()), key=int):
        try:
            with open("/proc/%s/cmdline" % pid, "rb") as file:
                command = file.read().split(b"\0")[0].decode("utf-8", "replace")
            uid = os.stat("/proc/%s" % pid).st_uid
        except OSError:
            continue
        rows.append({"pid": int(pid), "uid": uid, "command": os.path.basename(command)})
    return rows


def fill(path, megabytes):
    """Write until the filesystem refuses: ok (wrote it all) | ENOSPC | ..."""
    block = b"\0" * (1024 * 1024)
    written = 0
    try:
        with open(path, "wb") as file:
            for _ in range(megabytes):
                file.write(block)
                written += 1
            file.flush()
            os.fsync(file.fileno())
        return {"result": "ok", "megabytes": written}
    except OSError as error:
        return {"result": _errno_name(error), "megabytes": written}
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def main(spec):
    started = time.time()
    report = {
        "uid": os.getuid(), "euid": os.geteuid(), "gid": os.getgid(), "groups": sorted(os.getgroups()),
        "status": proc_status(), "loopbackControl": loopback_control(),
        "interfaces": sorted(os.listdir("/sys/class/net")) if os.path.isdir("/sys/class/net") else None,
    }
    with open("/proc/net/route") as file:
        report["ipv4Routes"] = [line.split()[1] for line in file.readlines()[1:]]
    try:
        with open("/proc/net/if_inet6") as file:
            # address, ifindex, prefix, scope (00 global, 20 link, 10 host), flags, name
            report["ipv6Addresses"] = [{"address": row[0], "scope": row[3], "interface": row[5]}
                                       for row in (line.split() for line in file) if len(row) >= 6]
    except OSError:
        report["ipv6Addresses"] = []
    timeout = spec.get("timeout", 3)
    proxy = spec.get("proxy")
    # Concurrently: a dropped packet costs the whole timeout, and there are many.
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        tcp_jobs = {"%s:%d" % (host, port): pool.submit(tcp, host, port, timeout) for host, port in spec.get("tcp", [])}
        dns_jobs = {server: pool.submit(dns_query, server, timeout) for server in spec.get("dns", [])}
        resolve_jobs = {name: pool.submit(resolve, name) for name in spec.get("resolve", [])}
    report["tcp"] = {key: job.result() for key, job in tcp_jobs.items()}
    report["dns"] = {key: job.result() for key, job in dns_jobs.items()}
    report["resolve"] = {key: job.result() for key, job in resolve_jobs.items()}
    if proxy:
        # One at a time: the agent-computer proxy admits only a few connections
        # per source at once and closes the rest unanswered (by design).
        report["proxy"] = {"%s %s" % (method, target): proxy_request(proxy[0], proxy[1], method, target, timeout + 7)
                           for method, target in spec.get("proxyRequests", [])}
    report["writes"] = {path: write(path) for path in spec.get("writes", [])}
    report["reads"] = {path: read(path) for path in spec.get("reads", [])}
    report["exists"] = {path: os.path.lexists(path) for path in spec.get("exists", [])}
    if spec.get("privileged"):
        report["privileged"] = privileged_calls()
    if spec.get("mounts"):
        report["mounts"] = mounts()
    if spec.get("cgroup"):
        report["cgroup"] = cgroup_limits()
    if spec.get("environ"):
        report["environ"] = environments()
    if spec.get("processes"):
        report["processes"] = processes()
    if spec.get("fill"):
        report["fill"] = fill(spec["fill"][0], spec["fill"][1])
    report["seconds"] = round(time.time() - started, 2)
    print("JUNO-PROBE " + json.dumps(report, sort_keys=True), flush=True)


def program(spec):
    """This file's source plus the call: a complete program for either sandbox."""
    with open(__file__, encoding="utf-8") as file:
        source = file.read()
    return source + "\n\nmain(json.loads(%r))\n" % json.dumps(spec)


def parse(output):
    for line in output.splitlines():
        if line.startswith("JUNO-PROBE "):
            return json.loads(line[len("JUNO-PROBE "):])
    raise AssertionError("the probe printed no report: " + output[-2000:])
