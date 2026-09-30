#!/bin/bash
# Starts the desktop, the CDP gate and a Chromium that is restarted if it closes.
# On `docker stop` (SIGTERM via tini) Chromium stops gracefully, so cookies and the
# profile are flushed to /home/agent, the agent's persistent volume.
# x11vnc is NOT started here: Juno starts it on demand, with fresh passwords,
# only while someone is watching.
set -uo pipefail
export DISPLAY=:0

mkdir -p /home/agent/work/downloads /home/agent/.chrome /home/agent/.juno
chmod 700 /home/agent/.juno
# Earlier builds left the VNC password file on the volume, where the agent's
# shell could read it. It now lives in tmpfs and x11vnc deletes it on read.
rm -f /home/agent/.juno/vncpass /tmp/.X0-lock

Xvfb :0 -screen 0 1280x800x24 -nolisten tcp -dpi 96 >/tmp/xvfb.log 2>&1 &
xvfb=$!
for _ in $(seq 1 100); do xdpyinfo -display :0 >/dev/null 2>&1 && break; sleep 0.1; done

dbus-launch --exit-with-session xfce4-session >/tmp/xfce.log 2>&1 &
session=$!

python3 /opt/juno/cdp-gate.py >/tmp/cdp-gate.log 2>&1 &
gate=$!

chrome=0
stopping=0
stop() {
  stopping=1
  if [ "$chrome" -ne 0 ]; then
    python3 -c '
import base64, json, socket, urllib.request
try:
    info = json.loads(urllib.request.urlopen("http://127.0.0.1:9223/json/version", timeout=2).read())
    path = "/" + info["webSocketDebuggerUrl"].split("/", 3)[3]
    s = socket.create_connection(("127.0.0.1", 9223), timeout=2)
    key = base64.b64encode(b"juno-cdp-close01").decode()
    req = f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:9223\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    s.sendall(req.encode())
    s.recv(4096)
    msg = b"{\"id\":1,\"method\":\"Browser.close\"}"
    s.sendall(bytearray([0x81, 0x80 | len(msg), 0, 0, 0, 0]) + msg)
    s.recv(1024)
    s.close()
except Exception:
    pass
' 2>/dev/null
    for _ in $(seq 1 30); do
      kill -0 "$chrome" 2>/dev/null || break
      sleep 0.1
    done
    kill -TERM "$chrome" 2>/dev/null
    wait "$chrome" 2>/dev/null
  fi
  sync
  pkill -TERM -x x11vnc 2>/dev/null
  kill -TERM "$gate" "$session" 2>/dev/null
  kill -TERM "$xvfb" 2>/dev/null
  exit 0
}
trap stop TERM INT

sleep 2
while [ "$stopping" -eq 0 ]; do
  # A stale lock from an unclean stop makes Chromium refuse the profile.
  rm -f /home/agent/.chrome/SingletonLock /home/agent/.chrome/SingletonSocket /home/agent/.chrome/SingletonCookie
  chromium \
    --no-sandbox \
    --remote-debugging-port=9223 \
    --user-data-dir=/home/agent/.chrome \
    --no-first-run \
    --no-default-browser-check \
    --password-store=basic \
    --start-maximized \
    --disable-features=Translate,MediaRouter \
    --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
    about:blank >/tmp/chromium.log 2>&1 &
  chrome=$!
  wait "$chrome"
  [ "$stopping" -ne 0 ] && break
  sleep 1
done
