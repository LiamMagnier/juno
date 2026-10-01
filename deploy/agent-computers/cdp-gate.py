#!/usr/bin/env python3
"""Authenticated WebSocket CDP adapter for Chromium's private fd 3/4 pipe.

Runs as browser (1001), separately from the agent shell (1000). No raw TCP
DevTools port exists; profile and bearer file are inaccessible to the agent.
"""
import asyncio
import ctypes
import hmac
import os
import signal
import threading
from http import HTTPStatus

import websockets
from websockets.exceptions import ConnectionClosed

TOKEN_FILE = "/tmp/.juno-cdp-token"
TOKEN = b""
LOCK = threading.Lock()


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


def launch_chromium():
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
            "chromium", "--no-sandbox", "--remote-debugging-pipe",
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
    pid, command_write, reply_read = launch_chromium()
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
        pending = b""
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
        await asyncio.sleep(1)
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        await asyncio.to_thread(os.waitpid, pid, 0)
        os.close(command_write)
        os.close(reply_read)


if __name__ == "__main__":
    asyncio.run(main())
