#!/bin/bash
# One-time, idempotent setup of agent computers on the Juno VM. The owner runs it
# after deploying the release that contains it:
#   ssh <vm> 'sudo bash ~/juno/current/deploy/agent-computers/setup-vm.sh'
# Re-run it after changing the Dockerfile to rebuild the image.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd -P)"
RUN_USER="${SUDO_USER:-liammgnr}"
# The tag `src/lib/env.ts` defaults to (`agentComputer.image`). Keep them equal.
IMAGE="${COMPUTER_DOCKER_IMAGE:-juno-computer:1}"
NET=juno-computers
SUBNET=172.30.0.0/24
BRIDGE=br-juno

echo "==> Docker"
systemctl enable --now docker
# The application user must never be root-equivalent through Docker.
if id -nG "$RUN_USER" | tr ' ' '\n' | grep -qx docker; then
  gpasswd -d "$RUN_USER" docker
fi
install -d -m 0755 /etc/juno
install -o root -g root -m 0755 "$HERE/docker-broker.py" /usr/local/sbin/juno-computer-docker-broker
python3 - "$IMAGE" "$NET" <<'PYCONFIG'
import json, sys
with open('/etc/juno/computer-broker.json', 'w') as file:
    json.dump({'image': sys.argv[1], 'network': sys.argv[2], 'maxMemoryMb': 2048, 'maxCpus': 2}, file)
PYCONFIG
chmod 0644 /etc/juno/computer-broker.json
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/juno-computer-docker-broker *\n' "$RUN_USER" > /etc/sudoers.d/juno-computers
chmod 0440 /etc/sudoers.d/juno-computers
visudo -cf /etc/sudoers.d/juno-computers

echo "==> Network $NET ($SUBNET, bridge $BRIDGE, no container-to-container traffic)"
docker network inspect "$NET" >/dev/null 2>&1 || docker network create \
  --driver bridge --subnet "$SUBNET" \
  -o com.docker.network.bridge.name="$BRIDGE" \
  -o com.docker.network.bridge.enable_icc=false \
  "$NET"

echo "==> Pinned public egress proxy"
install -o root -g root -m 0755 "$HERE/egress-proxy.py" /usr/local/sbin/juno-computers-egress-proxy
cat > /etc/systemd/system/juno-computers-egress.service <<'PROXYUNIT'
[Unit]
Description=Validated public egress for Juno computers
After=docker.service
PartOf=docker.service

[Service]
ExecStart=/usr/bin/python3 /usr/local/sbin/juno-computers-egress-proxy
DynamicUser=yes
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
RestrictAddressFamilies=AF_INET AF_INET6
Restart=on-failure
MemoryMax=96M
TasksMax=32

[Install]
WantedBy=multi-user.target docker.service
PROXYUNIT
systemctl daemon-reload
systemctl enable --now juno-computers-egress.service

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
echo "Image and narrow Docker broker installed. Restart the application login/session to drop its old docker group."
echo "Computers created by an older build keep their old arguments: use Reset on each one"
echo "(or docker rm -f juno-agent-*; volumes are kept) so they are recreated with this image."
echo "Turn them on:  cd ~/juno && ./scripts/set-env-key.sh COMPUTER_PROVIDER --reload   (value: docker)"
