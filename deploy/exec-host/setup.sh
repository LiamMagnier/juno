#!/bin/bash
# One-time, idempotent setup of juno-exec on a DEDICATED execution host — never on
# the web VM (TOOL_RUNTIME_DESIGN.md §6.2: no process, no Docker and no model code
# beside the application's secrets). The owner provisions the host (Linux amd64,
# e.g. 4 vCPU / 8 GB, same region as the web VM), copies this directory to it and runs:
#
#   sudo bash setup.sh --web-ip <web VM public IP> --domain exec.example.com \
#        [--cert /path/fullchain.pem --key /path/privkey.pem | --certbot-email you@example.com] \
#        [--ssh-from <admin CIDR>] [--gvisor] [--work-size 20G]
#
# Re-run after changing image/ to rebuild and re-pin the image. What it sets up:
#   - user juno-exec (no login); data in /var/lib/juno-exec; session workspaces on a
#     size-capped ext4 image mounted nosuid,nodev,noexec, so a run cannot fill the disk;
#   - the root broker, socket-activated (/run/juno-exec/broker.sock, root:juno-exec 0660),
#     the ONLY thing that talks to Docker, with its policy in /etc/juno/exec-broker.json
#     pinning the image id, the uid, the limits and (optionally) gVisor;
#   - juno-exec itself on 127.0.0.1:8740 under systemd with NoNewPrivileges, a strict
#     read-only system, no capabilities and memory/task caps; its bearer token in
#     /etc/juno/exec-token (root 0600), passed as a systemd credential;
#   - nginx terminating TLS on 443 in front of it (SSE unbuffered, 40 MB bodies);
#   - nftables: inbound 443 only from the web VM, SSH only from --ssh-from (or anywhere,
#     with a warning), everything else dropped.
# It prints where the token is. Copy it to the web VM yourself, as
# CODE_INTERPRETER_TOKEN, with CODE_INTERPRETER_URL=https://<domain> and TOOL_RUNTIME=1.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd -P)"

WEB_IP="" DOMAIN="" CERT="" KEY="" CERTBOT_EMAIL="" SSH_FROM="" GVISOR=0 WORK_SIZE="20G"
while [ $# -gt 0 ]; do
  case "$1" in
    --web-ip) WEB_IP="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --cert) CERT="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --certbot-email) CERTBOT_EMAIL="$2"; shift 2 ;;
    --ssh-from) SSH_FROM="$2"; shift 2 ;;
    --gvisor) GVISOR=1; shift ;;
    --work-size) WORK_SIZE="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$WEB_IP" ] || { echo "--web-ip is required: the API is reachable from the web VM only" >&2; exit 2; }
[ -n "$DOMAIN" ] || { echo "--domain is required for TLS" >&2; exit 2; }
if [ -z "$CERTBOT_EMAIL" ] && { [ -z "$CERT" ] || [ -z "$KEY" ]; }; then
  echo "give --cert and --key, or --certbot-email" >&2; exit 2
fi

DATA=/var/lib/juno-exec
SESSIONS="$DATA/sessions"
IMAGE_TAG=juno-exec:1
PORT=8740

echo "==> Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q docker.io nginx nftables python3 e2fsprogs curl openssl
[ -n "$CERTBOT_EMAIL" ] && apt-get install -y -q certbot python3-certbot-nginx
systemctl enable --now docker

echo "==> User and data"
id juno-exec >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin juno-exec
# Never root-equivalent through Docker: no docker group, no sudo.
if id -nG juno-exec | tr ' ' '\n' | grep -qx docker; then gpasswd -d juno-exec docker; fi
RUN_UID="$(id -u juno-exec)"
RUN_GID="$(id -g juno-exec)"
install -d -o juno-exec -g juno-exec -m 0750 "$DATA" "$DATA/runs" "$DATA/idempotency"
if ! mountpoint -q "$SESSIONS"; then
  [ -f "$DATA/sessions.img" ] || { truncate -s "$WORK_SIZE" "$DATA/sessions.img"; mkfs.ext4 -q -F "$DATA/sessions.img"; }
  install -d -m 0750 "$SESSIONS"
  grep -q "$DATA/sessions.img" /etc/fstab || echo "$DATA/sessions.img $SESSIONS ext4 loop,nosuid,nodev,noexec 0 2" >> /etc/fstab
  mount "$SESSIONS"
fi
chown juno-exec:juno-exec "$SESSIONS"
chmod 0750 "$SESSIONS"

echo "==> Broker"
install -d -m 0755 /etc/juno
install -o root -g root -m 0755 "$HERE/juno-exec-docker-broker.py" /usr/local/sbin/juno-exec-docker-broker
install -d -o root -g root -m 0755 /usr/local/lib/juno-exec
install -o root -g root -m 0644 "$HERE/juno-exec.py" /usr/local/lib/juno-exec/juno-exec.py

echo "==> Image"
docker build --pull -t "$IMAGE_TAG" "$HERE/image"
IMAGE_ID="$(docker image inspect "$IMAGE_TAG" --format '{{.Id}}')"
LABEL="$(docker image inspect "$IMAGE_TAG" --format '{{index .Config.Labels "juno.security"}}')"
[ "$LABEL" = "exec-v1" ] || { echo "the built image has the wrong security label ($LABEL)" >&2; exit 1; }
RUNTIME=null
if [ "$GVISOR" = 1 ]; then
  docker info --format '{{json .Runtimes}}' | grep -q '"runsc"' || { echo "--gvisor given but Docker has no runsc runtime" >&2; exit 1; }
  RUNTIME='"runsc"'
fi
cat > /etc/juno/exec-broker.json <<JSON
{
  "image": "$IMAGE_ID",
  "sessionsRoot": "$SESSIONS",
  "runUser": "$RUN_UID:$RUN_GID",
  "memoryMb": 1536,
  "cpus": "1",
  "pidsLimit": 256,
  "tmpfsSize": "256m",
  "runtime": $RUNTIME,
  "maxSkillMounts": 8
}
JSON
chown root:root /etc/juno/exec-broker.json
chmod 0644 /etc/juno/exec-broker.json

echo "==> Token"
if [ ! -s /etc/juno/exec-token ]; then
  (umask 077 && openssl rand -hex 32 > /etc/juno/exec-token)
fi
chown root:root /etc/juno/exec-token
chmod 0600 /etc/juno/exec-token

echo "==> systemd"
cat > /etc/systemd/system/juno-exec-broker.socket <<'UNIT'
[Unit]
Description=juno-exec Docker broker socket

[Socket]
ListenStream=/run/juno-exec/broker.sock
SocketUser=root
SocketGroup=juno-exec
SocketMode=0660
DirectoryMode=0755
Accept=yes
MaxConnections=64

[Install]
WantedBy=sockets.target
UNIT
cat > /etc/systemd/system/juno-exec-broker@.service <<'UNIT'
[Unit]
Description=juno-exec Docker broker (one validated docker command)
Requires=docker.service
After=docker.service

[Service]
Type=simple
User=root
ExecStart=/usr/bin/python3 /usr/local/sbin/juno-exec-docker-broker
StandardInput=socket
StandardOutput=socket
StandardError=journal
NoNewPrivileges=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX
TasksMax=64
UNIT
cat > /etc/systemd/system/juno-exec.service <<UNIT
[Unit]
Description=juno-exec hosted code execution
Requires=juno-exec-broker.socket docker.service
After=juno-exec-broker.socket docker.service network-online.target

[Service]
Type=simple
User=juno-exec
Group=juno-exec
ExecStart=/usr/bin/python3 /usr/local/lib/juno-exec/juno-exec.py
LoadCredential=token:/etc/juno/exec-token
Environment=JUNO_EXEC_BROKER_SOCKET=/run/juno-exec/broker.sock
Environment=JUNO_EXEC_POLICY=/etc/juno/exec-broker.json
Environment=JUNO_EXEC_DATA=$DATA
Environment=JUNO_EXEC_HOST=127.0.0.1
Environment=JUNO_EXEC_PORT=$PORT
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ReadWritePaths=$DATA
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
TasksMax=512
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now juno-exec-broker.socket
systemctl enable juno-exec.service
systemctl restart juno-exec.service

echo "==> nginx (TLS on 443)"
if [ -n "$CERTBOT_EMAIL" ]; then
  certbot certonly --nginx --non-interactive --agree-tos -m "$CERTBOT_EMAIL" -d "$DOMAIN"
  CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
  KEY="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
fi
cat > /etc/nginx/sites-available/juno-exec <<NGINX
# No request path in the log: it carries the names of users' input files.
log_format juno_exec '\$remote_addr [\$time_local] \$request_method \$status \$body_bytes_sent \$request_time';
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $DOMAIN;
    ssl_certificate $CERT;
    ssl_certificate_key $KEY;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 40m;
    access_log /var/log/nginx/juno-exec.access.log juno_exec;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
NGINX
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/juno-exec /etc/nginx/sites-enabled/juno-exec
nginx -t
systemctl enable --now nginx
systemctl reload nginx

echo "==> Firewall (nftables)"
if [ -z "$SSH_FROM" ]; then
  echo "WARNING: --ssh-from not given; SSH stays open to everyone. Re-run with your admin CIDR." >&2
  SSH_RULE="tcp dport 22 accept"
else
  SSH_RULE="ip saddr $SSH_FROM tcp dport 22 accept"
fi
cat > /etc/nftables.d-juno-exec.conf <<NFT
table inet juno_exec {
  chain input {
    type filter hook input priority 0; policy drop;
    iif lo accept
    ct state established,related accept
    ct state invalid drop
    ip protocol icmp accept
    meta l4proto ipv6-icmp accept
    $SSH_RULE
    ip saddr $WEB_IP tcp dport 443 accept
  }
}
NFT
nft list table inet juno_exec >/dev/null 2>&1 && nft delete table inet juno_exec
nft -f /etc/nftables.d-juno-exec.conf
grep -q "nftables.d-juno-exec.conf" /etc/nftables.conf 2>/dev/null || echo 'include "/etc/nftables.d-juno-exec.conf"' >> /etc/nftables.conf
systemctl enable nftables

echo "==> Health"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -H "Authorization: Bearer $(cat /etc/juno/exec-token)" "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1; then
    echo "juno-exec is healthy on 127.0.0.1:$PORT (image $IMAGE_ID)"
    break
  fi
  sleep 1
  [ "$attempt" = 10 ] && { echo "juno-exec did not answer; see: journalctl -u juno-exec -u 'juno-exec-broker@*'" >&2; exit 1; }
done
echo
echo "Done. The bearer token is in /etc/juno/exec-token (root only). On the WEB VM, set:"
echo "  CODE_INTERPRETER_URL=https://$DOMAIN"
echo "  CODE_INTERPRETER_TOKEN=<the token>"
echo "  TOOL_RUNTIME=1   (only once the host is healthy)"
