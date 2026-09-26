#!/usr/bin/env python3
# Juno CDP gate: exposes Chromium's loopback DevTools socket to Juno only.
import hmac, os, socket, threading
TOKEN = os.environ["JUNO_CDP_TOKEN"].encode()
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
        ok = False; upgrade = False; out = [lines[0]]
        for line in lines[1:]:
            k, _, v = line.partition(b":")
            key = k.strip().lower()
            if key == b"x-juno-cdp-token":
                ok = hmac.compare_digest(v.strip(), TOKEN); continue
            if key == b"upgrade" and v.strip().lower() == b"websocket":
                upgrade = True
            if key == b"host":
                out.append(b"Host: 127.0.0.1:9223"); continue
            if key == b"origin":
                continue
            out.append(line)
        if not (ok and upgrade):
            c.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            c.close(); return
        u = socket.create_connection(("127.0.0.1", 9223))
        u.sendall(b"\r\n".join(out) + b"\r\n\r\n" + rest)
        threading.Thread(target=pipe, args=(u, c), daemon=True).start()
        pipe(c, u)
    except OSError:
        try: c.close()
        except OSError: pass
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", 9222)); srv.listen(64)
while True:
    conn, _ = srv.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
