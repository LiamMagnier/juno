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
rm -f /tmp/.X0-lock

Xvfb :0 -screen 0 1280x800x24 -nolisten tcp -dpi 96 >/tmp/xvfb.log 2>&1 &
xvfb=$!
for _ in $(seq 1 100); do xdpyinfo -display :0 >/dev/null 2>&1 && break; sleep 0.1; done

dbus-launch --exit-with-session xfce4-session >/tmp/xfce.log 2>&1 &
session=$!

python3 /opt/juno/cdp-gate.py >/tmp/cdp-gate.log 2>&1 &
gate=$!

chrome=0
stop() {
  if [ "$chrome" -ne 0 ]; then
    kill -TERM "$chrome" 2>/dev/null
    wait "$chrome" 2>/dev/null
  fi
  pkill -TERM -x x11vnc 2>/dev/null
  kill -TERM "$gate" "$session" 2>/dev/null
  kill -TERM "$xvfb" 2>/dev/null
  exit 0
}
trap stop TERM INT

sleep 2
while true; do
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
  sleep 1
done
