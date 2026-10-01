#!/bin/bash
# Browser, window manager and gate use protected uid 1001; all agent shell execs use 1000.
set -euo pipefail
export DISPLAY=:0 HOME=/home/browser
mkdir -p /home/browser/.chrome
chmod 700 /home/browser /home/browser/.chrome
# Where the CDP token and the VNC password are handed over: a directory only this
# uid can enter, on the /run tmpfs. /tmp is shared with the agent (mode 1777), and
# whether a file the agent planted there could capture a write depended on host
# sysctls. /run is empty at every start, so this either creates it or stops.
mkdir -m 0700 /run/juno
[ "$(stat -c '%u:%a' /run/juno)" = "1001:700" ] || { echo "/run/juno is not private" >&2; exit 1; }
rm -f /tmp/.X0-lock /home/browser/.chrome/SingletonLock /home/browser/.chrome/SingletonSocket /home/browser/.chrome/SingletonCookie
Xvfb :0 -screen 0 1280x800x24 -nolisten tcp -ac -dpi 96 >/tmp/xvfb.log 2>&1 &
xvfb=$!
for _ in $(seq 1 100); do xdpyinfo -display :0 >/dev/null 2>&1 && break; sleep 0.1; done
# A window manager and nothing else: no session, panel, desktop menu or launcher
# that GUI input could use to start a program as this uid.
dbus-launch --exit-with-session xfwm4 --compositor=off >/tmp/wm.log 2>&1 &
session=$!
python3 /opt/juno/cdp-gate.py >/tmp/cdp-gate.log 2>&1 &
gate=$!
stop() {
  kill -TERM "$gate" 2>/dev/null || true
  wait "$gate" 2>/dev/null || true
  pkill -TERM -x x11vnc || true
  kill -TERM "$session" "$xvfb" 2>/dev/null || true
  sync
}
trap stop EXIT
trap 'exit 0' TERM INT
wait "$gate"
