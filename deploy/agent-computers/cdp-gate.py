#!/usr/bin/env python3
"""Authenticated WebSocket CDP adapter for Chromium's private fd 3/4 pipe.

Runs as browser (1001), separately from the agent shell (1000). No raw TCP
DevTools port exists, and the agent's SHELL cannot read the profile or the bearer
file (both are 0700 uid 1001). The agent does drive the shared display, so the
browser window's own UI is reachable by GUI input; see the Dockerfile header.

Chromium's own sandbox (pipe-v4, COMPUTERS_2026-10.md S2.3). At start the gate
asks whether this uid may create a user namespace (`unshare --user
--map-root-user true`). If it may, Chromium starts WITHOUT --no-sandbox and must
answer its first pipe command (Browser.getVersion) within 20 s; if it exits or
stays silent, it is started again with --no-sandbox ("off:chromium"). If the
probe fails (the kernel or the container's seccomp profile refuses user
namespaces, which Docker's default profile does), Chromium starts with
--no-sandbox ("off:kernel"). Every fallback is exactly the pipe-v3
configuration. The outcome is written to /run/juno-state/browser-sandbox ("on",
"off:kernel" or "off:chromium"), which the provider reports at every wake.
"""
import asyncio
import ctypes
import hmac
import os
import select
import signal
import subprocess
import threading
import time
from http import HTTPStatus

import websockets
from websockets.exceptions import ConnectionClosed

TOKEN_FILE = "/run/juno/cdp-token"
SANDBOX_STATE_FILE = "/run/juno-state/browser-sandbox"
TOKEN = b""
LOCK = threading.Lock()
FIRST_ANSWER_SECONDS = 20
# Docker's --stop-timeout is 20 s for the whole container: give Chromium most of
# it to flush cookies and the profile after Browser.close, never a fixed guess.
CLOSE_WAIT_SECONDS = 15
VERSION_PROBE_ID = 2147483645


def no_dump():
    PR_SET_DUMPABLE = 4
    if ctypes.CDLL(None).prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
        raise RuntimeError("Cannot protect the CDP gate from process inspection")


def load_token():
    global TOKEN
    while True:
        try:
            with open(TOKEN_FILE, "rb") as file:
                value = file.read(4096).strip()
            os.unlink(TOKEN_FILE)
            if value:
                with LOCK:
                    TOKEN = value
        except OSError:
            pass
        import time
        time.sleep(0.2)


def authorized(headers):
    values = headers.get_all("X-Juno-Cdp-Token")
    with LOCK:
        token = TOKEN
    return len(values) == 1 and bool(token) and hmac.compare_digest(values[0].encode(), token)


def user_namespaces_allowed():
    """Whether this uid may create a user namespace here (kernel and seccomp)."""
    try:
        return subprocess.run(["unshare", "--user", "--map-root-user", "true"], stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def record_sandbox_state(state):
    """on | off:kernel | off:chromium, renamed into place so a reader never sees half."""
    try:
        temporary = SANDBOX_STATE_FILE + ".part"
        with open(temporary, "w") as file:
            file.write(state + "\n")
        os.chmod(temporary, 0o644)
        os.replace(temporary, SANDBOX_STATE_FILE)
    except OSError:
        pass  # the provider then reports "unknown", never "on"


def first_answer(pid, command_write, reply_read, seconds=None):
    """Sends Browser.getVersion over the pipe and waits for its reply. Returns
    the bytes read after that reply (the reader thread starts from them), or
    None when Chromium exited or stayed silent."""
    try:
        os.write(command_write, b'{"id":%d,"method":"Browser.getVersion"}\0' % VERSION_PROBE_ID)
    except OSError:
        return None
    ends = time.monotonic() + (FIRST_ANSWER_SECONDS if seconds is None else seconds)
    pending = b""
    while time.monotonic() < ends:
        if os.waitpid(pid, os.WNOHANG) != (0, 0):
            return None
        readable, _, _ = select.select([reply_read], [], [], 0.25)
        if not readable:
            continue
        chunk = os.read(reply_read, 65536)
        if not chunk:
            return None
        pending += chunk
        while b"\0" in pending:
            message, pending = pending.split(b"\0", 1)
            if b'"id":%d' % VERSION_PROBE_ID in message.replace(b" ", b""):
                return pending
    return None


def stop_chromium(pid, command_write, reply_read):
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    for fd in (command_write, reply_read):
        try:
            os.close(fd)
        except OSError:
            pass


def start_browser():
    """(pid, command fd, reply fd, bytes already read, state)."""
    if user_namespaces_allowed():
        pid, command_write, reply_read = launch_chromium(sandbox=True)
        leftover = first_answer(pid, command_write, reply_read)
        if leftover is not None:
            return pid, command_write, reply_read, leftover, "on"
        stop_chromium(pid, command_write, reply_read)
        state = "off:chromium"
    else:
        state = "off:kernel"
    pid, command_write, reply_read = launch_chromium(sandbox=False)
    return pid, command_write, reply_read, b"", state


def launch_chromium(sandbox=False):
    command_read, command_write = os.pipe()
    reply_read, reply_write = os.pipe()
    pid = os.fork()
    if pid == 0:
        # Copy away first, since an original descriptor may itself be 3 or 4.
        read_copy = os.dup(command_read)
        write_copy = os.dup(reply_write)
        os.dup2(read_copy, 3, inheritable=True)
        os.dup2(write_copy, 4, inheritable=True)
        # dup2(fd, fd) may retain FD_CLOEXEC; Chromium needs both after exec.
        os.set_inheritable(3, True)
        os.set_inheritable(4, True)
        for fd in {command_read, command_write, reply_read, reply_write, read_copy, write_copy} - {3, 4}:
            os.close(fd)
        os.execv("/usr/bin/chromium", [
            "chromium", *([] if sandbox else ["--no-sandbox"]), "--remote-debugging-pipe",
            "--user-data-dir=/home/browser/.chrome", "--no-first-run",
            "--proxy-server=http://172.30.0.1:3128", "--proxy-bypass-list=<-loopback>",
            "--no-default-browser-check", "--password-store=basic",
            "--start-maximized", "--disable-features=Translate,MediaRouter",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "about:blank",
        ])
        os._exit(1)
    os.close(command_read)
    os.close(reply_write)
    return pid, command_write, reply_read


async def main():
    no_dump()
    pid, command_write, reply_read, leftover, sandbox_state = start_browser()
    record_sandbox_state(sandbox_state)
    threading.Thread(target=load_token, daemon=True).start()
    loop = asyncio.get_running_loop()
    active = None
    outgoing = asyncio.Queue(maxsize=256)
    stopped = asyncio.Event()

    def deliver(message):
        if active is None:
            return
        try:
            outgoing.put_nowait(message)
        except asyncio.QueueFull:
            stopped.set()  # fail closed rather than silently lose protocol events

    def read_replies():
        pending = leftover
        try:
            while True:
                chunk = os.read(reply_read, 65536)
                if not chunk:
                    break
                pending += chunk
                if len(pending) > 64 * 1024 * 1024:
                    break
                while b"\0" in pending:
                    message, pending = pending.split(b"\0", 1)
                    loop.call_soon_threadsafe(deliver, message.decode("utf-8"))
        finally:
            loop.call_soon_threadsafe(stopped.set)

    async def process_request(path, headers):
        if not authorized(headers) or path != "/devtools/browser":
            return HTTPStatus.FORBIDDEN, [("Content-Length", "0")], b""

    async def handle(socket, _path):
        nonlocal active
        # One controlling connection avoids CDP request-id collisions. Tokens
        # are checked at the HTTP upgrade, before any message reaches Chromium.
        if active is not None:
            await socket.close(code=1013, reason="Browser is already connected")
            return
        while not outgoing.empty():
            outgoing.get_nowait()
        active = socket

        async def replies():
            while True:
                await socket.send(await outgoing.get())

        task = asyncio.create_task(replies())
        try:
            async for message in socket:
                if not isinstance(message, str) or "\0" in message:
                    await socket.close(code=1003)
                    break
                data = memoryview(message.encode() + b"\0")
                while data:
                    written = await asyncio.to_thread(os.write, command_write, data)
                    data = data[written:]
        except ConnectionClosed:
            pass
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            # Unlike a native DevTools WebSocket, the private pipe survives a
            # client disconnect. Reset auto-attachment so reconnect discovers
            # existing tabs afresh and releases debugger-paused renderers.
            try:
                os.write(command_write, b'{"id":2147483646,"method":"Target.setAutoAttach","params":{"autoAttach":false,"waitForDebuggerOnStart":false,"flatten":true}}\0')
            except OSError:
                pass
            active = None

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stopped.set)
    try:
        async with websockets.serve(handle, "0.0.0.0", 9222,
                                    process_request=process_request,
                                    max_size=64 * 1024 * 1024, max_queue=32):
            threading.Thread(target=read_replies, daemon=True).start()
            await stopped.wait()
    finally:
        # Closing the browser through its private pipe flushes the profile.
        try:
            os.write(command_write, b'{"id":2147483647,"method":"Browser.close"}\0')
        except OSError:
            pass
        # Wait for Chromium to exit by itself (it writes cookies and the profile
        # as it closes), up to most of the container's stop timeout; only then
        # SIGTERM. A fixed one-second wait used to cut the flush on a slow host.
        ends = time.monotonic() + CLOSE_WAIT_SECONDS
        exited = False
        while time.monotonic() < ends:
            try:
                if os.waitpid(pid, os.WNOHANG) != (0, 0):
                    exited = True
                    break
            except ChildProcessError:
                exited = True
                break
            await asyncio.sleep(0.1)
        if not exited:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            await asyncio.to_thread(os.waitpid, pid, 0)
        os.close(command_write)
        os.close(reply_read)


if __name__ == "__main__":
    asyncio.run(main())
