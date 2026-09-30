#!/usr/bin/env python3
# Juno CDP gate: exposes Chromium's loopback DevTools socket to Juno only.
#
# The token arrives through a tmpfs file that Juno writes over `docker exec -i`
# after every start (never `-e`: docker exec inherits a container's configured
# env, so the agent's shell could print it). The gate loads it, deletes the file
# and marks itself non-dumpable, so /proc/<pid>/environ and /proc/<pid>/mem are
# not readable by the agent's own processes either. Until a token arrives,
# nobody gets in.
#
# Known limit, closed only by rebuilding the image (docs/design/agents-v2/OPERATIONS.md §6):
# Chromium's own DevTools socket (127.0.0.1:9223) and its profile are reachable
# by the agent's shell, which runs as the same uid. The fix is a second uid for
# Chromium and this gate, with DevTools over --remote-debugging-pipe.
import ctypes, hmac, os, socket, threading, time

TOKEN_FILE = "/tmp/.juno-cdp-token"
TOKEN = b""
LOCK = threading.Lock()

def no_dump():
    try:
        PR_SET_DUMPABLE = 4
        ctypes.CDLL(None).prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)
    except Exception:
        pass

def load_token():
    global TOKEN
    while True:
        try:
            with open(TOKEN_FILE, "rb") as f:
                value = f.read().strip()
            os.unlink(TOKEN_FILE)
            if value:
                with LOCK:
                    TOKEN = value
        except OSError:
            pass
        time.sleep(0.2)

def current_token():
    with LOCK:
        return TOKEN

def pipe(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d:
                break
            b.sendall(d)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try: s.shutdown(socket.SHUT_RDWR)
            except OSError: pass
def handle(c):
    try:
        c.settimeout(10)
        head = b""
        while b"\r\n\r\n" not in head:
            d = c.recv(4096)
            if not d or len(head) > 65536:
                c.close(); return
            head += d
        c.settimeout(None)
        h, _, rest = head.partition(b"\r\n\r\n")
        lines = h.split(b"\r\n")
        token = current_token()
        ok = False; seen = 0; upgrade = False; out = [lines[0]]
        for line in lines[1:]:
            k, _, v = line.partition(b":")
            key = k.strip().lower()
            if key == b"x-juno-cdp-token":
                seen += 1
                ok = bool(token) and hmac.compare_digest(v.strip(), token); continue
            if key == b"upgrade" and v.strip().lower() == b"websocket":
                upgrade = True
            if key == b"host":
                out.append(b"Host: 127.0.0.1:9223"); continue
            if key == b"origin":
                continue
            out.append(line)
        is_json = lines[0].startswith(b"GET /json/")
        # Exactly one token header, and it must match; no token loaded yet
        # means nobody gets in.
        if not (ok and seen == 1 and (upgrade or is_json)):
            c.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            c.close(); return
        u = socket.create_connection(("127.0.0.1", 9223))
        u.sendall(b"\r\n".join(out) + b"\r\n\r\n" + rest)
        threading.Thread(target=pipe, args=(u, c), daemon=True).start()
        pipe(c, u)
    except OSError:
        try: c.close()
        except OSError: pass
no_dump()
threading.Thread(target=load_token, daemon=True).start()
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", 9222)); srv.listen(64)
while True:
    conn, _ = srv.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
