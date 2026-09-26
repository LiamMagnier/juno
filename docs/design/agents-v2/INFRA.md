# Agents v2 — the computer infrastructure (mentor-written; copy verbatim)

Each agent's computer is a **Docker container on the owner's own server** (the Juno VM,
which the owner is upgrading). Inside each container:
- a full Linux desktop: Xvfb + XFCE;
- a headful Chromium with a persistent profile;
- a shell;
- files in `/home/agent`, which is a named volume per agent;
- x11vnc for the live view;
- a CDP gate for the agent's DOM-level browser tool.

No vendor and no third-party origin is involved. The live view streams through Juno's
existing voice relay (`/voice-relay`) on the owner's domain.

Copy the files below **verbatim** into `deploy/agent-computers/`. Change them only to fix
a problem you proved with the local smoke test, and record the change in `PROGRESS.md`.
Gemini never runs anything on the VM. The owner runs `setup-vm.sh` once, after the server
upgrade and the deploy (BRIEF §6).

---

## `deploy/agent-computers/Dockerfile`

```dockerfile
# An agent's computer: a full Linux desktop (Xvfb + XFCE), headful Chromium, a shell
# and a home directory, in one unprivileged container. One container and one named
# volume (/home/agent) per agent, never shared. Built on the Juno VM by setup-vm.sh
# (linux/amd64) and on a developer's Mac for the local smoke test (arm64).
#
# The container is the sandbox: uid 1000, every capability dropped,
# no-new-privileges, read-only root filesystem, firewalled network (firewall.sh).
# Chromium therefore runs with --no-sandbox.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/home/agent \
    DISPLAY=:0

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb x11vnc xdotool scrot x11-utils dbus-x11 \
      xfce4-session xfwm4 xfdesktop4 xfce4-panel xfce4-terminal thunar mousepad \
      chromium ca-certificates tini \
      python3 curl git jq unzip zip procps less nano \
      nodejs npm \
      fonts-liberation fonts-noto-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 --shell /bin/bash agent

# Chromium never offers to save a password, card or address: the person types
# secrets during a takeover, and they must not land in a store the agent's shell
# could read.
COPY chrome-policies.json /etc/chromium/policies/managed/juno.json
COPY cdp-gate.py entrypoint.sh /opt/juno/
RUN chmod 0644 /etc/chromium/policies/managed/juno.json /opt/juno/cdp-gate.py \
 && chmod 0755 /opt/juno/entrypoint.sh

USER 1000:1000
WORKDIR /home/agent
EXPOSE 5900 9222
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/juno/entrypoint.sh"]
```

## `deploy/agent-computers/chrome-policies.json`

```json
{
  "PasswordManagerEnabled": false,
  "AutofillCreditCardEnabled": false,
  "AutofillAddressEnabled": false,
  "DefaultBrowserSettingEnabled": false,
  "MetricsReportingEnabled": false,
  "BackgroundModeEnabled": false,
  "PromptForDownloadLocation": false,
  "DownloadDirectory": "/home/agent/work/downloads"
}
```

## `deploy/agent-computers/entrypoint.sh`

```bash
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
```

## `deploy/agent-computers/cdp-gate.py`

The only way into Chromium's DevTools from outside the container. It requires the
secret header, accepts WebSocket upgrades only, and rewrites `Host` (Chromium rejects
non-local Host headers). The token arrives in the environment: Juno passes
`-e JUNO_CDP_TOKEN` by **name only**, with the value in the docker CLI's environment,
so it never appears in a process list on the host.

```python
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
```

## `deploy/agent-computers/firewall.sh`

```bash
#!/bin/bash
# Keeps agent computers off private networks, the cloud metadata and wire-server
# endpoints, and the host itself. Idempotent: run at boot and whenever Docker starts.
set -euo pipefail
BRIDGE=br-juno
CHAIN=JUNO-COMPUTERS

iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 \
           127.0.0.0/8 0.0.0.0/8 224.0.0.0/4 240.0.0.0/4 168.63.129.16/32; do
  iptables -A "$CHAIN" -d "$net" -j DROP
done
iptables -A "$CHAIN" -j RETURN

iptables -N DOCKER-USER 2>/dev/null || true
iptables -C DOCKER-USER -i "$BRIDGE" -j "$CHAIN" 2>/dev/null \
  || iptables -I DOCKER-USER 1 -i "$BRIDGE" -j "$CHAIN"

# A computer may answer the host (Juno connects to its CDP and VNC ports) but never
# open a connection to the host: that is where the app, the relay and the database
# credentials live.
iptables -C INPUT -i "$BRIDGE" -j DROP 2>/dev/null \
  || iptables -I INPUT 1 -i "$BRIDGE" -j DROP
iptables -C INPUT -i "$BRIDGE" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null \
  || iptables -I INPUT 1 -i "$BRIDGE" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# The network is created without IPv6; refuse anything that appears anyway.
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -N DOCKER-USER 2>/dev/null || true
  ip6tables -C DOCKER-USER -i "$BRIDGE" -j DROP 2>/dev/null || ip6tables -I DOCKER-USER 1 -i "$BRIDGE" -j DROP
  ip6tables -C INPUT -i "$BRIDGE" -j DROP 2>/dev/null || ip6tables -I INPUT 1 -i "$BRIDGE" -j DROP
fi
echo "juno-computers firewall in place"
```

## `deploy/agent-computers/setup-vm.sh`

```bash
#!/bin/bash
# One-time, idempotent setup of agent computers on the Juno VM. The owner runs it
# after deploying the release that contains it:
#   ssh <vm> 'sudo bash ~/juno/current/deploy/agent-computers/setup-vm.sh'
# Re-run it after changing the Dockerfile to rebuild the image.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd -P)"
RUN_USER="${SUDO_USER:-liammgnr}"
IMAGE="${COMPUTER_DOCKER_IMAGE:-juno-computer:1}"
NET=juno-computers
SUBNET=172.30.0.0/24
BRIDGE=br-juno

echo "==> Docker"
systemctl enable --now docker
id -nG "$RUN_USER" | tr ' ' '\n' | grep -qx docker || usermod -aG docker "$RUN_USER"

echo "==> Network $NET ($SUBNET, bridge $BRIDGE, no container-to-container traffic)"
docker network inspect "$NET" >/dev/null 2>&1 || docker network create \
  --driver bridge --subnet "$SUBNET" \
  -o com.docker.network.bridge.name="$BRIDGE" \
  -o com.docker.network.bridge.enable_icc=false \
  "$NET"

echo "==> Firewall"
install -m 0755 "$HERE/firewall.sh" /usr/local/sbin/juno-computers-firewall
cat > /etc/systemd/system/juno-computers-firewall.service <<'UNIT'
[Unit]
Description=Firewall for Juno agent computers
After=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/juno-computers-firewall

[Install]
WantedBy=multi-user.target docker.service
UNIT
systemctl daemon-reload
systemctl enable juno-computers-firewall.service
systemctl restart juno-computers-firewall.service

echo "==> Image $IMAGE"
docker build --pull -t "$IMAGE" "$HERE"

echo
echo "Agent computers are ready on this server."
echo "Turn them on:  cd ~/juno && ./scripts/set-env-key.sh COMPUTER_PROVIDER --reload   (value: docker)"
```

---

## How Juno drives a container (`src/lib/computer/docker.ts`)

This is the **only** file allowed to import `node:child_process`. It uses only
`execFile("docker", argv)` or `spawn("docker", argv, { shell: false })`: never a shell
string on the host, and never any binary other than `docker`.

**Create (first use).** Run `docker volume create juno-agent-<agentId>`, then
`docker create` with **exactly** these flags. A unit test asserts them.
```
--name juno-agent-<agentId> --hostname computer
--network juno-computers --dns 1.1.1.1 --dns 9.9.9.9
--memory <COMPUTER_MEMORY_MB>m --memory-swap <COMPUTER_MEMORY_MB>m --cpus <COMPUTER_CPUS>
--pids-limit 2048 --shm-size 1g
--cap-drop ALL --security-opt no-new-privileges
--read-only
--tmpfs /tmp:rw,nosuid,nodev,size=1g,mode=1777
--tmpfs /run:rw,nosuid,nodev,size=64m
--tmpfs /var/tmp:rw,nosuid,nodev,size=256m
--mount type=volume,source=juno-agent-<agentId>,target=/home/agent
--label app=juno --label juno.agent=<agentId> --label juno.user=<userId>
-e JUNO_CDP_TOKEN          (name only; the value goes in execFile's env option)
--restart no --stop-timeout 20
<COMPUTER_DOCKER_IMAGE>
```
- **Development on macOS only** (`process.platform === "darwin"` and
  `NODE_ENV !== "production"`), also pass `-p 127.0.0.1::9222 -p 127.0.0.1::5900`.
  Docker Desktop cannot route to container IPs, so the endpoints come from
  `docker port`.
- The test asserts that production argv **never** contains:
  - `--privileged`, `--network host` or `-p`;
  - `/var/run/docker.sock`;
  - a `-v`/`--mount` of a host path;
  - `--cap-add`;
  - `seccomp=unconfined`.

**Endpoints.**
- On Linux, read the container IP with
  `docker inspect -f '{{(index .NetworkSettings.Networks "juno-computers").IPAddress}}' <name>`.
  CDP is at `ws://<ip>:9222` and VNC at `<ip>:5900`. The host reaches bridge IPs
  directly.
- On macOS dev, use `docker port <name> 9222` and `docker port <name> 5900`.

**Sleep has two tiers** (the "powerful" equivalent of a paused VM):
- **Resting** = `docker pause`, after `COMPUTER_IDLE_PAUSE_SECONDS`. Memory, open windows
  and tabs are kept, CPU use is zero, and it resumes instantly with `docker unpause`.
- **Asleep** = `docker stop`, after `COMPUTER_IDLE_STOP_MINUTES`. RAM is freed; the
  volume keeps logins, the profile and files. It resumes with `docker start` (the desktop
  plus Chromium, a few seconds). Take the poster screenshot before stopping.

**Pixel control and screenshots** go through `docker exec --user 1000 -e DISPLAY=:0 <name> …`:
- screenshot: `scrot -o -z /tmp/juno-shot.png`, then `cat /tmp/juno-shot.png`, then
  convert to JPEG q70 with `sharp` on the host, **without resizing** (1280×800, the same
  space as the click coordinates);
- click: `xdotool mousemove --sync X Y click [--repeat 2] 1|3`;
- type: `xdotool type --delay 12 -- "<text>"`, where the text is one argv element and
  never passes through a shell;
- key: `xdotool key -- <keys>` (for example `ctrl+l`, `Return`);
- scroll: `xdotool mousemove X Y click --repeat N 4|5`;
- drag: `xdotool mousemove X1 Y1 mousedown 1 mousemove X2 Y2 mouseup 1`.

**Shell:** `docker exec --user 1000 --workdir /home/agent/work <name> timeout --signal=TERM --kill-after=5 <secs> bash -lc <command>`.
The command is one argv element and is interpreted **inside the container** only.

**Files:** always under `/home/agent`, and resolved inside the container with
`realpath -m -- <path>`. The result must start with `/home/agent/`.
- list: `find <dir> -maxdepth 1 -mindepth 1 -printf '%y\t%s\t%p\n'`
- read: `cat -- <file>`, with a size limit
- write: `spawn` with stdin, running `sh -c 'cat > "$1"' sh <file>`

**Live view (x11vnc, on demand).**
1. Generate `vncControl` and `vncView`: 8 random characters each, from `[A-Za-z0-9]`,
   because VNC uses only the first 8 characters.
2. Write `/home/agent/.juno/vncpass` (mode 0600) through stdin as
   `"<control>\n__BEGIN_VIEWONLY__\n<view>\n"`.
3. Start
   `x11vnc -display :0 -forever -shared -rfbport 5900 -passwdfile /home/agent/.juno/vncpass -bg -o /tmp/x11vnc.log`,
   after `pkill -x x11vnc`.
4. **Verify** the view-only-password syntax against the installed x11vnc, with
   `docker exec <name> x11vnc -help | grep -n -A3 -i viewonly`. Adjust if the marker
   differs, and record it in `PROGRESS.md`.
5. Stop x11vnc when no one has viewed for 60 s. The next start rotates both passwords.

**Health and preflight** (before `create` or `start`):
- **Linux only:** host `MemAvailable` from `/proc/meminfo` must be ≥
  `COMPUTER_MIN_FREE_MEMORY_MB`, read with `fs`, not a subprocess.
- Host free disk from `fs.statfs("/")` must be ≥ `COMPUTER_MIN_FREE_DISK_GB`.
- `docker image inspect <image>` must succeed. Otherwise the provider reports
  "not set up", logs one line, and the feature stays hidden.
- Refuse with a plain sentence the UI can show: "The server doesn't have enough free
  memory to start another computer right now."
- The sweeper checks awake computers' disk use with `du -sm /home/agent` every 10 min.
  Over `COMPUTER_DISK_LIMIT_MB`, the shell and file-write tools refuse with "Your disk
  is full: delete files in /home/agent/work first."

## The live-view relay (`relay/src/computer-view.ts`)

The voice relay already runs on the VM behind nginx at `/voice-relay` (WebSocket upgrade,
URI passed through untouched), and it already has `AUTH_SECRET` in its env allowlist.
Add a second upgrade route:

- **Path:** any upgrade whose pathname ends with `/computer`, for example
  `wss://<host>/voice-relay/computer?t=<token>`. Dispatch it in `relay/src/server.ts`'s
  `upgrade` handler before the voice path.
- **Token:** minted by Next in `POST /api/agents/[id]/computer/view`.
  - It is `base64url(JSON {v:1, a: agentId, u: userId, h: host, p: port, m: "watch"|"control", exp})` + "." + `base64url(HMAC-SHA256(key, payload))`,
    where `key = HMAC-SHA256(AUTH_SECRET, "juno-computer-view-v1")`.
  - `exp` is 60 s after minting; it only needs to cover the connect.
  - The token is useless without the VNC password, which the page holds in memory.
- **Relay checks:**
  - the signature, with `timingSafeEqual`;
  - `exp`;
  - `Origin` against `ALLOWED_ORIGINS`, using `relay/src/origin.ts`;
  - `h` inside `RELAY_COMPUTER_CIDR` (default `172.30.0.0/24`), or `127.0.0.1` only when
    `NODE_ENV !== "production"`;
  - `p` is 5900, or any port on 127.0.0.1 in development;
  - at most 3 open viewers per agent.
- **Pipe:** accept the WebSocket, then pipe binary frames ↔ `net.connect(h, p)`,
  respecting backpressure. noVNC asks for the `binary` subprotocol; accept it. Apply a
  15-minute idle timeout and a 2-hour maximum. Close both sides on either error.
- **Never log** the token, the host or the port. Log only "computer view opened/closed"
  with a hashed agent id.
- Tests go in `relay/tests/`: a fake TCP server, a signed token, bad signature, expired,
  out-of-CIDR host, bad origin, and bytes round-trip.
