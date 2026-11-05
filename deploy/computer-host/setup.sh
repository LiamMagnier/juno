#!/bin/bash
# One-time, idempotent setup of a computer host: a DEDICATED Linux machine that runs
# agent computers away from the web VM (COMPUTERS_2026-10.md S3; the owner guide is
# README.md beside this file). Never on the web VM: the web VM holds the database URL,
# the provider keys and AUTH_SECRET, and model-driven desktops must not run beside them.
#
#   sudo bash setup.sh --web-ip <web VM address> --domain <host name> \
#        [--tls private|certbot|own] [--certbot-email <e>] [--cert <f> --key <f>] \
#        [--namespace <ns>] [--ssh-from <cidr>] [--max-running N]
#
# What it sets up (the firewall first, so 443 never answers anyone but --web-ip):
#   - nftables (table inet juno_computer_host): 443 from --web-ip only, SSH from --ssh-from,
#     the computers' own way to the egress proxy, everything else dropped;
#   - user juno-computer-host (no login, no docker group, no sudo);
#   - the shared computer steps of deploy/agent-computers/setup-vm.sh --computer-host:
#     the juno-computers network (172.30.0.0/24, bridge br-juno, no container-to-container
#     traffic), the egress address map, the egress proxy with its log and budget, the
#     iptables firewall, the image (pipe-v4) and the browser-sandbox decision;
#   - the root broker, socket-activated (/run/juno-computer-host/broker.sock,
#     root:juno-computer-host 0660), the only thing that talks to Docker; its argv policy
#     is deploy/agent-computers/docker-broker.py's, imported, in host mode;
#   - the host service on 127.0.0.1:8750 (API) and :8751 (tunnels), NoNewPrivileges, a
#     strict read-only system, no capabilities, memory and task caps;
#   - TLS (D18): by default a private CA that can sign only <domain>, whose key is
#     destroyed once the host's certificate is signed; or Let's Encrypt with port 80 open
#     only while a renewal runs; or the owner's own files;
#   - nginx on 443 in front (path-free logs, the tunnel and exec timeouts);
#   - the first token for --namespace (default: prod). Only its sha256 is kept on the
#     host; the token itself is written once to a root-only file whose path is printed.
#
# Maintenance (run on the host, as root):
#   --add-token --namespace <ns>   a second token for a namespace (rotation; at most two)
#   --retire-token <id>            stop accepting one (after the web VM has the new one); its
#                                  tunnel tickets and open tunnels are closed too
#   --renew-tls                    a new certificate of the kind setup installed, or of --tls
#                                  (private: a new CA too)
#   --rebuild-image                docker build --pull --no-cache, check the label, prune
#   --rebuild-timer on|off         a weekly --rebuild-image (it pulls Debian packages)
# Print modes (no root, nothing changed; used by the tests and run-local.sh):
#   --print-nftables --web-ip <ip> [--ssh-from <cidr>]
#   --print-nginx --domain <name> --cert <f> --key <f> [--listen <addr:port>] [--api-port N]
#                 [--tunnel-port N] [--access-log <f>] [--error-log <f>]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
# The repo's deploy/agent-computers, or (the installed copy the weekly rebuild
# runs) the image context setup copied beside it.
if [ -d "$HERE/../agent-computers" ]; then COMPUTERS="$(cd "$HERE/../agent-computers" && pwd -P)"; else COMPUTERS="$HERE/image-context"; fi

WEB_IP="" DOMAIN="" TLS=private TLS_GIVEN=0 CERTBOT_EMAIL="" CERT="" KEY="" NAMESPACE=prod SSH_FROM="" MAX_RUNNING=6
ACTION=setup TOKEN_ID="" TIMER="" LISTEN="" API_PORT=8750 TUNNEL_PORT=8751
ACCESS_LOG=/var/log/nginx/juno-computer-host.access.log ERROR_LOG=/var/log/nginx/juno-computer-host.error.log
while [ $# -gt 0 ]; do
  case "$1" in
    --web-ip) WEB_IP="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --tls) TLS="$2"; TLS_GIVEN=1; shift 2 ;;
    --certbot-email) CERTBOT_EMAIL="$2"; shift 2 ;;
    --cert) CERT="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --ssh-from) SSH_FROM="$2"; shift 2 ;;
    --max-running) MAX_RUNNING="$2"; shift 2 ;;
    --add-token) ACTION=add-token; shift ;;
    --retire-token) ACTION=retire-token; TOKEN_ID="$2"; shift 2 ;;
    --renew-tls) ACTION=renew-tls; shift ;;
    --rebuild-image) ACTION=rebuild-image; shift ;;
    --rebuild-timer) ACTION=rebuild-timer; TIMER="$2"; shift 2 ;;
    --print-nftables) ACTION=print-nftables; shift ;;
    --print-nginx) ACTION=print-nginx; shift ;;
    --listen) LISTEN="$2"; shift 2 ;;
    --api-port) API_PORT="$2"; shift 2 ;;
    --tunnel-port) TUNNEL_PORT="$2"; shift 2 ;;
    --access-log) ACCESS_LOG="$2"; shift 2 ;;
    --error-log) ERROR_LOG="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

CONFIG=/etc/juno/computer-host.json
TOKENS=/etc/juno/computer-host-tokens.json
LIB=/usr/local/lib/juno-computer-host
TLS_DIR=/etc/juno/computer-host-tls
IMAGE=juno-computer:1
LABEL=pipe-v4
SERVICE_USER=juno-computer-host

[[ "$NAMESPACE" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { echo "--namespace: lowercase letters, digits and dashes, at most 32" >&2; exit 2; }
[[ "$MAX_RUNNING" =~ ^[1-9][0-9]{0,2}$ ]] || { echo "--max-running must be a whole number from 1" >&2; exit 2; }
[[ "$API_PORT" =~ ^[1-9][0-9]{1,4}$ && "$TUNNEL_PORT" =~ ^[1-9][0-9]{1,4}$ ]] || { echo "ports must be numbers" >&2; exit 2; }

valid_address() {  # <address or cidr>
  python3 -c 'import ipaddress, sys; ipaddress.ip_network(sys.argv[1], strict=False)' "$1" 2>/dev/null
}
family_of() {  # ip | ip6
  case "$1" in *:*) echo ip6 ;; *) echo ip ;; esac
}

# Checked before anything is installed: the private CA certifies DNS:<domain>, which a
# client never matches against an https://<IP> origin (private-tls.sh refuses it too).
if [ "$ACTION" = setup ] || [ "$ACTION" = renew-tls ]; then
  if [ -n "$DOMAIN" ] && [ "$TLS" = private ] && valid_address "$DOMAIN"; then
    echo "--domain must be a DNS name, not an IP address, with --tls private: give the host a private DNS record (or an /etc/hosts line on the web VM)" >&2; exit 2
  fi
fi

print_nftables() {
  [ -n "$WEB_IP" ] && valid_address "$WEB_IP" || { echo "--web-ip must be the web VM's address" >&2; exit 2; }
  local ssh_rule
  if [ -z "$SSH_FROM" ]; then
    ssh_rule="tcp dport 22 accept"
  else
    valid_address "$SSH_FROM" || { echo "--ssh-from must be an address or CIDR" >&2; exit 2; }
    ssh_rule="$(family_of "$SSH_FROM") saddr $SSH_FROM tcp dport 22 accept"
  fi
  # Only the input hook: Docker's own forward and NAT rules are left alone. A drop
  # in any nftables base chain is final, so the computers' one way out (the egress
  # proxy on the bridge gateway, which firewall.sh also allows in its own table)
  # must be accepted here too, or every computer loses the Internet.
  cat <<NFT
table inet juno_computer_host {
  chain input {
    type filter hook input priority 0; policy drop;
    iif lo accept
    ct state established,related accept
    ct state invalid drop
    ip protocol icmp accept
    meta l4proto ipv6-icmp accept
    iifname "br-juno" ip daddr 172.30.0.1 tcp dport 3128 accept
    $ssh_rule
    $(family_of "$WEB_IP") saddr $WEB_IP tcp dport 443 accept
  }
}
NFT
}

print_nginx() {
  [ -n "$DOMAIN" ] && [ -n "$CERT" ] && [ -n "$KEY" ] || { echo "--print-nginx needs --domain, --cert and --key" >&2; exit 2; }
  local listen
  if [ -n "$LISTEN" ]; then
    listen="    listen $LISTEN ssl;"
  elif [ "$(family_of "$WEB_IP")" = ip6 ]; then
    # IPv6 only when the web VM comes over it: a host without IPv6 cannot bind [::].
    listen="    listen 443 ssl;
    listen [::]:443 ssl;"
  else
    listen="    listen 443 ssl;"
  fi
  python3 - "$HERE/nginx.conf.template" "$listen" "$DOMAIN" "$CERT" "$KEY" "$ACCESS_LOG" "$ERROR_LOG" \
    "127.0.0.1:$API_PORT" "127.0.0.1:$TUNNEL_PORT" <<'PY'
import sys
template, listen, domain, cert, key, access, error, api, tunnel = sys.argv[1:]
text = open(template, encoding="utf-8").read()
for name, value in (("@LISTEN@", listen), ("@DOMAIN@", domain), ("@CERT@", cert), ("@KEY@", key),
                    ("@ACCESS_LOG@", access), ("@ERROR_LOG@", error), ("@API@", api), ("@TUNNEL@", tunnel)):
    text = text.replace(name, value)
sys.stdout.write(text)
PY
}

case "$ACTION" in
  print-nftables) print_nftables; exit 0 ;;
  print-nginx) print_nginx; exit 0 ;;
esac

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }

new_token() {  # <namespace>: adds a token, prints the root-only file that holds it
  local ns="$1" id file
  id="t$(date -u +%Y%m%d%H%M%S)$(openssl rand -hex 2)"
  file="/root/juno-computer-host-token-$id.txt"
  # The token is made, hashed and written inside python: never a shell variable
  # or a command-line argument (any local user can read /proc/<pid>/cmdline).
  # The root-only file is written before the hash goes in force.
  python3 - "$TOKENS" "$id" "$ns" "$file" <<'PY' || return 1
import hashlib, json, os, secrets, sys
path, token_id, namespace, out = sys.argv[1:]
entries = []
if os.path.exists(path):
    with open(path, encoding="utf-8") as file:
        entries = json.load(file)
if sum(1 for entry in entries if entry["namespace"] == namespace) >= 2:
    sys.exit("namespace %s already has two tokens: retire one first (--retire-token <id>)" % namespace)
token = secrets.token_hex(32)  # 32 random bytes, 64 hex: the format the host and the app check
with os.fdopen(os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as file:
    file.write(token + "\n")
entries.append({"id": token_id, "sha256": hashlib.sha256(token.encode()).hexdigest(), "namespace": namespace})
with open(path + ".part", "w", encoding="utf-8") as file:
    json.dump(entries, file, indent=1)
os.replace(path + ".part", path)
PY
  chown root:"$SERVICE_USER" "$TOKENS"
  chmod 0640 "$TOKENS"
  echo "$file"
}

reload_service() {
  if systemctl is-active --quiet juno-computer-host.service; then systemctl reload juno-computer-host.service; fi
}

install_tls() {
  case "$TLS" in
    private)
      bash "$HERE/private-tls.sh" "$DOMAIN" "$TLS_DIR"
      CERT="$TLS_DIR/cert.pem"; KEY="$TLS_DIR/key.pem"
      ;;
    certbot)
      [ -n "$CERTBOT_EMAIL" ] || { echo "--tls certbot needs --certbot-email" >&2; exit 2; }
      # Port 80 is open only while certbot runs: the pre-hook adds the rule, the
      # post-hook deletes it by its comment, and a renewal reloads nginx.
      local open_80='nft add rule inet juno_computer_host input tcp dport 80 accept comment \"juno-certbot\"'
      local close_80="nft -a list chain inet juno_computer_host input | sed -n 's/.*juno-certbot.*# handle \\([0-9]*\\).*/\\1/p' | xargs -r -n1 nft delete rule inet juno_computer_host input handle"
      certbot certonly --standalone --non-interactive --agree-tos -m "$CERTBOT_EMAIL" -d "$DOMAIN" \
        --pre-hook "$open_80" --post-hook "$close_80" --deploy-hook "systemctl reload nginx"
      CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"; KEY="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
      ;;
    own)
      [ -f "$CERT" ] && [ -f "$KEY" ] || { echo "--tls own needs --cert and --key files" >&2; exit 2; }
      install -d -m 0755 "$TLS_DIR"
      install -m 0644 "$CERT" "$TLS_DIR/cert.pem"; install -m 0600 "$KEY" "$TLS_DIR/key.pem"
      CERT="$TLS_DIR/cert.pem"; KEY="$TLS_DIR/key.pem"
      ;;
    *) echo "--tls is private, certbot or own" >&2; exit 2 ;;
  esac
  # The service reads only the certificate (for the expiry it reports), never the key.
  install -m 0644 "$CERT" /etc/juno/computer-host-cert.pem
}

rebuild_image() {
  local context="$LIB/image-context"
  [ -d "$context" ] || context="$COMPUTERS"
  docker build --pull --no-cache -t "$IMAGE" "$context"
  local label
  label="$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "juno.security"}}')"
  [ "$label" = "$LABEL" ] || { echo "the rebuilt image carries $label, not $LABEL: computers stay off until it does" >&2; exit 1; }
  # Only untagged computer images no container uses (prune never removes one in use).
  docker image prune -f --filter "label=juno.security" >/dev/null
  echo "Image rebuilt ($(docker image inspect "$IMAGE" --format '{{.Id}}')). Computers made from the old image are recreated on their volumes at their next wake."
}

case "$ACTION" in
  add-token)
    file="$(new_token "$NAMESPACE")"
    reload_service
    echo "Added a token for namespace $NAMESPACE. It is in $file (root only): set it on the web VM as"
    echo "COMPUTER_HOST_TOKEN, restart the app, the Work runner and the relay when convenient, delete the file,"
    echo "then retire the old token with --retire-token <old id> (ids: $(python3 -c 'import json,sys; print(", ".join(e["id"] for e in json.load(open(sys.argv[1]))))' "$TOKENS"))."
    exit 0 ;;
  retire-token)
    python3 - "$TOKENS" "$TOKEN_ID" <<'PY'
import json, os, sys
path, token_id = sys.argv[1:]
with open(path, encoding="utf-8") as file:
    entries = json.load(file)
kept = [entry for entry in entries if entry["id"] != token_id]
if len(kept) == len(entries):
    sys.exit("no token has the id %s" % token_id)
if not kept:
    sys.exit("refusing to retire the last token: add a new one first")
with open(path + ".part", "w", encoding="utf-8") as file:
    json.dump(kept, file, indent=1)
os.replace(path + ".part", path)
PY
    chown root:"$SERVICE_USER" "$TOKENS"; chmod 0640 "$TOKENS"
    reload_service
    echo "Retired $TOKEN_ID; the host no longer accepts it, and its tunnel tickets and open tunnels are closed."
    exit 0 ;;
  renew-tls)
    # The kind setup installed, unless --tls says otherwise: `own` and `private` serve the
    # same file, and a private CA's certificate over the owner's would cut off the web VM.
    [ "$TLS_GIVEN" = 1 ] || TLS="$(python3 -c 'import json; print(json.load(open("/etc/juno/computer-host-setup.json"))["tls"])')"
    [ -n "$DOMAIN" ] || DOMAIN="$(python3 -c 'import json; print(json.load(open("/etc/juno/computer-host-setup.json"))["domain"])')"
    [ "$TLS" != private ] || [ -n "$DOMAIN" ] || { echo "--domain is required" >&2; exit 2; }
    install_tls
    nginx -t && systemctl reload nginx
    [ "$TLS" = private ] && { echo "New CA certificate (add it to the web VM's NODE_EXTRA_CA_CERTS file; keep the old one until every process restarted):"; cat "$TLS_DIR/ca.pem"; }
    exit 0 ;;
  rebuild-image) rebuild_image; exit 0 ;;
  rebuild-timer)
    case "$TIMER" in
      on)
        cat > /etc/systemd/system/juno-computer-image-rebuild.service <<UNIT
[Unit]
Description=Rebuild the agent computer image (Debian and Chromium updates)
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/bash $LIB/setup.sh --rebuild-image
UNIT
        cat > /etc/systemd/system/juno-computer-image-rebuild.timer <<'UNIT'
[Unit]
Description=Weekly rebuild of the agent computer image

[Timer]
OnCalendar=weekly
RandomizedDelaySec=6h
Persistent=true

[Install]
WantedBy=timers.target
UNIT
        systemctl daemon-reload
        systemctl enable --now juno-computer-image-rebuild.timer
        echo "Weekly image rebuild on." ;;
      off)
        systemctl disable --now juno-computer-image-rebuild.timer 2>/dev/null || true
        rm -f /etc/systemd/system/juno-computer-image-rebuild.timer /etc/systemd/system/juno-computer-image-rebuild.service
        systemctl daemon-reload
        echo "Weekly image rebuild off." ;;
      *) echo "--rebuild-timer on|off" >&2; exit 2 ;;
    esac
    exit 0 ;;
esac

[ -n "$WEB_IP" ] && valid_address "$WEB_IP" || { echo "--web-ip is required: the API answers the web VM only" >&2; exit 2; }
[ -n "$DOMAIN" ] || { echo "--domain is required for TLS" >&2; exit 2; }

echo "==> Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q docker.io nginx nftables python3 python3-websockets openssl curl
[ "$TLS" = certbot ] && apt-get install -y -q certbot
python3 - <<'PY'
import sys
import websockets
version = tuple(int(part) for part in websockets.__version__.split(".")[:2])
if not (10, 4) <= version < (15, 0):
    sys.exit("python3-websockets %s is outside [10.4, 15): the host imports websockets.legacy explicitly" % websockets.__version__)
print("    websockets %s" % websockets.__version__)
PY
systemctl enable --now docker

# The firewall goes first, before nginx serves 443 or the service starts, so the
# API is never reachable from anywhere but --web-ip, even if setup stops halfway.
# The package's default nginx site (port 80, every interface) goes too: only
# certbot's standalone renewals use port 80, through their own firewall hooks.
echo "==> Firewall (nftables, input only)"
[ -n "$SSH_FROM" ] || echo "WARNING: --ssh-from not given; SSH stays open to everyone. Re-run with your admin CIDR." >&2
print_nftables > /etc/nftables.d-juno-computer-host.conf
nft list table inet juno_computer_host >/dev/null 2>&1 && nft delete table inet juno_computer_host
nft -f /etc/nftables.d-juno-computer-host.conf
grep -q "nftables.d-juno-computer-host.conf" /etc/nftables.conf 2>/dev/null || echo 'include "/etc/nftables.d-juno-computer-host.conf"' >> /etc/nftables.conf
systemctl enable nftables
rm -f /etc/nginx/sites-enabled/default
systemctl reload nginx 2>/dev/null || true

echo "==> User"
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SERVICE_USER"
# Never root-equivalent through Docker: no docker group, no sudo.
if id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -qx docker; then gpasswd -d "$SERVICE_USER" docker; fi
rm -f "/etc/sudoers.d/$SERVICE_USER"

echo "==> Computers (network, egress proxy, firewall, image, sandbox decision)"
bash "$COMPUTERS/setup-vm.sh" --computer-host

echo "==> Broker and service"
install -d -m 0755 /etc/juno "$LIB"
install -o root -g root -m 0755 "$HERE/juno-computer-host-broker.py" /usr/local/sbin/juno-computer-host-broker
install -o root -g root -m 0644 "$COMPUTERS/docker-broker.py" "$LIB/docker-broker.py"
install -o root -g root -m 0644 "$HERE/juno-computer-host.py" "$LIB/juno-computer-host.py"
install -o root -g root -m 0644 "$HERE/setup.sh" "$LIB/setup.sh"
install -o root -g root -m 0644 "$HERE/private-tls.sh" "$LIB/private-tls.sh"
install -o root -g root -m 0644 "$HERE/nginx.conf.template" "$LIB/nginx.conf.template"
# The image's build context, for --rebuild-image and the weekly timer.
rm -rf "$LIB/image-context"
cp -a "$COMPUTERS" "$LIB/image-context"
cat > /etc/systemd/system/juno-computer-host-broker.socket <<'UNIT'
[Unit]
Description=Juno computer host Docker broker socket

[Socket]
ListenStream=/run/juno-computer-host/broker.sock
SocketUser=root
SocketGroup=juno-computer-host
SocketMode=0660
DirectoryMode=0755
Accept=yes
MaxConnections=64

[Install]
WantedBy=sockets.target
UNIT
cat > /etc/systemd/system/juno-computer-host-broker@.service <<'UNIT'
[Unit]
Description=Juno computer host Docker broker (one validated docker command)
Requires=docker.service
After=docker.service

[Service]
Type=simple
User=root
ExecStart=/usr/bin/python3 -I /usr/local/sbin/juno-computer-host-broker
StandardInput=socket
StandardOutput=socket
StandardError=journal
NoNewPrivileges=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX
RuntimeMaxSec=400
TasksMax=64
UNIT

python3 - "$CONFIG" "$MAX_RUNNING" "$API_PORT" "$TUNNEL_PORT" <<'PY'
import json, sys
path, max_running, api, tunnel = sys.argv[1:]
config = {"image": "juno-computer:1", "network": "juno-computers", "subnet": "172.30.0.0/24", "gateway": "172.30.0.1",
          "memoryMb": 2048, "cpus": 2, "minFreeMemMb": 1024, "minFreeDiskMb": 10240, "maxRunning": int(max_running),
          "listen": "127.0.0.1", "apiPort": int(api), "tunnelPort": int(tunnel), "ticketTtlSeconds": 60,
          "maxTicketsPerComputer": 16, "maxCommandsPerComputer": 4, "maxConcurrentCommands": 24,
          "tokensFile": "/etc/juno/computer-host-tokens.json",
          "brokerPolicy": "/etc/juno/computer-host-broker.json", "brokerSocket": "/run/juno-computer-host/broker.sock",
          "dockerRoot": "/var/lib/docker", "tlsCertificate": "/etc/juno/computer-host-cert.pem"}
with open(path, "w", encoding="utf-8") as file:
    json.dump(config, file, indent=1)
PY
chmod 0644 "$CONFIG"
python3 - "$DOMAIN" "$TLS" "$NAMESPACE" <<'PY'
import json, sys
with open("/etc/juno/computer-host-setup.json", "w", encoding="utf-8") as file:
    json.dump({"domain": sys.argv[1], "tls": sys.argv[2], "namespace": sys.argv[3]}, file)
PY

echo "==> Token"
FIRST_TOKEN_FILE=""
if [ ! -s "$TOKENS" ] || ! python3 -c 'import json,sys; sys.exit(0 if any(e["namespace"]==sys.argv[2] for e in json.load(open(sys.argv[1]))) else 1)' "$TOKENS" "$NAMESPACE"; then
  FIRST_TOKEN_FILE="$(new_token "$NAMESPACE")"
fi
chown root:"$SERVICE_USER" "$TOKENS"; chmod 0640 "$TOKENS"

cat > /etc/systemd/system/juno-computer-host.service <<UNIT
[Unit]
Description=Juno computer host (agent computers API and tunnels)
Requires=juno-computer-host-broker.socket docker.service
After=juno-computer-host-broker.socket docker.service network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
ExecStart=/usr/bin/python3 -I $LIB/juno-computer-host.py --config $CONFIG
ExecReload=/bin/kill -HUP \$MAINPID
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryMax=512M
TasksMax=256
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now juno-computer-host-broker.socket
systemctl enable juno-computer-host.service
systemctl restart juno-computer-host.service

echo "==> TLS ($TLS)"
install_tls

echo "==> nginx (TLS on 443)"
print_nginx > /etc/nginx/sites-available/juno-computer-host
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/juno-computer-host /etc/nginx/sites-enabled/juno-computer-host
nginx -t
systemctl enable --now nginx
systemctl reload nginx

echo "==> Health"
# The token never goes on a command line (any local user can read those in the
# process list): printf is a shell builtin, and curl reads the header from stdin.
TOKEN_FOR_CHECK=""
[ -n "$FIRST_TOKEN_FILE" ] && TOKEN_FOR_CHECK="$(cat "$FIRST_TOKEN_FILE")"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if [ -z "$TOKEN_FOR_CHECK" ]; then
    systemctl is-active --quiet juno-computer-host.service && { echo "juno-computer-host is running"; break; }
  elif printf 'Authorization: Bearer %s\n' "$TOKEN_FOR_CHECK" \
      | curl -fsS -H @- "http://127.0.0.1:$API_PORT/v1/available" | grep -q '"ok": true'; then
    echo "juno-computer-host is healthy on 127.0.0.1:$API_PORT"
    break
  fi
  sleep 1
  [ "$attempt" = 10 ] && { echo "juno-computer-host did not answer; see: journalctl -u juno-computer-host -u 'juno-computer-host-broker@*'" >&2; exit 1; }
done

echo
echo "Done. On the WEB VM (and nowhere else), set:"
echo "  COMPUTER_PROVIDER=remote"
echo "  COMPUTER_HOST_URL=https://$DOMAIN"
[ -n "$FIRST_TOKEN_FILE" ] && echo "  COMPUTER_HOST_TOKEN=<the token in $FIRST_TOKEN_FILE (root only); delete that file once copied>"
[ "$TLS" = private ] && echo "  NODE_EXTRA_CA_CERTS=<a file on the web VM holding this CA certificate> for the app, the Work runner and the relay:" && cat "$TLS_DIR/ca.pem"
echo "  and for the relay: RELAY_COMPUTER_HOSTS=https://$DOMAIN"
echo "Keep AGENT_COMPUTER_ROLLOUT=allowlist and list the first accounts in AGENT_COMPUTER_ALLOWLIST."
echo
echo "Check the address this host sees for the web VM (Azure may SNAT it): from the web VM run"
echo "  printf 'Authorization: Bearer %s\\n' \"\$COMPUTER_HOST_TOKEN\" | curl -fsS -H @- https://$DOMAIN/v1/health"
echo "and compare its \"source\" with --web-ip ($WEB_IP). If they differ, re-run with --web-ip <source>."
