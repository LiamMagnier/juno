#!/bin/bash
# Browser/desktop/gate use protected uid 1001; all agent shell execs use 1000.
set -euo pipefail
export DISPLAY=:0 HOME=/home/browser
mkdir -p /home/browser/.chrome
chmod 700 /home/browser /home/browser/.chrome
rm -f /tmp/.X0-lock /home/browser/.chrome/SingletonLock /home/browser/.chrome/SingletonSocket /home/browser/.chrome/SingletonCookie
Xvfb :0 -screen 0 1280x800x24 -nolisten tcp -ac -dpi 96 >/tmp/xvfb.log 2>&1 &
xvfb=$!
for _ in $(seq 1 100); do xdpyinfo -display :0 >/dev/null 2>&1 && break; sleep 0.1; done
dbus-launch --exit-with-session xfce4-session >/tmp/xfce.log 2>&1 &
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
